-- The two halves of the ledger must agree on which account is which.
--
-- 0035 fixed how a collection resolves its DEBIT (the bank). It left the CREDIT
-- side — the liability the money is held against — on the old private query:
--
--     select id into v_credit from ledger_accounts
--      where org_id = ... and purpose = v_purpose and active
--      order by created_at, id limit 1;
--
-- Deterministic, but ordered differently from `canonical_ledger_account`, which
-- prefers the standard numeric chart code. So with two active accounts for one
-- purpose, a COLLECTION credited the oldest while a REMITTANCE (0048) settled
-- against the standard one — and the payout was refused for overpaying an
-- account that had never received the money.
--
-- 0048 predicted this in its own comment. The remittance suite then proved it
-- within one run: rent collected to "Landlord (recon test)", remitted against
-- "2100 Landlord rent payable", refused. The guard was right and the resolution
-- was inconsistent.
--
-- Every purpose→account decision now goes through the one resolver.

create or replace function record_collection(
  p_intent_id uuid,
  p_amount_verified numeric,
  p_paid_at timestamptz default now()
)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  intent payment_intents%rowtype;
  v_bank uuid;
  v_credit uuid;
  v_purpose ledger_account_purpose;
  v_entry uuid;
  v_mismatch boolean;
  v_status payment_intent_status;
begin
  select * into intent from payment_intents where id = p_intent_id for update;
  if intent.id is null then
    raise exception 'payment intent not found';
  end if;

  -- Already posted: hand back the existing entry. A retry is normal traffic.
  if intent.ledger_entry_id is not null then
    return intent.ledger_entry_id;
  end if;

  if p_amount_verified is null or p_amount_verified <= 0 then
    raise exception 'a collection must have a positive verified amount';
  end if;

  v_purpose := case intent.purpose
    when 'rent' then 'landlord_payable'
    when 'service_charge' then 'service_charge_fund'
    when 'deposit' then 'tenant_deposit'
    else 'suspense'
  end;

  v_bank := collection_bank_account(intent.org_id);
  v_credit := canonical_ledger_account(intent.org_id, v_purpose);

  if v_bank is null or v_credit is null then
    raise exception 'the chart of accounts is not set up for this organisation';
  end if;

  insert into ledger_entries (org_id, entry_date, description, reference, source,
                              entity_type, entity_id, created_by)
  values (
    intent.org_id, p_paid_at::date,
    'Collection — ' || replace(intent.purpose::text, '_', ' '),
    intent.gateway_reference, 'collection',
    'payment_intent', intent.id, intent.created_by
  )
  returning id into v_entry;

  insert into ledger_postings (org_id, entry_id, account_id, amount, memo)
  values
    (intent.org_id, v_entry, v_bank, p_amount_verified, 'Received via ' || intent.gateway),
    (intent.org_id, v_entry, v_credit, -p_amount_verified, 'Held on behalf of the payer');

  v_mismatch := p_amount_verified <> intent.amount_expected;

  v_status := case
    when p_amount_verified >= intent.amount_expected then 'paid'
    else 'part_paid'
  end::payment_intent_status;

  update payment_intents
  set status = v_status,
      amount_paid = p_amount_verified,
      paid_at = p_paid_at,
      ledger_entry_id = v_entry,
      amount_mismatch = v_mismatch
  where id = intent.id;

  if intent.service_charge_id is not null
     and p_amount_verified >= intent.amount_expected then
    update service_charges set status = 'paid' where id = intent.service_charge_id;
  end if;

  return v_entry;
end;
$$;

revoke all on function record_collection(uuid, numeric, timestamptz) from public;
grant execute on function record_collection(uuid, numeric, timestamptz) to service_role;

-- Same fix for the vendor payable recognised at approval (0042), which also
-- resolved both of its accounts privately.
create or replace function recognise_vendor_payable(p_payment_id uuid)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  pay payments%rowtype;
  v_fund uuid;
  v_payable uuid;
  v_entry uuid;
begin
  select * into pay from payments where id = p_payment_id for update;
  if pay.id is null then
    raise exception 'payment not found';
  end if;

  if pay.payable_entry_id is not null then
    return pay.payable_entry_id;
  end if;

  if pay.approved_at is null or pay.status not in ('approved', 'remitted') then
    raise exception 'an unapproved payment is not yet a liability';
  end if;

  v_fund := canonical_ledger_account(pay.org_id, 'service_charge_fund');
  v_payable := canonical_ledger_account(pay.org_id, 'vendor_payable');

  if v_fund is null or v_payable is null then
    raise exception 'the chart of accounts is not set up for this organisation';
  end if;

  insert into ledger_entries (org_id, entry_date, description, reference, source,
                              entity_type, entity_id, created_by)
  values (
    pay.org_id, coalesce(pay.approved_at::date, current_date),
    'Vendor invoice approved', pay.invoice_reference, 'adjustment',
    'payment', pay.id, pay.approved_by
  )
  returning id into v_entry;

  insert into ledger_postings (org_id, entry_id, account_id, amount, memo)
  values (pay.org_id, v_entry, v_fund, pay.amount, 'Committed from the service charge fund'),
         (pay.org_id, v_entry, v_payable, -pay.amount, 'Owed to the vendor');

  update payments set payable_entry_id = v_entry where id = pay.id;
  return v_entry;
end;
$$;

revoke all on function recognise_vendor_payable(uuid) from public;
grant execute on function recognise_vendor_payable(uuid) to service_role;
