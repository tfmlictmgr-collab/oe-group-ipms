-- The notification 404, properly this time — plus the 30-day inbox.
--
-- ⚠️ Reported again after `0138` was supposed to have fixed it: a finance
-- administrator clicked a notification and landed on "This page could not be
-- found". 0138 is not wrong — it is INCOMPLETE, and the shape of the
-- incompleteness is the lesson.
--
-- 0138 deletes a notification when its subject is deleted, matching on
-- `entity_type` + `entity_id`. Checked against the live database: **zero
-- orphans by that key.** Its triggers work exactly as designed.
--
-- But 84 notifications carry a UUID in their `link` and a **NULL `entity_id`**,
-- and 66 of those links are dead. `notify_user`/`notify_role` take
-- `p_entity_type` / `p_entity_id` as trailing OPTIONAL arguments, and several
-- callers — `0118`'s work-order notifications among them — pass a link built
-- as `'/dashboard/tickets/' || p_ticket_id` and simply stop there. The
-- notification points at a ticket without ever declaring that it does, so the
-- cleanup has nothing to match and the row outlives its subject.
--
-- 📌 The fix that would NOT hold is editing those three call sites. The next
-- person to write a `notify_role(...)` with a link and no entity reference
-- reintroduces it, silently, and nothing fails. So the derivation moves INTO
-- the notify functions: if a link carries an id and no entity was declared,
-- work it out from the route. Every existing caller is covered without being
-- touched, and every future one is covered without being told.

-- ── 1. Derive the subject from the link ───────────────────────────────────
create or replace function notification_entity_from_link(p_link text)
returns table (entity_type text, entity_id uuid)
language sql immutable set search_path = public as $$
  select
    case
      when p_link ~ '^/dashboard/tickets/'    then 'ticket'
      when p_link ~ '^/dashboard/payments/'   then 'payment'
      when p_link ~ '^/dashboard/assets/'     then 'asset'
      when p_link ~ '^/dashboard/properties/' then 'property'
      when p_link ~ '^/dashboard/leases/'     then 'lease'
    end,
    nullif(substring(p_link from '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}'), '')::uuid;
$$;

comment on function notification_entity_from_link is
  'Reads the subject out of a notification link. Exists because entity_type/entity_id are OPTIONAL arguments on notify_user/notify_role, several callers omit them while still linking to a specific row, and 0138''s cleanup keys on exactly those columns -- so the notification outlived its subject and the click 404ed. Deriving it centrally covers every caller, including the ones nobody will remember to update.';

-- ── 2. Both notify functions derive it when the caller did not ────────────
create or replace function notify_user(
  p_user_id uuid, p_kind text, p_title text, p_body text default null,
  p_link text default null, p_entity_type text default null, p_entity_id uuid default null
)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_org uuid; v_id uuid; v_type text := p_entity_type; v_ent uuid := p_entity_id;
begin
  select org_id into v_org from users where id = p_user_id and deactivated_at is null;
  if v_org is null then return null; end if;

  if auth.uid() is not null
     and v_org is distinct from current_user_org_id()
     and not (select caller_is_operator_admin()) then
    return null;
  end if;

  if p_link is not null and p_link !~ '^/' then
    raise exception 'notification link must be a relative path';
  end if;

  -- Declared subject wins; otherwise take it from the link.
  if v_ent is null and p_link is not null then
    select e.entity_type, e.entity_id into v_type, v_ent
      from notification_entity_from_link(p_link) e;
  end if;

  insert into user_notifications (org_id, user_id, kind, title, body, link, entity_type, entity_id)
  values (v_org, p_user_id, p_kind, p_title, p_body, p_link, v_type, v_ent)
  returning id into v_id;
  return v_id;
end;
$$;

create or replace function notify_role(
  p_org_id uuid, p_roles user_role[], p_kind text, p_title text, p_body text default null,
  p_link text default null, p_entity_type text default null, p_entity_id uuid default null
)
returns integer language plpgsql security definer set search_path = public as $$
declare n integer := 0; v_type text := p_entity_type; v_ent uuid := p_entity_id;
begin
  if auth.uid() is not null
     and p_org_id is distinct from current_user_org_id()
     and not (select caller_is_operator_admin()) then
    return 0;
  end if;

  if p_link is not null and p_link !~ '^/' then
    raise exception 'notification link must be a relative path';
  end if;

  if v_ent is null and p_link is not null then
    select e.entity_type, e.entity_id into v_type, v_ent
      from notification_entity_from_link(p_link) e;
  end if;

  insert into user_notifications (org_id, user_id, kind, title, body, link, entity_type, entity_id)
  select p_org_id, u.id, p_kind, p_title, p_body, p_link, v_type, v_ent
  from users u
  where u.org_id = p_org_id and u.role = any(p_roles) and u.deactivated_at is null;
  get diagnostics n = row_count;
  return n;
end;
$$;

-- ── 3. Backfill, then let 0138's own cleanup finish the job ───────────────
-- ⚠️ Expressions inlined rather than `from notification_entity_from_link(n.link)`.
-- A set-returning function in an UPDATE's FROM clause cannot reference the
-- target row without LATERAL, and LATERAL cannot reach the UPDATE target at
-- all: "invalid reference to FROM-clause entry for table n". The function
-- stays the single definition used by the notify paths above; this one
-- statement spells it out because SQL will not let it borrow it.
update user_notifications
   set entity_type = case
         when link ~ '^/dashboard/tickets/'    then 'ticket'
         when link ~ '^/dashboard/payments/'   then 'payment'
         when link ~ '^/dashboard/assets/'     then 'asset'
         when link ~ '^/dashboard/properties/' then 'property'
         when link ~ '^/dashboard/leases/'     then 'lease'
       end,
       entity_id = substring(link from '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}')::uuid
 where entity_id is null
   and link is not null
   and link ~ '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}'
   and link ~ '^/dashboard/(tickets|payments|assets|properties|leases)/';

-- Now that every id-bearing link declares its subject, the rows whose subject
-- is gone can finally be found. Same two statements 0138 ran; they matched
-- nothing then because the key was missing.
delete from user_notifications n
 where n.entity_type = 'ticket'
   and not exists (select 1 from tickets t where t.id = n.entity_id);
delete from user_notifications n
 where n.entity_type = 'payment'
   and not exists (select 1 from payments p where p.id = n.entity_id);

-- ── 4. The inbox the tab actually needs ───────────────────────────────────
--
-- Last 30 days by default, and **unread is kept whatever its age** — an
-- untreated notification does not stop mattering because it got old; that is
-- precisely when it matters most. Only READ ones age out, which is what makes
-- the list shrink to what still needs a person.
--
-- ⚠️ `target_live` is the other half of the 404 fix, and it covers a case no
-- cascade can: a notification whose subject still EXISTS but is no longer
-- visible to this reader — an FM who loses scope to a vendor, a payment that
-- moved out of their properties. A trigger cannot know that; only a read as
-- the caller can. This function is SECURITY INVOKER for exactly that reason,
-- so the existence check runs under the caller's own RLS.
create or replace function my_notifications(p_days integer default 30)
returns table (
  id uuid, kind text, title text, body text, link text,
  read_at timestamptz, created_at timestamptz,
  entity_type text, entity_id uuid, target_live boolean
)
language sql stable security invoker set search_path = public as $$
  select
    n.id, n.kind, n.title, n.body, n.link, n.read_at, n.created_at,
    n.entity_type, n.entity_id,
    case
      when n.entity_id is null then true          -- a static link cannot dangle
      when n.entity_type = 'ticket'   then exists (select 1 from tickets t    where t.id = n.entity_id)
      when n.entity_type = 'payment'  then exists (select 1 from payments p   where p.id = n.entity_id)
      when n.entity_type = 'asset'    then exists (select 1 from assets a     where a.id = n.entity_id)
      when n.entity_type = 'property' then exists (select 1 from properties r where r.id = n.entity_id)
      when n.entity_type = 'lease'    then exists (select 1 from leases l     where l.id = n.entity_id)
      else true
    end
  from user_notifications n
  where n.user_id = auth.uid()
    and (n.read_at is null or n.created_at >= now() - make_interval(days => greatest(p_days, 1)))
  order by n.read_at nulls first, n.created_at desc;
$$;

revoke all on function my_notifications(integer) from public;
revoke execute on function my_notifications(integer) from anon;
grant execute on function my_notifications(integer) to authenticated;

comment on function my_notifications is
  'The caller''s own inbox: everything from the last N days, plus every UNREAD notification whatever its age -- an untreated item does not stop mattering because it got old. `target_live` says whether the thing it points at is still reachable BY THIS READER, which is why this is SECURITY INVOKER: a notification can dangle because its subject was deleted (a trigger catches that) or because the reader lost access to it (only a read as the caller can). The UI uses it to stop offering a link that would 404.';

-- ── 5. Housekeeping, so the table does not grow without bound ─────────────
create or replace function purge_old_read_notifications(p_days integer default 30)
returns integer language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  delete from user_notifications
   where read_at is not null
     and created_at < now() - make_interval(days => greatest(p_days, 1));
  get diagnostics n = row_count;
  return n;
end;
$$;

revoke all on function purge_old_read_notifications(integer) from public, anon, authenticated;
grant execute on function purge_old_read_notifications(integer) to service_role;

comment on function purge_old_read_notifications is
  'Deletes READ notifications older than N days. Unread rows are never touched, at any age. Service-role only: this is a scheduled housekeeping job, not something a session should be able to fire.';
