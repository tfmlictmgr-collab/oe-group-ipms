-- A vendor already registered with one brand introduces themselves to the other.
--
-- The problem, plainly: `vendors.org_id` is singular and the property/vendor
-- security anchor is org-scoped, so a contractor who cleans for TFML and then
-- wins work for OEA is two vendor rows by construction — and, until now, two
-- registration packs, two sets of the same certificates, two of everything.
-- That is the shape most vendor portals settle for, and it is why nobody keeps
-- them up to date.
--
-- ── Why this is not simply "share the row" ────────────────────────────────
--
-- B1: *a user on one portal must never see the other brand's data or existence.*
-- A cross-org SELECT policy would weaken that boundary permanently, for every
-- query, to serve this one case. Decision 7 already settled the shape for the
-- one crossing this system allows: a single audited SECURITY DEFINER function,
-- never a cross-org policy. This follows it exactly.
--
-- Three properties hold as a result:
--
--   1. **The vendor initiates.** Nobody at either org can pull another org's
--      vendor record. The only way data crosses is a living person, party to
--      both relationships, consenting — recorded verbatim, timestamped, and
--      revocable until it is accepted.
--
--   2. **The offer does not name the source organisation.** The receiving org
--      is told "this contractor holds an approved registration elsewhere on the
--      platform and has consented to share it with you" — not with whom. That
--      is the difference between a vendor sharing their own documents and OEA
--      learning that TFML exists and who cleans for them. Naming the source
--      would be a genuine improvement to the reviewer's context and it is
--      **deliberately not done**: it needs a recorded board exception to B1,
--      the same bar decision 12 sets for making the org directory public.
--
--   3. **What crosses is a COPY, not a view.** The receiving org gets its own
--      vendor row, its own registration pack, and its own copies of the files
--      under its own storage prefix. Nothing afterwards reads across the
--      boundary, so revoking, retiring or deleting on one side cannot reach
--      into the other.
--
-- ── What the receiving org still does ─────────────────────────────────────
-- The copied pack arrives as `submitted`, not `approved`. They verify and
-- approve it themselves — that was the requirement, and it is also the only
-- defensible reading: one brand's acceptance of a contractor is not the other
-- brand's acceptance of them. What is saved is the vendor's time, not the
-- reviewer's judgement.

create type vendor_introduction_status as enum (
  'offered', 'accepted', 'declined', 'withdrawn', 'expired'
);

-- ── The two columns a carried document needs ──────────────────────────────
--
-- Declared up front because accept_vendor_introduction() writes them. A plpgsql
-- body is not parsed until it runs, so putting the ALTER after the function
-- would still work — and would break the day somebody reorders the file.
alter table vendor_documents
  add column if not exists source_document_id uuid references vendor_documents(id),
  add column if not exists copied_at timestamptz;

comment on column vendor_documents.source_document_id is
  'Set only on a document carried in by accept_vendor_introduction(). The copy the receiving organisation owns; the row it came from stays with the organisation that collected it.';

comment on column vendor_documents.copied_at is
  'When the file itself landed in this org''s storage prefix. NULL means the metadata is here and the file is not yet — a visibly incomplete pack, which is the correct thing for a reviewer to see.';

create index if not exists vendor_documents_pending_copy_idx
  on vendor_documents (source_document_id) where source_document_id is not null and copied_at is null;

create table vendor_introductions (
  id uuid primary key default gen_random_uuid(),

  -- Where it came from. Read only by the SECURITY DEFINER functions below and
  -- never returned to the receiving organisation — see property 2 in the header.
  source_org_id    uuid not null references orgs(id)    on delete cascade,
  source_vendor_id uuid not null references vendors(id) on delete cascade,
  offered_by       uuid not null references users(id),

  target_org_id uuid not null references orgs(id) on delete cascade,

  -- Stored verbatim per introduction, so a later change to the wording never
  -- rewrites what this person actually agreed to (decision 10's rule for
  -- applicant consent, which is the same problem).
  consent_statement text not null,
  consented_at timestamptz not null default now(),

  status vendor_introduction_status not null default 'offered',
  expires_at timestamptz not null default (now() + interval '30 days'),

  decided_at timestamptz,
  decided_by uuid references users(id),
  decision_notes text,

  -- The vendor row created in the receiving org on acceptance.
  target_vendor_id uuid references vendors(id),

  created_at timestamptz not null default now(),

  constraint vendor_introductions_not_to_itself check (source_org_id <> target_org_id),
  constraint vendor_introductions_consent_stated check (length(trim(consent_statement)) >= 20)
);

-- One live offer per vendor per receiving org. Re-offering while one is open is
-- refused rather than queued twice — the 0021 duplicate-guard shape.
create unique index vendor_introductions_open_uidx
  on vendor_introductions (source_vendor_id, target_org_id)
  where status = 'offered';

create index vendor_introductions_target_idx on vendor_introductions (target_org_id, status);

comment on table vendor_introductions is
  'A vendor''s own consent to carry their approved registration to another organisation on the platform. The single vendor-side crossing of org isolation, and like 0050''s permission editor it goes through audited SECURITY DEFINER functions rather than any cross-org policy.';

alter table vendor_introductions enable row level security;

-- The SOURCE side only. The vendor sees their own offers; their current org's
-- staff can see that an offer was made from their org. The receiving org gets
-- nothing through RLS at all — it reads through pending_vendor_introductions()
-- below, which returns a redacted row.
create policy vendor_introductions_source_select on vendor_introductions
  for select to authenticated
  using (
    source_org_id = current_user_org_id()
    and (
      source_vendor_id in (select current_user_vendor_ids())
      or (select has_permission('vendors.read'))
    )
  );

-- No insert/update/delete policy for anyone. Every transition below is a
-- function, because each one either crosses the boundary or records consent.

create trigger audit_vendor_introduction_write
  after insert or update on vendor_introductions
  for each row execute function log_audit('vendor_introduction.write');

-- ── Offering ──────────────────────────────────────────────────────────────
--
-- By SLUG, not by picking from a list. Same reasoning as `org_public_branding`
-- (0085): a vendor who was given OEA's address can act on it; a vendor who was
-- not cannot discover that OEA exists by opening a dropdown. An unknown slug
-- and a retired org answer identically, so the platform cannot be mapped from
-- here either.
create or replace function offer_vendor_introduction(
  p_target_org_slug text,
  p_consent_statement text
)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_vendor vendors%rowtype;
  r vendor_registrations%rowtype;
  v_target uuid;
  v_id uuid;
begin
  select * into v_vendor from vendors where id = current_user_vendor_id();
  if v_vendor.id is null then
    raise exception 'only a vendor can offer their own registration';
  end if;
  if not vendor_user_can('manage_profile') then
    raise exception 'your account is not set up to share this company''s registration';
  end if;

  select * into r from vendor_registrations where vendor_id = v_vendor.id;
  if r.id is null or r.status <> 'approved' then
    raise exception 'your registration must be approved here before it can be carried anywhere else';
  end if;

  if length(trim(coalesce(p_consent_statement, ''))) < 20 then
    raise exception 'the consent wording shown to you must be recorded with the offer';
  end if;

  select o.id into v_target
    from orgs o
   where lower(o.slug) = lower(trim(coalesce(p_target_org_slug, '')))
     and o.deleted_at is null
   limit 1;

  -- One message for unknown, retired, and "that is where you already are".
  -- Three different refusals would be three different facts about the platform.
  if v_target is null or v_target = v_vendor.org_id then
    raise exception 'that organisation could not be found';
  end if;

  if exists (
    select 1 from vendor_introductions
     where source_vendor_id = v_vendor.id and target_org_id = v_target and status = 'offered'
  ) then
    raise exception 'you have already offered your registration there and it is still waiting';
  end if;

  insert into vendor_introductions (
    source_org_id, source_vendor_id, offered_by, target_org_id,
    consent_statement
  ) values (
    v_vendor.org_id, v_vendor.id, auth.uid(), v_target,
    trim(p_consent_statement)
  )
  returning id into v_id;

  perform notify_role(
    v_target,
    array['admin', 'facility_manager', 'regional_manager']::user_role[],
    'application',
    'A contractor offered their registration',
    v_vendor.name || ' has an approved registration elsewhere on the platform and has consented to share it with you.',
    '/dashboard/vendors/introductions'
  );

  return v_id;
end;
$$;

revoke all on function offer_vendor_introduction(text, text) from public, anon;
grant execute on function offer_vendor_introduction(text, text) to authenticated;

comment on function offer_vendor_introduction is
  'A vendor consents to carry their approved pack to another organisation, addressed by slug so the act cannot double as a way to discover which organisations exist (0085''s rule).';

-- Withdrawable until it is acted on. Consent that cannot be taken back is not
-- consent.
create or replace function withdraw_vendor_introduction(p_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare i vendor_introductions%rowtype;
begin
  select * into i from vendor_introductions where id = p_id for update;
  if i.id is null then raise exception 'that offer could not be found'; end if;
  if i.source_vendor_id not in (select current_user_vendor_ids()) then
    raise exception 'that offer is not yours to withdraw';
  end if;
  if not vendor_user_can('manage_profile') then
    raise exception 'your account is not set up to manage this company''s registration';
  end if;
  if i.status <> 'offered' then
    raise exception 'that offer has already been acted on';
  end if;

  update vendor_introductions
     set status = 'withdrawn', decided_at = now(), decided_by = auth.uid()
   where id = p_id;
end;
$$;

revoke all on function withdraw_vendor_introduction(uuid) from public, anon;
grant execute on function withdraw_vendor_introduction(uuid) to authenticated;

-- ── What the receiving organisation sees ──────────────────────────────────
--
-- Redacted by construction: the vendor's own identity and pack summary, and
-- nothing about where it came from. The permission check is INSIDE the query,
-- so a caller without `vendors.write` receives an empty set rather than a
-- refusal — decision 12's rule, because a refusal confirms there is something
-- worth refusing.
create or replace function pending_vendor_introductions()
returns table (
  id uuid,
  business_name text,
  service_category text,
  cac_number text,
  tin text,
  tier vendor_kyc_tier,
  document_count int,
  offered_at timestamptz,
  expires_at timestamptz
)
language sql stable security definer set search_path = public as $$
  select
    i.id,
    v.name,
    v.service_category,
    r.cac_number,
    r.tin,
    r.tier,
    (select count(*)::int from vendor_documents d
      where d.vendor_id = v.id and d.superseded_at is null),
    i.consented_at,
    i.expires_at
  from vendor_introductions i
  join vendors v              on v.id = i.source_vendor_id
  join vendor_registrations r on r.vendor_id = v.id
  where i.target_org_id = current_user_org_id()
    and i.status = 'offered'
    and i.expires_at > now()
    and coalesce(has_permission('vendors.write'), false)
  order by i.consented_at;
$$;

revoke all on function pending_vendor_introductions() from public, anon;
grant execute on function pending_vendor_introductions() to authenticated;

comment on function pending_vendor_introductions is
  'Registrations offered TO the caller''s organisation. Deliberately silent about which organisation each came from — naming the source would tell one brand that the other exists, which needs a recorded board exception to B1 (0165 header).';

-- ── Accepting ─────────────────────────────────────────────────────────────
--
-- Creates the receiving org's OWN vendor, its own pack and its own document
-- rows. The pack lands `submitted`: the receiving org verifies and approves it
-- themselves. Nothing here approves anything on anyone's behalf.
create or replace function accept_vendor_introduction(p_id uuid)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  i vendor_introductions%rowtype;
  v_src vendors%rowtype;
  r vendor_registrations%rowtype;
  v_new uuid;
  d record;
begin
  select * into i from vendor_introductions where id = p_id for update;
  if i.id is null then raise exception 'that offer could not be found'; end if;
  if i.target_org_id is distinct from current_user_org_id() then
    -- Same message as "not found": an offer to another org is not a thing this
    -- caller should learn exists.
    raise exception 'that offer could not be found';
  end if;
  if not coalesce((select has_permission('vendors.write')), false) then
    raise exception 'you are not able to take on vendor registrations';
  end if;
  if i.status <> 'offered' then raise exception 'that offer has already been acted on'; end if;
  if i.expires_at <= now() then raise exception 'that offer has expired'; end if;

  select * into v_src from vendors              where id = i.source_vendor_id;
  select * into r     from vendor_registrations where vendor_id = i.source_vendor_id;
  if r.id is null then raise exception 'that registration is no longer available'; end if;

  -- The receiving org's own vendor. `approval_status` is left at the default
  -- and no user_id is set: they invite the vendor's login themselves, through
  -- the ordinary invitation flow, which is also what creates the first
  -- vendor_users row (0163).
  insert into vendors (org_id, name, service_category, contact_email, contact_phone, status, kyc_tier)
  values (i.target_org_id, v_src.name, v_src.service_category,
          v_src.contact_email, v_src.contact_phone, 'active', r.tier)
  returning id into v_new;

  -- The pack, copied field for field, arriving for review.
  insert into vendor_registrations (
    org_id, vendor_id, tier,
    legal_name, trading_name, cac_number, tin, incorporation_date, business_type,
    address, city, state, country, phone, email, website,
    ownership, directors, regulatory,
    compliance_statement, compliance_declared_at, compliance_declared_by,
    bank_name, account_name, account_number_last4,
    status, submitted_at, submitted_by
  ) values (
    i.target_org_id, v_new, r.tier,
    r.legal_name, r.trading_name, r.cac_number, r.tin, r.incorporation_date, r.business_type,
    r.address, r.city, r.state, r.country, r.phone, r.email, r.website,
    r.ownership, r.directors, r.regulatory,
    r.compliance_statement, r.compliance_declared_at, null,
    r.bank_name, r.account_name, r.account_number_last4,
    'submitted', now(), null
  );
  -- ⚠️ `compliance_declared_by` and `submitted_by` are deliberately NULL. They
  -- reference `users`, which is org-scoped: carrying the source org's user id
  -- across would plant a foreign-org identifier in the receiving org's row —
  -- exactly the leak this whole migration is arranged to avoid. The declaration
  -- itself and its timestamp carry over; the person's id does not.

  -- The evidence. Metadata now; the files are copied into the receiving org's
  -- storage prefix by the transfer job below, because storage policy (0164)
  -- correctly refuses a cross-prefix read and should keep doing so.
  for d in
    select * from vendor_documents
     where vendor_id = i.source_vendor_id and superseded_at is null
  loop
    insert into vendor_documents (
      org_id, vendor_id, doc_type, storage_path, file_name, expires_on,
      uploaded_by, uploaded_at, source_document_id
    ) values (
      i.target_org_id, v_new, d.doc_type,
      i.target_org_id::text || '/' || v_new::text || '/' || d.doc_type::text || '-' ||
        gen_random_uuid()::text,
      d.file_name, d.expires_on,
      null, d.uploaded_at, d.id
    );
  end loop;
  -- Note what did NOT copy: verified_at/verified_by and machine_findings. One
  -- organisation's verification is not another's, and a document arriving
  -- pre-ticked is how a review becomes a formality.

  update vendor_introductions
     set status = 'accepted', decided_at = now(), decided_by = auth.uid(),
         target_vendor_id = v_new
   where id = p_id;

  return v_new;
end;
$$;

revoke all on function accept_vendor_introduction(uuid) from public, anon;
grant execute on function accept_vendor_introduction(uuid) to authenticated;

create or replace function decline_vendor_introduction(p_id uuid, p_notes text)
returns void language plpgsql security definer set search_path = public as $$
declare i vendor_introductions%rowtype;
begin
  select * into i from vendor_introductions where id = p_id for update;
  if i.id is null then raise exception 'that offer could not be found'; end if;
  if i.target_org_id is distinct from current_user_org_id() then
    raise exception 'that offer could not be found';
  end if;
  if not coalesce((select has_permission('vendors.write')), false) then
    raise exception 'you are not able to decide vendor registrations';
  end if;
  if i.status <> 'offered' then raise exception 'that offer has already been acted on'; end if;
  if length(trim(coalesce(p_notes, ''))) < 10 then
    raise exception 'record your reason so the contractor is told something they can act on';
  end if;

  update vendor_introductions
     set status = 'declined', decided_at = now(), decided_by = auth.uid(),
         decision_notes = trim(p_notes)
   where id = p_id;
end;
$$;

revoke all on function decline_vendor_introduction(uuid, text) from public, anon;
grant execute on function decline_vendor_introduction(uuid, text) to authenticated;

-- ── Carrying the files across ─────────────────────────────────────────────
--
-- The one part that cannot be done in SQL: `storage.objects` rows index files
-- the database does not itself hold, so a copy is a storage API call. Rather
-- than weaken the bucket policy to let one org read another's prefix — which
-- would undo the isolation this migration exists to preserve — the copy is a
-- service-role job working from an explicit queue.
--
-- A document row with `copied_at IS NULL` is a placeholder: its `storage_path`
-- names where the file WILL be, and the vendor's pack is visibly incomplete
-- until it arrives. The columns themselves are declared at the top of this
-- migration, next to the type.
create or replace function pending_vendor_document_copies()
returns table (document_id uuid, source_path text, target_path text)
language sql stable security definer set search_path = public as $$
  select d.id, s.storage_path, d.storage_path
    from vendor_documents d
    join vendor_documents s on s.id = d.source_document_id
   where d.copied_at is null
   order by d.uploaded_at;
$$;

revoke all on function pending_vendor_document_copies() from public, anon, authenticated;
grant execute on function pending_vendor_document_copies() to service_role;

create or replace function mark_vendor_document_copied(p_document_id uuid)
returns void language sql security definer set search_path = public as $$
  update vendor_documents set copied_at = now()
   where id = p_document_id and copied_at is null;
$$;

revoke all on function mark_vendor_document_copied(uuid) from public, anon, authenticated;
grant execute on function mark_vendor_document_copied(uuid) to service_role;

comment on function pending_vendor_document_copies is
  'Files owed to a receiving organisation after an accepted introduction. Service role only, because it is the one place that legitimately sees a path in each of two organisations — which is precisely why no user role may call it.';

-- ── Expiry ────────────────────────────────────────────────────────────────
-- The record decides, never the schedule (decision 15's rule): an offer past
-- its date is already invisible to pending_vendor_introductions() and refused
-- by accept_vendor_introduction(); this only tidies the status so the vendor's
-- own list reads honestly.
create or replace function expire_vendor_introductions()
returns int language plpgsql security definer set search_path = public as $$
declare v_count int;
begin
  update vendor_introductions set status = 'expired'
   where status = 'offered' and expires_at <= now();
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke all on function expire_vendor_introductions() from public, anon, authenticated;
grant execute on function expire_vendor_introductions() to service_role;

grant select on vendor_introductions to authenticated;
grant all    on vendor_introductions to service_role;
