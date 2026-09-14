-- Bank accounts — org-configurable, admin-managed.
--
-- Deliberately a record an admin fills in from Settings rather than anything
-- hardcoded: each org banks differently, and TFML's client-funds account is not
-- OEA's. A placeholder can be created with nothing but a label, so the ledger
-- and reconciliation can be built and demonstrated before the real account
-- exists, then completed later without touching code.
--
-- PRIVACY: only the LAST FOUR digits are stored. The application never
-- initiates a transfer from stored bank details — payouts go through the
-- gateway with its own credentials — so the full number would be data held at
-- risk for no functional gain. Last four is enough to identify the account on a
-- statement, which is all reconciliation needs.

create type bank_account_purpose as enum ('client_funds', 'operating');

create table bank_accounts (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,

  label text not null,                       -- e.g. "Client funds — TFML"
  purpose bank_account_purpose not null default 'client_funds',

  bank_name text,
  account_name text,
  account_number_last4 text
    check (account_number_last4 is null or account_number_last4 ~ '^[0-9]{4}$'),
  currency text not null default 'NGN',

  -- The ledger account this bank account corresponds to. Reconciliation
  -- compares this account's balance against the bank statement.
  ledger_account_id uuid references ledger_accounts(id),

  -- Where the ledger starts. Until the opening entry is posted the ledger and
  -- the bank cannot agree, so this is tracked explicitly rather than assumed.
  opening_balance numeric(16,2) not null default 0,
  opening_date date,
  opening_entry_id uuid references ledger_entries(id),

  active boolean not null default true,
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index bank_accounts_org_idx on bank_accounts (org_id) where active;
-- One live client-funds account per org: two would make "the" segregated
-- balance ambiguous, which is exactly what segregation is meant to prevent.
create unique index bank_accounts_one_client_funds_uidx
  on bank_accounts (org_id) where purpose = 'client_funds' and active;

create trigger bank_accounts_touch before update on bank_accounts
  for each row execute function touch_updated_at();

alter table bank_accounts enable row level security;

-- Separation of duties: an ADMIN defines the account (configuration), while
-- FINANCE reconciles against it (operation). Finance therefore reads but does
-- not silently redefine the account it is reconciling.
create policy bank_accounts_select on bank_accounts for select
  using (org_id = current_user_org_id()
    and current_user_role() = any (array['admin','finance_approver']::user_role[]));

create policy bank_accounts_write on bank_accounts for all
  using (org_id = current_user_org_id() and current_user_role() = 'admin')
  with check (org_id = current_user_org_id() and current_user_role() = 'admin');

create trigger audit_bank_account after insert or update on bank_accounts
  for each row execute function log_audit('bank_account.write');

/**
 * Creates the standard chart of accounts for an org, if absent. Idempotent, so
 * it can be called on demand rather than needing a migration per org.
 *
 * Per-counterparty accounts (one per landlord, one per vendor) are created on
 * first use elsewhere — pooling them would defeat the overpayment guard, which
 * works precisely because each party has its own balance.
 */
create or replace function ensure_default_ledger_accounts(p_org_id uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if current_user_role() is distinct from 'admin'
     or current_user_org_id() is distinct from p_org_id then
    -- Allow the service role (auth.uid() is null) for seeds and system setup.
    if auth.uid() is not null then
      raise exception 'only an administrator of this organisation may set up the chart of accounts';
    end if;
  end if;

  insert into ledger_accounts (org_id, code, name, class, purpose)
  values
    (p_org_id, '1000', 'Client funds (bank)',        'asset',     'client_funds'),
    (p_org_id, '2000', 'Service charge funds held',  'liability', 'service_charge_fund'),
    (p_org_id, '2100', 'Landlord rent payable',      'liability', 'landlord_payable'),
    (p_org_id, '2200', 'Vendor payable',             'liability', 'vendor_payable'),
    (p_org_id, '2300', 'Tenant deposits held',       'liability', 'tenant_deposit'),
    (p_org_id, '4000', 'Management & admin fees',    'income',    'fee_income'),
    (p_org_id, '5000', 'Bank charges',               'expense',   'bank_charges'),
    (p_org_id, '9000', 'Suspense (unidentified)',    'liability', 'suspense')
  on conflict do nothing;
end;
$$;

revoke all on function ensure_default_ledger_accounts(uuid) from public;
grant execute on function ensure_default_ledger_accounts(uuid) to authenticated;

-- The unique index is on lower(code) per org; make the seeding above idempotent.
create unique index if not exists ledger_accounts_org_code_plain_uidx
  on ledger_accounts (org_id, code);
