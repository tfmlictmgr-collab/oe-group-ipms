-- Verifying an invoice is a switch (requested 3 Oct 2026).
--
-- The first two steps of the vendor-invoice payment gate — "Service verified"
-- and "Run performance check" — were open to whoever `payments_update` (0078a)
-- admits: administrators, the payment officer, the Managing Partner, and the
-- FM/PM/regional/Executive desks on vendors in their scope. The operator could
-- not turn it off for a role. It becomes `payments.verify_service`, group
-- "Invoices", enforced in `enforce_payment_transition` on the two forward
-- moves (pending_verification → verified, verified → recommended).
--
-- Baseline: every role the invoice screen offered the buttons to — admin,
-- facility/property/regional manager, Executive, payment officer. The one
-- narrowing: `executive` (the MP on OEA) could make these moves only by calling
-- the API directly, never from the screen, and does not get the switch at
-- baseline; the operator can grant it. Rejecting, reopening, approval and
-- release are unchanged.
--
-- Rebuilt from pg_get_functiondef of a database holding 0001–0311.

set local lock_timeout = '5s';

insert into capabilities (key, module, label, description, locked, sort_order) values
  ('payments.verify_service', 'Invoices', 'Verify vendor invoices',
   'Confirm on a vendor invoice that the work was done, then run the performance check against the vendor''s scores — the first two steps before an invoice enters the approval chain. Does not approve or send money.',
   false, 78)
on conflict (key) do nothing;

CREATE OR REPLACE FUNCTION public.b7_grants(p_role user_role, p_capability text)
 RETURNS boolean
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
  select case
        when p_capability = 'tickets.assign_without_review' then false
        when p_capability = 'training.read' then false
        when p_capability = 'records.export' then false

        -- 0310. The Executive's own powers, as switches. Placed above the admin
        -- arm so an administrator is not shown holding two Executive-only
        -- powers that mean nothing for their role.
        when p_capability = 'requisitions.approve_within_limit' then p_role = 'operations_executive'
        when p_capability = 'operations.org_wide' then p_role = 'operations_executive'
        when p_capability = 'requisitions.raise' then p_role in (
          'fm_ops_staff', 'facility_manager', 'property_manager', 'regional_manager',
          'operations_executive', 'admin'
        )

        -- 0311. Raising planned work, split out of tickets.assign (dispatching a
        -- reported request) so the operator can switch one without the other.
        -- Baseline is exactly who held tickets.assign.
        when p_capability = 'workorders.raise' then p_role in (
          'facility_manager', 'property_manager', 'regional_manager',
          'operations_executive', 'admin'
        )

        -- 0312. Verifying the service on a vendor invoice and running its
        -- performance check — the first two steps of the payment gate. Baseline
        -- is every role the invoice screen offered those buttons to.
        when p_capability = 'payments.verify_service' then p_role in (
          'facility_manager', 'property_manager', 'regional_manager',
          'operations_executive', 'finance_approver', 'admin'
        )

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
          'facility_manager', 'property_manager', 'regional_manager', 'finance_approver',
          'operations_executive'
        )

        -- 0307. The OEA Executive: org-wide sight of operations, dispatch and
        -- closure, and onboarding. Nothing financial beyond the requisitions
        -- the chain hands them (which is not a capability — decision 7), no
        -- structure (hierarchy, properties, leases), no vendor decisions, no
        -- export. Placed after `payments.record_offline`, which they do not
        -- hold: recording a claim is a confirmation desk's conflict.
        -- 0309: everything a facilities/properties/regional manager holds,
        -- organisation-wide, plus the org-wide reads 0307 gave. Bounded by
        -- `current_user_property_ids()`, which for the Executive is every
        -- property in their organisation.
        when p_role = 'operations_executive' then p_capability in (
          'tickets.read_all', 'tickets.triage_unassigned',
          'tickets.assign', 'tickets.close',
          'properties.read_all', 'assets.read', 'vendors.read',
          'bi.read', 'people.invite',
          'assets.write', 'assets.import',
          'vendors.write', 'vendors.evaluate', 'vendors.recommend', 'vendors.approve',
          'properties.write', 'units.assign_occupant', 'hierarchy.write',
          'applications.recommend', 'applications.approve',
          'sc.manage', 'leases.write'
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

do $$
declare o record;
begin
  for o in select id from orgs loop
    perform seed_b7_permissions(o.id);
  end loop;
end $$;

CREATE OR REPLACE FUNCTION public.enforce_payment_transition()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  caller_role user_role := current_user_role();
  v_final_roles user_role[];
begin
  if auth.uid() is null then
    return new;
  end if;

  -- ⚠️ 0266. The early return is right — an update that does not move the
  -- status has no transition to police — but it was returning with the
  -- APPROVAL STAMP still writable. `update payments set approved_by = <me>` on
  -- a payment that is already approved changes nothing this trigger examines
  -- and everything an auditor reads, and `payments_update` (0078a) puts that
  -- statement within reach of the FM/PM who verified the work.
  --
  -- Found by pointing `verify-fm-journey`'s "an FM cannot approve" check at a
  -- payment that was ALREADY approved: the gate below never ran, because there
  -- was no transition to gate. Preserved rather than refused, and `coalesce`d
  -- so a null stamp on an older row can still be filled in — what is closed is
  -- OVERWRITING an attribution, not recording one.
  if new.status is not distinct from old.status then
    new.approved_by := coalesce(old.approved_by, new.approved_by);
    new.approved_at := coalesce(old.approved_at, new.approved_at);
    return new;
  end if;

  if not (
    (old.status = 'pending_verification' and new.status in ('verified','rejected'))
    or (old.status = 'verified'          and new.status in ('recommended','rejected'))
    or (old.status = 'recommended'       and new.status in ('approved','rejected','returned_for_correction'))
    or (old.status = 'approved'          and new.status = 'remitted')
    or (old.status = 'rejected'          and new.status = 'pending_verification')
    or (old.status = 'returned_for_correction' and new.status in ('recommended','rejected'))
  ) then
    raise exception 'illegal payment transition: % -> %', old.status, new.status;
  end if;

  -- 0312. The two forward steps of the gate — service verified, performance
  -- passed — are a switch in the permission matrix. Refusals and reopening
  -- are governed below, as before.
  if ((old.status = 'pending_verification' and new.status = 'verified')
      or (old.status = 'verified' and new.status = 'recommended'))
     and not has_permission('payments.verify_service') then
    raise exception 'verifying invoices is switched off for your role in this organisation';
  end if;

  if old.status = 'rejected' and new.status = 'pending_verification' then
    if caller_role not in ('finance_approver','admin') then
      raise exception 'only the payment officer or an administrator may reopen a rejected invoice';
    end if;
    if new.service_verified_at is not null or new.performance_validated is true then
      raise exception 'a reopened invoice starts the gate again -- clear the verification and performance flags';
    end if;
  end if;

  -- ⚠️ Deliberately NOT the reopen rule. A reopen restarts the B4 gate and so
  -- is finance's to authorise; a resubmission after a return keeps the gate
  -- satisfied and merely re-enters the chain at the rung it was sent back to.
  -- Gating it on finance would put the payment officer in the middle of a
  -- correction between two other desks.
  if old.status = 'returned_for_correction' and new.status = 'recommended' then
    if new.service_verified_at is null or new.performance_validated is not true then
      raise exception 'a resubmitted invoice must still satisfy the verification and performance gate';
    end if;
  end if;

  if new.status = 'rejected'
     and length(trim(coalesce(new.rejected_reason, ''))) < 10 then
    raise exception 'a rejection needs a reason of at least 10 characters';
  end if;

  if new.status = 'recommended' and (new.service_verified_at is null or new.performance_validated is not true) then
    raise exception 'cannot recommend: verification + performance gate not satisfied';
  end if;

  if new.status = 'approved' then
    if new.service_verified_at is null or new.performance_validated is not true then
      raise exception 'cannot approve: gate not satisfied';
    end if;

    if not is_cleared_for_disbursement('vendor_payment', new.id, new.amount) then
      raise exception
        'this payment has not completed its approval chain at ₦% — it cannot be marked approved',
        trim(to_char(new.amount, 'FM999,999,999,990.00'));
    end if;

    -- 0266. Who may say so, asked of this organisation's own ladder.
    select s.required_roles into v_final_roles
      from payment_chain_stages(new.org_id) s
     order by s.stage_order desc
     limit 1;

    if caller_role is null or not (caller_role = any (v_final_roles)) then
      raise exception
        'only the desk holding the final approval stage may mark a payment approved — % may, % may not',
        array_to_string(v_final_roles::text[], ' or '),
        coalesce(caller_role::text, 'an account with no role');
    end if;

    -- The approver is the caller, not whoever the caller names. A no-op on both
    -- legitimate paths, which already pass their own id.
    new.approved_by := auth.uid();
  end if;

  if new.status = 'remitted' then
    if new.approved_at is null then
      raise exception 'cannot remit: payment not approved';
    end if;
    if caller_role <> 'finance_approver' then
      raise exception 'only the payment officer may remit payments — oversight authorises, the payment officer disburses';
    end if;
  end if;

  return new;
end;
$function$;

do $$
begin
  if position('payments.verify_service' in pg_get_functiondef('enforce_payment_transition'::regproc)) = 0 then
    raise exception '0312: enforce_payment_transition must check payments.verify_service';
  end if;
  if exists (select 1 from orgs o where not exists (
       select 1 from role_permissions rp
        where rp.org_id = o.id and rp.role = 'facility_manager'
          and rp.capability = 'payments.verify_service' and rp.granted)) then
    raise exception '0312: every organisation''s facilities managers keep invoice verification at baseline';
  end if;
end $$;
