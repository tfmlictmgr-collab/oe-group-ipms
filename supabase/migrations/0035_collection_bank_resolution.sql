-- Fixes which bank account a collection is debited to.
--
-- record_collection resolved the debit side with:
--     select id from ledger_accounts
--      where org_id = ... and purpose = 'client_funds' and active limit 1;
--
-- `limit 1` with no ORDER BY is not a choice, it is whatever the planner hands
-- back. It was caught in a live run: a collection was debited to a leftover
-- account named "Client funds (recon test)" instead of the org's real one.
--
-- Why it matters beyond tidiness: 0028 lets an org hold several client-funds
-- LEDGER accounts (one per bank account it configures) while permitting exactly
-- one ACTIVE client-funds BANK account. Reconciliation compares the bank
-- statement against `bank_accounts.ledger_account_id`. A collection posted to a
-- different ledger account is therefore money that exists in the books but can
-- never be matched to the statement — it would surface as a permanent variance
-- on a system whose whole purpose is daily bank-vs-ledger agreement.
--
-- So the bank account is now the authority, exactly as reconciliation reads it,
-- with a deterministic fallback for an org that has not configured one yet.

create or replace function collection_bank_account(p_org_id uuid)
returns uuid language sql stable security definer set search_path = public as $$
  select coalesce(
    -- The account reconciliation actually compares against.
    (select b.ledger_account_id
       from bank_accounts b
      where b.org_id = p_org_id
        and b.purpose = 'client_funds'
        and b.active
        and b.ledger_account_id is not null
      limit 1),
    -- Not configured yet: the standard '1000' account, then the oldest, so the
    -- answer is at least stable rather than planner-dependent.
    (select a.id
       from ledger_accounts a
      where a.org_id = p_org_id
        and a.purpose = 'client_funds'
        and a.active
      order by (a.code = '1000') desc, a.created_at, a.id
      limit 1)
  );
$$;

comment on function collection_bank_account(uuid) is
  'The ledger account incoming client money is debited to — the one reconciliation compares against the bank statement.';

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

  -- The credit side is unambiguous: one account per purpose per org.
  select id into v_credit from ledger_accounts
   where org_id = intent.org_id and purpose = v_purpose and active
   order by created_at, id limit 1;

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

revoke all on function collection_bank_account(uuid) from public;
grant execute on function collection_bank_account(uuid) to service_role, authenticated;
