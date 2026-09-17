-- 0289 — A payee is paid by bank transfer, against their own evidence, and told.
--
-- Asked for directly (board, 12 Sept 2026): every outward payment — a vendor
-- invoice, an ops requisition, a landlord's rent remittance — gets an
-- alternative to Paystack Transfers. The person being paid supplies their own
-- bank details if the organisation does not already hold them; the payment
-- officer transfers the money by hand from the organisation's bank; the payee
-- is told on their own channel, in the organisation's own name; and the
-- organisation keeps a clean record.
--
-- Answers the board gave, which shape everything below:
--   • EVIDENCE, NOT A STORED FIELD. The full account number is never stored.
--     The payee uploads a document that shows it (a bank letter, a statement, a
--     screenshot of their banking app), and the payment officer reads the
--     number off that document when they make the transfer. We keep the bank,
--     the account name and the last four digits — decision 17's shape, and the
--     one `payout_recipients` has held since 0040b.
--   • A payee with no portal login gets a ONE-TIME SECURE LINK, the
--     tenancy-offer pattern (0263): only its SHA-256 is stored, it expires, and
--     it is spent the moment details are submitted.
--   • All three payable types.
--
-- ⚠️ Why this matters now and not later: 0288 refuses a gateway to any
-- organisation that has not connected its own Paystack account. That is the
-- correct state — the previous one paid OEA's landlords out of TFML's balance —
-- but it means OEA cannot currently pay anybody through a gateway at all. Until
-- it connects one, this is how OEA pays its contractors and its landlords.
--
-- ⚠️ The approval gate does not change by one clause. A bank transfer climbs the
-- same chain, is released by the payment officer alone (decision 16), is refused
-- to anyone who approved any stage of it, and posts through the same
-- `record_remittance_sent`. What is new is the MECHANISM — a person with a
-- banking app instead of an API call — and the evidence that has to exist
-- because there is no API call to be the evidence.

-- ── The storage bucket ──────────────────────────────────────────────────────
--
-- Two kinds of document, one private bucket, told apart by the second path
-- segment:
--   <org>/requests/<request id>/<file>   — a payee's own bank evidence
--   <org>/transfers/<payable id>/<file>  — the officer's confirmation of a transfer
-- Same five-megabyte limit and the same file types as `payment-proofs` (0281),
-- HEIC included because it is what a phone photographs by default.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'payout-evidence', 'payout-evidence', false,
  5242880,
  array['application/pdf','image/jpeg','image/png','image/webp','image/heic','image/heif']
) on conflict (id) do update
  set file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- ── Which methods an account is good for ────────────────────────────────────
--
-- ONE statement of the rule, read by every function below that picks an
-- account, so a gateway payout and a bank transfer cannot disagree about what
-- "usable" means. Unknown methods answer false: a caller who passes something
-- unexpected is refused, never given whichever account happens to match.
create or replace function payout_account_usable(
  p_gateway payment_gateway,
  p_recipient_code text,
  p_verified_at timestamptz,
  p_evidence_path text,
  p_method text
) returns boolean
language sql immutable set search_path = public as $$
  select case p_method
    when 'gateway' then p_gateway <> 'manual' and p_recipient_code is not null
    when 'manual'  then p_gateway = 'manual' and p_verified_at is not null and p_evidence_path is not null
    when 'any'     then (p_gateway <> 'manual' and p_recipient_code is not null)
                     or (p_gateway = 'manual' and p_verified_at is not null and p_evidence_path is not null)
    else false
  end
$$;

revoke all on function payout_account_usable(payment_gateway, text, timestamptz, text, text) from public, anon;
grant execute on function payout_account_usable(payment_gateway, text, timestamptz, text, text) to authenticated, service_role;

-- ── The request for bank details ────────────────────────────────────────────
create table payout_detail_requests (
  id                  uuid primary key default gen_random_uuid(),
  org_id              uuid not null references orgs(id),
  party               payout_party not null,
  vendor_id           uuid references vendors(id),
  user_id             uuid references users(id),
  requisition_line_id uuid references ops_requisition_lines(id),
  -- Who the organisation intends to pay. For a vendor or a landlord this is
  -- read off their own record, never typed; for a one-off payee on a
  -- requisition it is what the approvers were shown.
  payee_name          text not null check (length(trim(payee_name)) between 2 and 160),
  -- What the money is for, in words the payee will recognise on the page.
  purpose             text not null check (length(trim(purpose)) between 3 and 200),
  contact_email       text,
  contact_phone       text,
  token_hash          text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  expires_at          timestamptz not null,
  requested_by        uuid not null references users(id),
  requested_at        timestamptz not null default now(),
  submitted_at        timestamptz,
  recipient_id        uuid references payout_recipients(id),
  withdrawn_at        timestamptz,
  withdrawn_by        uuid references users(id),
  constraint payout_request_party_matches check (
    (party = 'vendor'   and vendor_id is not null and user_id is null and requisition_line_id is null) or
    (party = 'landlord' and user_id is not null and vendor_id is null and requisition_line_id is null) or
    (party = 'other'    and requisition_line_id is not null and vendor_id is null and user_id is null)
  ),
  constraint payout_request_has_somewhere_to_go check (
    coalesce(nullif(trim(contact_email), ''), nullif(trim(contact_phone), '')) is not null
  ),
  constraint payout_request_one_outcome check (not (submitted_at is not null and withdrawn_at is not null)),
  constraint payout_request_submission_names_its_account check ((submitted_at is null) = (recipient_id is null))
);

create index payout_detail_requests_org_idx on payout_detail_requests (org_id, requested_at desc);
create index payout_detail_requests_vendor_idx on payout_detail_requests (vendor_id) where vendor_id is not null;
create index payout_detail_requests_user_idx on payout_detail_requests (user_id) where user_id is not null;
create index payout_detail_requests_line_idx on payout_detail_requests (requisition_line_id) where requisition_line_id is not null;

alter table payout_detail_requests enable row level security;

-- Readable by the desks that pay and oversee, by whoever sent it, and — for a
-- requisition line — by anyone who can already see that requisition. No write
-- policy: the functions below are the only way in (0216).
create policy payout_detail_requests_select on payout_detail_requests for select to authenticated
  using (
    org_id = current_user_org_id()
    and (
      current_user_role() = any (array['admin','finance_approver','executive','payment_audit_approver']::user_role[])
      or requested_by = auth.uid()
      or requisition_line_id in (select l.id from ops_requisition_lines l)
    )
  );

revoke all on table payout_detail_requests from anon, authenticated;
grant select on table payout_detail_requests to authenticated;

create trigger audit_payout_detail_request
  after insert or update on payout_detail_requests
  for each row execute function log_audit('payout_request.write');

-- ── What a bank-transfer account is ─────────────────────────────────────────
alter table payout_recipients
  add column if not exists bank_code              text,
  add column if not exists evidence_bucket        text,
  add column if not exists evidence_path          text,
  add column if not exists evidence_filename      text,
  add column if not exists details_source         text,
  add column if not exists name_confirmed_by_bank boolean not null default false,
  add column if not exists verified_by            uuid references users(id),
  add column if not exists contact_email          text,
  add column if not exists contact_phone          text,
  add column if not exists payout_request_id      uuid references payout_detail_requests(id);

alter table payout_recipients
  add constraint payout_recipients_details_source_check
    check (details_source is null or details_source in ('gateway', 'payee_link', 'vendor_registration')),
  add constraint payout_recipients_evidence_bucket_check
    check (evidence_bucket is null or evidence_bucket in ('payout-evidence', 'vendor-documents')),
  -- A bank-transfer account is created complete or not at all: the officer
  -- needs the bank, the name, the last four AND the document to read the rest
  -- off. Half a set of bank details is how money goes to the wrong account.
  add constraint payout_recipients_manual_is_evidenced check (
    gateway <> 'manual' or (
      bank_name is not null and account_name is not null
      and account_number_last4 is not null
      and evidence_bucket is not null and evidence_path is not null
      and details_source is not null
    )
  ),
  -- 0262's lesson, at the table: a run of digits in the NAME box is the account
  -- number in the wrong place, and it is exactly the value we promised never to
  -- keep.
  add constraint payout_recipients_manual_name_is_a_name check (
    gateway <> 'manual' or account_name !~ '^[0-9\s-]{6,}$'
  );

-- One live GATEWAY recipient and one live BANK-TRANSFER account per payee, not
-- one of either. A contractor can be paid either way, and the officer chooses
-- when they pay; forcing one account to serve both would mean deleting the
-- gateway recipient to pay by hand, which is how the next gateway payout fails.
drop index if exists payout_recipients_vendor_uidx;
create unique index payout_recipients_vendor_uidx
  on payout_recipients (org_id, vendor_id, (gateway = 'manual'))
  where party = 'vendor' and active;

drop index if exists payout_recipients_landlord_uidx;
create unique index payout_recipients_landlord_uidx
  on payout_recipients (org_id, user_id, (gateway = 'manual'))
  where party = 'landlord' and active;

-- ⚠️ Direct writes may not touch a bank-transfer account. The existing policy
-- let an administrator or the payment officer insert any row at all — for a
-- gateway recipient that is bounded by the gateway having to accept the code,
-- but a bank-transfer account is bounded by nothing but its evidence, and a row
-- written straight through the REST API could name any account against any
-- vendor. That is payroll diversion with our audit trail on it. So bank-transfer
-- accounts are written only by the functions below, and the direct policy keeps
-- doing exactly what it did for gateway recipients.
drop policy if exists payout_recipients_write on payout_recipients;

create policy payout_recipients_insert on payout_recipients for insert
  with check (
    org_id = current_user_org_id()
    and current_user_role() = any (array['admin','finance_approver']::user_role[])
    and gateway <> 'manual'
  );
create policy payout_recipients_update on payout_recipients for update
  using (
    org_id = current_user_org_id()
    and current_user_role() = any (array['admin','finance_approver']::user_role[])
    and gateway <> 'manual'
  )
  with check (
    org_id = current_user_org_id()
    and current_user_role() = any (array['admin','finance_approver']::user_role[])
    and gateway <> 'manual'
  );
create policy payout_recipients_delete on payout_recipients for delete
  using (
    org_id = current_user_org_id()
    and current_user_role() = any (array['admin','finance_approver']::user_role[])
    and gateway <> 'manual'
  );

-- A requisition line whose payee has been asked for their details but has not
-- sent them yet. The NAME approvers see is fixed here, before approval.
alter table ops_requisition_lines
  add column if not exists payout_request_id uuid references payout_detail_requests(id);

-- ── A remittance's method follows its account ───────────────────────────────
--
-- `remittances.gateway` defaulted to 'paystack' and nothing set it, which was
-- true while every account was a gateway recipient. It now says how the money
-- actually left, read off the account rather than asserted by a caller.
create or replace function remittance_gateway_follows_recipient()
returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_gateway payment_gateway;
begin
  select gateway into v_gateway from payout_recipients where id = new.recipient_id;
  if found then
    new.gateway := v_gateway;
  end if;
  return new;
end;
$$;

revoke all on function remittance_gateway_follows_recipient() from public, anon, authenticated, service_role;

create trigger remittances_gateway_follows_recipient
  before insert or update of recipient_id on remittances
  for each row execute function remittance_gateway_follows_recipient();

-- ── The record of a bank transfer ───────────────────────────────────────────
create table manual_remittance_records (
  id                        uuid primary key default gen_random_uuid(),
  org_id                    uuid not null references orgs(id),
  remittance_id             uuid not null unique references remittances(id),
  recipient_id              uuid not null references payout_recipients(id),
  -- Which of the organisation's accounts the money left. Always its
  -- client-funds account for the currency (`remittances_name_their_account`),
  -- recorded here so the reconciliation against that account's statement has
  -- the one fact it needs on the row.
  paid_from_bank_account_id uuid not null references bank_accounts(id),
  transferred_on            date not null,
  -- The session ID or reference the officer's bank showed. What the payee
  -- quotes to their own bank if the money has not arrived.
  bank_reference            text not null check (length(trim(bank_reference)) between 4 and 60),
  proof_path                text not null unique,
  proof_filename            text,
  note                      text check (note is null or length(note) <= 500),
  -- A snapshot, deliberately. The account can be superseded tomorrow; what the
  -- money was sent TO on this day cannot change with it.
  payee_name                text not null,
  payee_bank_name           text not null,
  payee_account_name        text not null,
  payee_account_last4       text not null check (payee_account_last4 ~ '^[0-9]{4}$'),
  amount                    numeric(16,2) not null check (amount > 0),
  currency                  text not null,
  recorded_by               uuid not null references users(id),
  recorded_at               timestamptz not null default now()
);

create index manual_remittance_records_org_idx on manual_remittance_records (org_id, transferred_on desc);

alter table manual_remittance_records enable row level security;

-- Whoever may see the remittance may see how it was paid — the remittance's own
-- policy decides, rather than a second statement of it that could drift.
create policy manual_remittance_records_select on manual_remittance_records for select to authenticated
  using (remittance_id in (select r.id from remittances r));

revoke all on table manual_remittance_records from anon, authenticated;
grant select on table manual_remittance_records to authenticated;

-- A recorded transfer is evidence the ledger rests on. It is corrected with a
-- reversing entry and a new record, never edited — the same line the audit
-- trail draws for itself.
create or replace function manual_remittance_records_are_final()
returns trigger language plpgsql as $$
begin
  raise exception 'a recorded bank transfer is part of the ledger''s evidence and cannot be changed or removed';
end;
$$;

revoke all on function manual_remittance_records_are_final() from public, anon, authenticated, service_role;

create trigger manual_remittance_records_final
  before update or delete on manual_remittance_records
  for each row execute function manual_remittance_records_are_final();

create trigger audit_manual_remittance_record
  after insert on manual_remittance_records
  for each row execute function log_audit('remittance.bank_transfer_recorded');

-- ── Who may open the documents ──────────────────────────────────────────────
--
-- A payee's bank evidence carries their full account number, so it is read by
-- the two desks that register and pay accounts and nobody else. The officer's
-- transfer confirmation is read by those two and by the oversight and audit
-- desks, who exist to check that money went where it was meant to.
create or replace function may_read_payout_evidence(p_name text)
returns boolean
language sql stable security definer set search_path = public as $$
  select current_user_is_active()
     and split_part(p_name, '/', 1) = current_user_org_id()::text
     and case split_part(p_name, '/', 2)
           when 'requests'  then current_user_role() = any (array['admin','finance_approver']::user_role[])
           when 'transfers' then current_user_role() = any (array['admin','finance_approver','executive','payment_audit_approver']::user_role[])
           else false
         end
$$;

revoke all on function may_read_payout_evidence(text) from public, anon;
grant execute on function may_read_payout_evidence(text) to authenticated, service_role;

-- The officer uploads their own confirmation from the browser, under their own
-- session, into their own organisation's transfers folder. A payee's evidence
-- is never uploaded by a signed-in browser — it arrives through the one-time
-- link, which the server writes with the service role after checking the token.
create policy "transfer confirmations are uploaded by the payment officer"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'payout-evidence'
    and (storage.foldername(name))[1] = current_user_org_id()::text
    and (storage.foldername(name))[2] = 'transfers'
    and current_user_role() = 'finance_approver'
    and current_user_is_active()
  );

create policy "payout evidence is read by the desks that need it"
  on storage.objects for select to authenticated
  using (bucket_id = 'payout-evidence' and may_read_payout_evidence(name));

-- No update and no delete policy, deliberately. `upsert` therefore fails, which
-- is why the client uploads with `upsert: false` — the same lesson 0281 paid for.

-- ── Asking a payee for their details ────────────────────────────────────────
create or replace function request_payout_details(
  p_party payout_party,
  p_vendor_id uuid,
  p_user_id uuid,
  p_line_id uuid,
  p_payee_name text,
  p_contact_email text,
  p_contact_phone text,
  p_purpose text,
  p_token_hash text
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_uid   uuid := auth.uid();
  v_me    users%rowtype;
  v_name  text := nullif(trim(p_payee_name), '');
  v_email text := nullif(lower(trim(coalesce(p_contact_email, ''))), '');
  v_phone text := nullif(regexp_replace(coalesce(p_contact_phone, ''), '[^0-9+]', '', 'g'), '');
  v_line  ops_requisition_lines%rowtype;
  v_req   ops_requisitions%rowtype;
  v_prev  uuid;
  v_id    uuid;
begin
  if v_uid is null then
    raise exception 'your session expired — sign in again';
  end if;
  if not current_user_is_active() then
    raise exception 'this account has been deactivated';
  end if;
  select * into v_me from users where id = v_uid;

  if p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'the link could not be prepared — try again';
  end if;
  if v_email is null and v_phone is null then
    raise exception 'give an email address or a phone number, so the link has somewhere to go';
  end if;
  if v_email is not null and v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
    raise exception 'that email address does not look right';
  end if;
  if v_phone is not null and length(regexp_replace(v_phone, '\D', '', 'g')) < 10 then
    raise exception 'that phone number looks too short';
  end if;

  if p_party = 'vendor' then
    if v_me.role not in ('admin', 'finance_approver') then
      raise exception 'only the payment officer or an administrator may ask a contractor for bank details';
    end if;
    -- The name comes off the vendor's own record. A typed name here would let
    -- the page tell a payee they are being paid as somebody else.
    select name into v_name from vendors where id = p_vendor_id and org_id = v_me.org_id;
    if v_name is null then
      raise exception 'that contractor could not be found';
    end if;
    select id into v_prev from payout_detail_requests
     where org_id = v_me.org_id and vendor_id = p_vendor_id
       and submitted_at is null and withdrawn_at is null;

  elsif p_party = 'landlord' then
    if v_me.role not in ('admin', 'finance_approver') then
      raise exception 'only the payment officer or an administrator may ask a landlord for bank details';
    end if;
    select coalesce(full_name, email) into v_name from users
     where id = p_user_id and org_id = v_me.org_id and role = 'property_owner';
    if v_name is null then
      raise exception 'that landlord could not be found';
    end if;
    select id into v_prev from payout_detail_requests
     where org_id = v_me.org_id and user_id = p_user_id
       and submitted_at is null and withdrawn_at is null;

  elsif p_party = 'other' then
    -- The same desks `save_requisition_line_payee` admits, plus the two that
    -- pay and administer — a link that expired needs re-sending by somebody.
    if v_me.role not in ('admin', 'finance_approver', 'fm_ops_staff', 'facility_manager',
                         'property_manager', 'regional_manager') then
      raise exception 'you may not name who a requisition line pays';
    end if;
    select * into v_line from ops_requisition_lines
     where id = p_line_id and org_id = v_me.org_id
     for update;
    if v_line.id is null then
      raise exception 'that requisition line could not be found';
    end if;
    if v_line.vendor_id is not null or v_line.payee_recipient_id is not null then
      raise exception 'this line already names who it pays';
    end if;
    if v_line.remittance_id is not null then
      raise exception 'this line has already been paid';
    end if;

    if v_line.payout_request_id is null then
      -- First naming, so before anybody has approved — the rule
      -- `save_requisition_line_payee` has held since 0172: an approver signs
      -- for paying a named person, and that name must not move after they do.
      select * into v_req from ops_requisitions where id = v_line.requisition_id;
      if v_req.status <> 'pending_approval' or exists (
        select 1 from payment_approvals
         where payable_type = 'ops_requisition' and payable_id = v_req.id
      ) then
        raise exception 'this requisition has already begun approval — who a line pays cannot be named now';
      end if;
      if v_name is null or length(v_name) < 2 then
        raise exception 'give the payee''s name as it appears on their bank account';
      end if;
    else
      -- A fresh link to the SAME payee. The name the approvers saw is kept,
      -- whatever was typed this time.
      select payee_name into v_name from payout_detail_requests where id = v_line.payout_request_id;
    end if;

    select id into v_prev from payout_detail_requests
     where requisition_line_id = p_line_id
       and submitted_at is null and withdrawn_at is null;
  else
    raise exception 'unknown payee type';
  end if;

  -- One live link per payee. A second one kills the first, so an old message
  -- sitting in somebody's inbox stops working the moment a new one is sent.
  if v_prev is not null then
    update payout_detail_requests
       set withdrawn_at = now(), withdrawn_by = v_uid
     where id = v_prev;
  end if;

  insert into payout_detail_requests (
    org_id, party, vendor_id, user_id, requisition_line_id,
    payee_name, purpose, contact_email, contact_phone,
    token_hash, expires_at, requested_by
  ) values (
    v_me.org_id, p_party,
    case when p_party = 'vendor'   then p_vendor_id end,
    case when p_party = 'landlord' then p_user_id end,
    case when p_party = 'other'    then p_line_id end,
    v_name,
    left(coalesce(nullif(trim(p_purpose), ''), 'A payment from us to you'), 200),
    v_email, v_phone,
    p_token_hash, now() + interval '14 days', v_uid
  )
  returning id into v_id;

  if p_party = 'other' then
    update ops_requisition_lines set payout_request_id = v_id where id = p_line_id;
  end if;

  return v_id;
end;
$$;

revoke all on function request_payout_details(payout_party, uuid, uuid, uuid, text, text, text, text, text) from public, anon;
grant execute on function request_payout_details(payout_party, uuid, uuid, uuid, text, text, text, text, text) to authenticated, service_role;

create or replace function withdraw_payout_request(p_request_id uuid)
returns void
language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_me  users%rowtype;
  q     payout_detail_requests%rowtype;
begin
  if v_uid is null then
    raise exception 'your session expired — sign in again';
  end if;
  if not current_user_is_active() then
    raise exception 'this account has been deactivated';
  end if;
  select * into v_me from users where id = v_uid;
  select * into q from payout_detail_requests where id = p_request_id and org_id = v_me.org_id for update;
  if q.id is null then
    raise exception 'that request could not be found';
  end if;
  if v_me.role not in ('admin', 'finance_approver') and q.requested_by <> v_uid then
    raise exception 'only whoever sent this link, the payment officer or an administrator may cancel it';
  end if;
  if q.submitted_at is not null then
    raise exception 'the payee has already sent their details';
  end if;
  if q.withdrawn_at is not null then
    return;
  end if;
  update payout_detail_requests set withdrawn_at = now(), withdrawn_by = v_uid where id = q.id;
end;
$$;

revoke all on function withdraw_payout_request(uuid) from public, anon;
grant execute on function withdraw_payout_request(uuid) to authenticated, service_role;

-- What the payee's page needs, for exactly one link. Service role only: the page
-- has no session to read with, and this cannot be made to list.
create or replace function payout_request_by_token(p_token_hash text)
returns table (
  request_id     uuid,
  state          text,
  org_id         uuid,
  org_name       text,
  portal_name    text,
  logo_url       text,
  theme_primary  text,
  delivery_brand text,
  payee_name     text,
  purpose        text,
  party          payout_party,
  expires_at     timestamptz,
  submitted_at   timestamptz,
  bank_name      text,
  account_last4  text
)
language sql stable security definer set search_path = public as $$
  select
    q.id,
    case
      when q.withdrawn_at is not null then 'withdrawn'
      when q.submitted_at is not null then 'submitted'
      when q.expires_at < now()       then 'lapsed'
      else 'open'
    end,
    o.id, o.name, o.portal_name, o.logo_url, o.theme_primary, o.delivery_brand::text,
    q.payee_name, q.purpose, q.party, q.expires_at, q.submitted_at,
    pr.bank_name, pr.account_number_last4
  from payout_detail_requests q
  join orgs o on o.id = q.org_id
  left join payout_recipients pr on pr.id = q.recipient_id
  where q.token_hash = p_token_hash
    and o.deleted_at is null
$$;

revoke all on function payout_request_by_token(text) from public, anon, authenticated;
grant execute on function payout_request_by_token(text) to service_role;

-- The payee's submission. Service role only, called by the server after it has
-- checked the token and stored the document; the token is still the authority,
-- re-checked here.
create or replace function submit_payout_details(
  p_token_hash        text,
  p_bank_name         text,
  p_bank_code         text,
  p_account_name      text,
  p_last4             text,
  p_name_confirmed    boolean,
  p_evidence_path     text,
  p_evidence_filename text
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  q          payout_detail_requests%rowtype;
  v_bank     text := nullif(trim(p_bank_name), '');
  v_name     text := nullif(regexp_replace(trim(coalesce(p_account_name, '')), '\s+', ' ', 'g'), '');
  v_display  text;
  v_id       uuid;
begin
  select * into q from payout_detail_requests where token_hash = p_token_hash for update;
  if q.id is null or q.withdrawn_at is not null then
    raise exception 'this link is not valid';
  end if;
  if q.submitted_at is not null then
    raise exception 'your details have already been sent — thank you';
  end if;
  if q.expires_at < now() then
    raise exception 'this link has expired — ask for a new one';
  end if;

  if v_bank is null then
    raise exception 'choose your bank';
  end if;
  if v_name is null or length(v_name) < 3 then
    raise exception 'give the account name exactly as your bank shows it';
  end if;
  if v_name ~ '^[0-9\s-]{6,}$' then
    raise exception 'that is an account number — the account NAME goes in that box';
  end if;
  if p_last4 is null or p_last4 !~ '^[0-9]{4}$' then
    raise exception 'the account number did not come through — enter it again';
  end if;
  -- Evidence is the whole design: without a document, "the officer reads the
  -- number off it" has nothing to read.
  if p_evidence_path is null
     or p_evidence_path not like q.org_id::text || '/requests/' || q.id::text || '/%' then
    raise exception 'attach a document that shows your account name and number';
  end if;
  if not exists (
    select 1 from storage.objects o
     where o.bucket_id = 'payout-evidence' and o.name = p_evidence_path
  ) then
    raise exception 'the document did not finish uploading — attach it again';
  end if;

  if q.party = 'vendor' then
    select name into v_display from vendors where id = q.vendor_id;
  elsif q.party = 'landlord' then
    select coalesce(full_name, email) into v_display from users where id = q.user_id;
  end if;
  v_display := coalesce(v_display, q.payee_name);

  -- Supersede, never edit: past transfers keep pointing at the account they
  -- were actually sent to.
  if q.party in ('vendor', 'landlord') then
    update payout_recipients
       set active = false
     where org_id = q.org_id and party = q.party and gateway = 'manual' and active
       and ((q.party = 'vendor'   and vendor_id = q.vendor_id)
         or (q.party = 'landlord' and user_id   = q.user_id));
  end if;

  insert into payout_recipients (
    org_id, party, vendor_id, user_id, display_name,
    bank_name, bank_code, account_name, account_number_last4,
    gateway, recipient_code, currency, active,
    verified_at, name_confirmed_by_bank, details_source,
    evidence_bucket, evidence_path, evidence_filename,
    contact_email, contact_phone, payout_request_id
  ) values (
    q.org_id, q.party, q.vendor_id, q.user_id, v_display,
    v_bank, nullif(trim(coalesce(p_bank_code, '')), ''), v_name, p_last4,
    'manual', null, 'NGN', true,
    -- Confirmed by the bank at submission, or waiting for a person to open the
    -- document and confirm it before anything can be paid to it.
    case when coalesce(p_name_confirmed, false) then now() end,
    coalesce(p_name_confirmed, false), 'payee_link',
    'payout-evidence', p_evidence_path, nullif(trim(coalesce(p_evidence_filename, '')), ''),
    q.contact_email, q.contact_phone, q.id
  )
  returning id into v_id;

  if q.party = 'other' then
    update ops_requisition_lines
       set payee_recipient_id = v_id
     where id = q.requisition_line_id
       and vendor_id is null and payee_recipient_id is null and remittance_id is null;
    if not found then
      raise exception 'the payment this link was for has changed — ask for a new link';
    end if;
  end if;

  update payout_detail_requests
     set submitted_at = now(), recipient_id = v_id
   where id = q.id;

  return v_id;
end;
$$;

revoke all on function submit_payout_details(text, text, text, text, text, boolean, text, text) from public, anon, authenticated;
grant execute on function submit_payout_details(text, text, text, text, text, boolean, text, text) to service_role;

-- A contractor already vetted: their approved registration's own bank details
-- and bank letter become their bank-transfer account, with no link needed.
-- The registration review was the second pair of eyes (decision 17), so the
-- account is confirmed by whoever adopts it — and that person may not then pay
-- it (see `record_manual_remittance`).
create or replace function adopt_registration_bank_details(p_vendor_id uuid)
returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_uid    uuid := auth.uid();
  v_me     users%rowtype;
  v_vendor vendors%rowtype;
  v_reg    vendor_registrations%rowtype;
  v_doc    vendor_documents%rowtype;
  v_id     uuid;
begin
  if v_uid is null then
    raise exception 'your session expired — sign in again';
  end if;
  if not current_user_is_active() then
    raise exception 'this account has been deactivated';
  end if;
  select * into v_me from users where id = v_uid;
  if v_me.role not in ('admin', 'finance_approver') then
    raise exception 'only the payment officer or an administrator may set how a contractor is paid';
  end if;

  select * into v_vendor from vendors where id = p_vendor_id and org_id = v_me.org_id;
  if v_vendor.id is null then
    raise exception 'that contractor could not be found';
  end if;
  select * into v_reg from vendor_registrations where vendor_id = p_vendor_id and org_id = v_me.org_id;
  if v_reg.id is null or v_reg.status is distinct from 'approved' then
    raise exception 'this contractor''s registration has not been approved, so its bank details are not yet evidence of anything';
  end if;
  if v_reg.bank_name is null or v_reg.account_name is null or v_reg.account_number_last4 is null then
    raise exception 'their registration does not state a complete bank account — ask them for their bank details instead';
  end if;
  if v_reg.account_name ~ '^[0-9\s-]{6,}$' then
    raise exception 'their registration has an account number where the account name should be — ask them for their bank details instead';
  end if;

  select * into v_doc from vendor_documents
   where vendor_id = p_vendor_id and org_id = v_me.org_id
     and doc_type = 'bank_evidence' and superseded_at is null
   order by uploaded_at desc
   limit 1;
  if v_doc.id is null then
    raise exception 'no bank letter is attached to their registration, so there is nothing to read the account number from';
  end if;

  update payout_recipients
     set active = false
   where org_id = v_me.org_id and party = 'vendor' and vendor_id = p_vendor_id
     and gateway = 'manual' and active;

  insert into payout_recipients (
    org_id, party, vendor_id, display_name,
    bank_name, account_name, account_number_last4,
    gateway, currency, active,
    verified_at, verified_by, details_source,
    evidence_bucket, evidence_path, evidence_filename,
    contact_email, contact_phone, created_by
  ) values (
    v_me.org_id, 'vendor', p_vendor_id, v_vendor.name,
    v_reg.bank_name, v_reg.account_name, v_reg.account_number_last4,
    'manual', 'NGN', true,
    now(), v_uid, 'vendor_registration',
    'vendor-documents', v_doc.storage_path, v_doc.file_name,
    v_vendor.contact_email, v_vendor.contact_phone, v_uid
  )
  returning id into v_id;

  return v_id;
end;
$$;

revoke all on function adopt_registration_bank_details(uuid) from public, anon;
grant execute on function adopt_registration_bank_details(uuid) to authenticated, service_role;

-- Opening the payee's document and saying "yes, that is their account" — for an
-- account the bank could not confirm by name at submission.
create or replace function confirm_payout_account_evidence(p_recipient_id uuid)
returns void
language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_me  users%rowtype;
  r     payout_recipients%rowtype;
begin
  if v_uid is null then
    raise exception 'your session expired — sign in again';
  end if;
  if not current_user_is_active() then
    raise exception 'this account has been deactivated';
  end if;
  select * into v_me from users where id = v_uid;
  if v_me.role not in ('admin', 'finance_approver') then
    raise exception 'only the payment officer or an administrator may confirm bank details';
  end if;
  select * into r from payout_recipients where id = p_recipient_id and org_id = v_me.org_id for update;
  if r.id is null or r.gateway <> 'manual' then
    raise exception 'that bank-transfer account could not be found';
  end if;
  if not r.active then
    raise exception 'these details have been replaced by newer ones';
  end if;
  if r.verified_at is not null then
    raise exception 'these details are already confirmed';
  end if;
  update payout_recipients set verified_at = now(), verified_by = v_uid where id = r.id;
end;
$$;

revoke all on function confirm_payout_account_evidence(uuid) from public, anon;
grant execute on function confirm_payout_account_evidence(uuid) to authenticated, service_role;

-- ── The four functions that pick the account ────────────────────────────────
--
-- Rebuilt MECHANICALLY from the live catalogue (0183), never retyped — these
-- are the B4 gate itself, and 0277 is what happens when one is written from
-- memory. Each edit is a string replacement that must match exactly once, and
-- every safety clause is proven still present afterwards.
create or replace function pg_temp.swap(p_def text, p_from text, p_to text, p_what text)
returns text language plpgsql as $$
declare
  n int := (length(p_def) - length(replace(p_def, p_from, ''))) / greatest(length(p_from), 1);
begin
  if n <> 1 then
    raise exception 'rebuilding %: expected exactly one match for [%], found %', p_what, p_from, n;
  end if;
  return replace(p_def, p_from, p_to);
end;
$$;

do $$
declare
  d text;
begin
  -- Vendor invoice.
  d := pg_get_functiondef('public.create_vendor_remittance(uuid,text,uuid)'::regprocedure);
  d := pg_temp.swap(d,
    $s$create_vendor_remittance(p_payment_id uuid, p_reference text, p_executed_by uuid)$s$,
    $s$create_vendor_remittance(p_payment_id uuid, p_reference text, p_executed_by uuid, p_method text DEFAULT 'gateway'::text)$s$,
    'create_vendor_remittance signature');
  d := pg_temp.swap(d,
    $s$and active and recipient_code is not null$s$,
    $s$and active and payout_account_usable(gateway, recipient_code, verified_at, evidence_path, p_method)$s$,
    'create_vendor_remittance account');
  d := pg_temp.swap(d,
    $s$raise exception 'no verified bank recipient is on file for this vendor';$s$,
    $s$raise exception '%', case when p_method = 'manual'
      then 'no confirmed bank-transfer account is on file for this vendor — ask them for their bank details, or use the account on their approved registration'
      else 'no verified bank recipient is on file for this vendor' end;$s$,
    'create_vendor_remittance refusal');
  execute 'drop function public.create_vendor_remittance(uuid,text,uuid)';
  execute d;

  -- Requisition lines naming a registered vendor.
  d := pg_get_functiondef('public.create_requisition_vendor_remittance(uuid,uuid,text,uuid)'::regprocedure);
  d := pg_temp.swap(d,
    $s$create_requisition_vendor_remittance(p_requisition_id uuid, p_vendor_id uuid, p_reference text, p_executed_by uuid)$s$,
    $s$create_requisition_vendor_remittance(p_requisition_id uuid, p_vendor_id uuid, p_reference text, p_executed_by uuid, p_method text DEFAULT 'gateway'::text)$s$,
    'create_requisition_vendor_remittance signature');
  d := pg_temp.swap(d,
    $s$and active and recipient_code is not null$s$,
    $s$and active and payout_account_usable(gateway, recipient_code, verified_at, evidence_path, p_method)$s$,
    'create_requisition_vendor_remittance account');
  d := pg_temp.swap(d,
    $s$raise exception 'no verified bank recipient is on file for this vendor';$s$,
    $s$raise exception '%', case when p_method = 'manual'
      then 'no confirmed bank-transfer account is on file for this vendor — ask them for their bank details, or use the account on their approved registration'
      else 'no verified bank recipient is on file for this vendor' end;$s$,
    'create_requisition_vendor_remittance refusal');
  execute 'drop function public.create_requisition_vendor_remittance(uuid,uuid,text,uuid)';
  execute d;

  -- Requisition lines naming a one-off payee.
  d := pg_get_functiondef('public.create_requisition_payee_remittance(uuid,uuid,text,uuid)'::regprocedure);
  d := pg_temp.swap(d,
    $s$create_requisition_payee_remittance(p_requisition_id uuid, p_payee_recipient_id uuid, p_reference text, p_executed_by uuid)$s$,
    $s$create_requisition_payee_remittance(p_requisition_id uuid, p_payee_recipient_id uuid, p_reference text, p_executed_by uuid, p_method text DEFAULT 'gateway'::text)$s$,
    'create_requisition_payee_remittance signature');
  d := pg_temp.swap(d,
    $s$and active and recipient_code is not null$s$,
    $s$and active and payout_account_usable(gateway, recipient_code, verified_at, evidence_path, p_method)$s$,
    'create_requisition_payee_remittance account');
  d := pg_temp.swap(d,
    $s$raise exception 'that payee has no verified bank recipient on file';$s$,
    $s$raise exception '%', case when p_method = 'manual'
      then 'that payee has not sent bank details that have been confirmed yet'
      else 'that payee has no verified bank recipient on file' end;$s$,
    'create_requisition_payee_remittance refusal');
  execute 'drop function public.create_requisition_payee_remittance(uuid,uuid,text,uuid)';
  execute d;

  -- A landlord's rent. RAISED before anybody approves it, so the method is not
  -- known yet: any usable account will do, a gateway recipient first, and the
  -- officer chooses how to pay when they release it. Ordered, never
  -- `limit 1` on its own — decision 38's fault is an unordered pick.
  d := pg_get_functiondef('public.create_rent_remittance(uuid,uuid,uuid,text,uuid)'::regprocedure);
  d := pg_temp.swap(d,
    $s$and active and recipient_code is not null
   limit 1;$s$,
    $s$and active and payout_account_usable(gateway, recipient_code, verified_at, evidence_path, 'any')
   order by (gateway <> 'manual') desc, created_at desc
   limit 1;$s$,
    'create_rent_remittance account');
  execute d;

  -- Whether a landlord can be paid at all, as the payout run shows it.
  d := pg_get_functiondef('public.landlord_payout_candidates()'::regprocedure);
  d := pg_temp.swap(d,
    $s$and pr.recipient_code is not null$s$,
    $s$and payout_account_usable(pr.gateway, pr.recipient_code, pr.verified_at, pr.evidence_path, 'any')$s$,
    'landlord_payout_candidates');
  execute d;

  -- The ledger says how the money left, in words.
  d := pg_get_functiondef('public.record_remittance_sent(uuid,text,timestamp with time zone)'::regprocedure);
  d := pg_temp.swap(d,
    $s$'Paid via ' || r.gateway || ' from ' || bank.label$s$,
    $s$case when r.gateway = 'manual' then 'Paid by bank transfer from ' else 'Paid via ' || r.gateway || ' from ' end || bank.label$s$,
    'record_remittance_sent memo');
  execute d;
end $$;

revoke all on function create_vendor_remittance(uuid, text, uuid, text) from public, anon, authenticated;
grant execute on function create_vendor_remittance(uuid, text, uuid, text) to service_role;
revoke all on function create_requisition_vendor_remittance(uuid, uuid, text, uuid, text) from public, anon, authenticated;
grant execute on function create_requisition_vendor_remittance(uuid, uuid, text, uuid, text) to service_role;
revoke all on function create_requisition_payee_remittance(uuid, uuid, text, uuid, text) from public, anon, authenticated;
grant execute on function create_requisition_payee_remittance(uuid, uuid, text, uuid, text) to service_role;
revoke all on function create_rent_remittance(uuid, uuid, uuid, text, uuid) from public, anon, authenticated;
grant execute on function create_rent_remittance(uuid, uuid, uuid, text, uuid) to service_role;
revoke all on function landlord_payout_candidates() from public, anon;
grant execute on function landlord_payout_candidates() to authenticated, service_role;
revoke all on function record_remittance_sent(uuid, text, timestamptz) from public, anon, authenticated;
grant execute on function record_remittance_sent(uuid, text, timestamptz) to service_role;

-- ── A landlord raised against one account and released through the other ───
--
-- A rent remittance is raised with whichever account the landlord has. If the
-- officer releases it through Paystack while it names the bank-transfer
-- account, the send path needs the gateway recipient instead — same person,
-- different rail. Refuses to move it to anybody else.
create or replace function use_gateway_account_for_remittance(p_remittance_id uuid)
returns void
language plpgsql security definer set search_path = public as $$
declare
  r   remittances%rowtype;
  cur payout_recipients%rowtype;
  g   payout_recipients%rowtype;
begin
  select * into r from remittances where id = p_remittance_id for update;
  if r.id is null or r.status <> 'queued' then
    return;   -- the claim that follows refuses in its own words
  end if;
  select * into cur from payout_recipients where id = r.recipient_id;
  if cur.gateway <> 'manual' then
    return;
  end if;
  if cur.party = 'landlord' then
    select * into g from payout_recipients
     where org_id = r.org_id and party = 'landlord' and user_id = cur.user_id and active
       and payout_account_usable(gateway, recipient_code, verified_at, evidence_path, 'gateway');
  elsif cur.party = 'vendor' then
    select * into g from payout_recipients
     where org_id = r.org_id and party = 'vendor' and vendor_id = cur.vendor_id and active
       and payout_account_usable(gateway, recipient_code, verified_at, evidence_path, 'gateway');
  end if;
  if g.id is null then
    raise exception 'no verified bank recipient is on file for this landlord';
  end if;
  update remittances set recipient_id = g.id where id = r.id;
end;
$$;

revoke all on function use_gateway_account_for_remittance(uuid) from public, anon, authenticated;
grant execute on function use_gateway_account_for_remittance(uuid) to service_role;

-- ── Recording the transfer ──────────────────────────────────────────────────
--
-- Called only by `pay_by_bank_transfer` below, in the same transaction as the
-- remittance is created. Granted to nobody.
create or replace function record_manual_remittance(
  p_remittance_id  uuid,
  p_sent_by        uuid,
  p_transferred_on date,
  p_bank_reference text,
  p_proof_path     text,
  p_proof_filename text,
  p_note           text,
  p_proof_scope    uuid
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  r      remittances%rowtype;
  cur    payout_recipients%rowtype;
  acct   payout_recipients%rowtype;
  v_bank bank_accounts%rowtype;
  v_ref  text := nullif(trim(coalesce(p_bank_reference, '')), '');
  v_note text := nullif(trim(coalesce(p_note, '')), '');
  v_today date := (now() at time zone 'Africa/Lagos')::date;
begin
  select * into r from remittances where id = p_remittance_id for update;
  if r.id is null then
    raise exception 'remittance not found';
  end if;
  if r.status <> 'queued' then
    raise exception 'this payment is already %', r.status;
  end if;

  if p_transferred_on is null then
    raise exception 'say which day the transfer was made';
  end if;
  if p_transferred_on > v_today then
    raise exception 'a transfer cannot be dated in the future';
  end if;
  if p_transferred_on < v_today - 60 then
    raise exception 'that date is more than 60 days ago — a transfer is recorded when it is made';
  end if;
  if v_ref is null or length(v_ref) < 4 or length(v_ref) > 60 then
    raise exception 'give the reference or session ID your bank showed for the transfer';
  end if;
  if v_note is not null and length(v_note) > 500 then
    raise exception 'keep the note under 500 characters';
  end if;

  -- The confirmation: in this payment's own folder, really there, and not
  -- already the evidence for some other payment.
  if p_proof_path is null
     or p_proof_path not like r.org_id::text || '/transfers/' || p_proof_scope::text || '/%' then
    raise exception 'attach your bank''s confirmation of this transfer';
  end if;
  if not exists (
    select 1 from storage.objects o
     where o.bucket_id = 'payout-evidence' and o.name = p_proof_path
  ) then
    raise exception 'the transfer confirmation did not finish uploading — attach it again';
  end if;
  if exists (select 1 from manual_remittance_records where proof_path = p_proof_path) then
    raise exception 'that confirmation is already attached to another payment';
  end if;

  -- The account the money went to: this payee's own confirmed bank-transfer
  -- account. For a one-off payee the account IS their identity, so it is the
  -- remittance's own; for a vendor or a landlord it is their current one.
  select * into cur from payout_recipients where id = r.recipient_id;
  if cur.party = 'other' then
    acct := cur;
  elsif cur.party = 'vendor' then
    select * into acct from payout_recipients
     where org_id = r.org_id and party = 'vendor' and vendor_id = cur.vendor_id
       and active and gateway = 'manual';
  else
    select * into acct from payout_recipients
     where org_id = r.org_id and party = 'landlord' and user_id = cur.user_id
       and active and gateway = 'manual';
  end if;

  if acct.id is null or acct.gateway <> 'manual' or not acct.active then
    raise exception 'no bank-transfer account is on file for this payee — ask them for their bank details first';
  end if;
  if acct.verified_at is null then
    raise exception 'this payee''s bank details have not been confirmed yet — open their document and confirm it before paying';
  end if;
  -- Maker-checker on the ACCOUNT, the same shape decision 16 draws on the
  -- payment: the person who vouched for where money goes is not the person who
  -- sends it there. A bank-confirmed account has no human voucher to test.
  if acct.verified_by is not null and acct.verified_by = p_sent_by then
    raise exception 'you confirmed this payee''s bank details and cannot also send money to them — someone else must make the transfer';
  end if;

  if acct.id <> r.recipient_id then
    update remittances set recipient_id = acct.id where id = r.id;
  end if;

  -- Every part of the B4 gate, unchanged: finance authority, the chain at the
  -- current amount, and that the sender approved no stage of it.
  perform claim_remittance_for_sending(r.id, p_sent_by);

  select * into r from remittances where id = p_remittance_id;
  select * into v_bank from bank_accounts where id = r.bank_account_id;

  insert into manual_remittance_records (
    org_id, remittance_id, recipient_id, paid_from_bank_account_id,
    transferred_on, bank_reference, proof_path, proof_filename, note,
    payee_name, payee_bank_name, payee_account_name, payee_account_last4,
    amount, currency, recorded_by
  ) values (
    r.org_id, r.id, acct.id, v_bank.id,
    p_transferred_on, v_ref, p_proof_path, nullif(trim(coalesce(p_proof_filename, '')), ''), v_note,
    acct.display_name, acct.bank_name, acct.account_name, acct.account_number_last4,
    r.net_amount, r.currency, p_sent_by
  );

  -- Posted at midday Lagos time on the day of the transfer, so the entry date
  -- is that day in every timezone the server might be running in.
  perform record_remittance_sent(r.id, v_ref, (p_transferred_on + time '12:00') at time zone 'Africa/Lagos');

  return r.id;
end;
$$;

revoke all on function record_manual_remittance(uuid, uuid, date, text, text, text, text, uuid) from public, anon, authenticated, service_role;

-- The one entry point. Creating the remittance, claiming it, recording the
-- transfer and posting the ledger happen in ONE transaction: any refusal —
-- a missing confirmation, a short fund, the maker-checker rule — rolls all of
-- it back. Split in two, a failed recording would leave a queued remittance
-- claiming the requisition's lines, invisible on the page and blocking a retry.
create or replace function pay_by_bank_transfer(
  p_payable_type   text,
  p_payable_id     uuid,
  p_target_id      uuid,
  p_reference      text,
  p_sent_by        uuid,
  p_transferred_on date,
  p_bank_reference text,
  p_proof_path     text,
  p_proof_filename text,
  p_note           text
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_rem uuid;
begin
  if p_payable_type = 'vendor_payment' then
    v_rem := create_vendor_remittance(p_payable_id, p_reference, p_sent_by, 'manual');
  elsif p_payable_type = 'requisition_vendor' then
    v_rem := create_requisition_vendor_remittance(p_payable_id, p_target_id, p_reference, p_sent_by, 'manual');
  elsif p_payable_type = 'requisition_payee' then
    v_rem := create_requisition_payee_remittance(p_payable_id, p_target_id, p_reference, p_sent_by, 'manual');
  elsif p_payable_type = 'landlord_payout' then
    v_rem := p_payable_id;
  else
    raise exception 'a bank transfer cannot be recorded against a %', p_payable_type;
  end if;

  perform record_manual_remittance(
    v_rem, p_sent_by, p_transferred_on, p_bank_reference,
    p_proof_path, p_proof_filename, p_note, p_payable_id
  );
  return v_rem;
end;
$$;

revoke all on function pay_by_bank_transfer(text, uuid, uuid, text, uuid, date, text, text, text, text) from public, anon, authenticated;
grant execute on function pay_by_bank_transfer(text, uuid, uuid, text, uuid, date, text, text, text, text) to service_role;

-- ── Telling the payee in the portal ─────────────────────────────────────────
--
-- An eighth notification subject, so it arrives with its own orphan cascade and
-- its own branch in `my_notifications` — 0276's rule, and 0282's reason: an
-- unlisted type is reported live forever by the CASE's `else true`.
create trigger remittances_notification_cascade
  after delete on remittances
  for each row execute function delete_notifications_for_deleted_entity('remittance');

do $$
declare
  d text;
begin
  d := pg_get_functiondef('public.my_notifications(integer)'::regprocedure);
  d := pg_temp.swap(d,
    $s$      when n.entity_type = 'offline_payment'    then exists (select 1 from offline_payment_claims c where c.id = n.entity_id)$s$,
    $s$      when n.entity_type = 'offline_payment'    then exists (select 1 from offline_payment_claims c where c.id = n.entity_id)
      when n.entity_type = 'remittance'         then exists (select 1 from remittances m            where m.id = n.entity_id)$s$,
    'my_notifications');
  execute d;
end $$;

revoke all on function my_notifications(integer) from public, anon;
grant execute on function my_notifications(integer) to authenticated, service_role;

-- ── Proof ───────────────────────────────────────────────────────────────────
do $$
declare
  v_def text;
  f text;
begin
  -- Each rebuilt gate still carries every control it carried before.
  foreach f in array array[
    'create_vendor_remittance(uuid,text,uuid,text)',
    'create_requisition_vendor_remittance(uuid,uuid,text,uuid,text)',
    'create_requisition_payee_remittance(uuid,uuid,text,uuid,text)'
  ] loop
    v_def := pg_get_functiondef(('public.' || f)::regprocedure);
    if v_def not like '%assert_chain_cleared%' or v_def not like '%assert_may_disburse%'
       or v_def not like '%payment_approvals%' or v_def not like '%payout_account_usable%' then
      raise exception '% lost a control in the rebuild', f;
    end if;
  end loop;

  v_def := pg_get_functiondef('public.create_rent_remittance(uuid,uuid,uuid,text,uuid)'::regprocedure);
  if v_def not like '%assert_may_disburse%' or v_def not like '%for update of rc%'
     or v_def not like '%order by (gateway <> ''manual'') desc%' then
    raise exception 'create_rent_remittance lost a control in the rebuild';
  end if;

  -- One overload each: a trailing default changes a function's identity, and
  -- two callable versions is two gates (decision 39).
  if (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public'
         and p.proname in ('create_vendor_remittance', 'create_requisition_vendor_remittance',
                           'create_requisition_payee_remittance')) <> 3 then
    raise exception 'a remittance function was left with two overloads';
  end if;

  -- The money functions are callable by the server alone, and the recorder by
  -- nobody at all.
  if exists (
    select 1 from information_schema.routine_privileges
     where routine_schema = 'public'
       and routine_name in ('create_vendor_remittance', 'create_requisition_vendor_remittance',
                            'create_requisition_payee_remittance', 'create_rent_remittance',
                            'record_remittance_sent', 'pay_by_bank_transfer',
                            'submit_payout_details', 'payout_request_by_token',
                            'use_gateway_account_for_remittance')
       and privilege_type = 'EXECUTE'
       and grantee in ('PUBLIC', 'anon', 'authenticated')
  ) then
    raise exception 'a money function is callable by a signed-in user';
  end if;
  if exists (
    select 1 from information_schema.routine_privileges
     where routine_schema = 'public' and routine_name = 'record_manual_remittance'
       and privilege_type = 'EXECUTE' and grantee in ('PUBLIC', 'anon', 'authenticated', 'service_role')
  ) then
    raise exception 'record_manual_remittance is reachable from outside pay_by_bank_transfer';
  end if;

  if pg_get_functiondef('public.my_notifications(integer)'::regprocedure) not like '%''remittance''%'
     or pg_get_functiondef('public.my_notifications(integer)'::regprocedure) not like '%active_uid()%' then
    raise exception 'my_notifications cannot tell a live remittance from a deleted one, or lost its deactivation guard';
  end if;

  if not exists (
    select 1 from pg_trigger t join pg_proc pr on pr.oid = t.tgfoid
     where t.tgrelid = 'remittances'::regclass
       and pr.proname = 'delete_notifications_for_deleted_entity' and not t.tgisinternal
  ) then
    raise exception 'the remittance notification subject shipped with no orphan cascade';
  end if;

  -- The rule, exercised.
  if not payout_account_usable('manual', null, now(), 'x', 'manual')
     or payout_account_usable('manual', null, null, 'x', 'manual')
     or payout_account_usable('manual', null, now(), 'x', 'gateway')
     or payout_account_usable('paystack', 'RCP_x', now(), null, 'manual')
     or not payout_account_usable('paystack', 'RCP_x', null, null, 'any')
     or payout_account_usable('paystack', 'RCP_x', now(), null, 'surprise') then
    raise exception 'payout_account_usable does not say what it means';
  end if;
end $$;
