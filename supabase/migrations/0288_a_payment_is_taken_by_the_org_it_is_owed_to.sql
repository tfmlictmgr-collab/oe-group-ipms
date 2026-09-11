-- 0288 — A payment is taken by the organisation it is owed to.
--
-- ⚠️ Reported 11 Sept 2026 with a screenshot of a Paystack receipt. An OEA
-- tenant paid their OEA rent on oeaportal.com, and the receipt Paystack sent
-- them read "Total Facilities Management Limited received your payment",
-- with TFML's support address as the place to complain. Paystack writes that
-- receipt itself, from the MERCHANT ACCOUNT the transaction ran on — so the
-- receipt was not mis-branded, it was accurate: the money went into TFML's
-- merchant account.
--
-- Measured, not assumed:
--   • `org_gateway_credentials` holds 0 rows. No organisation has ever
--     connected its own Paystack account.
--   • `getGatewayForOrg` (0156) falls back to the platform key when an org has
--     none, and `payMyRent` / the service-charge checkout did not even call
--     that — they called `getGateway()`, the platform key unconditionally.
--   • The platform key is TFML's merchant account (that receipt is Paystack
--     saying so).
--
-- So every organisation's collections — OEA rent, OEA service charge, the
-- client orgs — and every payout through `getGatewayForOrg` ran through TFML's
-- Paystack balance. In test mode that is a branding leak; with a live key it
-- is decision 2 broken outright: an OEA tenant's rent settling into TFML's
-- bank account, an OEA landlord paid out of TFML's balance, and a
-- reconciliation that can never agree because the money is in another
-- organisation's account.
--
-- The rule this migration gives the application to enforce:
--
--   An organisation's money moves through ITS OWN merchant account. The
--   platform key may be used only by the one organisation that owns it.
--   Anyone else with no account of their own is REFUSED an online checkout —
--   they can still pay by bank transfer into the organisation's own
--   client-funds account (0281) — never quietly routed through another's.
--
-- 1. `orgs.uses_platform_gateway` — which org owns the platform key. At most
--    one, by index. Set for TFML here on the evidence above; not in the
--    `authenticated` UPDATE allowlist (0083c's column list is explicit, so a
--    new column is not in it), so no org administrator can claim the platform
--    account for their own organisation.
-- 2. `payment_intents.merchant_account` — which account an intent was minted
--    on ('platform' | 'org'). Verification must use the SAME account that took
--    the payment, or a payment taken on one key is looked up on another and
--    reads as "not found" forever. NULL on every intent before today, and every
--    one of those was minted on the platform key (see the 0 rows above), which
--    is exactly how the code reads NULL.
-- 3. `payment_intents.receipt_sent_at` — a claim, so the receipt is sent once.
--    Settlement now has two doors (the gateway's webhook, and the payer
--    returning from checkout, which is verified server-to-server — Paystack's
--    own recommended pattern), and both may arrive; `record_collection` is
--    already idempotent, the email was not.
-- 4. `set_payment_intent_checkout()` — the ONE write path for the hosted
--    checkout address. The app used to write it through the caller's session,
--    and `payment_intents_update` admits only admin and finance — so for a
--    tenant (and an FM/PM raising a link) the UPDATE matched nothing and raised
--    nothing (decision 38's silent write). `checkout_url` stayed NULL,
--    "Continue payment" fell back to `/pay/<reference>` — the SIMULATED
--    checkout, which correctly refuses to exist once a real gateway is
--    configured — and the tenant got a 404. Measured on the reported intent:
--    `checkout_url` is null.
-- 5. `retire_unopened_payment_intent()` — lets the payer (or whoever raised it)
--    retire a pending intent whose checkout address was never recorded, AFTER
--    the application has asked the gateway and been told it was not paid. Such
--    an intent can never be continued (the gateway's URL is gone) and, while it
--    lives, the one-live-intent guard refuses a fresh one: a dead end.

alter table orgs add column if not exists uses_platform_gateway boolean not null default false;

create unique index if not exists orgs_one_platform_gateway_owner
  on orgs ((true)) where uses_platform_gateway and deleted_at is null;

comment on column orgs.uses_platform_gateway is
  'This org owns the platform-level PAYSTACK_SECRET_KEY / FLUTTERWAVE_SECRET_KEY merchant account. At most one. Every other org must connect its own account or take no online payments (0288).';

update orgs set uses_platform_gateway = true
 where slug = 'tfml' and deleted_at is null and not uses_platform_gateway;

alter table payment_intents add column if not exists merchant_account text;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'payment_intents_merchant_account_known') then
    alter table payment_intents add constraint payment_intents_merchant_account_known
      check (merchant_account is null or merchant_account in ('platform', 'org'));
  end if;
end $$;

comment on column payment_intents.merchant_account is
  'Which merchant account the checkout was opened on: platform = the platform key, org = the org''s own connected account. NULL = before 0288, all of which were platform.';

alter table payment_intents add column if not exists receipt_sent_at timestamptz;

-- ── 4. The checkout address, written once, by the person who opened it ────
create or replace function set_payment_intent_checkout(
  p_intent_id uuid,
  p_checkout_url text,
  p_merchant_account text
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v payment_intents%rowtype;
begin
  select * into v from payment_intents where id = p_intent_id for update;
  if v.id is null or v.org_id is distinct from current_user_org_id() then
    raise exception 'that payment could not be found';
  end if;
  if auth.uid() is null
     or (auth.uid() is distinct from v.payer_user_id and auth.uid() is distinct from v.created_by) then
    raise exception 'only the person paying, or who raised the payment, can open its checkout';
  end if;
  if v.status <> 'pending' or v.ledger_entry_id is not null then
    raise exception 'that payment is no longer open';
  end if;
  if p_merchant_account is null or p_merchant_account not in ('platform', 'org') then
    raise exception 'unknown merchant account %', p_merchant_account;
  end if;
  -- A hosted checkout page on the gateway itself, and nowhere else. This is an
  -- address a payer is sent to with a card in their hand; a column any caller
  -- could point at any site would be a phishing link with our name on it.
  if p_checkout_url is not null
     and p_checkout_url !~ '^https://(checkout\.paystack\.com|checkout-v2\.dev-flutterwave\.com|checkout\.flutterwave\.com|checkout-testing\.flutterwave\.com)/' then
    raise exception 'that is not a payment gateway checkout address';
  end if;
  -- Written once. The merchant account in particular decides which key the
  -- payment is verified against; it must not move after the payer has paid.
  if v.merchant_account is not null and v.merchant_account <> p_merchant_account then
    raise exception 'this payment was opened on a different merchant account';
  end if;

  update payment_intents
     set checkout_url = coalesce(v.checkout_url, p_checkout_url),
         merchant_account = coalesce(v.merchant_account, p_merchant_account)
   where id = p_intent_id;
end;
$$;

-- ── 5. A pending intent that can never be continued ───────────────────────
create or replace function retire_unopened_payment_intent(p_intent_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v payment_intents%rowtype;
begin
  select * into v from payment_intents where id = p_intent_id for update;
  if v.id is null or v.org_id is distinct from current_user_org_id() then
    raise exception 'that payment could not be found';
  end if;
  if auth.uid() is null
     or (auth.uid() is distinct from v.payer_user_id and auth.uid() is distinct from v.created_by) then
    raise exception 'only the person paying, or who raised the payment, can retire it';
  end if;
  -- Only one that genuinely cannot be continued: still pending, never posted,
  -- and with no checkout address to go back to. One WITH an address is
  -- continued, never retired, because the payer may be half-way through it.
  if v.status <> 'pending' or v.ledger_entry_id is not null or v.checkout_url is not null then
    raise exception 'that payment is still open and can be continued';
  end if;
  update payment_intents set status = 'abandoned' where id = p_intent_id;
end;
$$;

-- The list is public, anon, authenticated, service_role (0264 / decision 45).
revoke all on function set_payment_intent_checkout(uuid, text, text) from public, anon, authenticated, service_role;
revoke all on function retire_unopened_payment_intent(uuid) from public, anon, authenticated, service_role;
grant execute on function set_payment_intent_checkout(uuid, text, text) to authenticated;
grant execute on function retire_unopened_payment_intent(uuid) to authenticated;

-- ── Assertions ─────────────────────────────────────────────────────────────
do $$
declare
  n int;
begin
  select count(*) into n from orgs where uses_platform_gateway and deleted_at is null;
  if n > 1 then
    raise exception '0288: % organisations claim the platform merchant account', n;
  end if;

  -- Not writable by an org administrator through the API.
  if exists (
    select 1 from information_schema.column_privileges
     where table_schema = 'public' and table_name = 'orgs'
       and column_name = 'uses_platform_gateway'
       and grantee in ('authenticated', 'anon') and privilege_type = 'UPDATE'
  ) then
    raise exception '0288: uses_platform_gateway is in an UPDATE allowlist';
  end if;

  -- Exactly the grants declared above.
  if exists (
    select 1 from information_schema.routine_privileges
     where routine_schema = 'public'
       and routine_name in ('set_payment_intent_checkout', 'retire_unopened_payment_intent')
       and grantee in ('anon', 'public', 'service_role')
  ) then
    raise exception '0288: a checkout function is callable by anon, public or service_role';
  end if;
end $$;
