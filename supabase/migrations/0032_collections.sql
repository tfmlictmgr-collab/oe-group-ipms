-- COLLECTIONS (Day 5) — money coming in, from checkout to ledger.
--
-- Two failure modes dominate payment integrations, and both are guarded here at
-- the database layer rather than trusted to application code:
--
--   1. DOUBLE POSTING. Gateways retry webhooks, and a retry after a timeout is
--      normal operation, not an error. If a retry posts a second ledger entry,
--      the books overstate what was received and the segregation position goes
--      wrong in the dangerous direction (looks like more money than is held).
--      Guarded by a one-to-one link between an intent and its ledger entry,
--      taken under a row lock.
--
--   2. TRUSTING THE CALLBACK FOR THE AMOUNT. A webhook body is attacker-
--      controllable until proven otherwise. The amount posted must come from
--      our own record or from a server-to-server verification call — never from
--      the payload. The signature proves who sent it, not that the contents are
--      true.

create type payment_gateway as enum ('paystack', 'flutterwave', 'manual', 'simulated');
create type collection_purpose as enum ('service_charge', 'rent', 'deposit', 'other');
create type payment_intent_status as enum (
  'pending', 'paid', 'part_paid', 'failed', 'abandoned', 'reversed'
);

create table payment_intents (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,

  purpose collection_purpose not null,
  service_charge_id uuid references service_charges(id),
  property_id uuid references properties(id),
  unit_id uuid references units(id),
  payer_user_id uuid references users(id),

  -- What we asked for. The authority on how much is owed; a payment is checked
  -- against this rather than the other way round.
  amount_expected numeric(16,2) not null check (amount_expected > 0),
  currency text not null default 'NGN',

  gateway payment_gateway not null default 'paystack',
  -- Our reference, sent to the gateway and echoed back. Unique per org so a
  -- redelivered webhook resolves to exactly one intent.
  gateway_reference text not null,
  checkout_url text,

  status payment_intent_status not null default 'pending',
  amount_paid numeric(16,2) check (amount_paid is null or amount_paid >= 0),
  paid_at timestamptz,

  -- Set exactly once, when the collection posts. Its presence IS the "already
  -- posted" flag, so there is no separate boolean to drift out of step.
  ledger_entry_id uuid references ledger_entries(id),

  -- Recorded when the money received differs from the amount asked for, so an
  -- under/overpayment is visible rather than silently absorbed.
  amount_mismatch boolean not null default false,

  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index payment_intents_org_ref_uidx
  on payment_intents (org_id, gateway_reference);
-- One ledger entry can back only one intent.
create unique index payment_intents_entry_uidx
  on payment_intents (ledger_entry_id) where ledger_entry_id is not null;
create index payment_intents_status_idx on payment_intents (org_id, status);
create index payment_intents_sc_idx on payment_intents (service_charge_id);

create trigger payment_intents_touch before update on payment_intents
  for each row execute function touch_updated_at();

alter table payment_intents enable row level security;

-- A payer sees their own intent (they need the checkout link and a receipt);
-- finance and admin see all of the org's.
create policy payment_intents_select on payment_intents for select
  using (
    org_id = current_user_org_id()
    and (
      payer_user_id = auth.uid()
      or current_user_role() = any (array['admin','finance_approver']::user_role[])
    )
  );

-- Only staff raise an intent. A payer cannot invent what they owe.
create policy payment_intents_insert on payment_intents for insert
  with check (
    org_id = current_user_org_id()
    and current_user_role() = any (array['admin','finance_approver','facility_manager']::user_role[])
  );

create policy payment_intents_update on payment_intents for update
  using (org_id = current_user_org_id()
    and current_user_role() = any (array['admin','finance_approver']::user_role[]))
  with check (org_id = current_user_org_id());

create trigger audit_payment_intent after insert or update on payment_intents
  for each row execute function log_audit('collection.intent');

-- ── Webhook event log ──────────────────────────────────────────────────────
-- Every inbound gateway event is recorded before it is acted on: what arrived,
-- whether its signature verified, and whether it was already seen. This is both
-- the dedupe mechanism and the evidence trail when a payment is disputed.
create table gateway_events (
  id uuid primary key default gen_random_uuid(),
  gateway payment_gateway not null,
  -- The gateway's own event id. Unique, so a redelivery is recognised even
  -- before we work out which intent it belongs to.
  event_id text not null,
  event_type text,
  reference text,
  signature_valid boolean not null,
  payload jsonb,
  intent_id uuid references payment_intents(id),
  processed_at timestamptz,
  outcome text,
  received_at timestamptz not null default now()
);

create unique index gateway_events_uidx on gateway_events (gateway, event_id);
create index gateway_events_ref_idx on gateway_events (reference);

alter table gateway_events enable row level security;

-- Written by the webhook handler with the service role; readable by finance for
-- investigation. No client writes at all.
create policy gateway_events_select on gateway_events for select
  using (current_user_role() = any (array['admin','finance_approver']::user_role[]));

/**
 * Posts a verified collection to the ledger, exactly once.
 *
 * p_amount_verified MUST come from our own record or a server-to-server
 * verification call — never from a webhook body. The function cannot tell the
 * difference, so the caller carries that responsibility and every call site is
 * written to honour it.
 *
 * Idempotency: the intent row is locked, and if it already carries a ledger
 * entry that entry is returned unchanged. Two concurrent deliveries therefore
 * produce one posting, with the loser returning the winner's entry rather than
 * an error — a retry is normal traffic and should not look like a failure.
 */
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
begin
  select * into intent from payment_intents where id = p_intent_id for update;
  if intent.id is null then
    raise exception 'payment intent not found';
  end if;

  -- Already posted: hand back the existing entry. Not an error.
  if intent.ledger_entry_id is not null then
    return intent.ledger_entry_id;
  end if;

  if p_amount_verified is null or p_amount_verified <= 0 then
    raise exception 'a collection must have a positive verified amount';
  end if;

  -- Which liability the money is held against. Rent is owed onward to a
  -- landlord; service charge belongs to the property's fund; a deposit is the
  -- tenant's. Getting this wrong would misstate who the money belongs to.
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

  -- Debit funds held, credit whoever the money belongs to. The balancing and
  -- overpayment triggers from 0027 still apply.
  insert into ledger_postings (org_id, entry_id, account_id, amount, memo)
  values
    (intent.org_id, v_entry, v_bank, p_amount_verified, 'Received via ' || intent.gateway),
    (intent.org_id, v_entry, v_credit, -p_amount_verified, 'Held on behalf of the payer');

  v_mismatch := p_amount_verified <> intent.amount_expected;

  update payment_intents
  set status = case
        when p_amount_verified >= intent.amount_expected then 'paid'
        else 'part_paid'
      end,
      amount_paid = p_amount_verified,
      paid_at = p_paid_at,
      ledger_entry_id = v_entry,
      amount_mismatch = v_mismatch
  where id = intent.id;

  -- Settle the service charge only when it is actually settled in full.
  if intent.service_charge_id is not null
     and p_amount_verified >= intent.amount_expected then
    update service_charges set status = 'paid' where id = intent.service_charge_id;
  end if;

  return v_entry;
end;
$$;

revoke all on function record_collection(uuid, numeric, timestamptz) from public;
-- Deliberately NOT granted to `authenticated`: collections are posted by the
-- webhook handler (service role) or by a staff action that verifies first.
grant execute on function record_collection(uuid, numeric, timestamptz) to service_role;
