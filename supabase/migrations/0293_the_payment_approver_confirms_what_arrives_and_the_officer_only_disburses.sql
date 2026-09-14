-- 13 Sept 2026 (board). Asked directly: the Payment Approver is the chief
-- accounting officer and should approve/confirm inflows — both off-platform
-- and gateway — while the Payment Officer (finance_approver) is majorly the
-- desk that dispenses outward disbursements. Some of what the Officer holds
-- today should move to the Approver.
--
-- ⚠️ This reverses a specific, board-confirmed line in decision 45 (0281/0282):
-- "The board confirmed payment_approver — stage 3 of the outbound ladder — is
-- not involved here [in the inbound chain]." Checked against the live system
-- before building, not assumed: the two roles' GRANTED capabilities are in
-- fact nearly identical already (both carry sc.manage, sc.read_all,
-- properties.read_all, assets.read, bi.read, vendors.read; the only asymmetry
-- was finance_approver's payments.record_offline against payment_approver's
-- records.export) — so "most of the Officer's privileges, unseen on the
-- Approver" was not true of the live grants. What WAS true, and what this
-- migration actually changes, is narrower and confirmed directly: the
-- INBOUND OFF-PLATFORM CONFIRMATION CHAIN's final, ledger-posting stage moves
-- from finance_approver to payment_approver, and finance_approver's
-- sc.manage is stripped (kept: sc.read_all, and the ability to RECORD a
-- walk-in claim — 0281's "the commonest way one of these arrives").
--
-- Online (Paystack/Flutterwave) inflows are UNCHANGED: decision 47 built
-- these to post automatically once the gateway verifies server-to-server,
-- with no human approval, and that stays exactly as built. payment_approver's
-- new visibility into that ledger is a NAV FIX (app/dashboard/ledger/layout.tsx),
-- not a database change — they were already in oversight_roles() and already
-- passed every RLS policy on ledger_entries/bank_accounts/reconciliations;
-- the page's own hardcoded role list had simply never caught up, the exact
-- "policy says yes, the page says no" pattern decisions 26/38/47 keep finding.

-- ── 1. The inbound off-platform chain's terminal desk ───────────────────────
--
-- Both functions are read by every consumer downstream (the confirmation
-- trigger, the read policy via may_read_offline_claim, the queue) — decision
-- 8's "one resolver, extended", so this one change re-routes the whole chain
-- correctly rather than needing to be repeated.

create or replace function offline_confirmation_stages()
returns table(stage_order smallint, required_roles user_role[], label text, posts_ledger boolean)
language sql immutable set search_path = public as $function$
  select v.stage_order, v.required_roles, v.label, v.posts_ledger
    from (values
      (1::smallint, array['payment_audit_approver']::user_role[],
       'Audit verification of the evidence'::text, false),
      (2::smallint, array['executive']::user_role[],
       'Executive authorisation'::text, false),
      -- 13 Sept 2026 (board). Was `finance_approver` ("Payment Officer") —
      -- decision 45's own comment named this the board-confirmed choice and
      -- explicitly excluded payment_approver. Reversed on direct instruction:
      -- the Payment Approver is the chief accounting officer who confirms
      -- what arrives; the Officer's job narrows to disbursement.
      (3::smallint, array['payment_approver']::user_role[],
       'Payment Approver confirmation and ledger posting'::text, true)
    ) as v(stage_order, required_roles, label, posts_ledger);
$function$;

create or replace function offline_confirmation_roles()
returns user_role[]
language sql immutable set search_path = public as $function$
  select array['payment_audit_approver', 'executive', 'payment_approver']::user_role[];
$function$;

-- ── 2. sc.manage narrows to property_manager alone ──────────────────────────
--
-- `b7_grants` is the single baseline source `role_permissions` rows are seeded
-- from (0244, rebuilt mechanically since at 0245/0246/0249/0281 — 0183's
-- rule). payment_approver's OWN arm above this already lists 'sc.manage'
-- explicitly (0246: "it holds everything the payment officer holds, and the
-- difference between them is DISBURSEMENT") — that line is untouched, so
-- nothing needs adding there. What changes is the generic sc.manage arm
-- further down, which is the one that has been answering for finance_approver.

create or replace function b7_grants(p_role user_role, p_capability text)
returns boolean
language sql immutable set search_path = public as $function$
  select case
        when p_capability = 'tickets.assign_without_review' then false
        when p_capability = 'training.read' then false
        when p_capability = 'records.export' then false

        when p_role = 'admin' then true

        -- 0281. Placed ABOVE the role-specific arms deliberately: those arms are
        -- closed lists, and a capability added to the bottom of this CASE would
        -- never be reached for `executive`, `regional_manager` or either payment
        -- desk. The three confirmation desks are absent by intent, not omission
        -- — recording a claim disqualifies you from confirming it (0282's
        -- maker-checker), so granting it to a chain role hands them a way to
        -- take themselves out of the chain. `finance_approver` is the deliberate
        -- exception: taking a walk-in payment at the finance desk is the single
        -- commonest way one of these arrives, and the consequence — that a
        -- colleague must confirm it — is the control working, exactly as 0142
        -- says. 13 Sept 2026: unchanged by the board's reversal above — the
        -- Officer still takes the walk-in, the Approver still confirms it, and
        -- a walk-in the Officer takes is confirmed by someone else regardless.
        when p_capability = 'payments.record_offline' then p_role in (
          'facility_manager', 'property_manager', 'regional_manager', 'finance_approver'
        )

        when p_role = 'executive' then p_capability in (
          'tickets.read_all', 'assets.read', 'sc.read_all', 'properties.read_all',
          'vendors.read', 'bi.read', 'tickets.triage_unassigned'
        )

        when p_role = 'payment_audit_approver' then p_capability in (
          'tickets.read_all', 'vendors.read', 'bi.read', 'properties.read_all'
        )

        -- 0246, unchanged by 13 Sept 2026's reversal: the payment approver is
        -- the senior accounting desk and already held sc.manage before this
        -- migration. What moved is who else does.
        when p_role = 'payment_approver' then p_capability in (
          'vendors.read', 'bi.read', 'properties.read_all',
          'assets.read', 'sc.read_all', 'sc.manage'
        )

        when p_role = 'regional_manager' then p_capability in (
          'tickets.assign', 'tickets.close', 'tickets.triage_unassigned',
          'assets.write', 'assets.import',
          'vendors.read', 'vendors.write', 'vendors.evaluate',
          'properties.write', 'units.assign_occupant',
          'people.invite', 'bi.read',
          'applications.recommend', 'applications.approve',
          'hierarchy.write', 'sc.manage', 'leases.write',
          'vendors.recommend', 'vendors.approve'
        )

        when p_capability = 'tickets.read_all' then false

        when p_capability in ('assets.read', 'sc.read_all', 'properties.read_all')
          then p_role = 'finance_approver'

        when p_capability in ('tickets.assign', 'tickets.close',
                         'assets.write', 'assets.import',
                         'vendors.write', 'vendors.evaluate',
                         'properties.write', 'units.assign_occupant',
                         'people.invite', 'hierarchy.write',
                         'vendors.recommend',
                         'applications.recommend')
          then p_role in ('facility_manager', 'property_manager')

        when p_capability = 'vendors.read'
          then p_role in ('facility_manager', 'property_manager', 'finance_approver')

        -- 13 Sept 2026 (board). Was `p_role in ('finance_approver',
        -- 'property_manager')` since 0249. The Payment Officer's role narrows
        -- to disbursement; administering the service-charge budget and its
        -- apportionment is not part of "dispensing outward payments" and moves
        -- fully to the Approver, who already held it via the closed-list arm
        -- above. property_manager's own grant (0249) is untouched — every
        -- write it unlocks is still bounded to a property they hold.
        when p_capability = 'sc.manage'
          then p_role = 'property_manager'

        when p_capability = 'leases.write'
          then p_role = 'property_manager'

        when p_capability = 'bi.read'
          then p_role in ('facility_manager', 'property_manager',
                     'finance_approver', 'property_owner')
        when p_capability = 'people.deactivate' then false
        when p_capability = 'tickets.triage_unassigned' then false

        else false
  end;
$function$;

-- ── Grants, restated explicitly ─────────────────────────────────────────────
--
-- `create or replace function` re-applies Supabase's default privileges
-- (0204/0209/0210/0264/0281's repeated lesson) — measured before writing this:
-- all three functions carried exactly `authenticated` and `service_role`
-- EXECUTE, no `anon`, no `PUBLIC`. Restated rather than trusted to survive
-- the replace unchanged.

revoke all on function offline_confirmation_stages() from public, anon;
grant execute on function offline_confirmation_stages() to authenticated, service_role;

revoke all on function offline_confirmation_roles() from public, anon;
grant execute on function offline_confirmation_roles() to authenticated, service_role;

revoke all on function b7_grants(user_role, text) from public, anon;
grant execute on function b7_grants(user_role, text) to authenticated, service_role;

-- ── 3. Existing organisations get the new baseline, not just new ones ───────
--
-- `has_permission()` reads ONLY the materialised `role_permissions` table
-- (never `b7_grants()` live) — decision 7's per-org matrix is a real table a
-- deviating operator can edit, not a formula recomputed on every read. So the
-- seed function above governs future orgs and backfills; existing rows need
-- their own update. `set_by is null` is the guard: every finance_approver +
-- sc.manage row checked before writing this migration carried `set_by = null`
-- (baseline-derived, never a recorded operator deviation) — an operator who
-- had explicitly re-granted it for their own organisation keeps that choice,
-- exactly as decision 7's "badged, one-click-revocable deviation" model
-- requires. Nothing here touches payment_approver's row: it was already true.

update role_permissions
   set granted = false
 where role = 'finance_approver'
   and capability = 'sc.manage'
   and granted = true
   and set_by is null;

-- ── The suite that must catch a regression here ─────────────────────────────
do $$
declare
  v_stage3_roles user_role[];
  v_stray_grants int;
begin
  select required_roles into v_stage3_roles
    from offline_confirmation_stages() where stage_order = 3;
  if v_stage3_roles is distinct from array['payment_approver']::user_role[] then
    raise exception '0293 assertion failed: offline confirmation stage 3 is % — must be {payment_approver}', v_stage3_roles;
  end if;

  if not (b7_grants('payment_approver', 'sc.manage')) then
    raise exception '0293 assertion failed: payment_approver must still be granted sc.manage';
  end if;
  if b7_grants('finance_approver', 'sc.manage') then
    raise exception '0293 assertion failed: finance_approver must no longer be granted sc.manage';
  end if;
  if not (b7_grants('property_manager', 'sc.manage')) then
    raise exception '0293 assertion failed: property_manager must keep sc.manage (0249, untouched)';
  end if;
  if not (b7_grants('finance_approver', 'payments.record_offline')) then
    raise exception '0293 assertion failed: finance_approver must still be able to record a walk-in claim';
  end if;

  select count(*) into v_stray_grants
    from role_permissions
   where role = 'finance_approver' and capability = 'sc.manage'
     and granted = true and set_by is null;
  if v_stray_grants > 0 then
    raise exception '0293 assertion failed: % baseline finance_approver sc.manage row(s) still granted', v_stray_grants;
  end if;
end $$;
