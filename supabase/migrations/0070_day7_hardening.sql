-- Day 7 hardening, from PC2's build audit plus what following it up turned over.
--
-- ── 1. An applicant could never submit ─────────────────────────────────────
--
-- `submitApplication` re-read `application_attachments` through the applicant's
-- own session to check the required documents were there. There is no anon SELECT
-- policy on that table — deliberately — and **a query with no matching policy
-- returns zero rows without erroring.** So every uploaded document read as
-- missing, and the flow returned "Still to upload: Government-issued ID, Passport
-- photograph, Guarantor's ID" seconds after all three had uploaded successfully.
--
-- Reproduced before fixing: three `record_application_attachment` calls returned
-- true, the service role saw three rows, the applicant's own session saw zero.
--
-- This is the third appearance of one shape: **a write-only role cannot read its
-- own row back.** 0063 fixed it for `tenant_applications` and did not carry the
-- lesson to `application_attachments` two tables away.
--
-- ── 2. …and the gate it was enforcing could be skipped anyway ──────────────
--
-- `submit_tenant_application` is granted to `anon`. The document check lived in
-- the server action, so anyone posting straight to the RPC bypassed it entirely.
-- A completeness rule enforced beside the transition rather than inside it is not
-- a rule. Moving it into the function fixes the applicant's case AND closes the
-- bypass, because a definer function can see the attachments and nothing can go
-- around it.
--
-- ── 3. Required documents become configurable, in one place ────────────────
--
-- Enforcing in SQL against a list held in `lib/application-form.ts` would give two
-- sources of truth for the same rule. Instead the requirements move into a table
-- that both the form and the trigger read — which also answers the outstanding
-- Day 7 question about which documents are mandatory: it is now an operator
-- setting per organisation and application type, not a constant in code.

create table application_document_requirements (
  org_id     uuid not null references orgs(id) on delete cascade,
  type       application_type not null,
  kind       attachment_kind not null,
  label      text not null,
  required   boolean not null default true,
  sort_order integer not null default 0,
  primary key (org_id, type, kind)
);

alter table application_document_requirements enable row level security;

-- The list is shown to prospective applicants before they have an account, so it
-- is readable by anyone. It contains only the names of document types.
create policy adr_public_select on application_document_requirements
  for select to anon, authenticated using (true);

create policy adr_admin_write on application_document_requirements
  for all to authenticated
  using (org_id = current_user_org_id() and (select has_permission('applications.review_all')))
  with check (org_id = current_user_org_id() and (select has_permission('applications.review_all')));

-- Seeded to exactly what lib/application-form.ts required, so behaviour is
-- unchanged on the day this lands and becomes configurable afterwards.
insert into application_document_requirements (org_id, type, kind, label, required, sort_order)
  select o.id, d.type::application_type, d.kind::attachment_kind, d.label, true, d.ord
    from orgs o
    cross join (values
      ('individual', 'national_id',   'Government-issued ID',       1),
      ('individual', 'passport_photo','Passport photograph',        2),
      ('individual', 'guarantor_id',  'Guarantor''s ID',            3),
      ('corporate',  'cac',           'CAC certificate',            1),
      ('corporate',  'tin',           'TIN or tax clearance',       2),
      ('corporate',  'national_id',   'Authorised contact''s ID',   3)
    ) as d(type, kind, label, ord)
on conflict do nothing;

-- What an applicant still owes, answered under definer rights against their own
-- token. The token is the authority: an application id proves nothing, and this
-- deliberately cannot be pointed at somebody else's application.
create or replace function application_document_status(p_token_hash text)
returns table (kind attachment_kind, label text, required boolean, uploaded boolean)
language sql stable security definer set search_path = public as $$
  select r.kind, r.label, r.required,
         exists (select 1 from application_attachments t
                  where t.application_id = a.id and t.kind = r.kind) as uploaded
    from tenant_applications a
    join application_document_requirements r
      on r.org_id = a.org_id and r.type = a.type
   where a.resume_token_hash = p_token_hash
     and a.purged_at is null
   order by r.sort_order;
$$;

revoke all on function application_document_status(text) from public;
grant execute on function application_document_status(text) to anon, authenticated;

-- ── The gate moves inside the transition ───────────────────────────────────
create or replace function submit_tenant_application(
  p_token_hash text,
  p_form       jsonb,
  p_sensitive  jsonb,
  p_consent    text
)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  a tenant_applications%rowtype;
  v_missing text;
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

  -- Required documents, checked HERE. The server action used to do this through
  -- the applicant's own session, which could see nothing, and the RPC itself
  -- accepted submissions regardless. Both halves are answered by asking the
  -- question where the answer is actually visible and cannot be routed around.
  select string_agg(r.label, ', ' order by r.sort_order) into v_missing
    from application_document_requirements r
   where r.org_id = a.org_id
     and r.type = a.type
     and r.required
     and not exists (
       select 1 from application_attachments t
        where t.application_id = a.id and t.kind = r.kind
     );

  if v_missing is not null then
    raise exception 'Still to upload: %', v_missing;
  end if;

  update tenant_applications
     set form = coalesce(p_form, '{}'::jsonb),
         sensitive = coalesce(p_sensitive, '{}'::jsonb),
         status = 'submitted',
         submitted_at = now(),
         consent_given_at = now(),
         consent_statement = p_consent,
         resume_token_hash = null
   where id = a.id;

  return a.id;
end;
$$;

-- ── 4. Special-category data, and a token hash worth more than it looks ────
--
-- PC2 reports `sensitive` is reachable through the BASE TABLE by anyone the
-- select policy admits, even though `application_overview` exists precisely to
-- withhold it. Correct: **RLS is row-level and cannot withhold a column.**
--
-- Following that up turned over something the audit did not name.
-- `resume_application()`, `save_application_draft()` and
-- `submit_tenant_application()` all take the token HASH as their argument — so
-- anyone who can read `resume_token_hash` from the base table can resume, edit
-- and submit another person's application. That is a larger problem than reading
-- a religion field, and it has the same cause and the same fix.
--
-- Column privileges cannot be carved out of a table-level grant: table-level
-- SELECT implies every column, and revoking one column afterwards does nothing.
-- The grant has to be replaced with an explicit column list.
revoke select on tenant_applications from authenticated;

grant select (
  id, org_id, type, status,
  applicant_name, applicant_email, applicant_phone,
  property_id, unit_id,
  form,
  consent_given_at, consent_statement,
  resume_expires_at,
  submitted_at, decided_by, decided_at, decision_notes,
  purge_after, purged_at,
  created_at, updated_at
) on tenant_applications to authenticated;

comment on column tenant_applications.sensitive is
  'Special-category data. NOT selectable by `authenticated` — the grant above names every other column. RLS is row-level and cannot withhold a field, so the privilege has to.';

comment on column tenant_applications.resume_token_hash is
  'NOT selectable by `authenticated`. The resume/save/submit functions take this hash as their argument, so reading it is equivalent to holding the applicant''s link.';

-- `application_overview` is a plain view and therefore reads the base table with
-- its owner's rights, so it is unaffected — reviewers keep exactly the access
-- they had, minus the two columns they were never meant to have.
