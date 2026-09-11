-- The navigation asks the permission matrix instead of guessing.
--
-- ⚠️ Three times now the same defect has been found and fixed one instance at a
-- time, and this file is the attempt to stop finding a fourth:
--
--   * the executive could not open the ledger, while `oversight_roles()` grants
--     them 135 entries and the nav already linked them there (fixed 7 Aug);
--   * the executive was refused above-threshold approval, which decision 9
--     explicitly gives them and `enforce_payment_transition` has allowed since
--     0073 (fixed 7 Aug);
--   * and the **regional manager** — who holds `properties.write`,
--     `assets.write`, `assets.import`, `tickets.assign`, `tickets.close`,
--     `people.invite`, `vendors.write`, `vendors.evaluate`, `leases.write`,
--     `units.assign_occupant` and five more — appears in NONE of the nav's role
--     arrays, so the product shows them no Properties, no Assets, no Vendors,
--     no Leases, no People. Fifteen capabilities and nowhere to use them.
--
-- Each was an application array of role names, hand-maintained beside a
-- database that had moved on. Decision 7 made privileges an operator-toggled
-- MATRIX precisely so role names would stop being hardcoded — and then the menu
-- kept its own copy anyway.
--
-- So the menu now asks. One round trip, one array, and a capability granted in
-- the operator's matrix appears in the affected user's navigation without a
-- deployment.

create or replace function my_capabilities()
returns text[]
language sql stable security definer set search_path = public as $$
  select coalesce(array_agg(rp.capability order by rp.capability), array[]::text[])
    from role_permissions rp
   where rp.org_id = current_user_org_id()
     and rp.role = current_user_role()
     and rp.granted;
$$;

revoke all on function my_capabilities() from public;
revoke execute on function my_capabilities() from anon;
grant execute on function my_capabilities() to authenticated;

comment on function my_capabilities is
  'Every capability the CALLER holds, from the operator-governed matrix (decision 7). Exists so the navigation can ask rather than keep its own array of role names -- a copy that had already drifted three times, most visibly leaving the regional manager with fifteen capabilities and no menu entry for any of them. Presentation only: RLS remains the boundary, and this returns nothing a policy would not.';

-- ⚠️ What deliberately does NOT come from here.
--
-- Decision 7 names the non-delegable controls that "stay hardwired and never
-- appear as toggles": payment approval and its threshold escalation, remittance
-- execution, ledger read/write, bank configuration, audit visibility, admin
-- invitation, permission editing, and channel-route credentials. There is no
-- capability row for any of them, so they cannot be returned above, and the
-- application must keep checking those by role. That is not drift — it is the
-- distinction between a preference and a control an auditor checks.
--
-- This view exists so that distinction is legible rather than remembered.
create or replace view non_delegable_controls as
  select * from (values
    ('payment.approve',        'Approving a payment, including the threshold escalation to admin/executive'),
    ('payment.remit',          'Executing a remittance -- oversight authorises, finance disburses'),
    ('ledger.read',            'Reading the client-funds ledger'),
    ('ledger.write',           'Posting to the client-funds ledger'),
    ('bank.configure',         'Adding or changing a bank account or payout recipient'),
    ('audit.read',             'Seeing the audit trail'),
    ('invitations.admin',      'Inviting an administrator'),
    ('permissions.edit',       'Editing the permission matrix itself'),
    ('channel.credentials',    'Channel-route credentials')
  ) as t(control, why);

comment on view non_delegable_controls is
  'The controls decision 7 hardwires and never exposes as toggles. Not enforcement -- each is enforced where it lives (enforce_payment_transition, oversight_roles, the ledger policies) -- but a single legible list, so "why is this not in the matrix?" has an answer that does not depend on someone remembering the board minute.';

grant select on non_delegable_controls to authenticated;
