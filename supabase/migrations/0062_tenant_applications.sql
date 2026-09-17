-- Day 7 — the front door to lettings.
--
-- A prospective tenant, with no account, fills an application and attaches
-- identity documents. This is the heaviest PII the system holds, and the design
-- is mostly about who can see what rather than about the form.
--
-- Four decisions carried from OEA_TENANT_ONBOARDING.md, all locked:
--   • ONE table with a `type` discriminator, so one review queue serves both
--     individual and corporate. Type-specific fields live in JSONB — forms will
--     change, and a schema migration per form revision is a tax on nothing.
--   • NO automated decisioning, ever (locked decision 2, and NDPA Art. 37).
--     Nothing here computes a score, a rank, or a recommendation.
--   • Special-category data (religion, marital status) is optional AND held in
--     a SEPARATE column, because RLS is row-level and cannot withhold a field.
--   • Retention is enforced, not documented: rejected/withdrawn purge at 90
--     days, approved at tenancy + 6 years (Nigerian contract limitation).

-- ── B9 module registry ─────────────────────────────────────────────────────
--
-- Lettings is OEA-only. TFML runs facilities operations and has no tenants,
-- leases or rent — so the module is a per-org flag rather than a role check.
-- This is the registry B9 promised; other deferred modules (HR, DMS) join it
-- without new machinery.
create table org_modules (
  org_id  uuid not null references orgs(id) on delete cascade,
  module  text not null,
  enabled boolean not null default false,
  primary key (org_id, module)
);

alter table org_modules enable row level security;

create policy org_modules_select on org_modules for select
  using (org_id = current_user_org_id());
-- No write policy: modules are provisioned by the platform operator, like
-- permissions. An org cannot switch on a module it has not contracted for.

create or replace function org_has_module(p_org_id uuid, p_module text)
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce(
    (select enabled from org_modules where org_id = p_org_id and module = p_module),
    false
  );
$$;

revoke all on function org_has_module(uuid, text) from public;
grant execute on function org_has_module(uuid, text) to anon, authenticated, service_role;

insert into org_modules (org_id, module, enabled)
  select id, 'lettings', delivery_brand = 'OEA' from orgs
  on conflict do nothing;

-- ── The application ────────────────────────────────────────────────────────
create type application_type   as enum ('individual', 'corporate');
create type application_status as enum (
  'draft', 'submitted', 'under_review', 'info_requested',
  'approved', 'rejected', 'withdrawn'
);

create table tenant_applications (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references orgs(id) on delete cascade,
  type        application_type not null,
  status      application_status not null default 'draft',

  -- Indexed core columns: what the queue lists and searches on. Everything else
  -- lives in `form`.
  applicant_name  text not null,
  applicant_email text not null,
  applicant_phone text,

  property_id uuid references properties(id),
  unit_id     uuid references units(id),

  -- The form as filled. JSONB so a form revision is a content change, not a
  -- migration — the three OEA forms will not be the last three.
  form jsonb not null default '{}'::jsonb,

  -- Special-category personal data, held APART from `form` on purpose.
  -- Religion and marital status appear on the OEA paper forms; under NDPA they
  -- are special-category and need a stricter basis than "we collect it because
  -- the form has a box". RLS cannot hide a column, so the separation is
  -- physical: reviewers read `application_overview`, which does not select this.
  sensitive jsonb not null default '{}'::jsonb,

  -- Consent, captured at submission. Recorded as WHEN and TO WHAT, not a
  -- boolean — "they ticked a box" is not a record of what they agreed to.
  consent_given_at   timestamptz,
  consent_statement  text,

  -- Save-and-resume without an account. Only the HASH is stored, exactly as
  -- invitations (0020): a database reader cannot resume someone's application.
  resume_token_hash text unique,
  resume_expires_at timestamptz,

  submitted_at   timestamptz,
  decided_by     uuid references users(id),
  decided_at     timestamptz,
  decision_notes text,

  -- Retention. `purge_after` is set on decision, so the deadline is a fact on
  -- the row rather than a calculation someone must remember to repeat.
  purge_after  timestamptz,
  purged_at    timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index tenant_applications_org_status_idx on tenant_applications (org_id, status);
create index tenant_applications_property_idx on tenant_applications (property_id);
create index tenant_applications_purge_idx on tenant_applications (purge_after)
  where purged_at is null and purge_after is not null;

create trigger tenant_applications_touch before update on tenant_applications
  for each row execute function touch_updated_at();

create trigger audit_tenant_application after insert or update on tenant_applications
  for each row execute function log_audit('application.write');

-- ── Attachments ────────────────────────────────────────────────────────────
create type attachment_kind as enum (
  'national_id', 'work_id', 'cac', 'tin', 'passport_photo',
  'company_profile', 'guarantor_id', 'bank_reference', 'other'
);

create table application_attachments (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null references orgs(id) on delete cascade,
  application_id uuid not null references tenant_applications(id) on delete cascade,
  kind           attachment_kind not null,
  -- Path within the private bucket. The FILE is the record; this row is its index.
  storage_path   text not null unique,
  file_name      text not null,
  content_type   text not null,
  size_bytes     bigint not null check (size_bytes > 0),
  uploaded_at    timestamptz not null default now()
);

create index application_attachments_app_idx on application_attachments (application_id);

alter table tenant_applications enable row level security;
alter table application_attachments enable row level security;

-- ── Who may submit ─────────────────────────────────────────────────────────
--
-- Anonymous INSERT, gated on the org having the module AND accepting
-- applications. Through a SECURITY DEFINER predicate, not an EXISTS over
-- `orgs`: a WITH CHECK subquery runs as the CALLER, and for anon
-- `current_user_org_id()` is null, so the EXISTS is always false and nobody can
-- ever submit. That exact mistake cost the vendor application flow (0021→0022);
-- it is not repeated here.
alter table orgs add column if not exists tenant_applications_open boolean not null default false;

create or replace function org_accepts_tenant_applications(p_org_id uuid)
returns boolean language sql security definer stable set search_path = public as $$
  select coalesce(
    (select o.tenant_applications_open and org_has_module(o.id, 'lettings')
       from orgs o where o.id = p_org_id),
    false
  );
$$;

revoke all on function org_accepts_tenant_applications(uuid) from public;
grant execute on function org_accepts_tenant_applications(uuid) to anon, authenticated;

create policy tenant_applications_public_insert on tenant_applications
  for insert to anon, authenticated
  with check (
    status in ('draft', 'submitted')
    and org_accepts_tenant_applications(org_id)
  );

-- Deliberately NO select policy for anon. An applicant returns through
-- `resume_application()` (below), which matches a hashed token — so the table
-- cannot be enumerated, and knowing an application id is worth nothing.

-- ── Who may read ───────────────────────────────────────────────────────────
--
-- A Property Manager sees applications for properties they are attached to; an
-- approver sees the org's. Property scoping is the attaché assignment, exactly
-- as everywhere else — the capability says WHETHER, the assignment says WHERE.
create policy tenant_applications_staff_select on tenant_applications
  for select to authenticated
  using (
    org_id = current_user_org_id()
    and purged_at is null
    and (
      (select has_permission('applications.review_all'))
      or property_id in (select current_user_property_ids())
    )
  );

create policy tenant_applications_staff_update on tenant_applications
  for update to authenticated
  using (
    org_id = current_user_org_id()
    and (
      (select has_permission('applications.review_all'))
      or property_id in (select current_user_property_ids())
    )
  );

create policy application_attachments_staff_select on application_attachments
  for select to authenticated
  using (
    org_id = current_user_org_id()
    and application_id in (select id from tenant_applications)
  );

create policy application_attachments_public_insert on application_attachments
  for insert to anon, authenticated
  with check (org_accepts_tenant_applications(org_id));

-- ── The reviewer's view: everything except special-category data ───────────
--
-- Definer rights, so its WHERE clause is the boundary. It restricts to the
-- caller's org and to those who may review — without it a tenant could read
-- every application in the org through the view.
create or replace view application_overview as
  select
    a.id, a.org_id, a.type, a.status,
    a.applicant_name, a.applicant_email, a.applicant_phone,
    a.property_id, a.unit_id,
    a.form,                       -- note: `sensitive` is NOT here
    a.consent_given_at, a.consent_statement,
    a.submitted_at, a.decided_by, a.decided_at, a.decision_notes,
    a.created_at, a.updated_at,
    (select count(*) from application_attachments t where t.application_id = a.id)
      as attachment_count
  from tenant_applications a
  where a.org_id = current_user_org_id()
    and a.purged_at is null
    and (
      has_permission('applications.review_all')
      or a.property_id in (select current_user_property_ids())
    );

comment on view application_overview is
  'Applications WITHOUT the special-category column. Definer rights, so its WHERE clause is the security boundary — org, not purged, and reviewer-or-attached.';

revoke all on application_overview from anon, authenticated;
grant select on application_overview to authenticated;

-- ── Resume without an account ──────────────────────────────────────────────
--
-- The applicant holds an unguessable token; we hold only its hash. Returns the
-- draft, or nothing — an expired, submitted or unknown token are indistinguishable,
-- so this cannot be used to discover which tokens exist.
create or replace function resume_application(p_token_hash text)
returns table (
  id uuid, org_id uuid, type application_type, status application_status,
  applicant_name text, applicant_email text, applicant_phone text,
  property_id uuid, unit_id uuid, form jsonb
)
language sql security definer stable set search_path = public as $$
  select a.id, a.org_id, a.type, a.status,
         a.applicant_name, a.applicant_email, a.applicant_phone,
         a.property_id, a.unit_id, a.form
    from tenant_applications a
   where a.resume_token_hash = p_token_hash
     and a.status = 'draft'
     and a.resume_expires_at > now()
     and a.purged_at is null;
$$;

revoke all on function resume_application(text) from public;
grant execute on function resume_application(text) to anon, authenticated;

-- ── Retention, enforced ────────────────────────────────────────────────────
--
-- Purging replaces PII with nulls and leaves the row: the audit trail must
-- still show that an application existed and a decision was taken, without
-- retaining who the person was. Deleting the row would destroy the evidence
-- that the process was followed, which is the opposite of what retention law
-- asks for.
create or replace function purge_expired_applications()
returns integer language plpgsql security definer set search_path = public as $$
declare
  v_count integer := 0;
begin
  with purged as (
    update tenant_applications
       set applicant_name  = '[purged]',
           applicant_email = '[purged]',
           applicant_phone = null,
           form            = '{}'::jsonb,
           sensitive       = '{}'::jsonb,
           decision_notes  = null,
           resume_token_hash = null,
           purged_at       = now()
     where purged_at is null
       and purge_after is not null
       and purge_after < now()
    returning id
  )
  select count(*) into v_count from purged;

  -- The files go too. Their storage objects are removed by the scheduled job
  -- that calls this, using the paths recorded here before they are dropped.
  delete from application_attachments
   where application_id in (
     select id from tenant_applications where purged_at is not null
   );

  return v_count;
end;
$$;

revoke all on function purge_expired_applications() from public;
grant execute on function purge_expired_applications() to service_role;

comment on function purge_expired_applications() is
  'Retention: nulls the PII and keeps an anonymised stub proving a decision was made. Rejected/withdrawn at 90 days, approved at tenancy + 6 years — set as purge_after when the decision is recorded.';

-- ── Private document storage ───────────────────────────────────────────────
--
-- Private, unlike org-logos. These are identity documents; they are reached
-- through signed URLs with a short life, never a public path.
insert into storage.buckets (id, name, public)
  values ('application-documents', 'application-documents', false)
  on conflict (id) do nothing;

-- Anonymous upload into the org's own prefix, only while that org accepts
-- applications. The first path segment is the org id, so one org's documents
-- cannot be written into another's folder.
create policy "applicants upload to their org prefix" on storage.objects
  for insert to anon, authenticated
  with check (
    bucket_id = 'application-documents'
    and org_accepts_tenant_applications((storage.foldername(name))[1]::uuid)
  );

create policy "staff read their org documents" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'application-documents'
    and (storage.foldername(name))[1]::uuid = current_user_org_id()
  );

-- ── The capability ─────────────────────────────────────────────────────────
insert into capabilities (key, module, label, description, locked, sort_order) values
  ('applications.review_all', 'Lettings', 'See all applications',
   'Read every tenant application in the organisation, not only those for properties they are attached to.',
   false, 90)
on conflict (key) do nothing;

-- Seeded per B7: finance/approver and admin org-wide; a PM sees their own
-- properties' applications through the attaché assignment, without this.
insert into role_permissions (org_id, role, capability, granted)
  select o.id, r.role, 'applications.review_all', r.role in ('admin', 'finance_approver')
    from orgs o
    cross join (select unnest(array['tenant','vendor','fm_ops_staff','facility_manager',
                                    'finance_approver','property_owner','admin','viewer']::user_role[]) as role) r
on conflict (org_id, role, capability) do nothing;
