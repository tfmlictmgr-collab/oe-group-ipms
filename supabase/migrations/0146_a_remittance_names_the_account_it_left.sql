-- A remittance names the account the money left.
--
-- `remittances` had no `bank_account_id`. Money going OUT was tied to a bank
-- account only by inference: `record_remittance_sent` called
-- `collection_bank_account(org)`, which returns the ledger account behind the
-- org's active client-funds bank account — and reconciliation compares a
-- statement against `bank_accounts.ledger_account_id`. So the two agreed only
-- because `bank_accounts_one_client_funds_per_currency_uidx` permits exactly
-- ONE active client-funds account per currency. The correctness of every
-- payout reconciliation rested on a uniqueness index nobody would think to
-- re-read before relaxing it — a second Naira account (a new bank, a migration
-- between banks, an operating float) and remittances would post to whichever
-- row `limit 1` returned, matching against a statement they never appeared on.
-- No error, no variance on the account that actually paid: the books would
-- simply be about a different account than the money.
--
-- Two defects fall out of the same inference, and both are fixed here:
--
--   1. `collection_bank_account(r.org_id)` was called with NO currency, so it
--      defaults to 'NGN' — as do the `canonical_ledger_account` calls beside
--      it for the liability and the fee. 0103 gave every money-in path its own
--      currency and never reached this one. Nothing has mis-posted: `payments`
--      carries no currency, Paystack Transfers is Naira, and every remittance
--      in existence is NGN. It would have mis-posted the first time one wasn't.
--
--   2. A remittance could be created for an org with no configured client-funds
--      account at all, and only fail later, at posting time — after the
--      transfer had been handed to the gateway. Money must not leave an account
--      nobody has named.
--
-- The fix is to stop inferring. A remittance stores the account it leaves, at
-- creation, and posting uses THAT account rather than re-deriving one. Where
-- the answer is ambiguous the insert is refused with the choice spelled out,
-- rather than resolved by whatever the planner returns — so the day the index
-- is relaxed, this fails loudly instead of quietly settling into the wrong
-- book.

-- ── 1. The column ──────────────────────────────────────────────────────────
alter table remittances
  add column if not exists bank_account_id uuid references bank_accounts(id);

create index if not exists remittances_bank_account_idx
  on remittances (bank_account_id);

comment on column remittances.bank_account_id is
  'The segregated client-funds account this money left. Stamped at creation and never inferred at posting time — reconciliation is per bank account, so a payout that does not name one can only be matched by guessing (0146).';

-- ── 2. One resolver, and it refuses to guess ───────────────────────────────
--
-- Returns the BANK ACCOUNT, where `collection_bank_account` returns the ledger
-- account behind it. Both are needed: the ledger account is where postings go,
-- the bank account is what a statement belongs to and what reconciliation runs
-- against.
--
-- ⚠️ It raises on ambiguity rather than ordering its way out of it. That is the
-- whole point: `collection_bank_account` resolves two candidates to one with a
-- silent `limit 1`, which is defensible for a default and indefensible for the
-- record of where money went. The same shape as `auto_match_statement_lines`
-- (0029) — exactly one candidate, or a person decides.
create or replace function client_funds_bank_account(
  p_org_id uuid,
  p_currency text default 'NGN'
)
returns uuid
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_currency text := upper(trim(coalesce(p_currency, 'NGN')));
  v_ids uuid[];
begin
  if auth.uid() is not null and p_org_id is distinct from current_user_org_id() then
    raise exception 'not permitted to resolve accounts for another organisation';
  end if;

  select array_agg(b.id order by b.created_at, b.id) into v_ids
    from bank_accounts b
   where b.org_id = p_org_id
     and b.purpose = 'client_funds'
     and b.active
     and b.currency = v_currency
     and b.ledger_account_id is not null;

  if v_ids is null then
    raise exception
      'this organisation has no active % client-funds account, so nothing can be paid out of one — configure it under Settings → Banking first',
      v_currency;
  end if;

  if array_length(v_ids, 1) > 1 then
    raise exception
      'this organisation holds % active % client-funds accounts; the remittance must say which one the money leaves',
      array_length(v_ids, 1), v_currency;
  end if;

  return v_ids[1];
end;
$$;

revoke all on function client_funds_bank_account(uuid, text) from public, anon;
grant execute on function client_funds_bank_account(uuid, text) to service_role, authenticated;

comment on function client_funds_bank_account(uuid, text) is
  'The segregated client-funds BANK account of an organisation in a currency. Raises when there is none, and raises when there is more than one rather than picking — a payout that guessed which account it left would reconcile against a statement it never appeared on (0146).';

-- ── 3. History says which account it left ──────────────────────────────────
--
-- Every existing remittance predates the column. Each is backfilled to the
-- account it must have used — the only one its org held in its currency — and
-- only where that is unambiguous, which on every live row it is.
update remittances r
   set bank_account_id = b.id
  from bank_accounts b
 where r.bank_account_id is null
   and b.org_id = r.org_id
   and b.purpose = 'client_funds'
   and b.active
   and b.currency = r.currency
   and b.ledger_account_id is not null
   and not exists (
     select 1 from bank_accounts b2
      where b2.org_id = r.org_id
        and b2.purpose = 'client_funds'
        and b2.active
        and b2.currency = r.currency
        and b2.ledger_account_id is not null
        and b2.id <> b.id
   );

-- Stop rather than half-apply. A row left without an account would be a payout
-- whose destination account is unknowable, and the `not null` below would fail
-- with a constraint name instead of a sentence.
do $$
declare
  v_orphans integer;
begin
  select count(*) into v_orphans from remittances where bank_account_id is null;
  if v_orphans > 0 then
    raise exception
      '% remittance(s) cannot be traced to a client-funds account. Configure the missing account(s) under Settings → Banking, or set bank_account_id by hand, then re-run this migration.',
      v_orphans;
  end if;
end;
$$;

alter table remittances alter column bank_account_id set not null;

-- ── 4. The rule lives on the table, not in the three creators ──────────────
--
-- There are three insert paths today — `create_vendor_remittance` (0142),
-- `create_rent_remittance` (0142) and the older `create_landlord_remittance`
-- (0041) — and the next one would be the fourth place to remember. A BEFORE
-- INSERT trigger cannot be forgotten by a function that has not been written
-- yet, which is the same reason the balancing rule (0027) is a trigger and not
-- a convention.
create or replace function remittance_names_its_account()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  bank bank_accounts%rowtype;
begin
  -- Rewriting where a posted payout came from would rewrite what a completed
  -- reconciliation was about.
  if tg_op = 'UPDATE'
     and old.ledger_entry_id is not null
     and new.bank_account_id is distinct from old.bank_account_id then
    raise exception 'this remittance has already been posted to the ledger; the account it left cannot be changed';
  end if;

  if new.bank_account_id is null then
    new.bank_account_id := client_funds_bank_account(new.org_id, new.currency);
  end if;

  select * into bank from bank_accounts where id = new.bank_account_id;

  if bank.id is null then
    raise exception 'that bank account does not exist';
  end if;
  if bank.org_id is distinct from new.org_id then
    raise exception 'that bank account belongs to another organisation';
  end if;
  if bank.purpose <> 'client_funds' then
    raise exception 'a payout may only leave the segregated client-funds account, not the % account', bank.purpose;
  end if;
  if not bank.active then
    raise exception 'that client-funds account is no longer active';
  end if;
  if bank.currency is distinct from new.currency then
    raise exception 'a % payout cannot leave a % account', new.currency, bank.currency;
  end if;
  if bank.ledger_account_id is null then
    raise exception 'that client-funds account is not linked to a ledger account, so nothing posted from it could be reconciled';
  end if;

  return new;
end;
$$;

drop trigger if exists remittances_name_their_account on remittances;
create trigger remittances_name_their_account
  before insert or update of bank_account_id, currency, org_id on remittances
  for each row execute function remittance_names_its_account();

comment on function remittance_names_its_account() is
  'Stamps and validates the client-funds account a remittance leaves. On the table rather than in each creator function, so a payout path written later cannot omit it (0146).';

-- ── 5. Posting uses the account the remittance names ───────────────────────
--
-- Unchanged: idempotency via ledger_entry_id, the gross/net/fee split, the
-- payment status update. Changed: where the three accounts come from.
--   • the bank side is `r.bank_account_id`'s ledger account — the same account
--     reconciliation compares the statement against, by construction now
--     rather than by coincidence
--   • the liability and fee accounts resolve IN THE REMITTANCE'S CURRENCY,
--     which is what 0103 did for every money-in path and never reached here
create or replace function record_remittance_sent(
  p_id uuid,
  p_transfer_code text,
  p_sent_at timestamptz default now()
)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  r remittances%rowtype;
  bank bank_accounts%rowtype;
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

  select * into bank from bank_accounts where id = r.bank_account_id;
  if bank.id is null or bank.ledger_account_id is null then
    raise exception 'this remittance does not name a client-funds account to post against';
  end if;

  -- ⚠️ Deliberately NOT re-checking that the account is still active. The
  -- money has already left it; refusing to write that down because the account
  -- was closed this morning would leave a real transfer unrecorded, which is
  -- the worse of the two states by a distance.
  v_bank := bank.ledger_account_id;
  v_liability := canonical_ledger_account(r.org_id, v_purpose, r.currency);
  v_fee := canonical_ledger_account(r.org_id, 'fee_income', r.currency);

  if v_liability is null then
    raise exception 'this organisation has no % account in %, so this payout cannot be settled',
      replace(v_purpose::text, '_', ' '), r.currency;
  end if;
  if (r.management_fee + r.admin_fee) > 0 and v_fee is null then
    raise exception 'this organisation has no fee income account in %, so the fee cannot be recognised', r.currency;
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
  -- difference is fee income we have earned.
  insert into ledger_postings (org_id, entry_id, account_id, amount, memo)
  values (r.org_id, v_entry, v_liability, r.gross_amount, 'Obligation settled'),
         (r.org_id, v_entry, v_bank, -r.net_amount,
          'Paid via ' || r.gateway || ' from ' || bank.label);

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

  if r.payment_id is not null then
    update payments set status = 'remitted', remittance_reference = r.reference
     where id = r.payment_id;
  end if;

  return v_entry;
end;
$$;

revoke all on function record_remittance_sent(uuid, text, timestamptz) from public, anon, authenticated;
grant execute on function record_remittance_sent(uuid, text, timestamptz) to service_role;

comment on function record_remittance_sent is
  'Posts a sent remittance to the ledger, crediting the client-funds account THE REMITTANCE NAMES and settling the liability and fee in its own currency. Idempotent on ledger_entry_id (0146).';
