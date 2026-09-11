-- Who released this money, and are they allowed to be the one releasing it?
--
-- Neither question could be answered. Two defects, both verified on live rows
-- before this was written:
--
--   1. NO RECORD OF THE EXECUTOR. `remittances.created_by` was NULL on every
--      row, and `audit_log.actor_id` NULL on every `remittance.write`. Cause:
--      both create_*_remittance functions stamp `auth.uid()`, and both are
--      called by their server action through the SERVICE-ROLE client — where
--      `auth.uid()` is null by definition. So the one action that moves real
--      money was the one action with no attributable actor. (Proof it is the
--      service-role call and not something broader: `payment.created` rows
--      written by a vendor's own authenticated session DID carry actor_id.)
--
--   2. ONE PERSON COULD APPROVE AND THEN DISBURSE. create_vendor_remittance
--      checked verification, the KPI gate, approval, status and recipient —
--      and never that the executor differs from the approver. An admin holding
--      both rights could approve a payment and send it alone.
--
-- ⚠️ Decision 9 already stated the principle — "*Oversight authorises; finance
-- disburses* — approving against a limit you can lift yourself is not an
-- approval" — but only ever enforced it against `executive`. The same critique
-- lands harder on `admin`, who can raise the threshold, approve above it, and
-- execute. Board direction (8 Aug 2026): the admin approves within their
-- threshold, the EXECUTIVE approves above it, and the FINANCE APPROVER — and
-- only the finance approver — disburses.
--
-- Both rules live here rather than in the server action because decision 7
-- names remittance execution a NON-DELEGABLE control: "these are what an
-- auditor checks; they are not preferences." A rule enforced only in
-- TypeScript is a rule the next call site can forget.
--
-- ⚠️ `p_executed_by` is REQUIRED — no default. A defaulted parameter would let
-- a call site that forgets it silently write NULL again, which is the exact
-- defect being closed. And per the 0141 lesson, a changed parameter list needs
-- DROP FUNCTION first: `create or replace` would leave a second overload
-- standing and make every existing call ambiguous.

-- ── The disburser test, in one place ──────────────────────────────────────
create or replace function assert_may_disburse(p_executed_by uuid, p_org_id uuid)
returns users language plpgsql stable security definer set search_path = public as $$
declare v_exec users%rowtype;
begin
  if p_executed_by is null then
    raise exception 'the person sending this payment was not identified';
  end if;

  select * into v_exec from users where id = p_executed_by;
  if v_exec.id is null then
    raise exception 'the person sending this payment could not be found';
  end if;
  if v_exec.deactivated_at is not null then
    raise exception 'that account is deactivated and cannot send payments';
  end if;
  if v_exec.org_id is distinct from p_org_id then
    raise exception 'a payment can only be sent by someone in the organisation it belongs to';
  end if;

  -- Finance, and finance alone. An administrator configures the approval
  -- threshold and approves beneath it; an executive approves above it. Neither
  -- releases the funds.
  if v_exec.role <> 'finance_approver' then
    raise exception 'only a finance approver may send a payment — oversight authorises, finance disburses';
  end if;

  return v_exec;
end;
$$;

revoke all on function assert_may_disburse(uuid, uuid) from public, anon, authenticated;
grant execute on function assert_may_disburse(uuid, uuid) to service_role;

comment on function assert_may_disburse is
  'The disburser test shared by every remittance path: the executor must exist, be active, belong to the paying organisation, and hold finance_approver. Raises with a sentence written for the person reading it. One definition, so the two payout paths cannot drift apart (0142).';

-- ── Vendor payments ───────────────────────────────────────────────────────
drop function if exists create_vendor_remittance(uuid, text);

create function create_vendor_remittance(
  p_payment_id uuid,
  p_reference text,
  p_executed_by uuid
)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  pay payments%rowtype;
  v_recipient uuid;
  v_id uuid;
begin
  select * into pay from payments where id = p_payment_id for update;
  if pay.id is null then
    raise exception 'payment not found';
  end if;

  if pay.service_verified_at is null then
    raise exception 'the service on this payment has not been verified';
  end if;
  if not pay.performance_validated then
    raise exception 'the vendor did not pass the performance check';
  end if;
  if pay.approved_at is null or pay.approved_by is null then
    raise exception 'this payment has not been approved';
  end if;
  if pay.status <> 'approved' then
    raise exception 'a payment at status % cannot be remitted', pay.status;
  end if;

  perform assert_may_disburse(p_executed_by, pay.org_id);

  -- ⚠️ Maker-checker, the control that actually prevents one person paying
  -- themselves out. The same shape as two-tier application review (0082),
  -- where the recommender may not also decide.
  --
  -- This can legitimately refuse a finance approver who approved the payment
  -- themselves. That is the rule working, not a deadlock: an administrator
  -- approving instead is the intended path, and an organisation with exactly
  -- one finance approver needs a second pair of hands somewhere — which is an
  -- organisational fact, not something code should paper over.
  if pay.approved_by = p_executed_by then
    raise exception 'the person who approved this payment cannot also send it — someone else must release the money';
  end if;

  select id into v_recipient from payout_recipients
   where org_id = pay.org_id and party = 'vendor' and vendor_id = pay.vendor_id
     and active and recipient_code is not null
   limit 1;
  if v_recipient is null then
    raise exception 'no verified bank recipient is on file for this vendor';
  end if;

  perform recognise_vendor_payable(pay.id);

  insert into remittances (
    org_id, party, recipient_id, payment_id,
    gross_amount, management_fee, admin_fee, net_amount,
    reference, approved_by, approved_at, created_by
  ) values (
    pay.org_id, 'vendor', v_recipient, pay.id,
    pay.amount, 0, 0, pay.amount,
    p_reference, pay.approved_by, pay.approved_at, p_executed_by
  )
  returning id into v_id;

  return v_id;
end;
$$;

revoke all on function create_vendor_remittance(uuid, text, uuid) from public, anon, authenticated;
grant execute on function create_vendor_remittance(uuid, text, uuid) to service_role;

comment on function create_vendor_remittance is
  'Creates a vendor remittance once the whole B4 gate passes. Records WHO released the money (created_by), requires that person to hold finance_approver, and refuses the approver of the same payment — approval and disbursement are two pairs of hands (0142).';

-- ── Landlord rent payouts ─────────────────────────────────────────────────
--
-- Same executor rules. No maker-checker clause here: a rent payout settles
-- collected charges and has no per-payment approver to be distinct FROM, so
-- inventing one would be theatre. Its previous in-function role check was
-- guarded by `auth.uid() is not null` and therefore never once fired under the
-- service-role call it actually receives — dormant, exactly like the NULL
-- created_by beside it.
drop function if exists create_rent_remittance(uuid, uuid, uuid, text);

create function create_rent_remittance(
  p_org_id uuid,
  p_landlord_user_id uuid,
  p_property_id uuid,
  p_period text,
  p_executed_by uuid
)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_recipient uuid;
  v_net numeric(16,2);
  v_ids uuid[];
  v_id uuid;
  v_claimed int;
begin
  perform assert_may_disburse(p_executed_by, p_org_id);

  select id into v_recipient from payout_recipients
   where org_id = p_org_id and party = 'landlord' and user_id = p_landlord_user_id
     and active and recipient_code is not null
   limit 1;
  if v_recipient is null then
    raise exception 'no verified bank recipient is on file for this landlord';
  end if;

  -- Only what has been COLLECTED and not yet paid out. `for update of rc`
  -- locks the rent_charges rows only; a second caller blocks here and, on
  -- release, re-evaluates against the committed row so settled charges are
  -- gone from its set rather than counted twice.
  select array_agg(id order by id) into v_ids
    from (
      select rc.id
        from rent_charges rc
        join leases l on l.id = rc.lease_id
       where rc.org_id = p_org_id
         and l.property_id = p_property_id
         and rc.amount_paid > 0
         and rc.remitted_at is null
       order by rc.id
       for update of rc
    ) locked;

  if v_ids is null or array_length(v_ids, 1) is null then
    raise exception 'there is no collected rent awaiting remittance for this property';
  end if;

  select coalesce(sum(round(rc.landlord_net_amount * (rc.amount_paid / rc.amount), 2)), 0)
    into v_net
    from rent_charges rc
   where rc.id = any (v_ids);

  if v_net is null or v_net <= 0 then
    raise exception 'there is no collected rent awaiting remittance for this property';
  end if;

  insert into remittances (
    org_id, party, recipient_id, property_id, period, reference,
    gross_amount, management_fee, admin_fee, net_amount, status, created_by
  ) values (
    p_org_id, 'landlord', v_recipient, p_property_id, p_period,
    'RENT-REM-' || to_char(now(), 'YYYYMMDDHH24MISS') || '-' || left(replace(p_property_id::text, '-', ''), 6),
    -- Gross IS net: the fee was taken at collection and already sits in
    -- fee_income. Reporting it again would double-count it in every statement
    -- that sums remittance fees.
    v_net, 0, 0, v_net, 'queued', p_executed_by
  )
  returning id into v_id;

  update rent_charges
     set remitted_at = now(), remittance_id = v_id
   where id = any (v_ids)
     and remitted_at is null;      -- never re-claim a settled charge
  get diagnostics v_claimed = row_count;

  if v_claimed <> array_length(v_ids, 1) then
    raise exception 'these charges were remitted by another action while this one was running; nothing has been sent';
  end if;

  return v_id;
end;
$$;

revoke all on function create_rent_remittance(uuid, uuid, uuid, text, uuid) from public, anon, authenticated;
grant execute on function create_rent_remittance(uuid, uuid, uuid, text, uuid) to service_role;

comment on function create_rent_remittance is
  'Remits collected rent to a landlord, paying the snapshotted net and deducting nothing (the fee was taken at collection, 0092). Locks the charges it aggregates and aborts if any is claimed concurrently. Records WHO released the money and requires them to hold finance_approver (0142).';
