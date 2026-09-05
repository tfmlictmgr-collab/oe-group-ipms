-- A vendor registers once, in proportion to what they are.
--
-- `vendor_applications` (0021) is a front door: business name, category, CAC,
-- TIN, a contact, and a human decision. It is deliberately thin, and it stops
-- the moment the vendor exists. After that there is nowhere in this system for
-- a certificate of incorporation, a tax clearance, an insurance certificate, or
-- the bank details a remittance will eventually be sent against — those live in
-- somebody's mailbox, which is where a compliance question goes to die.
--
-- What this adds is the registration PACK: the durable record of who a vendor
-- is, with its evidence attached, reviewed by a person, and re-reviewable.
--
-- ── Proportion is the whole design ────────────────────────────────────────
-- The reference this was drawn from (a development-bank vendor portal) asks
-- thirteen sections including ownership structure, board of directors and
-- executive management. That is correct for a bank onboarding trade-finance
-- counterparties and wrong for the two-man cleaning contractor who does most of
-- the actual work in this portfolio: an onboarding form nobody finishes is a
-- vendor who never gets registered, not a vendor who gets vetted harder.
--
-- So: two tiers. `standard` is the default and asks for a company's identity,
-- its contact, its bank evidence and four compulsory documents. `enhanced` adds
-- ownership, directors and the regulatory/compliance sections, and is set per
-- vendor by the managing organisation — with `orgs.vendor_enhanced_kyc_threshold`
-- as the stated trigger for doing so, not as an automatic rule. A tier assigned
-- by a formula is a decision nobody made and nobody can explain to the vendor.
--
-- ── What is deliberately NOT here ─────────────────────────────────────────
--
-- **A full bank account number.** 0040b's rule stands: the number is given to
-- the gateway once, and never stored by us. So the vendor states bank name,
-- account name and the last four, and UPLOADS the bank's own evidence of the
-- account. Finance reads the number off that document and registers the payout
-- recipient through the existing flow. There is no path from this table into
-- `payout_recipients` — deliberately, because a self-service field that changes
-- where money is sent is the single highest-value target in the product.
--
-- **A payment gate.** Nothing here refuses an invoice from an unregistered
-- vendor. 0161/0162 is the standing lesson: a control nobody asked for, that
-- refuses money a contractor is owed, is not a neutral addition.
-- `vendor_registration_state()` reports; it does not refuse.
--
-- **An automated decision.** Document findings may be machine-generated
-- (`vendor_documents.machine_findings`) and are recorded against the evidence
-- they came from, but the reviewer records their own reason and the approval is
-- theirs — CLAUDE.md decision 10, applied to vendors exactly as to tenants.

create type vendor_kyc_tier as enum ('standard', 'enhanced');

create type vendor_registration_status as enum (
  'draft',              -- the vendor is filling it in
  'submitted',          -- with the organisation for review
  'changes_requested',  -- back with the vendor, with a reason
  'approved'
);

create type vendor_document_type as enum (
  'cac_certificate',      -- Corporate Affairs Commission incorporation
  'tin_certificate',      -- Tax Identification Number
  'bank_evidence',        -- bank reference letter or statement header
  'proof_of_address',     -- utility bill or tenancy agreement for the premises
  'insurance',            -- public liability / employers' liability
  'professional_licence', -- trade or regulatory licence, where one applies
  'tax_clearance',        -- enhanced
  'audited_accounts',     -- enhanced
  'director_id'           -- enhanced; personal data, see the retention note
);

-- ── Per-org: when enhanced is expected ────────────────────────────────────
alter table orgs add column if not exists vendor_enhanced_kyc_threshold numeric(14,2);

comment on column orgs.vendor_enhanced_kyc_threshold is
  'Annual engagement value (NGN) at or above which a vendor is expected to complete the enhanced pack. Guidance for the person setting the tier, never an automatic promotion — see set_vendor_kyc_tier().';

-- 0083c/0159: a new orgs column arrives unwritable unless it is granted. This
-- one is written from Settings by an administrator.
grant update (vendor_enhanced_kyc_threshold) on orgs to authenticated;

-- ── The vendor's tier ─────────────────────────────────────────────────────
alter table vendors add column if not exists kyc_tier vendor_kyc_tier not null default 'standard';

comment on column vendors.kyc_tier is
  'How much registration this vendor is asked for. Standard by default — most FM vendors are small local contractors and a thirteen-section form is how they end up unregistered.';

-- ── The pack ──────────────────────────────────────────────────────────────
create table vendor_registrations (
  id        uuid primary key default gen_random_uuid(),
  org_id    uuid not null references orgs(id)    on delete cascade,
  vendor_id uuid not null references vendors(id) on delete cascade,

  -- The tier this pack was filled against, snapshotted. If the organisation
  -- promotes a vendor to enhanced later, the pack they already submitted is
  -- still a true record of what was asked of them at the time — same reasoning
  -- as fee snapshotting (decision 14) and verbatim consent (decision 10).
  tier vendor_kyc_tier not null default 'standard',

  -- 01 — Business identity
  legal_name         text,
  trading_name       text,
  cac_number         text,
  tin                text,
  incorporation_date date,
  business_type      text,   -- limited company, enterprise, sole trader…

  -- 02 — Contact and premises
  address text, city text, state text,
  country text not null default 'Nigeria',
  phone text, email text, website text,

  -- 03/04/05 — Enhanced only. jsonb rather than two more tables: these are
  -- read as a block, never joined or aggregated, and a shareholder is not an
  -- entity this system otherwise has any use for.
  ownership jsonb not null default '[]'::jsonb,  -- [{name, percent, nationality}]
  directors jsonb not null default '[]'::jsonb,  -- [{name, position, nationality}]

  -- 06 — Regulatory. [{body, licence_number, expires_on}]
  regulatory jsonb not null default '[]'::jsonb,

  -- 07 — Compliance declaration. Stored verbatim per vendor, so a later change
  -- to the wording never rewrites what somebody actually agreed to.
  compliance_statement  text,
  compliance_declared_at timestamptz,
  compliance_declared_by uuid references users(id),

  -- 08 — Bank details. STATED, not stored in full, and not connected to
  -- anything that pays. See the header.
  bank_name            text,
  account_name         text,
  account_number_last4 text
    check (account_number_last4 is null or account_number_last4 ~ '^[0-9]{4}$'),

  status vendor_registration_status not null default 'draft',
  submitted_at timestamptz,
  submitted_by uuid references users(id),
  reviewed_at  timestamptz,
  reviewed_by  uuid references users(id),
  -- The reviewer's own words. Required on a decision, both ways: an approval
  -- with no stated reason is the rubber stamp decision 10 exists to refuse.
  review_notes text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint vendor_registrations_one_per_vendor unique (vendor_id)
);

create index vendor_registrations_org_status_idx on vendor_registrations (org_id, status);

comment on table vendor_registrations is
  'One durable registration pack per vendor, tiered by vendors.kyc_tier, reviewed by a person. Never a source of payment instructions — bank details here are stated and evidenced, and the payout recipient is registered separately by finance (0040b).';

comment on column vendor_registrations.account_number_last4 is
  'Last four digits only, for recognition. The full number is never stored — it is read off the uploaded bank_evidence document by finance when they register the payout recipient, exactly as 0040b requires.';

-- ── The evidence ──────────────────────────────────────────────────────────
create table vendor_documents (
  id        uuid primary key default gen_random_uuid(),
  org_id    uuid not null references orgs(id)    on delete cascade,
  vendor_id uuid not null references vendors(id) on delete cascade,

  doc_type     vendor_document_type not null,
  storage_path text not null,
  file_name    text,
  expires_on   date,   -- insurance and licences lapse; a stale certificate is not evidence

  uploaded_by uuid references users(id),
  uploaded_at timestamptz not null default now(),

  -- Human verification. The only kind that counts.
  verified_at    timestamptz,
  verified_by    uuid references users(id),
  verification_notes text,

  -- Machine findings, recorded AGAINST the evidence they came from and never
  -- as a conclusion: extraction, format and consistency checks, duplicate
  -- detection. Decision 10 — support, never a decision, never a score.
  machine_findings jsonb,

  -- Re-uploads supersede rather than replace. An edited piece of evidence is
  -- not evidence (0106).
  superseded_at timestamptz,

  constraint vendor_documents_path_not_blank check (length(trim(storage_path)) > 0)
);

create index vendor_documents_vendor_idx on vendor_documents (vendor_id, doc_type)
  where superseded_at is null;

comment on table vendor_documents is
  'Registration evidence. Append-only in practice: a re-upload supersedes the previous row rather than overwriting it, so what the reviewer actually saw stays recoverable.';

comment on column vendor_documents.machine_findings is
  'Automated extraction and consistency findings against THIS document. Never a score, a ranking or a recommendation, and never a substitute for the reviewer''s own recorded reason (CLAUDE.md decision 10).';

-- ⚠️ RETENTION. `director_id` carries personal data about a named individual.
-- The vendor relationship plus statutory retention governs it, mirroring the
-- tenant rule in decision 10(3); there is no purge job here yet and one is
-- owed before enhanced-tier onboarding is opened to real vendors.
comment on type vendor_document_type is
  'Registration document kinds. director_id is personal data under NDPA and needs a retention decision before enhanced onboarding goes live — flagged here rather than discovered later.';

-- ── What each tier must produce ───────────────────────────────────────────
--
-- A table, not a CHECK constraint and not application code: the compulsory list
-- is the kind of thing that gets argued about in a board meeting, and it should
-- be readable and amendable in one place by one INSERT.
create table vendor_document_requirements (
  tier       vendor_kyc_tier not null,
  doc_type   vendor_document_type not null,
  required   boolean not null,
  label      text not null,
  help_text  text,
  sort_order int not null default 0,
  primary key (tier, doc_type)
);

alter table vendor_document_requirements enable row level security;
create policy vendor_document_requirements_select on vendor_document_requirements
  for select using (auth.uid() is not null);
-- No write policy: defined by migration, exactly as `capabilities` (0050) is.

insert into vendor_document_requirements (tier, doc_type, required, label, help_text, sort_order) values
  -- Standard: four compulsory, two optional.
  ('standard', 'cac_certificate', true,  'Certificate of incorporation',
   'Your CAC certificate, or business name registration if you trade as an enterprise.', 10),
  ('standard', 'tin_certificate', true,  'Tax Identification Number',
   'Your TIN certificate or FIRS registration printout.', 20),
  ('standard', 'bank_evidence',   true,  'Bank account evidence',
   'A bank reference letter, or a statement header showing the account name and number we will pay into.', 30),
  ('standard', 'proof_of_address',true,  'Proof of business address',
   'A recent utility bill or tenancy agreement in the business name.', 40),
  ('standard', 'insurance',       false, 'Insurance certificate',
   'Public or employers'' liability, where you hold it.', 50),
  ('standard', 'professional_licence', false, 'Trade or professional licence',
   'Required only for regulated trades — lifts, fire systems, pest control, electrical.', 60),

  -- Enhanced: everything above, plus three.
  ('enhanced', 'cac_certificate', true,  'Certificate of incorporation', null, 10),
  ('enhanced', 'tin_certificate', true,  'Tax Identification Number', null, 20),
  ('enhanced', 'bank_evidence',   true,  'Bank account evidence', null, 30),
  ('enhanced', 'proof_of_address',true,  'Proof of business address', null, 40),
  ('enhanced', 'insurance',       true,  'Insurance certificate',
   'Compulsory at this tier.', 50),
  ('enhanced', 'professional_licence', false, 'Trade or professional licence', null, 60),
  ('enhanced', 'tax_clearance',   true,  'Tax clearance certificate',
   'Most recent year available.', 70),
  ('enhanced', 'audited_accounts',true,  'Audited accounts',
   'Most recent financial year.', 80),
  ('enhanced', 'director_id',     true,  'Director identification',
   'Government-issued ID for each director named in the pack.', 90);

-- ── Completeness, as a question rather than a constraint ──────────────────
--
-- Returns the human-readable list of what is still missing. Used by the vendor's
-- own screen (so it can say what is left before they press submit) and by
-- submit_vendor_registration() (so the refusal and the screen can never
-- disagree — one definition of "complete", not two).
create or replace function vendor_registration_missing(p_vendor_id uuid)
returns setof text language plpgsql stable security definer set search_path = public as $$
declare
  r vendor_registrations%rowtype;
  v_tier vendor_kyc_tier;
begin
  select * into r from vendor_registrations where vendor_id = p_vendor_id;
  if r.id is null then
    return next 'the registration has not been started';
    return;
  end if;
  v_tier := r.tier;

  if nullif(trim(coalesce(r.legal_name, '')), '') is null then return next 'registered business name'; end if;
  if nullif(trim(coalesce(r.cac_number, '')), '') is null then return next 'CAC registration number'; end if;
  if nullif(trim(coalesce(r.tin, '')), '')        is null then return next 'Tax Identification Number'; end if;
  if nullif(trim(coalesce(r.address, '')), '')    is null then return next 'business address'; end if;
  if nullif(trim(coalesce(r.phone, '')), '')      is null then return next 'contact phone number'; end if;
  if nullif(trim(coalesce(r.email, '')), '')      is null then return next 'contact email address'; end if;

  if nullif(trim(coalesce(r.bank_name, '')), '')    is null then return next 'bank name'; end if;
  if nullif(trim(coalesce(r.account_name, '')), '') is null then return next 'account name'; end if;
  if r.account_number_last4 is null                          then return next 'last four digits of the account number'; end if;

  if r.compliance_declared_at is null then return next 'the compliance declaration'; end if;

  if v_tier = 'enhanced' then
    if jsonb_array_length(r.ownership) = 0 then return next 'ownership structure'; end if;
    if jsonb_array_length(r.directors) = 0 then return next 'board of directors'; end if;
  end if;

  return query
    select 'document: ' || req.label
      from vendor_document_requirements req
     where req.tier = v_tier
       and req.required
       and not exists (
         select 1 from vendor_documents d
          where d.vendor_id = p_vendor_id
            and d.doc_type = req.doc_type
            and d.superseded_at is null
            and (d.expires_on is null or d.expires_on >= current_date)
       )
     order by req.sort_order;
end;
$$;

revoke all on function vendor_registration_missing(uuid) from public, anon;
grant execute on function vendor_registration_missing(uuid) to authenticated, service_role;

comment on function vendor_registration_missing is
  'Everything still outstanding on a vendor''s pack, in the words the vendor sees. One definition of complete, read by both the screen and the submit function, so a refusal can never surprise somebody the screen told was finished.';

-- ── Reporting, not gating ─────────────────────────────────────────────────
create or replace function vendor_registration_state(p_vendor_id uuid)
returns table (tier vendor_kyc_tier, status vendor_registration_status, outstanding int)
language sql stable security definer set search_path = public as $$
  select
    coalesce(r.tier, v.kyc_tier),
    coalesce(r.status, 'draft'::vendor_registration_status),
    (select count(*)::int from vendor_registration_missing(p_vendor_id))
  from vendors v
  left join vendor_registrations r on r.vendor_id = v.id
  where v.id = p_vendor_id;
$$;

revoke all on function vendor_registration_state(uuid) from public, anon;
grant execute on function vendor_registration_state(uuid) to authenticated, service_role;

comment on function vendor_registration_state is
  'What state a vendor''s registration is in. Reports; refuses nothing. No payment path consults it — 0162''s lesson about controls nobody asked for applies with full force to money a contractor is owed.';

-- ── Access ────────────────────────────────────────────────────────────────
alter table vendor_registrations enable row level security;
alter table vendor_documents     enable row level security;

-- The vendor's own pack, or staff who may read vendors.
create policy vendor_registrations_select on vendor_registrations for select to authenticated
  using (
    org_id = current_user_org_id()
    and (
      vendor_id in (select current_user_vendor_ids())
      or (select has_permission('vendors.read'))
    )
  );

-- Starting it. The vendor themselves, holding manage_profile — or staff filling
-- it in on their behalf, which is how most of these will actually get done.
create policy vendor_registrations_insert on vendor_registrations for insert to authenticated
  with check (
    org_id = current_user_org_id()
    and (
      (vendor_id in (select current_user_vendor_ids()) and vendor_user_can('manage_profile'))
      or (select has_permission('vendors.write'))
    )
  );

-- Editing it. The vendor may edit only while it is theirs to edit; once
-- submitted it is with the reviewer, and a pack that changes underneath the
-- person reviewing it is not a pack that was reviewed.
create policy vendor_registrations_update on vendor_registrations for update to authenticated
  using (
    org_id = current_user_org_id()
    and (
      (
        vendor_id in (select current_user_vendor_ids())
        and vendor_user_can('manage_profile')
        and status in ('draft', 'changes_requested')
      )
      or (select has_permission('vendors.write'))
    )
  )
  with check (org_id = current_user_org_id());

-- The status column is not writable from the client at all: it moves only
-- through submit_vendor_registration() and review_vendor_registration(), so a
-- pack cannot mark itself approved by PATCH.
revoke update on vendor_registrations from authenticated, anon;
grant update (
  legal_name, trading_name, cac_number, tin, incorporation_date, business_type,
  address, city, state, country, phone, email, website,
  ownership, directors, regulatory,
  compliance_statement, compliance_declared_at, compliance_declared_by,
  bank_name, account_name, account_number_last4,
  updated_at
) on vendor_registrations to authenticated;

create policy vendor_documents_select on vendor_documents for select to authenticated
  using (
    org_id = current_user_org_id()
    and (
      vendor_id in (select current_user_vendor_ids())
      or (select has_permission('vendors.read'))
    )
  );

create policy vendor_documents_insert on vendor_documents for insert to authenticated
  with check (
    org_id = current_user_org_id()
    and uploaded_by = auth.uid()
    and verified_at is null          -- nobody uploads pre-verified evidence
    and machine_findings is null     -- findings are written by the checker, not the subject
    and (
      (vendor_id in (select current_user_vendor_ids()) and vendor_user_can('manage_profile'))
      or (select has_permission('vendors.write'))
    )
  );

-- No UPDATE and no DELETE for the vendor: superseding is the supported
-- correction and it leaves both rows. Verification is staff-only.
create policy vendor_documents_staff_update on vendor_documents for update to authenticated
  using (org_id = current_user_org_id() and (select has_permission('vendors.write')))
  with check (org_id = current_user_org_id());

create trigger audit_vendor_registration_write
  after insert or update on vendor_registrations
  for each row execute function log_audit('vendor_registration.write');

create trigger audit_vendor_document_write
  after insert or update on vendor_documents
  for each row execute function log_audit('vendor_document.write');

-- ── Submission ────────────────────────────────────────────────────────────
create or replace function submit_vendor_registration()
returns void language plpgsql security definer set search_path = public as $$
declare
  v_vendor_id uuid := current_user_vendor_id();
  r vendor_registrations%rowtype;
  v_missing text[];
  v_name text;
  v_org uuid;
begin
  if v_vendor_id is null then
    raise exception 'only a vendor can submit their own registration';
  end if;
  if not vendor_user_can('manage_profile') then
    raise exception 'your account is not set up to submit this company''s registration';
  end if;

  select * into r from vendor_registrations where vendor_id = v_vendor_id for update;
  if r.id is null then
    raise exception 'there is nothing to submit yet';
  end if;
  if r.status = 'submitted' then
    raise exception 'this registration is already with the team for review';
  end if;
  if r.status = 'approved' then
    raise exception 'this registration has already been approved';
  end if;

  select array(select vendor_registration_missing(v_vendor_id)) into v_missing;
  if cardinality(v_missing) > 0 then
    raise exception 'still outstanding: %', array_to_string(v_missing, ', ');
  end if;

  update vendor_registrations
     set status = 'submitted', submitted_at = now(), submitted_by = auth.uid(),
         updated_at = now()
   where id = r.id;

  select name, org_id into v_name, v_org from vendors where id = v_vendor_id;

  perform notify_role(
    v_org,
    array['admin', 'facility_manager', 'regional_manager']::user_role[],
    -- 'application' is the notification kind for "a vendor thing to review"
    -- (0025's allowed list); there is no 'vendor' kind and adding one would
    -- widen a CHECK that every existing consumer already switches on.
    'application',
    'A contractor submitted their registration',
    v_name || ' has completed their registration pack and it is ready to review.',
    '/dashboard/vendors/' || v_vendor_id::text
  );
end;
$$;

revoke all on function submit_vendor_registration() from public, anon;
grant execute on function submit_vendor_registration() to authenticated;

-- ── Review ────────────────────────────────────────────────────────────────
--
-- A human decision with a stated reason, both ways. `p_notes` is required on a
-- refusal because "changes requested" with no reason is a vendor who cannot
-- act, and required on an approval because an approval nobody had to justify is
-- the rubber stamp decision 10 refuses.
create or replace function review_vendor_registration(
  p_vendor_id uuid,
  p_approve boolean,
  p_notes text
)
returns void language plpgsql security definer set search_path = public as $$
declare
  r vendor_registrations%rowtype;
  v_org uuid;
begin
  select * into r from vendor_registrations where vendor_id = p_vendor_id for update;
  if r.id is null then raise exception 'that registration could not be found'; end if;
  if r.org_id is distinct from current_user_org_id() then
    raise exception 'that registration belongs to another organisation';
  end if;
  if not coalesce((select has_permission('vendors.write')), false) then
    raise exception 'you are not able to review vendor registrations';
  end if;
  if r.status <> 'submitted' then
    raise exception 'that registration is not currently with you for review';
  end if;
  if length(trim(coalesce(p_notes, ''))) < 10 then
    raise exception 'record your reason — at least 10 characters — so the decision can be explained later';
  end if;

  update vendor_registrations
     set status = case when p_approve then 'approved' else 'changes_requested' end,
         reviewed_at = now(), reviewed_by = auth.uid(), review_notes = trim(p_notes),
         updated_at = now()
   where id = r.id;

  select org_id into v_org from vendors where id = p_vendor_id;

  perform notify_user(
    u.user_id, 'application',
    case when p_approve then 'Your registration was approved'
         else 'Your registration needs a change' end,
    trim(p_notes),
    '/dashboard/profile/registration'
  )
  from vendor_users u
  where u.vendor_id = p_vendor_id;
end;
$$;

revoke all on function review_vendor_registration(uuid, boolean, text) from public, anon;
grant execute on function review_vendor_registration(uuid, boolean, text) to authenticated;

comment on function review_vendor_registration is
  'A person decides a vendor registration and states why, both on approval and on refusal. Machine findings on the documents inform this; they never make it (CLAUDE.md decision 10).';

-- ── Tier ──────────────────────────────────────────────────────────────────
create or replace function set_vendor_kyc_tier(p_vendor_id uuid, p_tier vendor_kyc_tier, p_reason text)
returns void language plpgsql security definer set search_path = public as $$
declare v_org uuid;
begin
  select org_id into v_org from vendors where id = p_vendor_id;
  if v_org is null then raise exception 'that vendor could not be found'; end if;
  if v_org is distinct from current_user_org_id() then
    raise exception 'that vendor belongs to another organisation';
  end if;
  if not coalesce((select has_permission('vendors.write')), false) then
    raise exception 'you are not able to change a vendor''s registration tier';
  end if;
  if length(trim(coalesce(p_reason, ''))) < 10 then
    raise exception 'say why this vendor is being asked for a different tier';
  end if;

  update vendors set kyc_tier = p_tier where id = p_vendor_id;

  -- The tier the pack was filled against only follows while it is still the
  -- vendor's to fill. A submitted or approved pack keeps its own tier, so the
  -- record still says what was asked at the time.
  update vendor_registrations
     set tier = p_tier, updated_at = now()
   where vendor_id = p_vendor_id and status in ('draft', 'changes_requested');

  insert into audit_log (org_id, actor_id, action, entity_type, entity_id, after_state)
  values (v_org, auth.uid(), 'vendor.kyc_tier', 'vendors', p_vendor_id,
          jsonb_build_object('tier', p_tier, 'reason', trim(p_reason)));
end;
$$;

revoke all on function set_vendor_kyc_tier(uuid, vendor_kyc_tier, text) from public, anon;
grant execute on function set_vendor_kyc_tier(uuid, vendor_kyc_tier, text) to authenticated;

-- ── Private document storage ──────────────────────────────────────────────
--
-- Same shape as application-documents (0062) and work-order-media (0106): the
-- first path segment is the org id, so one org's evidence cannot be written
-- into another's folder, and reads are through short-lived signed URLs.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('vendor-documents', 'vendor-documents', false, 15728640,
        array['image/jpeg','image/png','image/webp','application/pdf'])
on conflict (id) do nothing;

create policy "vendor documents uploaded to the org prefix" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'vendor-documents'
    and (storage.foldername(name))[1]::uuid = current_user_org_id()
  );

create policy "vendor documents readable within the org" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'vendor-documents'
    and (storage.foldername(name))[1]::uuid = current_user_org_id()
  );

grant select, insert on vendor_documents to authenticated;
grant update (verified_at, verified_by, verification_notes, machine_findings, superseded_at, expires_on)
  on vendor_documents to authenticated;
grant all on vendor_documents to service_role;

grant select, insert on vendor_registrations to authenticated;
grant all on vendor_registrations to service_role;
grant select on vendor_document_requirements to authenticated;
grant all on vendor_document_requirements to service_role;
