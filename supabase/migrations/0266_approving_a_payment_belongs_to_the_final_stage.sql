-- Approving a payment belongs to the desk that holds the final stage
-- (7 Sept 2026).
--
-- Found by `verify-fm-journey` against live OEA data: a PROPERTY MANAGER ran
--
--     update payments set status = 'approved', approved_by = <themselves>
--
-- and it succeeded. One organisation of four, because in the other three the
-- FM/PM's vendor scope did not happen to reach a payment sitting at
-- `recommended` with a cleared chain — which is to say the other three passed
-- by accident of data, not by rule.
--
-- ── Why it was open ───────────────────────────────────────────────────────
--
-- `payments_update` (0078a) admits `fm_roles()` for vendors in their own scope,
-- and it has to: setting `service_verified_at` is the operational half of the
-- B4 gate and belongs to exactly that desk. The status column travels on the
-- same policy, so the only thing standing between an FM and `approved` is this
-- trigger — and every other consequential transition here names its role while
-- this one named none:
--
--     rejected -> pending_verification   'only the payment officer or an administrator may reopen'
--     approved -> remitted               'only the payment officer may remit payments'
--     recommended -> approved            (the chain must be cleared, and nothing about who)
--
-- `is_cleared_for_disbursement` answers "have three desks signed this", which is
-- a fact about the PAYMENT. It was being read as though it also answered "may
-- you be the one to say so", which is a fact about the CALLER. Once the chain
-- was complete, whoever held UPDATE on the row could flip it and write
-- themselves into `approved_by`.
--
-- ⚠️ No money moves on this by itself — `assert_may_disburse` (0142) and the
-- `remitted` branch below both still admit only the payment officer, and
-- decision 16's "the approver may never also release it" is untouched. What it
-- forges is the RECORD of who authorised, on the one field an auditor reads to
-- answer that question. Decision 34 has just finished putting every approval
-- decision into the audit trail; a stamp anyone in reach can write is not worth
-- recording.
--
-- ── The rule, asked rather than restated ──────────────────────────────────
--
-- The desk that may mark a payment approved is the desk that holds the FINAL
-- stage of that organisation's own ladder — read from `payment_chain_stages`,
-- which decision 28 made per-org. Written as a lookup and not as a role list
-- because a literal here would be a second copy of the ladder, free to disagree
-- with it the next time a shape is added. On today's shapes it resolves to:
--
--     standard       payment_approver, executive
--     oea            payment_approver                     (decision 23)
--     single_stage   payment_approver, executive          (decision 28)
--
-- and to neither `admin` (decision 23 took the administrator out of money
-- approval entirely) nor `finance_approver`, who releases rather than approves.
-- Both legitimate write paths satisfy it by construction: `approve_payments` ->
-- `record_payment_approval` -> `apply_chain_outcome_to_payment` runs with the
-- final-stage approver as the caller, and `approvePayment` is already gated on
-- `my_approval_limit()`, which reads the same tiers.
--
-- ⚠️ `caller_role is null` is tested FIRST, deliberately. A deactivated caller
-- resolves to NULL, `null = any(array)` is NULL, and `if not NULL` never fires
-- — the exact null-tripping shape `verify-deactivation` section E was written
-- to catch, and the reason this is two conditions rather than one.
--
-- ── And the stamp is taken rather than accepted ───────────────────────────
--
-- This is a BEFORE trigger, so `approved_by` is assigned instead of merely
-- checked. On both legitimate paths the value is already `auth.uid()` (the
-- chain writes `actor_id`, which `record_payment_approval` sets from
-- `auth.uid()`), so nothing changes for them; what it removes is the ability to
-- name somebody else as the approver. 0142's lesson about `remittances.
-- created_by` — "the one action that moves real money had been the one action
-- with no attributable actor" — one column over.
--
-- ── And the same column, reached the other way ───────────────────────────
--
-- 📌 Proving the fix found a second door into the same field. The trigger
-- returns early when the status does not move — correctly, there is no
-- transition to police — and that return handed back a row whose `approved_by`
-- was still writable. So on a payment ALREADY at `approved`, this succeeds and
-- the block below never runs:
--
--     update payments set approved_by = <me> where id = <already approved>
--
-- Nothing about the money changes and everything about the record does. The
-- early return now carries the stamp forward from OLD, `coalesce`d so a null on
-- an older row can still be filled in: what is closed is overwriting an
-- attribution, never recording one.
--
-- The shape is this repo's most familiar: a rule written for the case in front
-- of the author, correct for that case, silently absent from the second way in
-- — decision 24's own summary of itself.
--
-- Body rebuilt from `pg_get_functiondef` (0183), not retyped from 0250b. Two
-- blocks are inserted and two assignments added; nothing else moves.

create or replace function enforce_payment_transition()
returns trigger
language plpgsql security definer set search_path = public as $function$
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

comment on function enforce_payment_transition is
  'The legal status moves on a payment, and who may make each one. 0266 added the missing half of recommended -> approved: the chain being cleared is a fact about the payment, not a licence for whoever holds UPDATE on the row — an FM/PM reaches that column legitimately for service verification (0078a) and was reaching the status with it. The permitted desk is read from payment_chain_stages(org) rather than listed, so a new chain shape cannot leave a stale role list behind.';

-- ⚠️ `create or replace` re-applies Supabase's default grants — the fault 0264
-- recorded for the fourth time, and `authenticated` is the half the anon-shaped
-- reflex misses.
revoke all on function enforce_payment_transition() from public, anon;
grant execute on function enforce_payment_transition() to authenticated, service_role;

-- ── The rule, asserted rather than described ──────────────────────────────
--
-- Not "the FM is refused" (an instance) but "no operational role appears in any
-- final stage on any live organisation" (the class) — 0185's lesson, which is
-- what a migration written against the diff would have missed.
do $$
declare
  v_bad text;
begin
  select string_agg(distinct o.slug || ' → ' || r::text, ', ')
    into v_bad
    from orgs o
    cross join lateral (
      select s.required_roles
        from payment_chain_stages(o.id) s
       order by s.stage_order desc
       limit 1
    ) f
    cross join lateral unnest(f.required_roles) r
   where o.deleted_at is null
     and (r = any (fm_roles())
          or r in ('admin', 'regional_manager', 'fm_ops_staff', 'tenant', 'vendor', 'viewer'));

  if v_bad is not null then
    raise exception
      'an operational or administrative role holds a final approval stage, which decisions 16 and 23 forbid: %',
      v_bad;
  end if;
end $$;
