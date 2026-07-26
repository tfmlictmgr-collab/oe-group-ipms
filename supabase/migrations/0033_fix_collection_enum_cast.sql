-- Fixes record_collection: a CASE expression returns TEXT, and assigning it to
-- an enum column fails at runtime:
--   column "status" is of type payment_intent_status but expression is of type text
--
-- The migration that introduced it applied cleanly, because PL/pgSQL bodies are
-- not type-checked until executed. This is the second occurrence of exactly this
-- mistake in this build (0029 had it too), so the rule is worth stating: after
-- writing any function, CALL it. A migration applying successfully says nothing
-- about whether its functions run.

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

  select id into v_bank from ledger_accounts
   where org_id = intent.org_id and purpose = 'client_funds' and active limit 1;
  select id into v_credit from ledger_accounts
   where org_id = intent.org_id and purpose = v_purpose and active limit 1;

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

  -- Resolved into a typed variable, so the enum assignment is explicit rather
  -- than relying on inference from a CASE.
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
