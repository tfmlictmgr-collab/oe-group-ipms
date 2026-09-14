-- Third occurrence of the same mistake, so it becomes one function.
--
-- `0035` fixed `record_collection` picking a client-funds account with LIMIT 1
-- and no ORDER BY. The banking settings form does the same thing when it links
-- a bank account to its ledger counterpart — and it bit for real: an admin
-- configured the POC org's client-funds account and it was wired to a leftover
-- "Client funds (recon test)" ledger account left behind by a test script.
--
-- That is worse than the collections case. The bank account's ledger_account_id
-- is what reconciliation compares the statement against AND what the opening
-- balance is posted to, so a wrong link silently misdirects both.
--
-- One resolver, used everywhere a purpose must be turned into an account.

create or replace function canonical_ledger_account(
  p_org_id uuid,
  p_purpose ledger_account_purpose
)
returns uuid language sql stable security definer set search_path = public as $$
  select a.id
    from ledger_accounts a
   where a.org_id = p_org_id
     and a.purpose = p_purpose
     and a.active
   -- The standard chart account first ('1000', '2000', …), then oldest. Any
   -- extra account for a purpose is a later addition; the default one wins.
   order by (a.code ~ '^[0-9]+$') desc, a.code, a.created_at, a.id
   limit 1;
$$;

comment on function canonical_ledger_account(uuid, ledger_account_purpose) is
  'The default ledger account for a purpose. Deterministic — never let the planner choose which account money lands in.';

-- Collections keep preferring the account reconciliation actually compares
-- against, falling back to the canonical one for an org with no bank account
-- configured yet.
create or replace function collection_bank_account(p_org_id uuid)
returns uuid language sql stable security definer set search_path = public as $$
  select coalesce(
    (select b.ledger_account_id
       from bank_accounts b
      where b.org_id = p_org_id
        and b.purpose = 'client_funds'
        and b.active
        and b.ledger_account_id is not null
      limit 1),
    canonical_ledger_account(p_org_id, 'client_funds')
  );
$$;

revoke all on function canonical_ledger_account(uuid, ledger_account_purpose) from public;
grant execute on function canonical_ledger_account(uuid, ledger_account_purpose)
  to service_role, authenticated;
