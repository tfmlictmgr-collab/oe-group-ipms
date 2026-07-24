-- Day 2 — per-org inbound channel routing.
-- Replaces the hardcoded DEMO_ORG_ID in the intake webhooks. Each inbound
-- channel identity maps to exactly one org, so a message to the TFML number
-- creates a ticket in TFML and a message to the OEA number lands in OEA.
--
--   whatsapp  external_id = the WhatsApp Business phone_number_id (from the
--             webhook payload's value.metadata.phone_number_id). Safe to route
--             on because the payload is already HMAC-authenticated as Meta's.
--   telegram  external_id = the per-bot webhook secret token (the value echoed
--             in x-telegram-bot-api-secret-token). It doubles as auth AND route
--             key: a token that matches no row is an unknown/forged bot → reject.

create table channel_routes (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  channel text not null check (channel in ('whatsapp', 'telegram')),
  external_id text not null,
  label text,
  created_at timestamptz not null default now()
);

-- One identity routes to exactly one org (no ambiguous or hijacked routing).
create unique index channel_routes_channel_ext_uidx
  on channel_routes (channel, external_id);
create index channel_routes_org_idx on channel_routes (org_id);

alter table channel_routes enable row level security;

-- Staff may VIEW their own org's routes (transparency in the admin UI).
create policy channel_routes_select on channel_routes for select
  using (org_id = current_user_org_id());

-- No insert/update/delete policy: routes are provisioned by the platform
-- operator via the service role, never self-served by an org admin. This
-- prevents one brand pre-registering another brand's number to hijack its
-- inbound money-related messages. (Service role bypasses RLS.)

-- Route changes are governance-relevant → audit them.
create trigger audit_channel_route_write
  after insert or update or delete on channel_routes
  for each row execute function log_audit('channel_route.write');
