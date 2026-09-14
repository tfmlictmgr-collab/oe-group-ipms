-- SECURITY FIX — two SECURITY DEFINER functions took an org id and never checked
-- it belonged to the caller.
--
--   canonical_ledger_account(p_org_id, p_purpose)   -- 0036
--   collection_bank_account(p_org_id)               -- 0035, 0036
--
-- Both are `security definer` (so they bypass RLS by design) and both were
-- granted to `authenticated`. Neither compared `p_org_id` to the caller's own
-- org. Any signed-in user — a tenant, a vendor, a member of the other brand —
-- could call:
--
--   supabase.rpc('collection_bank_account', { p_org_id: '<another org uuid>' })
--
-- and receive that org's internal client-funds ledger account id.
--
-- What leaks is a UUID rather than money or personal data, so the blast radius
-- is small. The defect is not: this is precisely the failure mode flagged when
-- the viewer views were written — a definer boundary whose body is the ONLY
-- check — and it was reintroduced hours later in a function instead of a view.
-- A definer function that accepts an org id must verify that org id. There is
-- no version of that rule with exceptions.
--
-- The service role must still pass. `record_collection` is itself a definer
-- function invoked by the webhook under the service role, where `auth.uid()` is
-- null and `current_user_org_id()` is therefore null; the same allowance the
-- rest of the schema already makes (see `ensure_default_ledger_accounts`).

create or replace function canonical_ledger_account(
  p_org_id uuid,
  p_purpose ledger_account_purpose
)
returns uuid language plpgsql stable security definer set search_path = public as $$
begin
  -- auth.uid() is null for the service role, which legitimately acts across orgs
  -- inside webhook handlers and seeds. Every other caller is confined to itself.
  if auth.uid() is not null and p_org_id is distinct from current_user_org_id() then
    raise exception 'not permitted to resolve accounts for another organisation';
  end if;

  return (
    select a.id
      from ledger_accounts a
     where a.org_id = p_org_id
       and a.purpose = p_purpose
       and a.active
     -- The standard chart account first ('1000', '2000', …), then oldest. Any
     -- extra account for a purpose is a later addition; the default one wins.
     order by (a.code ~ '^[0-9]+$') desc, a.code, a.created_at, a.id
     limit 1
  );
end;
$$;

create or replace function collection_bank_account(p_org_id uuid)
returns uuid language plpgsql stable security definer set search_path = public as $$
begin
  if auth.uid() is not null and p_org_id is distinct from current_user_org_id() then
    raise exception 'not permitted to resolve accounts for another organisation';
  end if;

  return coalesce(
    -- The account reconciliation actually compares against.
    (select b.ledger_account_id
       from bank_accounts b
      where b.org_id = p_org_id
        and b.purpose = 'client_funds'
        and b.active
        and b.ledger_account_id is not null
      limit 1),
    canonical_ledger_account(p_org_id, 'client_funds')
  );
end;
$$;

revoke all on function canonical_ledger_account(uuid, ledger_account_purpose) from public;
revoke all on function collection_bank_account(uuid) from public;
grant execute on function canonical_ledger_account(uuid, ledger_account_purpose)
  to service_role, authenticated;
grant execute on function collection_bank_account(uuid) to service_role, authenticated;

comment on function canonical_ledger_account(uuid, ledger_account_purpose) is
  'Default ledger account for a purpose. SECURITY DEFINER: verifies the caller belongs to p_org_id (service role exempt). Never remove that check — the function bypasses RLS.';
comment on function collection_bank_account(uuid) is
  'Ledger account incoming client money is debited to. SECURITY DEFINER: verifies the caller belongs to p_org_id (service role exempt).';
