-- ⚠️ A regression from 0122, caught by `verify-operator-governance`:
-- "NOBODY AT THE ORG WAS TOLD".
--
-- 0122 stopped a signed-in caller writing notifications into another
-- organisation — a genuine B1 breach, proven live: a TFML tenant put "Urgent:
-- verify your bank details" into an OEA administrator's inbox. That fix was
-- right and stays.
--
-- What it also stopped is the one crossing the board explicitly sanctions.
-- `operator_break_glass_invite` (0079/0079b) ends by telling the target org's
-- administrators and executives that OE Group has just issued an emergency
-- administrator invitation into their organisation:
--
--     perform notify_role(p_org_id, array['admin','executive'], 'security',
--                         'OE Group issued an emergency administrator invitation', ...)
--
-- The caller there is a signed-in operator admin, not a service role, so
-- `auth.uid()` is set and `current_user_org_id()` is the OPERATOR org while
-- `p_org_id` is the brand. 0122's check therefore returned 0 and the
-- announcement went nowhere.
--
-- 📌 The consequence is precisely backwards. `operator_actions`' own comment
-- says the crossing is "visible to the organisation it was done TO, not only to
-- the operator — silent operator access is the thing auditors object to, not
-- operator access as such." A boundary that silences exactly that announcement
-- has made operator access silent, which is the one outcome decision 7 was
-- written to prevent.
--
-- Fixed by naming the exception rather than widening the rule: an operator
-- ADMINISTRATOR may notify across organisations. `caller_is_operator_admin()`
-- is the same gate the permission matrix, the org directory and the
-- consolidated position all use, so this adds no new privilege — it lets the
-- existing one finish speaking.

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

  -- Own organisation, or a service-role caller (auth.uid() null: the scheduled
  -- jobs and webhooks), or the platform operator's administrator — the single
  -- audited crossing decision 7 allows, and the one that tells an org it has
  -- been crossed.
  if auth.uid() is not null
     and v_org is distinct from current_user_org_id()
     and not (select caller_is_operator_admin()) then
    return null;
  end if;

  if p_link is not null and p_link !~ '^/' then
    raise exception 'notification link must be a relative path';
  end if;

  insert into user_notifications (org_id, user_id, kind, title, body, link, entity_type, entity_id)
  values (v_org, p_user_id, p_kind, p_title, p_body, p_link, p_entity_type, p_entity_id)
  returning id into v_id;
  return v_id;
end;
$$;

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
  if auth.uid() is not null
     and p_org_id is distinct from current_user_org_id()
     and not (select caller_is_operator_admin()) then
    return 0;
  end if;

  if p_link is not null and p_link !~ '^/' then
    raise exception 'notification link must be a relative path';
  end if;

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
revoke execute on function notify_user(uuid, text, text, text, text, text, uuid) from anon;
revoke execute on function notify_role(uuid, user_role[], text, text, text, text, text, uuid) from anon;
grant execute on function notify_user(uuid, text, text, text, text, text, uuid) to authenticated, service_role;
grant execute on function notify_role(uuid, user_role[], text, text, text, text, text, uuid) to authenticated, service_role;

comment on function notify_user is
  'Writes one in-app notification. A signed-in caller may only notify within their own organisation -- silently a no-op otherwise, matching the deactivated-recipient case, because refusing would confirm the recipient exists. Three exceptions, each deliberate: a service-role caller (scheduled jobs, webhooks), and an operator administrator, who must be able to tell an organisation it has been crossed.';

comment on function notify_role is
  'Notifies every active holder of a role in an org. Own org only for an ordinary signed-in caller; service-role and operator-administrator callers may name any org -- the latter because operator_break_glass_invite announces itself to the org it crossed, and silent operator access is the thing auditors object to.';
