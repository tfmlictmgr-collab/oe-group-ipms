-- An applicant asked to upload a clearer document could not upload one.
--
-- `record_application_attachment` matched only `status = 'draft'`.
-- `record_application_info_request` reopens an application through
-- `status = 'info_requested'` on a freshly minted token — exactly the state an
-- applicant is in when a reviewer's most common request lands: "upload a clearer
-- copy of X". The function returned `false` rather than erroring, so this would
-- have surfaced as a silent failure on the applicant's device, not a message
-- anyone could act on.
--
-- Caught by the suite that exercises the info-request path end to end, which is
-- the only reason it was caught before a real reviewer tried it. Widened exactly
-- as `submit_tenant_application` already was for the same status.

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
     and status in ('draft', 'info_requested')
     and resume_expires_at > now()
     and purged_at is null;

  if a.id is null then
    return false;
  end if;

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
