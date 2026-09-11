-- Self-service notification preferences, and admin member deactivation.
--
-- Why RPCs rather than an RLS policy on `users`:
-- RLS is ROW-level, not column-level. A policy permitting `id = auth.uid()` to
-- UPDATE would let anyone edit *any column of their own row* — including
-- `role` and `org_id`. That is a straight privilege escalation: a tenant could
-- make themselves an admin. These functions expose exactly the columns each
-- caller is allowed to touch, and nothing else.

/**
 * A user updates their OWN notification channels. role, org_id and every other
 * column are untouchable through this path.
 *
 * A channel is only enabled when its identifier is present, so preferences can
 * never claim a delivery route that would fail at send time.
 */
create or replace function update_my_notification_prefs(
  p_phone text default null,
  p_telegram_chat_id text default null,
  p_email boolean default true,
  p_whatsapp boolean default false,
  p_sms boolean default false,
  p_telegram boolean default false
)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_phone text := nullif(trim(p_phone), '');
  v_tg text := nullif(trim(p_telegram_chat_id), '');
begin
  if auth.uid() is null then
    raise exception 'you must be signed in';
  end if;

  update users set
    phone            = v_phone,
    telegram_chat_id = v_tg,
    notify_email     = coalesce(p_email, true),
    -- Both ride on the phone number; without one they are not deliverable.
    notify_whatsapp  = coalesce(p_whatsapp, false) and v_phone is not null,
    notify_sms       = coalesce(p_sms, false) and v_phone is not null,
    notify_telegram  = coalesce(p_telegram, false) and v_tg is not null
  where id = auth.uid();
end;
$$;

/**
 * Deactivate or restore a member. Not a delete: anyone who has performed an
 * audited action is referenced by audit_log.actor_id and must remain, or the
 * audit trail develops holes. Deactivating removes them from pickers, stops
 * notifications reaching them, and leaves history intact.
 *
 * An admin cannot deactivate themselves — that is the classic way to lock an
 * organisation out of its own account.
 */
create or replace function set_member_active(p_user_id uuid, p_active boolean)
returns void language plpgsql security definer set search_path = public as $$
declare v_org uuid;
begin
  if current_user_role() <> 'admin' then
    raise exception 'only an administrator may deactivate or restore a member';
  end if;

  select org_id into v_org from users where id = p_user_id;
  if v_org is null then
    raise exception 'member not found';
  end if;
  if v_org is distinct from current_user_org_id() then
    raise exception 'that member belongs to another organisation';
  end if;
  if p_user_id = auth.uid() and not p_active then
    raise exception 'you cannot deactivate your own account';
  end if;

  update users
  set deactivated_at = case when p_active then null else now() end
  where id = p_user_id;
end;
$$;

revoke all on function update_my_notification_prefs(text, text, boolean, boolean, boolean, boolean) from public;
revoke all on function set_member_active(uuid, boolean) from public;
grant execute on function update_my_notification_prefs(text, text, boolean, boolean, boolean, boolean) to authenticated;
grant execute on function set_member_active(uuid, boolean) to authenticated;

-- Acceptance must also record the channels chosen during enrolment, so a new
-- member's preferences are live from their first login.
create or replace function accept_invitation(
  p_token_hash text,
  p_full_name text default null,
  p_phone text default null,
  p_telegram_chat_id text default null,
  p_notify_whatsapp boolean default false,
  p_notify_sms boolean default false,
  p_notify_telegram boolean default false
)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  inv invitations%rowtype;
  v_uid uuid := auth.uid();
  v_email text;
  v_phone text := nullif(trim(p_phone), '');
  v_tg text := nullif(trim(p_telegram_chat_id), '');
  p uuid;
begin
  if v_uid is null then
    raise exception 'you must be signed in to accept an invitation';
  end if;

  select * into inv from invitations
  where token_hash = p_token_hash and status = 'pending' and expires_at > now()
  for update;

  if inv.id is null then
    raise exception 'this invitation is invalid, already used, or has expired';
  end if;

  select email into v_email from auth.users where id = v_uid;
  if lower(v_email) is distinct from lower(inv.email) then
    raise exception 'this invitation was issued to a different email address';
  end if;

  if exists (select 1 from users where id = v_uid) then
    raise exception 'this account already belongs to an organisation';
  end if;

  insert into users (
    id, org_id, role, full_name, email, phone, telegram_chat_id,
    notify_email, notify_whatsapp, notify_sms, notify_telegram
  )
  values (
    v_uid, inv.org_id, inv.role,
    coalesce(nullif(trim(p_full_name), ''), inv.full_name), inv.email,
    coalesce(v_phone, nullif(trim(inv.invite_phone), '')), v_tg,
    true,
    coalesce(p_notify_whatsapp, false) and coalesce(v_phone, nullif(trim(inv.invite_phone), '')) is not null,
    coalesce(p_notify_sms, false) and coalesce(v_phone, nullif(trim(inv.invite_phone), '')) is not null,
    coalesce(p_notify_telegram, false) and v_tg is not null
  );

  foreach p in array inv.property_ids loop
    insert into property_stakeholders (org_id, property_id, user_id, relation)
    values (inv.org_id, p, v_uid, inv.property_relation)
    on conflict (property_id, user_id, relation) do nothing;
  end loop;

  if inv.unit_id is not null then
    update units set occupant_user_id = v_uid
    where id = inv.unit_id and org_id = inv.org_id;
  end if;

  if inv.vendor_id is not null then
    update vendors set user_id = v_uid
    where id = inv.vendor_id and org_id = inv.org_id;
  end if;

  update invitations
  set status = 'accepted', accepted_at = now(), accepted_user_id = v_uid
  where id = inv.id;

  -- Welcome them into their own notification centre.
  perform notify_user(
    v_uid, 'system', 'Welcome aboard',
    'Your account is ready. You can change how we reach you in Settings.',
    '/dashboard'
  );

  return inv.org_id;
end;
$$;

grant execute on function accept_invitation(text, text, text, text, boolean, boolean, boolean) to authenticated;
