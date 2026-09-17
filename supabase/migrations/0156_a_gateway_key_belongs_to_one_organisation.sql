-- TFML and OEA each collect into their own Paystack merchant account.
--
-- ⚠️ THE STATE BEFORE THIS. `getGateway()` read `PAYSTACK_SECRET_KEY` from the
-- environment — ONE key pair for the entire platform, both gateways. Every
-- collection from every organisation landed in the same merchant account, and
-- every Paystack Transfer drew on the same balance. With one live client that
-- was invisible. With two brands and a service-charge client it means a TFML
-- vendor is paid out of whatever balance that variable happens to name.
--
-- 📌 This was briefed as "mirror the existing Flutterwave per-org pattern".
-- There is no such pattern: Flutterwave is a global env var too, and
-- `verify-fx-collections` proves per-CURRENCY ledger segregation, not per-ORG
-- gateway segregation. The real precedent is `channel_routes` — per-org
-- credentials that 0039 stripped of every policy and grant because a signed-in
-- tenant could read them, and that 0047 extended with per-org bot tokens under
-- that same protection. This follows that, not the one named.
--
-- ── Three separations, because they are three different secrets ───────────
--   public_key      NOT a secret. Paystack publishes it; it initialises
--                   checkout in the browser. Readable by the org.
--   secret_key      The merchant account's entire authority — it can charge
--                   cards and move the balance. Never readable by anyone.
--   webhook_secret  Proves a notification came from Paystack for THIS org.
--                   Never readable by anyone.
--
-- The same distinction 0147 drew for Telegram: the handle is public, the token
-- is not, and putting them in one column is how one leaks with the other.
--
-- ── Encryption ────────────────────────────────────────────────────────────
-- Ciphertext only. AES-256-GCM, and the key lives in the application
-- environment (`GATEWAY_CREDENTIAL_KEY`) — deliberately NOT in the database and
-- deliberately not Supabase Vault. Anything holding the service-role key can
-- read `vault.decrypted_secrets`, which would make a leaked service-role key
-- and a leaked set of live payment keys the same event. `.env.local` already
-- sits on two machines and the service role is used throughout the money paths,
-- so the two are worth keeping apart: a database compromise alone must not
-- yield the ability to charge cards.
--
-- The database therefore never sees a usable key and cannot decrypt one. That
-- is the point, and it is why there is no "show me the key" function here at
-- any privilege level.

create table if not exists org_gateway_credentials (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null references orgs(id) on delete cascade,
  gateway        text not null check (gateway in ('paystack', 'flutterwave')),

  -- Public by construction. This one may be read.
  public_key     text,

  -- AES-256-GCM ciphertext, base64, `iv:tag:ciphertext`. Opaque here.
  secret_key_enc      text not null,
  webhook_secret_enc  text,

  -- Which Paystack account this is, WITHOUT holding the key that proves it.
  -- Derived from the key prefix at save time (sk_test_ / sk_live_).
  key_mode       text not null check (key_mode in ('test', 'live')),
  -- Last four of the SECRET key, for "is this the one I pasted?" and nothing
  -- else. Four characters cannot reconstruct a key and are what every payment
  -- dashboard shows.
  secret_last4   text check (secret_last4 is null or length(secret_last4) = 4),

  active         boolean not null default true,
  configured_by  uuid references users(id),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),

  -- One live credential per (org, gateway). A second would make "which key
  -- charges this card" a matter of row order.
  constraint org_gateway_credentials_one_active
    unique (org_id, gateway, active) deferrable initially immediate
);

-- The uniqueness that actually matters: at most one ACTIVE row per pair.
-- A plain unique on (org_id, gateway, active) would still permit many inactive
-- rows, which is what we want — superseded keys stay for the audit trail.
drop index if exists org_gateway_credentials_active_uidx;
create unique index org_gateway_credentials_active_uidx
  on org_gateway_credentials (org_id, gateway) where active;

alter table org_gateway_credentials enable row level security;

-- ⚠️ NO POLICIES AND NO GRANTS — the 0039 rule, for the same reason. Two of the
-- three columns are credentials, and a table holding a credential must not be
-- selectable by a signed-in session at all, however narrow the policy looks
-- when it is written. Everything the UI needs comes from
-- `org_gateway_status()` below, which cannot return a secret because it does
-- not select one.
revoke all on table org_gateway_credentials from anon, authenticated;

comment on table org_gateway_credentials is
  'Per-org payment gateway credentials. Secret key and webhook secret are AES-256-GCM ciphertext whose key lives in the application environment, never here — the database cannot decrypt these. Service-role only, no policies, no grants (the 0039 rule for channel_routes). Read the org-safe view of it through org_gateway_status() (0154).';

comment on column org_gateway_credentials.public_key is
  'Paystack PUBLIC key. Not a secret — it initialises checkout in the browser and Paystack publishes it. Readable, unlike the two columns beside it (0147''s handle-vs-token distinction).';
comment on column org_gateway_credentials.secret_key_enc is
  'CREDENTIAL, encrypted. The merchant account''s entire authority. AES-256-GCM, iv:tag:ciphertext base64, key in GATEWAY_CREDENTIAL_KEY. Nothing in the database can decrypt this and nothing should try.';

-- ── The org-safe view ─────────────────────────────────────────────────────
--
-- What an administrator legitimately needs to know: is a key configured, is it
-- test or live, which one is it, and who set it. None of that requires the key.
create or replace function org_gateway_status(p_org_id uuid default null)
returns table (
  gateway       text,
  configured    boolean,
  key_mode      text,
  public_key    text,
  secret_last4  text,
  configured_by uuid,
  updated_at    timestamptz
)
language sql stable security definer set search_path = public as $$
  select c.gateway, true, c.key_mode, c.public_key, c.secret_last4,
         c.configured_by, c.updated_at
    from org_gateway_credentials c
   where c.active
     and c.org_id = coalesce(p_org_id, current_user_org_id())
     -- An administrator of the org it belongs to, or the operator. Asked here
     -- rather than by policy because the table itself must stay unreadable.
     and (
       (c.org_id = current_user_org_id() and current_user_role() = 'admin')
       or caller_is_operator_admin()
     );
$$;

revoke all on function org_gateway_status(uuid) from public, anon;
grant execute on function org_gateway_status(uuid) to authenticated, service_role;

comment on function org_gateway_status is
  'Whether an org has a gateway configured, in which mode, and who set it — never the key. The only route by which a signed-in session learns anything about org_gateway_credentials (0154).';

-- ── Saving one ────────────────────────────────────────────────────────────
--
-- The ciphertext is produced by the APPLICATION and handed here already
-- encrypted; this function stores it. It cannot encrypt, because the key is
-- deliberately not available to Postgres.
--
-- Supersede rather than update: the previous row is deactivated and kept. A
-- key that stopped working should leave evidence of when it was replaced and by
-- whom, which an in-place UPDATE destroys.
create or replace function set_org_gateway_credential(
  p_gateway        text,
  p_public_key     text,
  p_secret_enc     text,
  p_webhook_enc    text,
  p_key_mode       text,
  p_secret_last4   text,
  p_org_id         uuid default null
)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_org uuid := coalesce(p_org_id, current_user_org_id());
  v_id  uuid;
begin
  if auth.uid() is null then
    raise exception 'your session expired — sign in again';
  end if;

  -- An administrator of the org whose money this is, or the operator acting for
  -- them. Not finance: this is the account itself, not a payment out of it.
  if not (
    (v_org = current_user_org_id() and current_user_role() = 'admin')
    or caller_is_operator_admin()
  ) then
    raise exception 'only an administrator of this organisation may connect its payment gateway';
  end if;

  if p_gateway not in ('paystack', 'flutterwave') then
    raise exception 'unknown gateway %', p_gateway;
  end if;
  if p_key_mode not in ('test', 'live') then
    raise exception 'a gateway key is either test or live';
  end if;
  if p_secret_enc is null or length(p_secret_enc) < 16 then
    raise exception 'the secret key did not arrive encrypted';
  end if;

  update org_gateway_credentials
     set active = false, updated_at = now()
   where org_id = v_org and gateway = p_gateway and active;

  insert into org_gateway_credentials (
    org_id, gateway, public_key, secret_key_enc, webhook_secret_enc,
    key_mode, secret_last4, configured_by
  ) values (
    v_org, p_gateway, nullif(trim(p_public_key), ''), p_secret_enc,
    nullif(trim(p_webhook_enc), ''), p_key_mode, p_secret_last4, auth.uid()
  )
  returning id into v_id;

  return v_id;
end;
$$;

revoke all on function set_org_gateway_credential(text, text, text, text, text, text, uuid) from public, anon;
grant execute on function set_org_gateway_credential(text, text, text, text, text, text, uuid) to authenticated, service_role;

comment on function set_org_gateway_credential is
  'Stores an already-encrypted gateway credential for an org. Supersedes rather than overwrites, so a replaced key leaves a record of when and by whom. Administrators of the owning org, or the operator (0154).';

-- ── The org tag that lets a webhook find its key ──────────────────────────
--
-- ⚠️ THE ORDERING PROBLEM. A webhook's signature must be verified with the
-- SENDING org's secret — but which org sent it is only knowable from the
-- payload, which is unverified until the signature checks out. Today the route
-- verifies with a global key at step 1 and resolves the org at step 5 by
-- looking up `gateway_reference`; with per-org secrets that order cannot stand.
--
-- The reference carries the answer instead. `payment_reference_org_tag()` maps
-- a tag back to an org, so the route can: read the reference from the raw body,
-- resolve the org, fetch THAT org's secret, and only then verify.
--
-- Using an unverified field to CHOOSE A KEY is safe, and worth being explicit
-- about: a forged payload naming another org's tag is verified against that
-- org's secret and fails. The choice cannot be exploited because a wrong choice
-- refuses. What would be unsafe is trusting any other field in that payload,
-- which the route does not.
alter table orgs add column if not exists gateway_tag text;

update orgs
   set gateway_tag = upper(substr(replace(id::text, '-', ''), 1, 6))
 where gateway_tag is null;

alter table orgs drop constraint if exists orgs_gateway_tag_shape;
alter table orgs add constraint orgs_gateway_tag_shape
  check (gateway_tag is null or gateway_tag ~ '^[A-Z0-9]{6}$');

drop index if exists orgs_gateway_tag_uidx;
create unique index orgs_gateway_tag_uidx on orgs (gateway_tag) where gateway_tag is not null;

comment on column orgs.gateway_tag is
  'Six characters embedded in every payment reference this org mints, so an incoming webhook can resolve WHICH org before verifying a signature it cannot verify without knowing. Opaque and non-authoritative — it selects a key, it never grants anything (0154).';

create or replace function payment_reference_org_tag(p_reference text)
returns uuid language sql stable security definer set search_path = public as $$
  -- OE-<TAG>-<PURPOSE>-<TIME>-<RAND>. Anything else is a pre-0154 reference
  -- and resolves to null, which the caller treats as "use the platform key".
  select o.id
    from orgs o
   where o.gateway_tag is not null
     and p_reference ~ '^OE-[A-Z0-9]{6}-'
     and o.gateway_tag = split_part(p_reference, '-', 2)
   limit 1;
$$;

revoke all on function payment_reference_org_tag(text) from public, anon, authenticated;
grant execute on function payment_reference_org_tag(text) to service_role;

comment on function payment_reference_org_tag is
  'The org that minted a payment reference, from the tag inside it. Returns null for references minted before 0154 — those predate per-org keys and must keep verifying against the platform key, or every in-flight payment breaks on deploy (0154).';
