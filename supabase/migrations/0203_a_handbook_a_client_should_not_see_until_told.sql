-- The training handbook (`/dashboard/training`, `/api/training`) ships this
-- release, and no client organisation should see it appear on their own menu
-- the day it deploys — decision 7's own reasoning, applied to a screen rather
-- than a payment: a capability nobody asked for showing up unannounced is a
-- support ticket, not a feature launch. OE Group wants to turn it on org by
-- org, once each org's own content has been reviewed.
--
-- `tickets.assign_without_review` (0178) is the exact precedent: a capability
-- named explicitly OFF for every role, admin included, before admin's blanket
-- grant — "off by default for every role, including admin — turn on only for
-- a specific, understood gap." That is the whole of what is needed here too.
--
-- Deliberately NOT a B9 `org_modules` flag. B9 marks what an org has
-- CONTRACTED for (lettings, ai_document_checks) and is seeded once at
-- provisioning; this is a rollout switch for a screen every org's own admin
-- already qualifies for by role, and B7's matrix is exactly the mechanism
-- decision 7 built for "operator-governed, not org-governed, off until an
-- operator turns it on."

insert into capabilities (key, module, label, description, locked, sort_order)
values (
  'training.read', 'Training', 'Training handbook',
  'See the in-app training handbook (every process, by role) and download it as a PDF, chapter, job aid or slide deck. Off by default for every role, including admin — the platform operator turns it on per organisation once that organisation''s content has been reviewed.',
  false, 90
)
on conflict (key) do nothing;

-- ── The baseline: false for everyone, admin included ───────────────────────
-- Full function body carried forward from 0184 (its most recent definition)
-- with exactly one addition — the same shape as 0178's own precedent, and in
-- the same first-priority position, so admin's blanket `true` never reaches
-- this capability.
create or replace function seed_b7_permissions(p_org_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  cap record;
  r user_role;
  v_granted boolean;
begin
  for cap in select key from capabilities where not locked loop
    foreach r in array array['tenant','vendor','fm_ops_staff','facility_manager',
                             'property_manager',
                             'finance_approver','property_owner','admin','viewer',
                             'executive','regional_manager',
                             'payment_audit_approver','payment_approver']::user_role[]
    loop
      v_granted := case
        when cap.key = 'tickets.assign_without_review' then false
        when cap.key = 'training.read' then false

        when r = 'admin' then true

        when r = 'executive' then cap.key in (
          'tickets.read_all', 'assets.read', 'sc.read_all', 'properties.read_all',
          'vendors.read', 'bi.read', 'tickets.triage_unassigned'
        )

        when r = 'payment_audit_approver' then cap.key in (
          'tickets.read_all', 'vendors.read', 'bi.read', 'properties.read_all'
        )

        when r = 'payment_approver' then cap.key in (
          'vendors.read', 'bi.read', 'properties.read_all'
        )

        when r = 'regional_manager' then cap.key in (
          'tickets.assign', 'tickets.close', 'tickets.triage_unassigned',
          'assets.write', 'assets.import',
          'vendors.read', 'vendors.write', 'vendors.evaluate',
          'properties.write', 'units.assign_occupant',
          'people.invite', 'bi.read',
          'applications.review_all'
        )

        when cap.key = 'tickets.read_all' then false

        when cap.key in ('assets.read', 'sc.read_all', 'properties.read_all')
          then r = 'finance_approver'

        when cap.key in ('tickets.assign', 'tickets.close',
                         'assets.write', 'assets.import',
                         'vendors.write', 'vendors.evaluate',
                         'properties.write', 'units.assign_occupant',
                         'people.invite')
          then r in ('facility_manager', 'property_manager')

        when cap.key = 'vendors.read'
          then r in ('facility_manager', 'property_manager', 'finance_approver')
        when cap.key = 'sc.manage'    then r = 'finance_approver'
        when cap.key = 'bi.read'
          then r in ('facility_manager', 'property_manager',
                     'finance_approver', 'property_owner')
        when cap.key = 'people.deactivate' then false
        when cap.key = 'tickets.triage_unassigned' then false

        else false
      end;

      insert into role_permissions (org_id, role, capability, granted)
      values (p_org_id, r, cap.key, v_granted)
      on conflict (org_id, role, capability) do nothing;
    end loop;
  end loop;
end;
$$;

-- ── Existing orgs ───────────────────────────────────────────────────────────
-- Deliberately NO backfill insert here. `training.read` did not exist before
-- this migration, so no organisation holds a `role_permissions` row for it —
-- `has_permission()` denies on an absent row exactly as it denies on an
-- unknown one, so every existing org is already OFF without writing a single
-- row. The permission-matrix editor (`loadMatrix`) reads the `capabilities`
-- table directly and treats a missing row as unchecked, so the new capability
-- appears as an available, togglable, currently-off switch for every org the
-- moment this migration runs — an operator turns it on per org through the
-- existing editor at /orgs, nothing further to build there.
comment on function seed_b7_permissions is
  'What a NEW org starts with, and what "reset to B7" returns an existing one to (0184, +0203 for training.read). A capability not named here falls to `else false` -- decision 7''s "B7 silent means OFF".';
