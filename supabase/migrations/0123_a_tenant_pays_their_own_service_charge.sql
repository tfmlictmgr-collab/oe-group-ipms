-- The tenant-facing half of service-charge collection.
--
-- Module 3 built the whole billing side: budgets, apportionment, invoicing,
-- statements, the ledger posting, daily reconciliation. What it never built is
-- a way for the person being billed to PAY. `payment_intents_insert` (0032)
-- admits `admin | finance_approver | facility_manager` and nobody else, so a
-- tenant looking at "₦482,000 outstanding" on their own statement has no
-- button — they must wait for finance to raise a link and send it to them.
--
-- That is the same gap 0110 closed for rent, and this closes it the same way,
-- for the same reason: the accounting is already wired to receive the money.
--
-- Three things had to be true first, and two of them were not.

-- ── 1. A collection must actually settle the invoice ──────────────────────
--
-- ⚠️ A live regression, found while tracing where a tenant's payment would
-- land. `record_collection` used to end with:
--
--     update service_charges set status = 'paid' where id = intent.service_charge_id;
--
-- present in 0032, 0033, 0035 and 0049. `0092_rent_reaches_the_ledger` rewrote
-- the function with `create or replace` to add the rent fee split, and that
-- line did not survive the rewrite; 0103 rewrote it again from 0092. Confirmed
-- against the LIVE definition (`pg_proc.prosrc`) rather than the migration
-- files: the deployed function contains no reference to `service_charges` at
-- all.
--
-- So today a service-charge payment posts to the ledger correctly, marks the
-- INTENT paid, and leaves the INVOICE reading `invoiced` for ever. The tenant
-- who just paid still sees it outstanding, and arrears over-report by exactly
-- the amount collected. The money was right; the record of what it settled was
-- not.
--
-- Adding a tenant-facing Pay button on top of that would have made the defect
-- everyone's problem rather than finance's.

-- Part payments need somewhere to accumulate. `rent_charges.amount_paid` (0090)
-- already works this way; `service_charges` only ever had a status string, so a
-- half-paid invoice had nowhere to record the half.
alter table service_charges add column if not exists amount_paid numeric(14,2)
  not null default 0 check (amount_paid >= 0);

comment on column service_charges.amount_paid is
  'Cumulative amount collected against this invoice. Maintained by record_collection; status is derived from it. Mirrors rent_charges.amount_paid rather than inventing a second shape for the same idea.';

-- Repair what the regression left behind, in two passes because the two cases
-- have different evidence.
--
-- First: invoices that were settled through a payment intent. The intent knows
-- what was actually received, so that is the authority — not the invoice's own
-- face value, which would overstate a part payment as full.
update service_charges sc
   set amount_paid = coalesce(paid.total, 0),
       status = case when coalesce(paid.total, 0) >= sc.amount then 'paid' else 'part_paid' end
  from (
    select service_charge_id, sum(amount_paid) total
      from payment_intents
     where service_charge_id is not null
       and ledger_entry_id is not null
       and amount_paid is not null
     group by service_charge_id
  ) paid
 where paid.service_charge_id = sc.id
   and coalesce(paid.total, 0) > 0
   and sc.amount_paid = 0;

-- Second: invoices already marked paid by some other route (a manual
-- correction, the seed data). Their amount_paid would otherwise read zero and
-- the statement would show a paid invoice as fully outstanding.
update service_charges
   set amount_paid = amount
 where status = 'paid' and amount_paid = 0;

-- Now the function itself. Rewritten from the LIVE definition (`pg_get_functiondef`),
-- not from 0103's file — the file and the deployment have diverged before, and
-- rebuilding from the file is exactly how the line below went missing twice.
-- The only change is the `else` branch: everything above it is byte-identical
-- to what is deployed.
create or replace function record_collection(
  p_intent_id uuid,
  p_amount_verified numeric,
  p_paid_at timestamptz default now()
)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  intent payment_intents%rowtype;
  rc rent_charges%rowtype;
  v_bank uuid;
  v_credit uuid;
  v_fee uuid;
  v_purpose ledger_account_purpose;
  v_entry uuid;
  v_mismatch boolean;
  v_status payment_intent_status;
  v_fee_total numeric(16,2);
  v_landlord_share numeric(16,2);
begin
  select * into intent from payment_intents where id = p_intent_id for update;
  if intent.id is null then
    raise exception 'payment intent not found';
  end if;

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

  v_bank := collection_bank_account(intent.org_id, intent.currency);
  v_credit := canonical_ledger_account(intent.org_id, v_purpose, intent.currency);

  if v_bank is null or v_credit is null then
    raise exception 'no client-funds account is configured for % — enable it under Settings before collecting in this currency', intent.currency;
  end if;

  if intent.rent_charge_id is not null then
    select * into rc from rent_charges where id = intent.rent_charge_id for update;
  end if;

  insert into ledger_entries (org_id, entry_date, description, reference, source,
                              entity_type, entity_id, created_by)
  values (
    intent.org_id, p_paid_at::date,
    'Collection — ' || replace(intent.purpose::text, '_', ' ')
      || case when intent.currency <> 'NGN' then ' (' || intent.currency || ')' else '' end,
    intent.gateway_reference, 'collection',
    'payment_intent', intent.id, intent.created_by
  )
  returning id into v_entry;

  if rc.id is not null then
    -- The fee, taken once, from the rate frozen when the demand was raised, and
    -- apportioned to what was actually received — so a part payment does not
    -- hand the org its whole fee out of the landlord's first instalment.
    v_fee_total := round(
      (rc.management_fee_amount + rc.admin_fee_amount) * (p_amount_verified / rc.amount), 2
    );
    if v_fee_total < 0 then v_fee_total := 0; end if;
    if v_fee_total > p_amount_verified then v_fee_total := p_amount_verified; end if;

    v_landlord_share := p_amount_verified - v_fee_total;

    v_fee := canonical_ledger_account(intent.org_id, 'fee_income', intent.currency);
    if v_fee is null then
      raise exception 'the chart of accounts has no fee income account for this organisation';
    end if;

    insert into ledger_postings (org_id, entry_id, account_id, amount, memo)
    values (intent.org_id, v_entry, v_bank, p_amount_verified,
            'Rent received via ' || intent.gateway);

    if v_landlord_share > 0 then
      insert into ledger_postings (org_id, entry_id, account_id, amount, memo)
      values (intent.org_id, v_entry, v_credit, -v_landlord_share,
              'Held for the landlord, net of fees');
    end if;

    if v_fee_total > 0 then
      insert into ledger_postings (org_id, entry_id, account_id, amount, memo)
      values (intent.org_id, v_entry, v_fee, -v_fee_total,
              'Management and admin fee at ' || rc.management_fee_pct || '%');
    end if;

    update rent_charges
       set amount_paid = amount_paid + p_amount_verified,
           status = case
             when amount_paid + p_amount_verified >= amount then 'paid'::rent_charge_status
             else 'part_paid'::rent_charge_status
           end,
           ledger_entry_id = coalesce(ledger_entry_id, v_entry)
     where id = rc.id;
  else
    insert into ledger_postings (org_id, entry_id, account_id, amount, memo)
    values
      (intent.org_id, v_entry, v_bank, p_amount_verified, 'Received via ' || intent.gateway),
      (intent.org_id, v_entry, v_credit, -p_amount_verified, 'Held on behalf of the payer');

    -- ⚠️ The line that went missing, restored — and no longer a flat 'paid'.
    --
    -- The original set status = 'paid' unconditionally, which was already wrong
    -- for a short payment: the ledger recorded ₦300k received against a ₦482k
    -- invoice and the invoice then read fully settled. Derived from what was
    -- actually collected instead, the same way rent has been since 0090.
    --
    -- No fee split here, deliberately. A management fee is a rent concept
    -- (decision 14); service-charge money is held in full for the fund it
    -- belongs to and disbursed against it.
    if intent.service_charge_id is not null then
      update service_charges
         set amount_paid = amount_paid + p_amount_verified,
             status = case
               when amount_paid + p_amount_verified >= amount then 'paid'
               else 'part_paid'
             end
       where id = intent.service_charge_id;
    end if;
  end if;

  v_mismatch := p_amount_verified <> intent.amount_expected;
  v_status := case when p_amount_verified >= intent.amount_expected
                   then 'paid'::payment_intent_status
                   else 'part_paid'::payment_intent_status end;

  update payment_intents
     set status = v_status,
         amount_paid = p_amount_verified,
         paid_at = p_paid_at,
         ledger_entry_id = v_entry,
         amount_mismatch = v_mismatch
   where id = intent.id;

  return v_entry;
end;
$$;

revoke all on function record_collection(uuid, numeric, timestamptz) from public;
grant execute on function record_collection(uuid, numeric, timestamptz) to service_role;

comment on function record_collection is
  'Posts a verified collection to the client-funds ledger and settles what it was for. Rent takes the fee split and updates rent_charges; a service charge updates service_charges.amount_paid/status -- a line present from 0032 to 0049, lost in the 0092 rewrite, and restored here derived from the amount actually received rather than set flat to paid. Service-role only: a collection is recorded from a verified gateway webhook, never from a browser.';

-- ── 2. A part-paid invoice must still be payable ──────────────────────────
--
-- ⚠️ 0045's unique index blocks a second intent while one exists in
-- `('pending','part_paid')`. Its purpose — "two checkout links for the same
-- charge invites paying twice" — is about two LIVE links. A `part_paid` intent
-- is not live: it has already been through the gateway and its checkout URL is
-- spent. Under the old index a tenant who paid ₦300k of ₦482k could never be
-- issued a link for the remaining ₦182k, by any route, including finance's.
--
-- `create_rent_payment_intent` has guarded on `status = 'pending'` alone since
-- 0092c, and 0110 documented why. The index and the function have simply
-- disagreed since; this makes the index say what the function already says.
drop index if exists payment_intents_one_live_per_charge_uidx;
create unique index payment_intents_one_live_per_charge_uidx
  on payment_intents (service_charge_id)
  where service_charge_id is not null and status = 'pending';

comment on index payment_intents_one_live_per_charge_uidx is
  'At most one PENDING checkout per invoice -- two live links for one debt is how a payer pays twice. Deliberately not extended to part_paid: that intent is spent, and blocking on it makes the outstanding balance uncollectable.';

-- ── 3. The tenant's own way in ────────────────────────────────────────────
--
-- The rent equivalent, argument for argument. Standing is decided here, once,
-- so the tenant's button, a finance screen and any future job all go through
-- the same test rather than each re-implementing it.
create or replace function create_service_charge_payment_intent(
  p_service_charge_id uuid,
  p_gateway payment_gateway default 'paystack'
)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  sc service_charges%rowtype;
  v_unit units%rowtype;
  v_property_id uuid;
  v_id uuid;
  v_ref text;
  v_outstanding numeric(14,2);
begin
  select * into sc from service_charges where id = p_service_charge_id and deleted_at is null;
  if sc.id is null then
    raise exception 'that service charge could not be found';
  end if;
  if auth.uid() is not null and sc.org_id is distinct from current_user_org_id() then
    raise exception 'that invoice belongs to another organisation';
  end if;

  select * into v_unit from units where id = sc.unit_id;
  v_property_id := v_unit.property_id;

  -- Who may open a link against this invoice: the person billed, oversight, or
  -- an FM/PM scoped to the property it sits on.
  --
  -- ⚠️ The reason this matters is not that someone might pay a stranger's bill.
  -- It is the one-live-intent rule above: opening an intent on somebody else's
  -- invoice LOCKS THEM OUT of paying it, from any account in the org, with
  -- nothing in the app to explain why. That is the defect 0110 found in the
  -- rent function, and it would have arrived here identically had this been
  -- written without the check.
  if auth.uid() is not null
     and sc.billed_to_user_id is distinct from auth.uid()
     and not (current_user_role() = any (oversight_roles()))
     and not (v_property_id is not null and v_property_id in (select current_user_property_ids())) then
    raise exception 'that invoice is billed to someone else';
  end if;

  v_outstanding := sc.amount - sc.amount_paid;
  if v_outstanding <= 0 then
    raise exception 'that service charge has already been paid in full';
  end if;

  if exists (
    select 1 from payment_intents
     where service_charge_id = sc.id and status = 'pending'
  ) then
    raise exception 'a payment link is already open for this invoice';
  end if;

  v_ref := 'SC-' || to_char(now(), 'YYYYMM') || '-' || left(replace(sc.id::text, '-', ''), 10);

  insert into payment_intents (
    org_id, purpose, service_charge_id, property_id, unit_id, payer_user_id,
    amount_expected, currency, gateway, gateway_reference, created_by
  ) values (
    sc.org_id, 'service_charge', sc.id, v_property_id, sc.unit_id, sc.billed_to_user_id,
    -- Service charges are a domestic Naira obligation. The column is carried
    -- through the intent all the same so an FX invoice needs no re-architecture,
    -- matching how the rent function treats currency.
    v_outstanding, 'NGN', p_gateway, v_ref, auth.uid()
  )
  returning id into v_id;

  return v_id;
end;
$$;

revoke all on function create_service_charge_payment_intent(uuid, payment_gateway) from public;
grant execute on function create_service_charge_payment_intent(uuid, payment_gateway) to authenticated, service_role;

comment on function create_service_charge_payment_intent is
  'Opens a payment for the outstanding balance of a service-charge invoice. Callable by the person billed, by oversight roles, or by an FM/PM scoped to the property -- never by an unrelated member of the org, who could otherwise lock the real payer out via the one-live-intent guard. The amount is computed here from amount - amount_paid and never accepted from the caller.';

-- ── What the tenant's own screen reads ────────────────────────────────────
--
-- `service_charges_select` (0052) already admits `billed_to_user_id =
-- auth.uid()`, and `payment_intents_select` (0032) admits `payer_user_id =
-- auth.uid()`, so the statement page could query both directly. It reads
-- through here instead for the reason `my_rent_charges()` exists: the live
-- checkout reference lives on the other table, and a page that joins them
-- itself has to be trusted to filter both — this filters once, in the place
-- that also decides what "outstanding" means.
create or replace function my_service_charges()
returns table (
  charge_id uuid,
  property_or_unit text,
  billing_period text,
  due_date date,
  amount numeric,
  amount_paid numeric,
  outstanding numeric,
  apportionment_pct numeric,
  status text,
  open_intent_reference text
)
language sql stable security definer set search_path = public as $$
  select
    sc.id, sc.property_or_unit, sc.billing_period, sc.due_date,
    sc.amount, sc.amount_paid, sc.amount - sc.amount_paid,
    sc.apportionment_pct, sc.status,
    (select pi.gateway_reference
       from payment_intents pi
      where pi.service_charge_id = sc.id
        and pi.status = 'pending'
      order by pi.created_at desc
      limit 1)
  from service_charges sc
  -- The whole boundary, in one line. This is SECURITY DEFINER, so this WHERE
  -- clause is all that stands between a caller and every invoice in the
  -- database.
  where sc.billed_to_user_id = auth.uid()
    and sc.deleted_at is null
  order by sc.billing_period desc nulls last, sc.due_date desc nulls last;
$$;

revoke all on function my_service_charges() from public;
grant execute on function my_service_charges() to authenticated;

comment on function my_service_charges is
  'The caller''s own service-charge invoices, with the outstanding balance computed and any live checkout reference attached. Definer-scoped to auth.uid().';

-- ── What they paid, and when ──────────────────────────────────────────────
--
-- "View statements (payment history)". The statement said what was BILLED and
-- nothing about what was PAID — so a tenant had no receipt, no reference to
-- quote in a dispute, and no way to tell a settled invoice from one finance
-- had simply not chased.
create or replace function my_payment_history()
returns table (
  intent_id uuid,
  purpose text,
  reference text,
  description text,
  amount_expected numeric,
  amount_paid numeric,
  currency text,
  status text,
  paid_at timestamptz,
  created_at timestamptz
)
language sql stable security definer set search_path = public as $$
  select
    pi.id,
    pi.purpose::text,
    pi.gateway_reference,
    coalesce(sc.property_or_unit || ' · ' || sc.billing_period, p.name, replace(pi.purpose::text, '_', ' ')),
    pi.amount_expected, pi.amount_paid, pi.currency, pi.status::text,
    pi.paid_at, pi.created_at
  from payment_intents pi
  left join service_charges sc on sc.id = pi.service_charge_id
  left join properties p on p.id = pi.property_id
  where pi.payer_user_id = auth.uid()
  order by coalesce(pi.paid_at, pi.created_at) desc;
$$;

revoke all on function my_payment_history() from public;
grant execute on function my_payment_history() to authenticated;

comment on function my_payment_history is
  'Every payment the caller has been asked for and what became of it -- rent, service charge or deposit -- with the gateway reference to quote in a dispute. Definer-scoped to payer_user_id = auth.uid(); joins properties/service_charges to name what was paid for, which a tenant has no direct read on.';
