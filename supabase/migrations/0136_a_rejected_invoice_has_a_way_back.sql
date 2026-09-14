-- A rejection needs a reason, and a wrong rejection needs a way back.
--
-- ⚠️ Today `rejected` is a dead end reached silently. Three things are wrong
-- with that, and the third is the one a vendor feels:
--
--   1. **No reason is recorded anywhere.** `payments` has no rejection column,
--      so an invoice can be refused and nothing says why. The screen shows
--      "Blocked — vendor failed the performance gate", which is the ONLY
--      rejection the product can currently produce.
--   2. **Nobody is told.** Approval notifies the vendor via the B8 cascade;
--      rejection notifies no one. The invoice simply stops.
--   3. **`rejected` is terminal.** `enforce_payment_transition` lists no
--      transition out of it, so an invoice rejected in error — a mis-click, a
--      performance score that was wrong because an evaluation had not landed
--      yet — can never be corrected. The money is owed and the record says no.
--
-- 📌 The appeal is not a new subsystem. Standard practice on a refused invoice
-- is to correct and re-issue it, and that already works: both
-- `submit_vendor_invoice` (0118) and `payments_work_order_valid` (0128) treat a
-- rejected invoice as not blocking a fresh one. Nothing told the vendor that,
-- which is the actual defect. So this migration records WHY, tells the vendor,
-- and adds the one thing resubmission cannot cover: reversing a rejection that
-- should never have happened.

alter table payments add column if not exists rejected_reason text;
alter table payments add column if not exists rejected_by uuid references users(id);
alter table payments add column if not exists rejected_at timestamptz;
alter table payments add column if not exists reopened_at timestamptz;

comment on column payments.rejected_reason is
  'Why this invoice was refused, in words the vendor reads. Required by reject_payment -- an unexplained rejection cannot be appealed or corrected, which makes it a dead end rather than a decision.';

-- ── The state machine gains exactly one edge ──────────────────────────────
--
-- ⚠️ Rewritten from the LIVE definition (`pg_proc.prosrc`), not from a
-- migration file. 0092's file still contains a `processing` enum value that
-- does not exist and was replaced by 0092c; anyone rebuilding a function from
-- the file reintroduces the bug. Everything below is the live text plus the
-- `rejected -> pending_verification` edge and its guard.
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
    -- The appeal. Back to the START of the gate, never to the middle of it:
    -- reopening restores the claim, it does not restore the verification or the
    -- performance pass that were made about it. Both must be earned again.
    or (old.status = 'rejected'          and new.status = 'pending_verification')
  ) then
    raise exception 'illegal payment transition: % -> %', old.status, new.status;
  end if;

  -- Reopening is a correction of someone else's refusal, so it sits with the
  -- people who answer for the money -- not with the FM whose performance gate
  -- may have produced the rejection in the first place.
  if old.status = 'rejected' and new.status = 'pending_verification' then
    if caller_role not in ('finance_approver','admin') then
      raise exception 'only finance or an administrator may reopen a rejected invoice';
    end if;
    if new.service_verified_at is not null or new.performance_validated is true then
      raise exception 'a reopened invoice starts the gate again -- clear the verification and performance flags';
    end if;
  end if;

  -- A rejection must say why. Enforced here rather than only in the function
  -- below, so a direct UPDATE cannot produce a silent dead end either.
  if new.status = 'rejected'
     and length(trim(coalesce(new.rejected_reason, ''))) < 10 then
    raise exception 'a rejection needs a reason of at least 10 characters';
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

comment on function enforce_payment_transition is
  'The B4 gate. Legal transitions, the verification/performance conditions, who may approve (incl. the decision-9 threshold escalation to admin/executive) and who may remit (never an executive). Since 0136 a rejection must carry a reason, and finance or an administrator may reopen one back to pending_verification -- to the START of the gate, so the verification and performance pass have to be earned again rather than inherited.';

-- ── Refusing, with a reason the vendor reads ──────────────────────────────
--
-- SECURITY INVOKER, so `payments_update` still decides who may refuse which
-- invoice: an FM/PM or regional manager scoped to that vendor, or
-- finance/admin/executive. This adds the reason and the notification, not the
-- permission.
create or replace function reject_payment(p_id uuid, p_reason text)
returns void language plpgsql set search_path = public as $$
declare
  v payments%rowtype;
  v_vendor_user uuid;
  v_n integer;
begin
  if length(trim(coalesce(p_reason, ''))) < 10 then
    raise exception 'tell the vendor why in at least 10 characters -- they have to act on this';
  end if;

  select * into v from payments where id = p_id;
  if v.id is null then
    raise exception 'that invoice could not be found';
  end if;

  update payments
     set status = 'rejected',
         rejected_reason = trim(p_reason),
         rejected_by = auth.uid(),
         rejected_at = now()
   where id = p_id
     and status in ('pending_verification', 'verified', 'recommended');
  get diagnostics v_n = row_count;

  if v_n = 0 then
    raise exception 'that invoice is at % and cannot be rejected from there', v.status;
  end if;

  -- Tell them. An approval notifies the vendor; a refusal that does not is how
  -- an invoice goes quiet and a contractor chases it by phone.
  select user_id into v_vendor_user from vendors where id = v.vendor_id;
  if v_vendor_user is not null then
    perform notify_user(
      v_vendor_user, 'payment',
      'Invoice ' || coalesce(v.invoice_reference, left(replace(v.id::text,'-',''), 8)) || ' was not approved',
      trim(p_reason) || ' — you can correct it and submit again from My Work.',
      '/dashboard/my-work', 'payment', v.id
    );
  end if;
end;
$$;

revoke all on function reject_payment(uuid, text) from public;
revoke execute on function reject_payment(uuid, text) from anon;
grant execute on function reject_payment(uuid, text) to authenticated;

comment on function reject_payment is
  'Refuses an invoice with a stated reason and tells the vendor. SECURITY INVOKER, so payments_update decides WHO may refuse -- this adds the reason and the notification, never the permission.';

-- ── The appeal outcome ────────────────────────────────────────────────────
create or replace function reopen_payment(p_id uuid, p_reason text)
returns void language plpgsql set search_path = public as $$
declare
  v payments%rowtype;
  v_vendor_user uuid;
  v_n integer;
begin
  if length(trim(coalesce(p_reason, ''))) < 10 then
    raise exception 'record why this rejection is being reversed, in at least 10 characters';
  end if;

  select * into v from payments where id = p_id;
  if v.id is null then
    raise exception 'that invoice could not be found';
  end if;

  -- Back to the beginning of the gate, with the flags cleared. A reopened
  -- invoice that kept its old `service_verified_at` would walk straight to
  -- approval carrying a verification made before the reason for refusal was
  -- known.
  update payments
     set status = 'pending_verification',
         service_verified_at = null,
         service_verified_by = null,
         performance_validated = false,
         reopened_at = now(),
         rejected_reason = 'Reopened: ' || trim(p_reason)
                           || coalesce(' (was: ' || v.rejected_reason || ')', '')
   where id = p_id and status = 'rejected';
  get diagnostics v_n = row_count;

  if v_n = 0 then
    raise exception 'only a rejected invoice can be reopened (this one is %)', v.status;
  end if;

  select user_id into v_vendor_user from vendors where id = v.vendor_id;
  if v_vendor_user is not null then
    perform notify_user(
      v_vendor_user, 'payment',
      'Invoice ' || coalesce(v.invoice_reference, left(replace(v.id::text,'-',''), 8)) || ' has been reopened',
      trim(p_reason) || ' — it is back with the team for service verification.',
      '/dashboard/my-work', 'payment', v.id
    );
  end if;
end;
$$;

revoke all on function reopen_payment(uuid, text) from public;
revoke execute on function reopen_payment(uuid, text) from anon;
grant execute on function reopen_payment(uuid, text) to authenticated;

comment on function reopen_payment is
  'Reverses a rejection that should not have happened, back to pending_verification with the verification and performance flags CLEARED -- the gate is walked again rather than inherited. Finance or an administrator only, enforced in enforce_payment_transition, because reopening corrects a refusal the FM''s own performance gate may have produced. The vendor is told.';
