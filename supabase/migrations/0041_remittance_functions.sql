-- Creating and settling outbound payments.
--
-- Every gate is re-read from the database here. The server action that calls
-- these has already checked the same things, and that is not duplication — the
-- action protects the user experience, this protects the money. Only one of the
-- two is reachable by a direct API call.

-- ── Vendor payout: settles an approved invoice ─────────────────────────────

create or replace function create_vendor_remittance(
  p_payment_id uuid,
  p_reference text
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

  -- The B4 gate, read from the record rather than taken on trust.
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

  select id into v_recipient from payout_recipients
   where org_id = pay.org_id and party = 'vendor' and vendor_id = pay.vendor_id
     and active and recipient_code is not null
   limit 1;
  if v_recipient is null then
    raise exception 'no verified bank recipient is on file for this vendor';
  end if;

  -- A vendor invoice carries no management fee: it is the vendor's money in
  -- full. Fees are deducted from RENT, which is a different arrangement.
  insert into remittances (
    org_id, party, recipient_id, payment_id,
    gross_amount, management_fee, admin_fee, net_amount,
    reference, approved_by, approved_at, created_by
  ) values (
    pay.org_id, 'vendor', v_recipient, pay.id,
    pay.amount, 0, 0, pay.amount,
    p_reference, pay.approved_by, pay.approved_at, auth.uid()
  )
  returning id into v_id;

  return v_id;
end;
$$;

-- ── Landlord rent: custodial, fees deducted before remitting ───────────────

create or replace function create_landlord_remittance(
  p_org_id uuid,
  p_landlord_user_id uuid,
  p_property_id uuid,
  p_period text,
  p_gross numeric,
  p_reference text
)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  st payment_settings%rowtype;
  v_recipient uuid;
  v_mgmt numeric(16,2);
  v_admin numeric(16,2);
  v_net numeric(16,2);
  v_id uuid;
begin
  if p_gross is null or p_gross <= 0 then
    raise exception 'there is nothing to remit';
  end if;

  select id into v_recipient from payout_recipients
   where org_id = p_org_id and party = 'landlord' and user_id = p_landlord_user_id
     and active and recipient_code is not null
   limit 1;
  if v_recipient is null then
    raise exception 'no verified bank recipient is on file for this landlord';
  end if;

  select * into st from payment_settings where org_id = p_org_id;

  -- Percentages default to 0 (0027), so an org that has not agreed a fee model
  -- remits the full amount rather than guessing one. Rounding is applied per
  -- fee and the net takes the remainder, so the three always sum to the gross —
  -- the table's own CHECK constraint would reject them otherwise.
  v_mgmt  := round(p_gross * coalesce(st.management_fee_percent, 0) / 100, 2);
  v_admin := round(p_gross * coalesce(st.admin_fee_percent, 0) / 100, 2);
  v_net   := p_gross - v_mgmt - v_admin;

  if v_net <= 0 then
    -- `%%` is a literal percent sign in RAISE and consumes no argument, so the
    -- sign is spelled out rather than risking a placeholder/argument mismatch.
    raise exception 'combined fees of % percent would leave the landlord nothing',
      coalesce(st.management_fee_percent, 0) + coalesce(st.admin_fee_percent, 0);
  end if;

  insert into remittances (
    org_id, party, recipient_id, property_id, period,
    gross_amount, management_fee, admin_fee, net_amount,
    reference, created_by
  ) values (
    p_org_id, 'landlord', v_recipient, p_property_id, p_period,
    p_gross, v_mgmt, v_admin, v_net,
    p_reference, auth.uid()
  )
  returning id into v_id;

  return v_id;
end;
$$;

-- ── Claiming an instruction before it is sent ──────────────────────────────
--
-- The single most important function here. Two concurrent callers must not both
-- reach the gateway, so the row is locked and the transition is the claim: the
-- loser sees `sending` and is refused. Returns the row so the caller has the
-- amounts it must not re-derive.

create or replace function claim_remittance_for_sending(p_id uuid)
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

  update remittances set status = 'sending' where id = p_id;
  select * into r from remittances where id = p_id;
  return r;
end;
$$;

-- ── Settling ───────────────────────────────────────────────────────────────

create or replace function record_remittance_sent(
  p_id uuid,
  p_transfer_code text,
  p_sent_at timestamptz default now()
)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  r remittances%rowtype;
  v_bank uuid;
  v_liability uuid;
  v_fee uuid;
  v_purpose ledger_account_purpose;
  v_entry uuid;
begin
  select * into r from remittances where id = p_id for update;
  if r.id is null then
    raise exception 'remittance not found';
  end if;

  -- Already posted: hand back the existing entry. A repeated confirmation is
  -- normal traffic; a second LEDGER POSTING would not be.
  if r.ledger_entry_id is not null then
    return r.ledger_entry_id;
  end if;

  v_purpose := case r.party when 'vendor' then 'vendor_payable'
                            else 'landlord_payable' end;

  v_bank := collection_bank_account(r.org_id);
  select id into v_liability from ledger_accounts
   where org_id = r.org_id and purpose = v_purpose and active
   order by created_at, id limit 1;
  select id into v_fee from ledger_accounts
   where org_id = r.org_id and purpose = 'fee_income' and active
   order by created_at, id limit 1;

  if v_bank is null or v_liability is null then
    raise exception 'the chart of accounts is not set up for this organisation';
  end if;
  if (r.management_fee + r.admin_fee) > 0 and v_fee is null then
    raise exception 'no fee income account exists to post the fee to';
  end if;

  insert into ledger_entries (org_id, entry_date, description, reference, source,
                              entity_type, entity_id, created_by)
  values (
    r.org_id, p_sent_at::date,
    case r.party when 'vendor' then 'Vendor remittance'
                 else 'Rent remittance to landlord' end,
    r.reference, 'remittance', 'remittance', r.id, r.created_by
  )
  returning id into v_entry;

  -- We owed the counterparty the GROSS; the bank gives up the NET; the
  -- difference is fee income we have earned. The balancing trigger rejects the
  -- whole transaction if those three disagree, and the overpayment guard in
  -- 0027 rejects it if we would be paying out more than we hold for them.
  insert into ledger_postings (org_id, entry_id, account_id, amount, memo)
  values (r.org_id, v_entry, v_liability, r.gross_amount, 'Obligation settled'),
         (r.org_id, v_entry, v_bank, -r.net_amount, 'Paid via ' || r.gateway);

  if (r.management_fee + r.admin_fee) > 0 then
    insert into ledger_postings (org_id, entry_id, account_id, amount, memo)
    values (r.org_id, v_entry, v_fee,
            -(r.management_fee + r.admin_fee), 'Management and admin fee retained');
  end if;

  update remittances
     set status = 'sent',
         transfer_code = coalesce(p_transfer_code, transfer_code),
         sent_at = p_sent_at,
         ledger_entry_id = v_entry
   where id = p_id;

  -- A vendor payment is only 'remitted' once the money has actually gone.
  if r.payment_id is not null then
    update payments set status = 'remitted', remittance_reference = r.reference
     where id = r.payment_id;
  end if;

  return v_entry;
end;
$$;

create or replace function record_remittance_outcome(
  p_id uuid,
  p_status remittance_status,
  p_message text default null
)
returns void language plpgsql security definer set search_path = public as $$
begin
  if p_status not in ('failed', 'unknown') then
    raise exception 'use record_remittance_sent for a successful transfer';
  end if;
  update remittances
     set status = p_status, gateway_message = p_message
   where id = p_id;
end;
$$;

-- Service role only. None of these is granted to `authenticated`: a signed-in
-- finance user must go through the server action, which checks the gate and
-- talks to the gateway. Granting them here would make the gate optional.
revoke all on function create_vendor_remittance(uuid, text) from public;
revoke all on function create_landlord_remittance(uuid, uuid, uuid, text, numeric, text) from public;
revoke all on function claim_remittance_for_sending(uuid) from public;
revoke all on function record_remittance_sent(uuid, text, timestamptz) from public;
revoke all on function record_remittance_outcome(uuid, remittance_status, text) from public;

grant execute on function create_vendor_remittance(uuid, text) to service_role;
grant execute on function create_landlord_remittance(uuid, uuid, uuid, text, numeric, text) to service_role;
grant execute on function claim_remittance_for_sending(uuid) to service_role;
grant execute on function record_remittance_sent(uuid, text, timestamptz) to service_role;
grant execute on function record_remittance_outcome(uuid, remittance_status, text) to service_role;
