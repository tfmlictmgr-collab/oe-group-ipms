-- An applicant needs the id of the application they just created — but must not
-- be able to READ the table.
--
-- The insert policy was correct and the insert itself succeeded in raw SQL. It
-- failed through PostgREST because the client asked for the new row back
-- (`.insert(...).select("id")`), and a RETURNING clause is evaluated against the
-- SELECT policy. There is deliberately no anon SELECT policy — that absence is
-- what stops the table being enumerated — so the returning row was filtered and
-- surfaced as "new row violates row-level security policy".
--
-- The same shape bit the asset soft-delete earlier in this build: **Postgres
-- applies SELECT policies to rows a write RETURNS.** A write-only role cannot
-- ask for its own row back.
--
-- Resolved the way every other anon write here is: one SECURITY DEFINER function
-- that answers exactly one question and reveals nothing else. The gate is
-- re-checked inside it, so the function is not a way around the policy — it
-- enforces the same rule and hands back only the id and the caller's own token.

create or replace function start_tenant_application(
  p_org_id      uuid,
  p_type        application_type,
  p_name        text,
  p_email       text,
  p_phone       text,
  p_token_hash  text,
  p_expires_at  timestamptz
)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_id uuid;
begin
  -- The same gate the INSERT policy applies. A definer function that skipped it
  -- would be a hole beside the door, not a door.
  if not org_accepts_tenant_applications(p_org_id) then
    raise exception 'this organisation is not accepting applications';
  end if;

  if coalesce(trim(p_name), '') = '' or coalesce(trim(p_email), '') = '' then
    raise exception 'a name and an email address are required';
  end if;

  insert into tenant_applications (
    org_id, type, status, applicant_name, applicant_email, applicant_phone,
    resume_token_hash, resume_expires_at
  ) values (
    p_org_id, p_type, 'draft', trim(p_name), lower(trim(p_email)),
    nullif(trim(coalesce(p_phone, '')), ''), p_token_hash, p_expires_at
  )
  returning id into v_id;

  return v_id;
end;
$$;

revoke all on function start_tenant_application(uuid, application_type, text, text, text, text, timestamptz) from public;
grant execute on function start_tenant_application(uuid, application_type, text, text, text, text, timestamptz)
  to anon, authenticated;

comment on function start_tenant_application is
  'Creates a draft and returns its id. Exists because an applicant may write but must never read: a RETURNING clause is checked against the SELECT policy, and there deliberately is none.';

-- Saving a draft has the same problem in reverse — an UPDATE ... RETURNING would
-- be filtered too, and matching the row needs the token rather than an id an
-- applicant could guess.
create or replace function save_application_draft(
  p_token_hash text,
  p_form       jsonb,
  p_sensitive  jsonb
)
returns boolean language plpgsql security definer set search_path = public as $$
declare
  v_id uuid;
begin
  select id into v_id from tenant_applications
   where resume_token_hash = p_token_hash
     and status = 'draft'
     and resume_expires_at > now()
     and purged_at is null;

  if v_id is null then
    return false;   -- expired, submitted, or never existed: all the same answer
  end if;

  update tenant_applications
     set form = coalesce(p_form, '{}'::jsonb),
         sensitive = coalesce(p_sensitive, '{}'::jsonb)
   where id = v_id;

  return true;
end;
$$;

revoke all on function save_application_draft(text, jsonb, jsonb) from public;
grant execute on function save_application_draft(text, jsonb, jsonb) to anon, authenticated;

create or replace function submit_tenant_application(
  p_token_hash text,
  p_form       jsonb,
  p_sensitive  jsonb,
  p_consent    text
)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  a tenant_applications%rowtype;
begin
  select * into a from tenant_applications
   where resume_token_hash = p_token_hash
     and status = 'draft'
     and resume_expires_at > now()
     and purged_at is null
   for update;

  if a.id is null then
    raise exception 'this application link is no longer valid';
  end if;
  if coalesce(trim(p_consent), '') = '' then
    raise exception 'consent must be recorded before an application is accepted';
  end if;

  update tenant_applications
     set form = coalesce(p_form, '{}'::jsonb),
         sensitive = coalesce(p_sensitive, '{}'::jsonb),
         status = 'submitted',
         submitted_at = now(),
         consent_given_at = now(),
         -- Stored verbatim: changing the wording later must not alter what this
         -- person actually agreed to.
         consent_statement = p_consent,
         -- The draft link dies here. An application under review must not be
         -- editable behind the reviewer's back.
         resume_token_hash = null
   where id = a.id;

  return a.id;
end;
$$;

revoke all on function submit_tenant_application(text, jsonb, jsonb, text) from public;
grant execute on function submit_tenant_application(text, jsonb, jsonb, text) to anon, authenticated;

-- Attachments have the same write-but-never-read shape.
create or replace function record_application_attachment(
  p_token_hash  text,
  p_kind        attachment_kind,
  p_path        text,
  p_file_name   text,
  p_content_type text,
  p_size        bigint
)
returns boolean language plpgsql security definer set search_path = public as $$
declare
  a tenant_applications%rowtype;
begin
  select * into a from tenant_applications
   where resume_token_hash = p_token_hash
     and status = 'draft'
     and resume_expires_at > now()
     and purged_at is null;

  if a.id is null then
    return false;
  end if;

  -- The path must sit under this application's own folder. Without this, a
  -- caller holding one valid token could register a row pointing at another
  -- application's file and read it back through the reviewer's view.
  if p_path not like a.org_id::text || '/' || a.id::text || '/%' then
    raise exception 'that upload path does not belong to this application';
  end if;

  insert into application_attachments (
    org_id, application_id, kind, storage_path, file_name, content_type, size_bytes
  ) values (
    a.org_id, a.id, p_kind, p_path, left(p_file_name, 200), p_content_type, p_size
  );

  return true;
end;
$$;

revoke all on function record_application_attachment(text, attachment_kind, text, text, text, bigint) from public;
grant execute on function record_application_attachment(text, attachment_kind, text, text, text, bigint)
  to anon, authenticated;

-- The anon INSERT policies are now unnecessary — every applicant write goes
-- through the functions above, which re-check the same gate. Removing them
-- leaves exactly one way in, which is one thing to reason about rather than two.
drop policy if exists tenant_applications_public_insert on tenant_applications;
drop policy if exists application_attachments_public_insert on application_attachments;
