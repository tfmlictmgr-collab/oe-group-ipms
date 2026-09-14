-- What a `viewer` may see. Deliberately narrow.
--
-- Every existing SELECT policy names the roles it admits, so a new role starts
-- able to read nothing but its own user row, its own notifications, and its org
-- record. That deny-by-default is the right footing; this file adds back only
-- what a progress review actually needs.
--
-- THE RULE: a viewer sees what a public case study could show — structure,
-- operations, counts. Never money, never a person's contact details, never the
-- audit trail.
--
-- Excluded on purpose, each for a reason:
--   service_charges, sc_budgets, payments, payment_intents, payment_settings,
--   ledger_*, bank_*, reconciliations, gateway_events  — the entire point of
--     the role. An external reviewer has no business in client funds.
--   audit_log            — who did what, and when.
--   users                — staff names, emails, phone numbers.
--   invitations          — email addresses of people not yet enrolled.
--   vendor_applications  — unsuccessful applicants' business and contact data.
--   channel_routes       — maps inbound WhatsApp/Telegram identifiers to orgs.

-- ── Column-bearing tables go through views ─────────────────────────────────
--
-- RLS is row-level. Two tables carry columns a viewer must not see — ticket
-- free text, vendor contact details — and no policy can withhold a column.
-- Column-level GRANTs cannot help either: every signed-in user shares the one
-- database role `authenticated`, so a grant that hides a column from a viewer
-- hides it from finance too.
--
-- So these views run with DEFINER rights (the default — deliberately NOT
-- security_invoker) and do their own gating. A viewer is given no policy on the
-- underlying tables at all, which is what makes the omission real: the columns
-- are not filtered in the application, they are unreachable.
--
-- Because a definer view bypasses RLS, its WHERE clause IS the security
-- boundary, and must therefore restrict BOTH the org and the roles that may
-- read org-wide. Without the role test a tenant would read every ticket in the
-- org through this view — a widening, not a narrowing.

create or replace view ticket_overview as
  select
    t.id, t.org_id, t.property_id, t.asset_id,
    t.channel, t.category, t.urgency, t.status,
    t.requires_human_review,
    t.assigned_vendor_id is not null as is_assigned_to_vendor,
    t.assigned_to_user_id is not null as is_assigned_to_staff,
    t.assigned_at, t.acknowledged_at, t.created_at
  from tickets t
  where t.org_id = current_user_org_id()
    and current_user_role() = any (
      array['viewer', 'admin', 'finance_approver']::user_role[]
    );

comment on view ticket_overview is
  'Tickets without message_text/summary/channel_sender_ref. Definer rights, so its WHERE clause is the security boundary: org + the roles that already read tickets org-wide, plus viewer.';

create or replace view vendor_overview as
  select
    v.id, v.org_id, v.name, v.service_category, v.status,
    v.approval_status, v.created_at
  from vendors v
  where v.org_id = current_user_org_id()
    and current_user_role() = any (
      array['viewer', 'admin', 'facility_manager', 'finance_approver']::user_role[]
    );

comment on view vendor_overview is
  'Vendors without contact_email/contact_phone. Same definer-rights reasoning as ticket_overview.';

revoke all on ticket_overview from anon, authenticated;
revoke all on vendor_overview from anon, authenticated;
grant select on ticket_overview to authenticated;
grant select on vendor_overview to authenticated;

-- ── Structure: no personal data, and the clearest evidence of the build ────
create policy properties_viewer_select on properties for select
  using (org_id = current_user_org_id() and current_user_role() = 'viewer');

create policy units_viewer_select on units for select
  using (org_id = current_user_org_id() and current_user_role() = 'viewer');

create policy assets_viewer_select on assets for select
  using (
    deleted_at is null
    and org_id = current_user_org_id()
    and current_user_role() = 'viewer'
  );

create policy asset_identifiers_viewer_select on asset_identifiers for select
  using (org_id = current_user_org_id() and current_user_role() = 'viewer');

create policy asset_certificates_viewer_select on asset_certificates for select
  using (org_id = current_user_org_id() and current_user_role() = 'viewer');

create policy asset_field_definitions_viewer_select on asset_field_definitions for select
  using (org_id = current_user_org_id() and current_user_role() = 'viewer');

-- Vendor performance is the AURA scorecard — a headline deliverable, and about
-- a business rather than a person.
create policy vendor_evaluations_viewer_select on vendor_evaluations for select
  using (org_id = current_user_org_id() and current_user_role() = 'viewer');

create policy vendor_properties_viewer_select on vendor_properties for select
  using (org_id = current_user_org_id() and current_user_role() = 'viewer');

-- ── No writes, anywhere ────────────────────────────────────────────────────
-- Every write policy in the schema names the roles it admits and none names
-- 'viewer', so no new rule is needed. But this is an invariant that holds by
-- ABSENCE, and an absence is exactly what a later migration removes by
-- accident. scripts/verify-viewer-access.mjs asserts it directly against every
-- table rather than trusting that no future policy adds a blanket USING clause.
