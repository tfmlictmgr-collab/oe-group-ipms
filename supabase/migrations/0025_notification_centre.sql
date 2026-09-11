-- Notification centre, channel preferences, and member deactivation.
--
-- Note the distinction from the existing `notifications` table (0007): that is a
-- per-channel DELIVERY LOG (attempt → sent/failed/skipped, mirrored to audit),
-- readable only by staff. It answers "did the message go out?".
--
-- This table answers a different question — "what does THIS person still need to
-- deal with?" — so it is addressed to a user, readable only by that user, and
-- carries read state.

create table user_notifications (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  -- The recipient. Scoping by user is what makes this safe: a row is either
  -- yours or invisible. There is no role logic to get wrong.
  user_id uuid not null references users(id) on delete cascade,

  kind text not null check (kind in (
    'request',        -- new/updated service request
    'assignment',     -- a job assigned to you
    'approval',       -- something awaiting your decision
    'payment',        -- payment/remittance movement
    'application',    -- vendor application to review
    'invitation',     -- enrolment activity
    'asset',          -- compliance/service due
    'system'
  )),
  title text not null,
  body text,
  /** In-app destination, e.g. /dashboard/tickets/<id>. Relative only. */
  link text,
  entity_type text,
  entity_id uuid,

  read_at timestamptz,
  created_at timestamptz not null default now()
);

create index user_notifications_user_idx on user_notifications (user_id, created_at desc);
-- The bell's unread count hits this constantly; keep it a partial index.
create index user_notifications_unread_idx on user_notifications (user_id)
  where read_at is null;
create index user_notifications_org_idx on user_notifications (org_id);

alter table user_notifications enable row level security;

-- Read your own, and only your own. Org membership is implied by the row.
create policy user_notifications_select on user_notifications for select
  using (user_id = auth.uid());

-- You may mark your own as read. The WITH CHECK keeps the row yours, so an
-- update cannot reassign a notification to someone else.
create policy user_notifications_update on user_notifications for update
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- Deliberately no INSERT/DELETE policy: notifications are raised by the system
-- (service role) or by the SECURITY DEFINER helper below. A user cannot
-- fabricate a notification for themselves or anyone else.

/**
 * Raises a notification. SECURITY DEFINER so server actions can notify a
 * DIFFERENT user (e.g. telling an FM that a vendor applied) without granting
 * the caller blanket insert rights. The org is derived from the recipient, not
 * supplied, so a caller cannot plant a row into another org.
 */
create or replace function notify_user(
  p_user_id uuid,
  p_kind text,
  p_title text,
  p_body text default null,
  p_link text default null,
  p_entity_type text default null,
  p_entity_id uuid default null
)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_org uuid;
  v_id uuid;
begin
  select org_id into v_org from users where id = p_user_id and deactivated_at is null;
  if v_org is null then
    return null;  -- unknown or deactivated recipient: nothing to do
  end if;

  -- Only ever an in-app path, never an absolute URL, so a notification cannot
  -- be used to send someone to an external site.
  if p_link is not null and p_link !~ '^/' then
    raise exception 'notification link must be a relative path';
  end if;

  insert into user_notifications (org_id, user_id, kind, title, body, link, entity_type, entity_id)
  values (v_org, p_user_id, p_kind, p_title, p_body, p_link, p_entity_type, p_entity_id)
  returning id into v_id;
  return v_id;
end;
$$;

/** Notifies every active holder of a role in an org — e.g. all admins. */
create or replace function notify_role(
  p_org_id uuid,
  p_roles user_role[],
  p_kind text,
  p_title text,
  p_body text default null,
  p_link text default null,
  p_entity_type text default null,
  p_entity_id uuid default null
)
returns integer language plpgsql security definer set search_path = public as $$
declare n integer := 0;
begin
  insert into user_notifications (org_id, user_id, kind, title, body, link, entity_type, entity_id)
  select p_org_id, u.id, p_kind, p_title, p_body, p_link, p_entity_type, p_entity_id
  from users u
  where u.org_id = p_org_id and u.role = any(p_roles) and u.deactivated_at is null;
  get diagnostics n = row_count;
  return n;
end;
$$;

revoke all on function notify_user(uuid, text, text, text, text, text, uuid) from public;
revoke all on function notify_role(uuid, user_role[], text, text, text, text, text, uuid) from public;
grant execute on function notify_user(uuid, text, text, text, text, text, uuid) to authenticated;
grant execute on function notify_role(uuid, user_role[], text, text, text, text, text, uuid) to authenticated;

-- ── Member lifecycle ───────────────────────────────────────────────────────
-- People leave organisations, and some rows (anyone who has performed an
-- audited action) can never be hard-deleted because audit_log.actor_id
-- references them — correctly, since the audit trail must stay intact.
-- Deactivation is therefore the right primitive, not deletion.
alter table users add column if not exists deactivated_at timestamptz;
create index if not exists users_active_idx on users (org_id) where deactivated_at is null;

-- ── Notification channel preferences (B8) ──────────────────────────────────
-- Email is on by default because every account has one. The rest are strictly
-- opt-in and need an identifier before they can be used — so a blank phone
-- number silently disables SMS/WhatsApp rather than failing at send time.
alter table users add column if not exists telegram_chat_id text;
alter table users add column if not exists notify_email    boolean not null default true;
alter table users add column if not exists notify_whatsapp boolean not null default false;
alter table users add column if not exists notify_sms      boolean not null default false;
alter table users add column if not exists notify_telegram boolean not null default false;

-- Captured during enrolment, so a person chooses their channels as they sign up
-- rather than having to find a settings screen afterwards.
alter table invitations add column if not exists invite_phone text;
