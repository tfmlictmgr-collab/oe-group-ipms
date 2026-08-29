-- Bulk record export and document downloads — operator-governed, same shape
-- as 0203's `training.read`.
--
-- Every KYC review screen already lets a reviewer open one document at a time
-- through a signed URL (tenancy, vendor registrations) — that stays exactly
-- as it was. What did not exist anywhere was a way to pull many records or
-- many documents out of the platform at once: a CSV of a roster, or every
-- document on one applicant zipped into a single file. That is a materially
-- different capability from reading one row on a screen — it is the shape of
-- thing a data-protection review asks about by name — so it gets its own
-- capability rather than riding on `people.invite` or `vendors.read`.
--
-- Same precedent as 0203/0178: named explicitly OFF for every role, admin
-- included, before admin's blanket grant. The platform operator (the OE
-- Group org, `is_platform_operator`) reaches every export/download route
-- through a hardcoded operator check in the route itself — the same pattern
-- `training.read`'s screen uses for its own operator edition — so this
-- capability is never needed for the operator to use the feature. What it
-- IS for: the one lever that turns bulk export on for a SPECIFIC client
-- org's OWN admin, per org, through the Settings → Permissions matrix that
-- already exists — nothing new to build there, exactly as 0203 documented.

insert into capabilities (key, module, label, description, locked, sort_order)
values (
  'records.export', 'Records',
  'Bulk record export and document downloads',
  'Download a CSV roster (staff, tenants, vendors, landlords/owners) or a zip of every document on one applicant/vendor. Off by default for every role, including admin — the platform operator always has this on their own portal, and turns it on for a client organisation''s administrator only when asked.',
  false, 91
)
on conflict (key) do nothing;

-- ── The baseline: false for everyone, admin included ───────────────────────
-- Carried forward from 0203 with exactly one addition, in the same
-- first-priority position so admin's blanket `true` never reaches it.
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
        when cap.key = 'records.export' then false

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

-- No backfill: `records.export` did not exist before this migration, so no
-- org holds a row for it, and `has_permission()` denies an absent row exactly
-- as it denies a false one (0203's same reasoning). Every existing org is
-- already off; the operator turns it on per org through the existing matrix.
comment on function seed_b7_permissions is
  'What a NEW org starts with, and what "reset to B7" returns an existing one to (0184, +0203 training.read, +0223 records.export). A capability not named here falls to `else false` -- decision 7''s "B7 silent means OFF".';
