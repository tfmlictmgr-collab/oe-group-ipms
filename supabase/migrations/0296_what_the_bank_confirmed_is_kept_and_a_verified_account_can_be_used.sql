-- 0296 — What the bank confirmed is kept, a link says where it actually went,
-- and a verified account can be used for a bank transfer (14 Sept 2026).
--
-- Three reports from one payout, all of them measured before this was written.
--
-- ── 1. The payee was refused after the bank had confirmed their name ───────
--
-- The one-time bank-details page (0289) showed "Your bank holds this account in
-- the name AMAPAKABO IBIEBELE JOSEPH" and then refused to send: "Type the
-- account name exactly as your bank shows it." `submitPayoutDetails` asks the
-- bank AGAIN at submit, deliberately — "the name that is stored is the bank's".
-- But OEA's Paystack key is in test mode, and Paystack allows a test key three
-- real lookups a day (measured: 429 "Test mode daily limit of 3 live bank
-- resolves exceeded"). The second ask was refused, the server fell back to
-- "type it", and the page had hidden the name box because the first ask had
-- succeeded — a dead end with the right answer on screen.
--
-- The bank's first answer is now KEPT against the link: the name, and a binding
-- of (the link's own token, the bank, the number) as a SHA-256 — so a later
-- submission is matched to exactly the account the bank vouched for without the
-- number being stored (decision 17), and without anyone who can read this table
-- being able to recover it: the binding needs the raw token, which only the
-- payee's link holds (only its hash is stored). Submitting the same bank and
-- number uses the kept answer; anything else asks the bank afresh.
--
-- ── 2. "A link went to … and +234…" when nothing reached the phone ─────────
--
-- The vendor card printed the contacts TYPED into the request as though they
-- were where it went. Measured on the delivery log: the WhatsApp copy was
-- skipped ("no WhatsApp consent on record for this recipient (not a portal
-- user)") and the SMS copy has no provider. The request now records the
-- channels it was actually delivered on (`link_sent_to`), and the card says so.
--
-- ── 3. A verified account the bank-transfer route could not use ────────────
--
-- kemi soft services has a Paystack recipient — First Bank ···8803, name
-- verified — and the bank-transfer dialog said "no bank-transfer account yet".
-- Both true: decision 48's bank-transfer account is the bank, the name, the
-- last four AND a document the payment officer reads the full number from,
-- and a Paystack recipient has no document — the full number is held by
-- Paystack, never here (decision 17). It is also held on the WRONG Paystack
-- account: it was registered on 7 Sept, before OEA connected its own key, so it
-- lives on the platform (TFML) merchant account that decision 47 forbids OEA to
-- use. Same for 4 OEA and 35 Foundation POC recipients.
--
-- `adopt_gateway_account_for_transfer` makes such an account usable for a bank
-- transfer the way `adopt_registration_bank_details` already does for a
-- registration: the payment officer or an administrator attaches a document
-- showing the full number, the bank, the name and the last four are copied from
-- the verified record, and the adopter is recorded as the person who confirmed
-- it — so decision 48's maker-checker bars them from paying into it. Nothing
-- about the evidence rule is relaxed: a document is still required, and it is
-- read at the moment of transfer. The document lives under
-- `<org>/accounts/…` in `payout-evidence`, readable by the two desks that
-- register and pay accounts.

-- ── 1 & 2. Columns on the link ────────────────────────────────────────────
alter table payout_detail_requests
  add column if not exists name_check_binding text,
  add column if not exists name_check_name    text,
  add column if not exists name_checked_at    timestamptz,
  add column if not exists link_sent_to       text[];

comment on column payout_detail_requests.name_check_binding is
  'SHA-256 of (raw link token | bank code | account number) for the account the bank last confirmed through this link (0296). Not the number, and not recoverable without the raw token, which only the payee''s link holds.';
comment on column payout_detail_requests.link_sent_to is
  'The channels the link was actually delivered on, as reported by the senders (0296) — not the contacts that were typed.';

-- ── 3. Using a verified gateway account for a bank transfer ───────────────
create or replace function public.adopt_gateway_account_for_transfer(
  p_recipient_id uuid,
  p_evidence_path text,
  p_evidence_filename text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_me  users%rowtype;
  v_src payout_recipients%rowtype;
  v_id  uuid;
begin
  if v_uid is null then
    raise exception 'your session expired — sign in again';
  end if;
  if not current_user_is_active() then
    raise exception 'this account has been deactivated';
  end if;
  select * into v_me from users where id = v_uid;
  if v_me.role not in ('admin', 'finance_approver') then
    raise exception 'only the payment officer or an administrator may set how someone is paid';
  end if;

  select * into v_src from payout_recipients
   where id = p_recipient_id and org_id = v_me.org_id;
  if v_src.id is null then
    raise exception 'that account could not be found';
  end if;
  if v_src.gateway = 'manual' then
    raise exception 'that is already a bank-transfer account';
  end if;
  if not v_src.active or v_src.verified_at is null then
    raise exception 'only an active, verified account can be used for a bank transfer';
  end if;
  if v_src.party not in ('vendor', 'landlord') then
    raise exception 'a one-off payee on a requisition is asked for their details directly';
  end if;
  if v_src.bank_name is null or v_src.account_name is null or v_src.account_number_last4 is null then
    raise exception 'that account does not record a complete bank, name and last four digits';
  end if;

  -- The document must be real, in this organisation's own accounts folder —
  -- otherwise "a document is required" is a check on a string (decision 45).
  if p_evidence_path is null
     or split_part(p_evidence_path, '/', 1) <> v_me.org_id::text
     or split_part(p_evidence_path, '/', 2) <> 'accounts'
     or not exists (select 1 from storage.objects o
                     where o.bucket_id = 'payout-evidence' and o.name = p_evidence_path) then
    raise exception 'attach a document showing the full account number first';
  end if;

  update payout_recipients
     set active = false
   where org_id = v_me.org_id and party = v_src.party and gateway = 'manual' and active
     and vendor_id is not distinct from v_src.vendor_id
     and user_id   is not distinct from v_src.user_id;

  insert into payout_recipients (
    org_id, party, vendor_id, user_id, display_name,
    bank_name, account_name, account_number_last4,
    gateway, currency, active,
    verified_at, verified_by, details_source,
    evidence_bucket, evidence_path, evidence_filename,
    contact_email, contact_phone, created_by
  ) values (
    v_me.org_id, v_src.party, v_src.vendor_id, v_src.user_id, v_src.display_name,
    v_src.bank_name, v_src.account_name, v_src.account_number_last4,
    'manual', coalesce(v_src.currency, 'NGN'), true,
    now(), v_uid, 'gateway',
    'payout-evidence', p_evidence_path, nullif(btrim(coalesce(p_evidence_filename, '')), ''),
    v_src.contact_email, v_src.contact_phone, v_uid
  )
  returning id into v_id;

  return v_id;
end;
$$;

comment on function public.adopt_gateway_account_for_transfer(uuid, text, text) is
  'Makes a verified gateway recipient usable for a bank transfer, against a document the adopter attaches showing the full number (0296). The adopter is recorded as its confirmer, so decision 48''s maker-checker bars them from paying into it.';

revoke all on function public.adopt_gateway_account_for_transfer(uuid, text, text) from public, anon, authenticated, service_role;
grant execute on function public.adopt_gateway_account_for_transfer(uuid, text, text) to authenticated;

-- The accounts folder is read by the same two desks that register and pay.
create or replace function pg_temp.swap(p_def text, p_from text, p_to text, p_what text)
returns text language plpgsql as $$
declare n int;
begin
  n := (length(p_def) - length(replace(p_def, p_from, ''))) / greatest(length(p_from), 1);
  if n <> 1 then
    raise exception '0296 rebuild of %: expected exactly one match, found %', p_what, n;
  end if;
  return replace(p_def, p_from, p_to);
end $$;

do $$
declare d text;
begin
  d := pg_get_functiondef('public.may_read_payout_evidence(text)'::regprocedure);
  d := pg_temp.swap(d,
    $x$when 'requests'$x$,
    $x$when 'accounts'  then current_user_role() = any (array['admin','finance_approver']::user_role[])
           when 'requests'$x$,
    'may_read_payout_evidence (the requests branch)');
  execute d;
end $$;

-- ── Assertions ────────────────────────────────────────────────────────────
do $$
begin
  if exists (select 1 from information_schema.routine_privileges
              where routine_schema = 'public'
                and routine_name = 'adopt_gateway_account_for_transfer'
                and grantee in ('anon', 'PUBLIC', 'service_role')) then
    raise exception '0296: adopt_gateway_account_for_transfer is reachable beyond signed-in callers';
  end if;
  if not exists (select 1 from information_schema.routine_privileges
                  where routine_schema = 'public'
                    and routine_name = 'adopt_gateway_account_for_transfer'
                    and grantee = 'authenticated') then
    raise exception '0296: adopt_gateway_account_for_transfer is not callable by a signed-in desk';
  end if;
  if pg_get_functiondef('public.may_read_payout_evidence(text)'::regprocedure) !~ '''accounts''' then
    raise exception '0296: the accounts folder is not readable by the paying desks';
  end if;
  if pg_get_functiondef('public.may_read_payout_evidence(text)'::regprocedure) !~ '''transfers''' then
    raise exception '0296: the rebuild lost the transfers branch';
  end if;
end $$;
