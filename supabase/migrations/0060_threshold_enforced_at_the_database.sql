-- S-1 (baseline audit) — the approval threshold was the ONE gate condition the
-- database did not back.
--
-- Every other stage of the B4 gate is re-checked here and therefore holds
-- against a direct PostgREST call. `enforce_payment_transition()` (0010)
-- restricted `recommended → approved` to finance/admin — but never compared the
-- amount against `payment_settings.approval_threshold_amount`. The "above the
-- limit requires an administrator" rule lived only in `approvePayment()`.
--
-- Confirmed exploitable before this fix: a finance_approver PATCHed a payment of
-- ₦5,000,000 — five times the org's ₦1,000,000 threshold — straight to
-- `approved` with their own JWT, then could remit it themselves. That is the
-- segregation-of-duties control on the LARGEST disbursements, defeated by one
-- hand-crafted call.
--
-- Workplan security call S2 asked for this to be "an enforced control rather
-- than display-only". Half of it shipped in the app; this is the other half.
--
-- Null threshold means "not configured", which must not read as "no limit" — an
-- unconfigured org falls back to the same ₦1,000,000 the application assumes,
-- so the two layers cannot disagree about what is unlimited.

create or replace function enforce_payment_transition()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  caller_role user_role := current_user_role();
  v_threshold numeric;
begin
  -- Trusted system/seed writes (service role) are exempt.
  if auth.uid() is null then
    return new;
  end if;

  -- No status change → allow (other column edits are governed by RLS).
  if new.status is not distinct from old.status then
    return new;
  end if;

  -- Legal transitions only.
  if not (
    (old.status = 'pending_verification' and new.status in ('verified','rejected'))
    or (old.status = 'verified'          and new.status in ('recommended','rejected'))
    or (old.status = 'recommended'       and new.status in ('approved','rejected'))
    or (old.status = 'approved'          and new.status = 'remitted')
  ) then
    raise exception 'illegal payment transition: % -> %', old.status, new.status;
  end if;

  -- Gate conditions for each forward step.
  if new.status = 'recommended' and (new.service_verified_at is null or new.performance_validated is not true) then
    raise exception 'cannot recommend: verification + performance gate not satisfied';
  end if;

  if new.status = 'approved' then
    if new.service_verified_at is null or new.performance_validated is not true then
      raise exception 'cannot approve: gate not satisfied';
    end if;
    if caller_role not in ('finance_approver','admin') then
      raise exception 'only finance/admin may approve payments';
    end if;

    -- The threshold escalation, now enforced here as well as in the action.
    select approval_threshold_amount into v_threshold
      from payment_settings where org_id = new.org_id;
    v_threshold := coalesce(v_threshold, 1000000);

    if new.amount > v_threshold and caller_role <> 'admin' then
      raise exception
        'approvals above % require an administrator (this payment is %)',
        v_threshold, new.amount;
    end if;
  end if;

  if new.status = 'remitted' then
    if new.approved_at is null then
      raise exception 'cannot remit: payment not approved';
    end if;
    if caller_role not in ('finance_approver','admin') then
      raise exception 'only finance/admin may remit payments';
    end if;
  end if;

  return new;
end;
$$;

comment on function enforce_payment_transition() is
  'The B4 gate, enforced in the database so it holds against a direct API call — including the amount threshold, which until 0060 lived only in the server action.';
