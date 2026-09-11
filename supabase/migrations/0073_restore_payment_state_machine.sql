-- I broke the payment gate while adding `executive` to it.
--
-- 0072b rewrote `enforce_payment_transition()` having read only the middle of it.
-- The three blocks above what I had looked at went missing:
--
--   1. the service-role exemption (`auth.uid() is null`) — seeds and verification
--      scripts write payments directly and are trusted
--   2. the no-status-change short circuit — other column edits are RLS's business,
--      not the gate's
--   3. **the legal-transition state machine** — the list of which status may
--      follow which
--
-- The third is the one that mattered. Without it, a caller could forge
-- `service_verified_at` and `performance_validated` and jump straight from
-- `pending_verification` to `approved` in a single statement, skipping
-- verification and recommendation entirely. `verify-payment-gate` caught it on the
-- next run: "finance: forge both gate flags + approve → ALLOWED".
--
-- ⚠️ This is the same mistake the journal already records about `block_hard_delete`,
-- made from the other direction. That time I redefined a shared function and
-- changed behaviour for callers I had not considered. This time I redefined a
-- function from a PARTIAL READ of it and silently dropped rules I had not seen.
-- **`create or replace` on a function is a full rewrite: whatever you do not
-- restate, you delete.** Read the whole definition — from the catalogue, not from
-- the migration that happened to introduce the part you were looking for.
--
-- Restored in full, with the board's 29 July change layered on rather than
-- substituted for it.

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

  -- Legal transitions only. This is what stops a forged jump past the gates.
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
    -- Board, 29 July 2026: the MD of TFML and the Managing Partner of OEA
    -- co-hold approval.
    if caller_role not in ('finance_approver','admin','executive') then
      raise exception 'only finance, an administrator or an executive may approve payments';
    end if;

    select approval_threshold_amount into v_threshold
      from payment_settings where org_id = new.org_id;
    v_threshold := coalesce(v_threshold, 1000000);

    -- Above the threshold the approval must come from the top of the house. An
    -- executive counts: the escalation exists so a large payment reaches a
    -- principal, and the MD / Managing Partner is exactly who it was meant for.
    if new.amount > v_threshold and caller_role not in ('admin','executive') then
      raise exception
        'approvals above % require an administrator or an executive (this payment is %)',
        v_threshold, new.amount;
    end if;
  end if;

  if new.status = 'remitted' then
    if new.approved_at is null then
      raise exception 'cannot remit: payment not approved';
    end if;
    -- `executive` is absent BY DECISION. Oversight authorises; finance disburses.
    -- Whoever approves the money must not also be the one who moves it.
    if caller_role not in ('finance_approver','admin') then
      raise exception 'only finance or an administrator may remit payments';
    end if;
  end if;

  return new;
end;
$$;

comment on function enforce_payment_transition() is
  'The B4 gate, in the database so it holds against a direct API call: legal transitions, the verification/performance gates, and the amount threshold. Approval: finance, admin or executive, above-threshold reserved to admin/executive. Remittance: finance or admin ONLY — an executive may authorise a payment and may never execute it (board, 29 Jul 2026).';
