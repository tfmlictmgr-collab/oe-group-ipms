-- Day 8.5 — AI may verify documents; it may never screen.
--
-- Locked decision 10 (board, 29 July 2026), amending decision 2. Automated
-- **document verification** — extraction, format and consistency checks,
-- completeness, duplicate detection — is permitted as decision *support*.
-- No automated system may **decide, score, rank or recommend** an outcome.
--
-- The NDPA Art. 37 test is whether a decision is **solely** automated with
-- significant effect. Refusing someone housing is significant, and a
-- rubber-stamp does not cure it. So the shape of this table is the compliance
-- argument, not a comment above it:
--
--   • **There is no score column, and no recommendation column.** Not "nullable",
--     not "unused" — absent. A column that exists gets populated eventually, and
--     a number attached to an applicant becomes a ranking whatever it is called.
--   • **`attachment_id` is NOT NULL.** A finding exists only as an observation
--     about a specific piece of evidence. A finding about "the applicant" rather
--     than about a document is exactly the thing that is forbidden.
--   • **Severity is `info | attention`.** Never pass/fail. "Attention" means a
--     person should look at this; it has never meant reject.
--   • **Findings are contestable**, by the applicant through a reviewer, and the
--     contest is part of the record.
--
-- What this does NOT touch: `record_application_recommendation`,
-- `record_application_approval` and `record_application_rejection` do not read
-- this table and are not modified here. The reviewer's own reason (≥10 chars)
-- remains required and is still theirs to write. Findings inform it; they can
-- never be it.

-- ── The kinds of check, and what a finding may say ────────────────────────
create type document_finding_kind as enum (
  'extraction',    -- what the document appears to say
  'format',        -- does it look like the kind of document it was filed as
  'consistency',   -- does it agree with what the form says
  'completeness',  -- is it legible, whole, unexpired
  'duplicate'      -- has this exact file been submitted before
);

-- Deliberately two values. A third ("fail", "reject", "high risk") is the point
-- at which a finding becomes a conclusion.
create type document_finding_severity as enum ('info', 'attention');

-- The composite key the findings table references. Declared BEFORE the table
-- that points at it — a foreign key cannot reference a uniqueness that does not
-- exist yet, and Postgres says so at CREATE TABLE time, not at insert time.
alter table application_attachments drop constraint if exists application_attachments_id_org_uniq;
alter table application_attachments add constraint application_attachments_id_org_uniq unique (id, org_id);

create table application_document_findings (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null references orgs(id) on delete cascade,
  application_id uuid not null,

  -- The evidence this finding is ABOUT. Not nullable, ever: findings are
  -- recorded against the evidence they came from (decision 10).
  attachment_id  uuid not null,

  kind      document_finding_kind not null,
  severity  document_finding_severity not null,

  -- What was observed, phrased as an observation. Enforced as a length floor
  -- for the same reason a review reason has one: "mismatch" is not a finding a
  -- person can act on or an applicant can contest.
  summary   text not null check (length(trim(summary)) >= 10),
  detail    text,

  -- Provenance, so a finding can be re-examined or a model change audited.
  model         text not null,
  evidence_mode text not null check (evidence_mode in ('extracted_text', 'document_image')),

  -- Contest. The applicant cannot write here directly — they have no account —
  -- so a reviewer records it on their behalf, which is also what makes it
  -- auditable rather than an email nobody kept.
  contested_by     uuid references users(id),
  contested_at     timestamptz,
  contest_reason   text,

  created_at timestamptz not null default now(),

  constraint findings_application_same_org_fk
    foreign key (application_id, org_id) references tenant_applications (id, org_id) on delete cascade,
  constraint findings_attachment_same_org_fk
    foreign key (attachment_id, org_id) references application_attachments (id, org_id) on delete cascade,

  -- A contest is a reason and a person together, or neither.
  constraint findings_contest_complete check (
    (contested_by is null and contested_at is null and contest_reason is null)
    or (contested_by is not null and contested_at is not null
        and length(trim(coalesce(contest_reason, ''))) >= 10)
  )
);

create index application_document_findings_app_idx
  on application_document_findings (application_id);
create index application_document_findings_attachment_idx
  on application_document_findings (attachment_id);

comment on table application_document_findings is
  'Automated document-verification findings, each recorded against the attachment it came from. There is deliberately no score and no recommendation column: decision 10 permits verification as decision support and forbids any automated system deciding, scoring, ranking or recommending an outcome.';

comment on column application_document_findings.attachment_id is
  'The evidence this finding is about. NOT NULL by design — a finding about the applicant rather than about a document is precisely what decision 10 forbids.';

-- ── Duplicate detection needs something to compare ────────────────────────
--
-- A hash, not the file. Comparing content hashes answers "has this exact file
-- been submitted before" without any reviewer reading another applicant's
-- document, and the finding says only that it happened and when — never whose
-- application it was, which would leak one applicant's affairs into another's
-- review.
alter table application_attachments add column if not exists content_sha256 text;
create index if not exists application_attachments_hash_idx
  on application_attachments (org_id, content_sha256) where content_sha256 is not null;

comment on column application_attachments.content_sha256 is
  'SHA-256 of the uploaded file, for duplicate detection. The hash is compared; the file never is, and a duplicate finding names no other applicant.';

-- ── The per-org flag, OFF by default ──────────────────────────────────────
--
-- B9's module registry, and decision 10 is explicit that this one starts off.
-- Written as an explicit `false` for every existing org rather than left to the
-- column default, so the state is a record rather than an absence.
insert into org_modules (org_id, module, enabled)
  select id, 'ai_document_checks', false from orgs
on conflict (org_id, module) do nothing;

-- ── Who may read, run and contest ─────────────────────────────────────────
alter table application_document_findings enable row level security;

-- Whoever may review the application may read its findings. Deliberately the
-- same reach as `application_attachments_staff_select` rather than a new rule:
-- a finding is a note about a document, and someone who cannot see the document
-- has no business reading notes about it.
create policy application_document_findings_select on application_document_findings
  for select to authenticated
  using (
    org_id = current_user_org_id()
    and exists (
      select 1 from tenant_applications a
       where a.id = application_document_findings.application_id
         and a.org_id = current_user_org_id()
         and (
           (select has_permission('applications.review_all'))
           or a.property_id in (select current_user_property_ids())
         )
    )
  );

-- No INSERT or UPDATE policy for `authenticated`. Findings are written by the
-- runner through the service role, and contested through the function below —
-- a reviewer who could write findings directly could manufacture the evidence
-- their own decision cites.

insert into capabilities (key, module, label, description, locked, sort_order) values
  ('applications.run_document_checks', 'Applications', 'Run automated document checks',
   'Run extraction, format, consistency, completeness and duplicate checks over an application''s uploaded documents. The checks report findings against each document and never decide, score or recommend an outcome — the reviewer''s own reason is still required.',
   false, 47)
on conflict (key) do nothing;

-- Seeded to the roles that already review applications, and to nobody else.
insert into role_permissions (org_id, role, capability, granted)
  select o.id, r.role, 'applications.run_document_checks',
         r.role in ('admin', 'facility_manager', 'regional_manager')
    from orgs o
    cross join (select unnest(enum_range(null::user_role)) as role) r
on conflict (org_id, role, capability) do nothing;

-- ── Contesting a finding ──────────────────────────────────────────────────
--
-- Decision 10 requires findings to be contestable. A contest does not delete
-- the finding — the record must show that the check ran, what it said, and that
-- it was disputed. Erasing it would leave a decision whose evidence trail has a
-- hole in it.
create or replace function contest_document_finding(
  p_finding_id uuid,
  p_reason text
)
returns void language plpgsql security definer set search_path = public as $$
declare
  f application_document_findings%rowtype;
begin
  if auth.uid() is null then
    raise exception 'you must be signed in';
  end if;
  if length(trim(coalesce(p_reason, ''))) < 10 then
    raise exception 'say why this finding is wrong, in at least 10 characters';
  end if;

  select * into f from application_document_findings where id = p_finding_id;
  if f.id is null then
    raise exception 'that finding could not be found';
  end if;
  if f.org_id is distinct from current_user_org_id() then
    raise exception 'that finding belongs to another organisation';
  end if;

  -- The reviewer must be able to reach the application itself, checked here
  -- rather than trusted from the UI.
  if not exists (
    select 1 from tenant_applications a
     where a.id = f.application_id
       and a.org_id = current_user_org_id()
       and (
         (select has_permission('applications.review_all'))
         or a.property_id in (select current_user_property_ids())
       )
  ) then
    raise exception 'you cannot review that application';
  end if;

  update application_document_findings
     set contested_by = auth.uid(),
         contested_at = now(),
         contest_reason = trim(p_reason)
   where id = p_finding_id;
end;
$$;

revoke all on function contest_document_finding(uuid, text) from public;
grant execute on function contest_document_finding(uuid, text) to authenticated, service_role;

comment on function contest_document_finding is
  'Marks an automated finding as disputed, with a reason and a name. The finding is never deleted: a decision whose evidence trail has been edited is worse than one carrying a contested finding.';

-- ── Whether an org may run these at all ───────────────────────────────────
create or replace function org_runs_document_checks(p_org_id uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select org_has_module(p_org_id, 'lettings')
     and org_has_module(p_org_id, 'ai_document_checks');
$$;

revoke all on function org_runs_document_checks(uuid) from public;
grant execute on function org_runs_document_checks(uuid) to authenticated, service_role;

comment on function org_runs_document_checks is
  'Both flags, not one. An org must have lettings AND have deliberately switched on automated document checks — which start off (decision 10).';
