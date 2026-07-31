-- A finding must cite evidence from the application it is about.
--
-- Found by `verify-document-checks` section C, which I had written expecting
-- the composite foreign keys to cover it. They do not, and could not: one FK
-- proves the application is in this org, the other proves the attachment is in
-- this org, and neither says the two belong to *each other*. Both rows being in
-- the same organisation was never the property that mattered.
--
-- The consequence is precisely what decision 10 exists to prevent: a finding on
-- application A citing application B's identity document would put one
-- applicant's papers into another applicant's review, and would do it wearing
-- the authority of a recorded, auditable check.
--
-- The runner never constructs one — it reads only the attachments of the
-- application it was handed — but "the code that exists today does not do this"
-- is not a control. `assets.scope` and the nullable-unit_id defects taught the
-- same lesson twice: state the invariant where it cannot be forgotten.

create or replace function findings_cite_own_evidence()
returns trigger language plpgsql set search_path = public as $$
declare
  v_app uuid;
begin
  select application_id into v_app
    from application_attachments
   where id = new.attachment_id;

  if v_app is distinct from new.application_id then
    raise exception
      'that document belongs to a different application — a finding cites the evidence of the application it is about';
  end if;

  return new;
end;
$$;

create trigger application_document_findings_own_evidence
  before insert or update of application_id, attachment_id
  on application_document_findings
  for each row execute function findings_cite_own_evidence();

comment on function findings_cite_own_evidence is
  'A finding must cite an attachment belonging to its own application. The composite FKs prove both rows are in one organisation and say nothing about whether they belong to each other — which is the property that keeps one applicant''s documents out of another''s review.';
