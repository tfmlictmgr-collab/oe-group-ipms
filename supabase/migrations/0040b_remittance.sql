-- Money going OUT. The mirror of 0032, but the failure modes are not symmetric.
--
-- A collection that posts twice is a bookkeeping error you can reverse. A
-- transfer that executes twice has left the building. So the discipline here is
-- stricter in one specific way: we never retry an instruction whose outcome we
-- do not know. An unknown result is a state, not something to paper over —
-- `unknown` below is deliberately terminal until a human resolves it.
--
-- The B4 gate is unchanged and still the law: no transfer exists unless service
-- verification, the KPI check, and the recorded approvals all passed. This
-- migration does not re-implement that gate; it refuses to create a remittance
-- for anything that has not already been through it.

-- ── Who we are allowed to pay ──────────────────────────────────────────────
--
-- PRIVACY, same rule as 0028: the full account number is sent to the gateway
-- once, to register the recipient, and is NEVER stored. What comes back is an
-- opaque recipient code, which is what subsequent transfers reference. Storing
-- the number would be a standing liability for no functional gain — we cannot
-- initiate a transfer from it anyway, only the gateway can.

create type payout_party as enum ('vendor', 'landlord');

create table payout_recipients (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,

  party payout_party not null,
  vendor_id uuid references vendors(id),
  user_id uuid references users(id),          -- the landlord

  -- Exactly one counterparty, matching `party`. A recipient that is both, or
  -- neither, has no meaning and would make the ledger account ambiguous.
  constraint payout_recipient_party_matches check (
    (party = 'vendor'   and vendor_id is not null and user_id is null) or
    (party = 'landlord' and user_id  is not null and vendor_id is null)
  ),

  display_name text not null,
  bank_name text,
  account_name text,
  account_number_last4 text
    check (account_number_last4 is null or account_number_last4 ~ '^[0-9]{4}$'),

  -- The gateway's handle for this recipient. The only thing we can pay to.
  gateway payment_gateway not null default 'paystack',
  recipient_code text,
  currency text not null default 'NGN',

  active boolean not null default true,
  verified_at timestamptz,                    -- name-enquiry confirmed at the bank
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index payout_recipients_vendor_uidx
  on payout_recipients (org_id, vendor_id) where party = 'vendor' and active;
create unique index payout_recipients_landlord_uidx
  on payout_recipients (org_id, user_id) where party = 'landlord' and active;

create trigger payout_recipients_touch before update on payout_recipients
  for each row execute function touch_updated_at();

-- ── The instruction itself ─────────────────────────────────────────────────

create type remittance_status as enum (
  'queued',    -- created, gate passed, nothing sent
  'sending',   -- handed to the gateway; outcome not yet known
  'sent',      -- gateway confirmed success; posted to the ledger
  'failed',    -- gateway confirmed failure; nothing left our account
  'unknown',   -- we asked, and do not know. NEVER auto-retried.
  'reversed'   -- returned by the bank after the fact
);

create table remittances (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,

  party payout_party not null,
  recipient_id uuid not null references payout_recipients(id),

  -- What this pays. A vendor remittance settles an approved payment; a landlord
  -- remittance settles rent collected over a period.
  payment_id uuid references payments(id),
  property_id uuid references properties(id),
  period text,

  -- Gross collected, what we keep, what actually goes out. Held separately
  -- rather than derived, so a fee change later cannot silently restate history.
  gross_amount numeric(16,2) not null check (gross_amount > 0),
  management_fee numeric(16,2) not null default 0 check (management_fee >= 0),
  admin_fee numeric(16,2) not null default 0 check (admin_fee >= 0),
  net_amount numeric(16,2) not null check (net_amount > 0),
  constraint remittance_net_is_gross_less_fees
    check (net_amount = gross_amount - management_fee - admin_fee),

  currency text not null default 'NGN',

  status remittance_status not null default 'queued',

  -- OUR reference, generated before anything is sent and unique per org. It is
  -- passed to the gateway so a redelivered instruction is refused at their end
  -- as well as ours.
  reference text not null,
  gateway payment_gateway not null default 'paystack',
  transfer_code text,
  gateway_message text,

  -- Set exactly once, when the ledger entry is posted. Its presence IS the
  -- "already posted" flag — the same rule as payment_intents in 0032, so there
  -- is no separate boolean to drift out of step.
  ledger_entry_id uuid references ledger_entries(id),

  -- Who let this happen. The gate is enforced elsewhere; this records it.
  approved_by uuid references users(id),
  approved_at timestamptz,
  sent_at timestamptz,
  settled_at timestamptz,

  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index remittances_org_reference_uidx on remittances (org_id, reference);
-- One live remittance per approved vendor payment. Two would pay the invoice
-- twice, which is the entire failure this table exists to prevent.
create unique index remittances_one_live_per_payment_uidx
  on remittances (payment_id)
  where payment_id is not null and status <> 'failed';

create index remittances_org_status_idx on remittances (org_id, status);

create trigger remittances_touch before update on remittances
  for each row execute function touch_updated_at();

-- ── The transitions that are allowed ───────────────────────────────────────
--
-- A state machine in the DATABASE, not only in a server action, so a direct
-- PostgREST PATCH cannot jump an instruction straight to `sent` — or, worse,
-- walk `sent` back to `queued` so it can be sent again.

create or replace function assert_remittance_transition()
returns trigger language plpgsql as $$
begin
  if old.status = new.status then
    return new;
  end if;

  if not (
    (old.status = 'queued'  and new.status in ('sending', 'failed')) or
    (old.status = 'sending' and new.status in ('sent', 'failed', 'unknown')) or
    (old.status = 'unknown' and new.status in ('sent', 'failed')) or
    (old.status = 'sent'    and new.status = 'reversed')
  ) then
    raise exception 'a remittance cannot go from % to %', old.status, new.status;
  end if;

  -- Terminal in the direction that matters: once money has gone, the amounts
  -- are history. Correct with a reversing entry, never by editing.
  if old.status in ('sent', 'reversed') and (
       new.gross_amount is distinct from old.gross_amount
    or new.net_amount   is distinct from old.net_amount
    or new.recipient_id is distinct from old.recipient_id
    or new.reference    is distinct from old.reference
  ) then
    raise exception 'a sent remittance cannot be restated';
  end if;

  return new;
end;
$$;

create trigger remittances_transition before update on remittances
  for each row execute function assert_remittance_transition();

-- ── RLS ────────────────────────────────────────────────────────────────────

alter table payout_recipients enable row level security;
alter table remittances enable row level security;

-- Recipients: finance and admin manage them; a vendor may see its own, so it
-- can confirm where its money is going.
create policy payout_recipients_select on payout_recipients for select
  using (
    org_id = current_user_org_id()
    and (
      current_user_role() = any (array['admin','finance_approver']::user_role[])
      or user_id = auth.uid()
      or vendor_id in (select id from vendors where user_id = auth.uid())
    )
  );

create policy payout_recipients_write on payout_recipients for all
  using (org_id = current_user_org_id()
    and current_user_role() = any (array['admin','finance_approver']::user_role[]))
  with check (org_id = current_user_org_id()
    and current_user_role() = any (array['admin','finance_approver']::user_role[]));

-- Remittances: the counterparty sees its own; finance and admin see all.
create policy remittances_select on remittances for select
  using (
    org_id = current_user_org_id()
    and (
      current_user_role() = any (array['admin','finance_approver']::user_role[])
      or recipient_id in (
        select id from payout_recipients
         where user_id = auth.uid()
            or vendor_id in (select id from vendors where user_id = auth.uid())
      )
    )
  );

-- Deliberately NO insert/update policy for any client role. Remittances are
-- created and advanced only by the server-side functions below, running as the
-- service role after the gate has been checked. A finance user who could INSERT
-- directly could create one for an unapproved payment.

create trigger audit_remittance after insert or update on remittances
  for each row execute function log_audit('remittance.write');
create trigger audit_payout_recipient after insert or update on payout_recipients
  for each row execute function log_audit('payout_recipient.write');

comment on table remittances is
  'Outbound payment instructions. Status `unknown` means the gateway result was never established — it is terminal until a human reconciles it, and must never be auto-retried: retrying an instruction of unknown outcome is how you pay twice.';
