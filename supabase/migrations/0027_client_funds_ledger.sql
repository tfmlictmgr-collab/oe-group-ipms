-- SEGREGATED CLIENT-FUNDS LEDGER (Day 4) — the highest-compliance-risk component.
--
-- CLAUDE.md locked decision #2: client money sits in OE Group's own designated
-- bank accounts, and OE Group authorises disbursement. That is a managed
-- client-funds arrangement, not licensed custody — which makes the in-app
-- ledger the actual control. If the ledger is wrong, nothing downstream is
-- trustworthy.
--
-- Four invariants are enforced by the DATABASE, not by application code, because
-- a bug or a direct PostgREST call must not be able to break them:
--
--   1. EVERY entry balances. Postings for one entry sum to exactly zero.
--   2. Entries are IMMUTABLE. No update, no delete — corrections are reversing
--      entries, so history can never be quietly rewritten.
--   3. Client funds cannot go NEGATIVE. You cannot disburse money you do not
--      hold.
--   4. A counterparty cannot be OVERPAID. You cannot pay a landlord or vendor
--      more than is owed to them — which is precisely how one client's money
--      ends up funding another's payout.
--
-- Amounts are signed numeric: debit positive, credit negative, and every entry
-- sums to zero. One column is harder to get wrong than a debit/credit pair
-- where a value can land in the wrong side.

create type ledger_account_class as enum ('asset', 'liability', 'income', 'expense');

-- What the account is FOR, so the invariants can target the right accounts
-- without string-matching on names.
create type ledger_account_purpose as enum (
  'client_funds',        -- the segregated bank account itself (asset)
  'landlord_payable',    -- rent collected, owed onward to a landlord (liability)
  'vendor_payable',      -- approved vendor invoices awaiting remittance (liability)
  'tenant_deposit',      -- deposits held on a tenant's behalf (liability)
  'service_charge_fund', -- SC collected for a property's budget (liability)
  'fee_income',          -- management/admin fee earned by the org (income)
  'bank_charges',        -- expense
  'suspense'             -- unidentified receipts pending allocation
);

create table ledger_accounts (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  code text not null,                      -- e.g. '1000', 'LL-ADEYEMI'
  name text not null,
  class ledger_account_class not null,
  purpose ledger_account_purpose not null,

  -- Whose money this represents. A per-landlord or per-vendor account is what
  -- makes "segregated" meaningful — one pooled liability account would let one
  -- party's balance mask another's.
  counterparty_user_id uuid references users(id),
  counterparty_vendor_id uuid references vendors(id),
  property_id uuid references properties(id),

  active boolean not null default true,
  created_at timestamptz not null default now()
);

create unique index ledger_accounts_org_code_uidx on ledger_accounts (org_id, lower(code));
create index ledger_accounts_org_purpose_idx on ledger_accounts (org_id, purpose);
create index ledger_accounts_counterparty_idx on ledger_accounts (counterparty_user_id);
create index ledger_accounts_vendor_idx on ledger_accounts (counterparty_vendor_id);

-- ── Journal ────────────────────────────────────────────────────────────────
create type ledger_source as enum (
  'opening_balance', 'collection', 'remittance', 'fee', 'adjustment',
  'bank_charge', 'reversal'
);

create table ledger_entries (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  entry_date date not null default current_date,
  description text not null,
  reference text,                          -- invoice no, payment ref, etc.
  source ledger_source not null default 'adjustment',

  -- What in the app caused this, so a posting can always be traced back.
  entity_type text,
  entity_id uuid,

  -- A correction points at what it reverses; the original always survives.
  reverses_entry_id uuid references ledger_entries(id),

  created_by uuid references users(id),
  created_at timestamptz not null default now()
);

create index ledger_entries_org_date_idx on ledger_entries (org_id, entry_date desc);
create index ledger_entries_entity_idx on ledger_entries (entity_type, entity_id);

create table ledger_postings (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  entry_id uuid not null references ledger_entries(id) on delete cascade,
  account_id uuid not null references ledger_accounts(id),
  -- Debit positive, credit negative. Zero is meaningless, so it is rejected.
  amount numeric(16,2) not null check (amount <> 0),
  memo text,
  created_at timestamptz not null default now()
);

create index ledger_postings_entry_idx on ledger_postings (entry_id);
create index ledger_postings_account_idx on ledger_postings (account_id);
create index ledger_postings_org_idx on ledger_postings (org_id);

-- ── Invariant 1: every entry balances ──────────────────────────────────────
-- A CONSTRAINT TRIGGER deferred to COMMIT, so header and lines can be inserted
-- in any order within one transaction, but an unbalanced entry can never be
-- committed.
create or replace function assert_entry_balanced()
returns trigger language plpgsql as $$
declare
  v_entry uuid := coalesce(new.entry_id, old.entry_id);
  v_sum numeric(16,2);
  v_count integer;
begin
  select coalesce(sum(amount), 0), count(*) into v_sum, v_count
  from ledger_postings where entry_id = v_entry;

  -- An entry deleted entirely (cascade) leaves nothing to check.
  if v_count = 0 then return null; end if;

  if v_count < 2 then
    raise exception 'ledger entry % must have at least two postings (got %)', v_entry, v_count;
  end if;
  if v_sum <> 0 then
    raise exception 'ledger entry % does not balance: postings sum to %', v_entry, v_sum;
  end if;
  return null;
end;
$$;

create constraint trigger ledger_postings_balanced
  after insert or update or delete on ledger_postings
  deferrable initially deferred
  for each row execute function assert_entry_balanced();

-- ── Invariants 3 & 4: no overdrawn funds, no overpaid counterparty ─────────
-- Also deferred, so a single balanced transaction is judged on its net effect
-- rather than on the order its lines happen to be inserted.
create or replace function assert_funds_available()
returns trigger language plpgsql as $$
declare
  v_account uuid := coalesce(new.account_id, old.account_id);
  acct ledger_accounts%rowtype;
  v_balance numeric(16,2);
begin
  select * into acct from ledger_accounts where id = v_account;
  if acct.id is null then return null; end if;

  select coalesce(sum(amount), 0) into v_balance
  from ledger_postings where account_id = v_account;

  -- Client funds are an asset: debit-normal, so the balance is what is held.
  -- Negative means money has been disbursed that was never received.
  if acct.purpose = 'client_funds' and v_balance < 0 then
    raise exception
      'client funds account % would go negative (%). You cannot disburse funds that are not held.',
      acct.code, v_balance;
  end if;

  -- Liabilities are credit-normal, so a NEGATIVE balance is what is owed and a
  -- POSITIVE balance means we have paid out more than we owe — i.e. we have
  -- spent someone else's money. This is the segregation guarantee.
  if acct.class = 'liability' and v_balance > 0 then
    raise exception
      'account % would be overpaid by % — a counterparty cannot be paid more than is owed to them.',
      acct.code, v_balance;
  end if;

  return null;
end;
$$;

create constraint trigger ledger_postings_funds_available
  after insert or update or delete on ledger_postings
  deferrable initially deferred
  for each row execute function assert_funds_available();

-- ── Invariant 2: immutability ──────────────────────────────────────────────
-- The service role is exempt so seeds and system reversals work, but no
-- authenticated user can alter or remove a posted entry. Corrections must be
-- reversing entries, which leave both sides visible.
create or replace function block_ledger_mutation()
returns trigger language plpgsql as $$
begin
  if auth.uid() is not null then
    raise exception
      'the ledger is append-only; % on % is not permitted. Post a reversing entry instead.',
      TG_OP, TG_TABLE_NAME;
  end if;
  return coalesce(new, old);
end;
$$;

create trigger ledger_entries_immutable before update or delete on ledger_entries
  for each row execute function block_ledger_mutation();
create trigger ledger_postings_immutable before update or delete on ledger_postings
  for each row execute function block_ledger_mutation();

-- ── Access ─────────────────────────────────────────────────────────────────
alter table ledger_accounts enable row level security;
alter table ledger_entries  enable row level security;
alter table ledger_postings enable row level security;

-- Money is finance + admin only. An FM/PM manages operations, not the ledger;
-- owners see their own portfolio reporting, not the client-funds ledger.
create policy ledger_accounts_select on ledger_accounts for select
  using (org_id = current_user_org_id()
    and current_user_role() = any (array['admin','finance_approver']::user_role[]));
create policy ledger_entries_select on ledger_entries for select
  using (org_id = current_user_org_id()
    and current_user_role() = any (array['admin','finance_approver']::user_role[]));
create policy ledger_postings_select on ledger_postings for select
  using (org_id = current_user_org_id()
    and current_user_role() = any (array['admin','finance_approver']::user_role[]));

create policy ledger_accounts_write on ledger_accounts for all
  using (org_id = current_user_org_id()
    and current_user_role() = any (array['admin','finance_approver']::user_role[]))
  with check (org_id = current_user_org_id()
    and current_user_role() = any (array['admin','finance_approver']::user_role[]));

-- Insert only — the immutability triggers block the rest.
create policy ledger_entries_insert on ledger_entries for insert
  with check (org_id = current_user_org_id()
    and current_user_role() = any (array['admin','finance_approver']::user_role[]));
create policy ledger_postings_insert on ledger_postings for insert
  with check (org_id = current_user_org_id()
    and current_user_role() = any (array['admin','finance_approver']::user_role[]));

create trigger audit_ledger_entry after insert on ledger_entries
  for each row execute function log_audit('ledger.entry');
create trigger audit_ledger_account_write after insert or update on ledger_accounts
  for each row execute function log_audit('ledger.account');

-- ── Balances ───────────────────────────────────────────────────────────────
-- A view rather than a stored balance: a stored total can drift from its
-- postings, and a ledger whose balance disagrees with its own history is worse
-- than no ledger. Postings are indexed by account, so this stays fast.
create or replace view ledger_account_balances as
  select
    a.id as account_id, a.org_id, a.code, a.name, a.class, a.purpose,
    a.counterparty_user_id, a.counterparty_vendor_id, a.property_id, a.active,
    coalesce(sum(p.amount), 0)::numeric(16,2) as balance,
    -- What a person expects to see: positive means "held" or "owed".
    case
      when a.class in ('asset', 'expense') then coalesce(sum(p.amount), 0)
      else -coalesce(sum(p.amount), 0)
    end::numeric(16,2) as natural_balance,
    count(p.id) as posting_count,
    max(p.created_at) as last_posted_at
  from ledger_accounts a
  left join ledger_postings p on p.account_id = a.id
  group by a.id;

/**
 * The segregation check, in one row: money held vs money owed.
 *
 * In a correctly-run client-funds account these must be equal. A positive
 * difference is unallocated cash; a NEGATIVE difference means client money has
 * been used for something it should not have been — the single most important
 * number in the system.
 */
create or replace view client_funds_position as
  select
    b.org_id,
    sum(b.natural_balance) filter (where b.purpose = 'client_funds') as funds_held,
    sum(b.natural_balance) filter (
      where b.class = 'liability'
        and b.purpose in ('landlord_payable','vendor_payable','tenant_deposit','service_charge_fund')
    ) as funds_owed,
    (
      coalesce(sum(b.natural_balance) filter (where b.purpose = 'client_funds'), 0)
      - coalesce(sum(b.natural_balance) filter (
          where b.class = 'liability'
            and b.purpose in ('landlord_payable','vendor_payable','tenant_deposit','service_charge_fund')
        ), 0)
    )::numeric(16,2) as unallocated
  from ledger_account_balances b
  group by b.org_id;

-- Views inherit the RLS of their underlying tables (security_invoker), so no
-- separate policy is needed and none can be forgotten.
alter view ledger_account_balances set (security_invoker = on);
alter view client_funds_position set (security_invoker = on);

-- ── Admin-configurable fee ─────────────────────────────────────────────────
-- OEA deducts a management fee from rent before remitting to the landlord
-- (CLAUDE.md OEA decision #1). Admin-configurable, defaulting to 0 so nothing
-- is ever deducted by accident before the real figure is confirmed.
alter table payment_settings
  add column if not exists management_fee_percent numeric(5,2) not null default 0
    check (management_fee_percent >= 0 and management_fee_percent <= 100);
alter table payment_settings
  add column if not exists admin_fee_percent numeric(5,2) not null default 0
    check (admin_fee_percent >= 0 and admin_fee_percent <= 100);
