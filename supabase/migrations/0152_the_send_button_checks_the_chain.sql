-- The chain is only a control if the thing that moves the money reads it.
--
-- 0151 built the ladder. This wires it to the two functions that actually
-- release funds, and closes the landlord-payout gap named there:
--
--   • `create_vendor_remittance` — the payment must have cleared all three
--     stages AT ITS CURRENT AMOUNT, not merely carry an `approved_at`.
--   • `claim_remittance_for_sending` — the last gate before the transfer. For a
--     landlord payout this is where the chain is checked, because the payout
--     record does not exist until finance assembles it.
--
-- ⚠️ `claim_remittance_for_sending` gains a REQUIRED sender. It is called
-- through the service-role client, where `auth.uid()` is null by definition —
-- the exact defect 0142 found in both create_*_remittance functions, where the
-- executor had been NULL on every row ever written. A defaulted parameter would
-- let a call site forget it and silently reintroduce that, so there is no
-- default, and per the 0141 lesson a changed parameter list needs DROP FUNCTION
-- first: `create or replace` would leave a second overload standing and make
-- every existing call ambiguous.

-- ── Vendor payments: approved is not enough, approved AT THIS AMOUNT is ────
drop function if exists create_vendor_remittance(uuid, text, uuid);

create function create_vendor_remittance(
  p_payment_id  uuid,
  p_reference   text,
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

  -- The chain, at the amount now being sent. `approved_at` says the chain
  -- completed once; this says it completed for THIS number.
  perform assert_chain_cleared('vendor_payment', pay.id, pay.amount);

  perform assert_may_disburse(p_executed_by, pay.org_id);

  -- Maker-checker on the recorded approver (0142) …
  if pay.approved_by = p_executed_by then
    raise exception 'the person who approved this payment cannot also send it — someone else must release the money';
  end if;

  -- … and on EVERY stage, not only the last one. 0142 compared against
  -- `approved_by` alone, which since 0151 is the stage-3 approver. The FM who
  -- signed the job off and the auditor who verified it are equally people who
  -- must not also be the ones moving the money.
  if exists (
    select 1 from payment_approvals a
     where a.payable_type = 'vendor_payment'
       and a.payable_id   = pay.id
       and a.actor_id     = p_executed_by
  ) then
    raise exception 'you approved this payment at an earlier stage and cannot also send it — someone else must release the money';
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
  'Creates a vendor remittance once the whole B4 gate passes, the approval chain is complete AT THE CURRENT AMOUNT (0151), and the executor is a finance approver who actioned no stage of it (0142, widened 0152 from the final approver to every stage).';

-- ── Who pressed send ──────────────────────────────────────────────────────
--
-- `created_by` records who ASSEMBLED the remittance; nothing recorded who
-- released it. For a vendor payment those are the same person and the gap was
-- invisible. For a landlord payout, finance assembles the run and — after the
-- chain — sends it, potentially days apart and potentially a different person.
alter table remittances add column if not exists sent_by uuid references users(id);

comment on column remittances.sent_by is
  'Who released this money, as distinct from created_by, who assembled it. The maker-checker in claim_remittance_for_sending is tested against this person (0152).';

-- ── The last gate before the transfer ─────────────────────────────────────
drop function if exists claim_remittance_for_sending(uuid);

create function claim_remittance_for_sending(p_id uuid, p_sent_by uuid)
returns remittances language plpgsql security definer set search_path = public as $$
declare
  r remittances%rowtype;
begin
  select * into r from remittances where id = p_id for update;
  if r.id is null then
    raise exception 'remittance not found';
  end if;
  if r.status <> 'queued' then
    raise exception 'this remittance is already %', r.status;
  end if;

  perform assert_may_disburse(p_sent_by, r.org_id);

  -- A landlord payout has no prior gate of its own — this is the one. A vendor
  -- remittance was already gated at creation against the payment it settles,
  -- and re-checking the chain here would look for approvals filed against the
  -- REMITTANCE id, which correctly do not exist.
  if r.party = 'landlord' then
    perform assert_chain_cleared('landlord_payout', r.id, r.net_amount);
  end if;

  if exists (
    select 1 from payment_approvals a
     where a.payable_type = case when r.party = 'landlord' then 'landlord_payout' else 'vendor_payment' end
       and a.payable_id   = coalesce(r.payment_id, r.id)
       and a.actor_id     = p_sent_by
  ) then
    raise exception 'you approved this payout and cannot also send it — someone else must release the money';
  end if;

  update remittances set status = 'sending', sent_by = p_sent_by where id = p_id;
  select * into r from remittances where id = p_id;
  return r;
end;
$$;

revoke all on function claim_remittance_for_sending(uuid, uuid) from public, anon, authenticated;
grant execute on function claim_remittance_for_sending(uuid, uuid) to service_role;

comment on function claim_remittance_for_sending is
  'Claims a queued remittance for sending, and is the last gate before money moves: the sender must be a finance approver of the paying org, a landlord payout must have cleared the full approval chain at its net amount, and the sender must have actioned no stage of it (0152).';
