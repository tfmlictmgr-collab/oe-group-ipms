-- A payer is told where to pay, and says where they paid from (10 Sept 2026).
--
-- Three reports off one screen, and the first two are the same gap seen from
-- either end of a bank transfer.
--
-- ⚠️ 1. THE PRODUCT CANNOT SAY WHERE TO SEND MONEY. `0281`'s form asks "which of
-- our accounts you paid into" and offers the org's client-funds accounts — which
-- is right for somebody who has ALREADY paid, and useless to somebody about to.
-- The board asked for the button to read "make a direct bank transfer" as well
-- as "I paid another way", and the moment it does, the page has to answer the
-- obvious next question: pay into WHAT?
--
-- It could not. `bank_accounts` holds `account_number_last4` and nothing else —
-- correct and deliberate for a PAYOUT destination (decision 17: the number goes
-- to the gateway once and is never stored), and wrong for the one account whose
-- number is meant to be published. An organisation's own collection account is
-- printed on every invoice it issues; withholding it from the person trying to
-- pay is not a privacy control, it is a missing field.
--
--   `published_account_number` is therefore added, and constrained to
--   `client_funds` accounts ONLY. The name says what it is for. A payout or
--   operating account cannot carry one, so nothing here weakens decision 17's
--   rule about accounts money is sent TO.
--
-- ⚠️ 2. AND NOTHING RECORDED WHERE THE MONEY CAME FROM. Finance matches a
-- reported payment against a bank statement, and a statement line names the
-- SENDER. The form captured a free-text "your bank/teller reference" and no
-- account at all, so the one field that most reliably identifies a credit was
-- missing. The board asked for a bank dropdown with the account name filled in
-- from the number — which is Nigerian account-name resolution, and which this
-- codebase already does for vendor payouts.
--
--   📌 Stored exactly as `payout_recipients` stores it and for the same reason:
--   the BANK, the RESOLVED NAME, and the LAST FOUR. The full number goes to
--   Paystack to be resolved and is never written down. `0262` found the opposite
--   mistake live — a full ten-digit number sitting in an `account_name` column —
--   so the check that refuses it is copied here rather than trusted to a form.
--
--   ⚠️ And resolution must NOT go through `createTransferRecipient`. That call
--   resolves a name as a side effect of creating a PAYOUT TARGET, and turning
--   every tenant's account into one would be the precise inversion of the
--   control decision 17 exists to keep. `lib/bank-actions.ts` calls
--   `GET /bank/resolve` and nothing else.

-- ── 1. The account a payer is told to pay into ──────────────────────────────

alter table bank_accounts add column if not exists published_account_number text;

comment on column bank_accounts.published_account_number is
  'The full account number PRINTED ON INVOICES so a payer can transfer into it. Client-funds accounts only — this is money coming IN, and is never used to send money out (0286).';

alter table bank_accounts drop constraint if exists bank_accounts_published_number_is_collection;
alter table bank_accounts add constraint bank_accounts_published_number_is_collection
  check (
    published_account_number is null
    or (purpose = 'client_funds' and published_account_number ~ '^[0-9]{6,20}$')
  );

-- ── 2. What the payer says about their own account ──────────────────────────

alter table offline_payment_claims add column if not exists payer_bank_name text;
alter table offline_payment_claims add column if not exists payer_account_name text;
alter table offline_payment_claims add column if not exists payer_account_last4 text;

comment on column offline_payment_claims.payer_account_name is
  'The account name AS THE BANK GAVE IT for the account the money came from — resolved, not typed, so it is evidence rather than a claim (0286).';
comment on column offline_payment_claims.payer_account_last4 is
  'Last four digits only. The full number is sent to the gateway to resolve the name and never stored — decision 17, and the rule payout_recipients already follows.';

alter table offline_payment_claims drop constraint if exists offline_claims_payer_account_shape;
alter table offline_payment_claims add constraint offline_claims_payer_account_shape
  check (
    (payer_account_last4 is null or payer_account_last4 ~ '^[0-9]{4}$')
    -- 0262's finding, copied rather than trusted to a form: an account NAME
    -- that is a run of digits is an account NUMBER in the wrong box, and the
    -- box it is in is the one we publish to three desks.
    and (payer_account_name is null or payer_account_name !~ '^[\d\s-]{6,}$')
  );

-- ── 3. The payer's own view of where to pay ─────────────────────────────────
--
-- Rebuilt with the published number. Still definer and still scoped to the
-- caller's own org: a tenant cannot read `bank_accounts` at all, and this is the
-- one thing about it they must be able to see.
--
-- ⚠️ DROPPED first: adding a column to a RETURNS TABLE changes the return type,
-- which `create or replace` refuses outright ("cannot change return type of
-- existing function"). The drop is what makes the explicit revoke below matter
-- rather than being belt-and-braces — Supabase re-applies its default grants to
-- a freshly created function, which is `0264`'s finding and `0263`'s before it.
drop function if exists org_client_funds_accounts();

create or replace function org_client_funds_accounts()
returns table (
  id uuid,
  label text,
  bank_name text,
  account_name text,
  account_number_last4 text,
  published_account_number text,
  currency text
)
language sql stable security definer set search_path = public as $fn$
  select b.id, b.label, b.bank_name, b.account_name, b.account_number_last4,
         b.published_account_number, b.currency
    from bank_accounts b
   where b.org_id = current_user_org_id()
     and b.purpose = 'client_funds'
     and b.active
   order by b.currency, b.label;
$fn$;

comment on function org_client_funds_accounts is
  'The organisation''s own designated client-funds accounts, as a payer needs to see them: which bank, in what name, and the number to transfer into. Client-funds only, so no payout account is ever exposed here (0281/0286).';

revoke all on function org_client_funds_accounts() from public, anon, authenticated;
grant execute on function org_client_funds_accounts() to authenticated, service_role;

-- ── 4. Recording where it came from ─────────────────────────────────────────
--
-- Three trailing parameters, all defaulted, so every existing caller — the
-- correction path and the chat path among them — is untouched.
--
-- ⚠️ A trailing DEFAULT still changes a function's identity in Postgres, so the
-- old signature is DROPPED first. `create or replace` alone leaves BOTH
-- callable, which is decision 39's recorded finding about `raise_work_order`
-- ("two ways to approve, one of them the behaviour being replaced") and was
-- caught there only by the migration failing on "function name is not unique".
drop function if exists submit_offline_payment_claim(
  offline_payment_method, numeric, date, uuid, text, jsonb, text, text, text, text, uuid
);

create or replace function submit_offline_payment_claim(
  p_method offline_payment_method,
  p_amount numeric,
  p_paid_on date,
  p_bank_account_id uuid,
  p_proof_path text,
  p_allocations jsonb,
  p_currency text default 'NGN',
  p_payer_reference text default null,
  p_payer_note text default null,
  p_proof_filename text default null,
  p_payer_user_id uuid default null,
  p_payer_bank_name text default null,
  p_payer_account_name text default null,
  p_payer_account_last4 text default null
)
returns uuid
language plpgsql security definer set search_path = public as $fn$
declare
  v_actor uuid := active_uid();
  v_org uuid;
  v_currency text := upper(trim(coalesce(p_currency, 'NGN')));
  v_bank bank_accounts%rowtype;
  v_claim_id uuid;
  v_ref text;
  v_payer uuid;
  v_email text;
  v_staff boolean;
begin
  if v_actor is null then
    raise exception 'your session expired - sign in again';
  end if;

  select org_id, email into v_org, v_email from users where id = v_actor;
  if v_org is null then
    raise exception 'your account is not attached to an organisation';
  end if;
  v_staff := has_permission('payments.record_offline');

  if p_amount is null or p_amount <= 0 then
    raise exception 'enter the amount you paid - it has to be more than nothing';
  end if;

  if p_proof_path is null or trim(p_proof_path) = '' then
    raise exception 'attach your payment proof - a transfer receipt, bank-app screenshot or teller slip';
  end if;

  if (storage.foldername(p_proof_path))[1] is distinct from v_org::text then
    raise exception 'that proof was not uploaded to this organisation';
  end if;

  if not exists (
    select 1 from storage.objects
     where bucket_id = 'payment-proofs' and name = p_proof_path
  ) then
    raise exception 'that proof could not be found - attach the file again';
  end if;

  if p_paid_on is null or p_paid_on > current_date then
    raise exception 'say what date the payment was made - it cannot be in the future';
  end if;

  select * into v_bank from bank_accounts where id = p_bank_account_id;
  if v_bank.id is null or v_bank.org_id is distinct from v_org then
    raise exception 'choose which of our accounts you paid into';
  end if;
  if not v_bank.active then
    raise exception 'that account is no longer in use - choose the account named on your demand';
  end if;
  if v_bank.purpose <> 'client_funds' then
    raise exception 'a tenant payment is paid into the client-funds account, not %', v_bank.label;
  end if;
  if upper(v_bank.currency) <> v_currency then
    raise exception 'that account holds %, and this payment is in %', v_bank.currency, v_currency;
  end if;

  if collection_bank_account(v_org, v_currency) is null then
    raise exception
      'no % client-funds account is set up for this organisation - an administrator needs to add one under Settings before a payment in that currency can be recorded',
      v_currency;
  end if;

  -- 0286. A last-four that is not four digits, or a "name" that is a run of
  -- digits, is refused here as well as by the constraint — so the person gets a
  -- sentence rather than a constraint name.
  if p_payer_account_last4 is not null
     and trim(p_payer_account_last4) <> ''
     and trim(p_payer_account_last4) !~ '^[0-9]{4}$' then
    raise exception 'the last four digits of the paying account should be four digits';
  end if;
  if p_payer_account_name is not null and trim(p_payer_account_name) ~ '^[\d\s-]{6,}$' then
    raise exception 'that looks like an account number rather than an account name';
  end if;

  v_ref := 'OPC-' || to_char(p_paid_on, 'YYYYMM') || '-' ||
           upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 6));

  insert into offline_payment_claims (
    org_id, reference, payer_user_id, payer_email, recorded_by, method,
    claimed_amount, currency, paid_on, destination_bank_account_id,
    payer_reference, payer_note, proof_path, proof_filename,
    payer_bank_name, payer_account_name, payer_account_last4
  ) values (
    v_org, v_ref, p_payer_user_id, null, v_actor, p_method,
    round(p_amount, 2), v_currency, p_paid_on, p_bank_account_id,
    nullif(trim(coalesce(p_payer_reference, '')), ''),
    nullif(trim(coalesce(p_payer_note, '')), ''),
    p_proof_path, nullif(trim(coalesce(p_proof_filename, '')), ''),
    nullif(trim(coalesce(p_payer_bank_name, '')), ''),
    nullif(trim(coalesce(p_payer_account_name, '')), ''),
    nullif(trim(coalesce(p_payer_account_last4, '')), '')
  )
  returning id into v_claim_id;

  v_payer := write_offline_claim_allocations(v_claim_id, p_allocations, round(p_amount, 2));

  update offline_payment_claims
     set payer_user_id = v_payer,
         payer_email = coalesce(
           (select u.email from users u where u.id = v_payer),
           case when v_payer is null and not v_staff then v_email end
         )
   where id = v_claim_id;

  return v_claim_id;
end;
$fn$;

revoke all on function submit_offline_payment_claim(
  offline_payment_method, numeric, date, uuid, text, jsonb, text, text, text, text, uuid,
  text, text, text
) from public, anon, authenticated;
grant execute on function submit_offline_payment_claim(
  offline_payment_method, numeric, date, uuid, text, jsonb, text, text, text, text, uuid,
  text, text, text
) to authenticated, service_role;

comment on function submit_offline_payment_claim is
  'Records a payment made by bank transfer or over a bank counter, with its proof, its breakdown and — where the payer gave them — the bank and resolved name of the account it came from. The ONE write path; neither claim table carries an insert policy (0281/0286).';

-- ── 5. Assertions ───────────────────────────────────────────────────────────
do $$
begin
  -- One overload, not two. Decision 39's finding.
  if (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname = 'submit_offline_payment_claim') <> 1 then
    raise exception 'submit_offline_payment_claim has more than one overload';
  end if;

  -- A published number belongs to a collection account and nowhere else.
  -- Asserted on the CONSTRAINT rather than by writing a row and rolling it back:
  -- an assertion that mutates the table it is checking has to be undone, and an
  -- undo that fails leaves the migration having damaged what it was verifying.
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'bank_accounts'::regclass
       and conname = 'bank_accounts_published_number_is_collection'
       and pg_get_constraintdef(oid) like '%client_funds%'
  ) then
    raise exception 'nothing stops a payout account carrying a published number';
  end if;

  -- 0262's mistake cannot be stored.
  if exists (
    select 1 from offline_payment_claims
     where payer_account_name ~ '^[\d\s-]{6,}$'
  ) then
    raise exception 'an account number is sitting in an account-name column';
  end if;

  -- The payer-facing reader must expose the number to pay INTO, and must still
  -- be client-funds only — it is the one bank detail a tenant may read.
  if pg_get_functiondef((select p.oid from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                          where n.nspname = 'public' and p.proname = 'org_client_funds_accounts'))
     not like '%published_account_number%' then
    raise exception 'the payer cannot be told which account to pay into';
  end if;
  if pg_get_functiondef((select p.oid from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                          where n.nspname = 'public' and p.proname = 'org_client_funds_accounts'))
     not like '%client_funds%' then
    raise exception 'org_client_funds_accounts stopped restricting itself to collection accounts';
  end if;

  if (select count(*) from information_schema.routine_privileges
       where routine_schema = 'public' and routine_name = 'submit_offline_payment_claim'
         and grantee in ('anon', 'PUBLIC')) > 0 then
    raise exception 'the submit path is callable anonymously';
  end if;
end $$;
