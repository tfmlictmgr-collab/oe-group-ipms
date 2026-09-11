-- Fixes from the Day-6 code review.
--
-- Three unrelated defects, none of them live faults, all of them the kind that
-- become one later:
--   1. remittance posting resolved its accounts with a private query instead of
--      the shared resolver
--   2. the opening balance was written in two round trips, so a failure could
--      leave an entry with no postings
--   3. an auth lookup relied on an invariant rather than stating it

-- ── 1. One resolver, everywhere ────────────────────────────────────────────
--
-- `record_remittance_sent` still resolved v_liability/v_fee with its own
-- `order by created_at, id limit 1`, while `canonical_ledger_account` (0036)
-- exists precisely so that "which account is this?" has ONE answer. Both are
-- deterministic, so nothing was posting to a random account — but they order
-- differently (the resolver prefers the numeric chart code), so an org holding
-- two active accounts for a purpose would settle against a different account
-- than a collection credited. The books would disagree with themselves.

create or replace function record_remittance_sent(
  p_id uuid,
  p_transfer_code text,
  p_sent_at timestamptz default now()
)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  r remittances%rowtype;
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

  v_bank := collection_bank_account(r.org_id);
  v_liability := canonical_ledger_account(r.org_id, v_purpose);
  v_fee := canonical_ledger_account(r.org_id, 'fee_income');

  if v_bank is null or v_liability is null then
    raise exception 'the chart of accounts is not set up for this organisation';
  end if;
  if (r.management_fee + r.admin_fee) > 0 and v_fee is null then
    raise exception 'no fee income account exists to post the fee to';
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
         (r.org_id, v_entry, v_bank, -r.net_amount, 'Paid via ' || r.gateway);

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

revoke all on function record_remittance_sent(uuid, text, timestamptz) from public;
grant execute on function record_remittance_sent(uuid, text, timestamptz) to service_role;

-- ── 2. The opening balance posts atomically ────────────────────────────────
--
-- It was: insert the entry, then insert the postings, from the application. If
-- the second call failed the first had already committed, leaving an entry with
-- no postings — a row the balancing trigger never sees, because that trigger
-- fires on POSTINGS. Every other money path in this build (record_collection,
-- record_remittance_sent) is one function for exactly this reason.

create or replace function record_opening_balance(
  p_bank_account_id uuid,
  p_as_of date,
  p_allocations jsonb          -- [{"accountId": uuid, "amount": numeric}, ...]
)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  bank bank_accounts%rowtype;
  v_total numeric(16,2) := 0;
  v_entry uuid;
  v_line jsonb;
  v_role user_role := current_user_role();
begin
  select * into bank from bank_accounts where id = p_bank_account_id for update;
  if bank.id is null then
    raise exception 'that bank account could not be found';
  end if;

  -- The caller's own authority, checked here because this is SECURITY DEFINER.
  -- The service role (auth.uid() is null) is allowed through for seeds.
  if auth.uid() is not null then
    if bank.org_id is distinct from current_user_org_id() then
      raise exception 'that bank account belongs to another organisation';
    end if;
    if v_role is distinct from 'admin' and v_role is distinct from 'finance_approver' then
      raise exception 'only an administrator or finance approver can record an opening balance';
    end if;
  end if;

  if bank.opening_entry_id is not null then
    raise exception 'an opening balance has already been recorded for this account';
  end if;
  if bank.ledger_account_id is null then
    raise exception 'this bank account is not linked to a ledger account yet';
  end if;

  for v_line in select * from jsonb_array_elements(p_allocations) loop
    v_total := v_total + coalesce((v_line->>'amount')::numeric, 0);
  end loop;

  if v_total <= 0 then
    raise exception 'an opening balance needs at least one positive allocation';
  end if;

  insert into ledger_entries (org_id, entry_date, description, source,
                              entity_type, entity_id, created_by)
  values (bank.org_id, p_as_of, 'Opening balance — ' || bank.label,
          'opening_balance', 'bank_account', bank.id, auth.uid())
  returning id into v_entry;

  -- Debit the bank for the total.
  insert into ledger_postings (org_id, entry_id, account_id, amount, memo)
  values (bank.org_id, v_entry, bank.ledger_account_id, v_total,
          'Funds held at go-live');

  -- Credit each liability for its share. The deferred balancing trigger rejects
  -- the WHOLE transaction if these disagree, which is the point of doing it here.
  for v_line in select * from jsonb_array_elements(p_allocations) loop
    if coalesce((v_line->>'amount')::numeric, 0) > 0 then
      insert into ledger_postings (org_id, entry_id, account_id, amount, memo)
      values (bank.org_id, v_entry, (v_line->>'accountId')::uuid,
              -((v_line->>'amount')::numeric), 'Opening allocation');
    end if;
  end loop;

  update bank_accounts
     set opening_balance = v_total, opening_date = p_as_of, opening_entry_id = v_entry
   where id = bank.id;

  return jsonb_build_object('total', v_total, 'entryId', v_entry);
end;
$$;

revoke all on function record_opening_balance(uuid, date, jsonb) from public;
grant execute on function record_opening_balance(uuid, date, jsonb) to authenticated, service_role;

-- ── 3. State the invariant instead of relying on it ────────────────────────
--
-- `auth_account_state` matched an email with `limit 1` and no ORDER BY. Supabase
-- enforces email uniqueness on auth.users, so it is not currently ambiguous —
-- but this exact pattern has now been wrong four times in this codebase, and the
-- one place it must never be wrong is an account-takeover check.

create or replace function auth_account_state(p_email text)
returns table (user_id uuid, is_confirmed boolean, has_signed_in boolean)
language sql
security definer
set search_path = auth, public
as $$
  select u.id,
         u.email_confirmed_at is not null,
         u.last_sign_in_at is not null
    from auth.users u
   where lower(u.email) = lower(trim(p_email))
   order by u.created_at, u.id
   limit 1;
$$;

revoke all on function auth_account_state(text) from public, anon, authenticated;
grant execute on function auth_account_state(text) to service_role;
