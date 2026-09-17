-- An FM/PM could see the "who is attached to this property" panel and could
-- not use it. (Found live while answering "how do we attach a landlord to a
-- property with no FM/PM yet" — verified against the running database, not
-- theorised.)
--
-- 0067 gave `property_stakeholders` ONE write policy, gated on
-- `hierarchy.write`, and its own reasoning was specific to the case it was
-- solving: *"assigning someone to a REGION is a materially larger act than
-- assigning them to one property, so it belongs with portfolio structure
-- rather than with people administration."* True of a node-level assignment.
--
-- But `property_stakeholders` holds two different things (0067's own
-- `property_stakeholders_one_scope` constraint says so — exactly one of
-- `property_id` or `node_id` is set), and the DROP + single CREATE POLICY
-- replaced the write rule for BOTH with the rule meant for the larger one.
-- Property-level attachment — "this FM/PM manages this one building", "this
-- landlord owns this one building" — used no such gate before 0067 and is not
-- the act 0067's own comment is describing.
--
-- ── Confirmed live, not inferred from reading the policy ──────────────────
--
--     FM attaching an owner: REFUSED — new row violates row-level security
--     policy for table "property_stakeholders"
--
-- `hierarchy.write` is admin-only by default (decision 7, silence means off),
-- so in practice ONLY AN ADMIN could attach anybody to a property — while
-- `app/dashboard/properties/[id]/page.tsx` renders the panel and its toggle
-- buttons to any `properties.write` holder (facility_manager, property_manager,
-- regional_manager too) and its own copy says *"the actual access"*. The
-- screen promised something the database refused.
--
-- ── The fix, and why THIS is the right gate ────────────────────────────────
--
-- `properties_update`/`properties_insert`/`properties_delete` are the
-- reference: gated on `has_permission('properties.write')` alone, org-wide, no
-- further restriction to properties the caller personally holds. Deciding who
-- is attached to a property is not a larger act than editing the property
-- record itself — it is the same authority, applied to one more column of
-- facts about the building. So property-level rows now use exactly that gate;
-- node-level rows are UNCHANGED, still `hierarchy.write`, for 0067's own
-- reason.
drop policy if exists property_stakeholders_write on property_stakeholders;
create policy property_stakeholders_write on property_stakeholders for all to authenticated
  using (
    org_id = current_user_org_id()
    and (
      (property_id is not null and (select has_permission('properties.write')))
      or (node_id is not null and (select has_permission('hierarchy.write')))
    )
  )
  with check (
    org_id = current_user_org_id()
    and (
      (property_id is not null and (select has_permission('properties.write')))
      or (node_id is not null and (select has_permission('hierarchy.write')))
    )
  );

comment on policy property_stakeholders_write on property_stakeholders is
  'Two different acts, two different gates. property_id rows (who manages/owns THIS building) need properties.write, mirroring properties_update exactly. node_id rows (who runs a whole region) need hierarchy.write, per 0067''s original reasoning — a materially larger act. A single ALL policy on this table conflated them once already; do not recombine them.';
