-- Day 13: B8 notification cascade — per-message delivery tracking.
-- One logical notification produces one row per channel attempt (grouped by
-- cascade_id). Inserts are server-side only (service role); a trigger mirrors
-- every attempt into the immutable audit_log (Module 5), satisfying "log every
-- attempt/failure to audit_log".

create type notification_channel as enum ('whatsapp', 'sms', 'email', 'telegram', 'push');
create type notification_status as enum ('sent', 'failed', 'skipped');

create table notifications (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id),
  cascade_id uuid not null,           -- groups the attempts for one message
  channel notification_channel not null,
  recipient text,
  status notification_status not null,
  detail text,                        -- 'delivered' | error text | 'stubbed: …'
  entity_type text,                   -- 'ticket' | 'payment' | 'service_charge'
  entity_id uuid,
  attempt_order int not null,
  created_at timestamptz not null default now()
);
create index notifications_org_idx on notifications(org_id);
create index notifications_cascade_idx on notifications(cascade_id);

alter table notifications enable row level security;

-- Staff read; no client insert policy (written by the service role, like audit).
create policy notifications_select on notifications for select
  using (org_id = current_user_org_id()
    and current_user_role() = any (array['admin','facility_manager','finance_approver']::user_role[]));

-- Each attempt is mirrored to the audit trail.
create trigger audit_notifications after insert on notifications
  for each row execute function log_audit('notification.attempt');
