-- What actually happened to an email we sent.
--
-- The bug this fixes: the portal reported "Invitation emailed to <address>" on
-- the strength of Resend returning 2xx. That response means ACCEPTED FOR
-- DELIVERY and nothing more. A message can be accepted and then bounce — the
-- mailbox does not exist, the domain rejects on DMARC, the recipient's server
-- defers and gives up. An administrator was being told the invitation had
-- arrived when the system had no idea whether it had, and no way to find out:
-- the provider's message id came back in the response and was discarded.
--
-- So: record every send, keep the provider's id, and let the provider's webhook
-- tell us the outcome. `accepted` is now an honest starting state rather than a
-- claim of success.

create table email_deliveries (
  id uuid primary key default gen_random_uuid(),
  org_id uuid references orgs(id) on delete cascade,

  provider text not null default 'resend',
  -- The key the webhook correlates on. Unique so a redelivered event cannot
  -- create a second row.
  provider_message_id text,

  to_email text not null,
  category text not null,
  subject text,

  -- What the email was about, so a bounce can be shown next to the thing it
  -- concerns rather than in a separate log nobody opens.
  entity_type text,
  entity_id uuid,

  status text not null default 'accepted'
    check (status in ('accepted', 'delivered', 'delayed', 'bounced', 'complained', 'failed')),
  detail text,

  sent_at timestamptz not null default now(),
  resolved_at timestamptz
);

create unique index email_deliveries_provider_msg_uidx
  on email_deliveries (provider, provider_message_id)
  where provider_message_id is not null;

create index email_deliveries_entity_idx on email_deliveries (entity_type, entity_id);
create index email_deliveries_org_idx on email_deliveries (org_id, sent_at desc);

alter table email_deliveries enable row level security;

-- Readable by the people who send and chase mail. Deliberately not tenants or
-- vendors: it lists other people's addresses.
create policy email_deliveries_select on email_deliveries for select
  using (
    org_id = current_user_org_id()
    and current_user_role() = any (
      array['admin', 'facility_manager', 'finance_approver']::user_role[]
    )
  );

-- No write policy at all. Rows are created by the send path and updated by the
-- provider webhook, both under the service role. A delivery record that a user
-- could edit would be worthless as evidence.

comment on table email_deliveries is
  'One row per outbound email. status starts at `accepted` (the provider took it) and is moved to delivered/bounced/complained by the provider webhook. Never claim delivery from an API 2xx alone.';
