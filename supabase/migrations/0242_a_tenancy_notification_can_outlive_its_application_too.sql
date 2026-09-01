-- The same 404 as 0138/0145, on the one entity those two never covered.
--
-- 🚨 Reported live, on OEA staging: a regional manager (Remi Abolarinwa) had
-- nine unread "A new tenancy application" notifications, every one pointing
-- at `/dashboard/people/tenancy/e40e0508-...`. The application row is gone —
-- `select * from tenant_applications where id = '...'` returns nothing — but
-- the notification survived it and kept offering a link.
--
-- ⚠️ 0219 (the caller) did everything right: it passes `p_entity_type =>
-- 'tenant_application'` explicitly on every notify_role call, exactly as
-- 0145 asks. The gap is on the READING side, in two places 0145 built but
-- never extended to this entity:
--
--   1. `notification_entity_from_link()` — its CASE recognises tickets,
--      payments, assets, properties, leases. Not tenancy applications. Any
--      caller that (like 0241's `system_recommend_application` and
--      `escalate_stale_applications`) relies on DERIVATION rather than
--      passing the entity explicitly gets `entity_type = NULL` back, and
--      `my_notifications()` treats a NULL entity as "a static link cannot
--      dangle" — permanently live, even after the row is gone.
--   2. `my_notifications()`'s `target_live` CASE — the same five tables,
--      and nothing else. Even 0219's notifications, which DO carry
--      `entity_type = 'tenant_application'` correctly, fall through to the
--      `else true` at the bottom because nothing asks `tenant_applications`
--      whether the row is still there.
--   3. 0138's cascade trigger is on `tickets` and `payments` only. Nothing
--      deletes a tenant application's notifications when the application
--      itself is deleted, which is how nine of them outlived theirs.
--
-- Fixing only the symptom (delete these nine rows) leaves the next probe
-- cleanup, or the next `system_recommend_application` call, doing exactly
-- this again — 0145's own lesson, reapplied to the table it missed.
--
-- This also finishes the job 0145 started for `target_live` as an ACCESS
-- check, not only an EXISTENCE one: `tenant_applications_staff_select`
-- scopes an FM/PM/regional manager to `property_id in
-- current_user_property_ids()`, and `my_notifications()` is already
-- SECURITY INVOKER for exactly this reason. A regional manager notified
-- about a property outside their own region — 0219 notifies every fm_roles()
-- holder in the org, not only those whose scope includes the property — will
-- now see the link correctly greyed out instead of landing on a 404, with no
-- change needed to who gets notified.

-- ── 1. Clean up what already broke ─────────────────────────────────────────
do $$
declare v_deleted integer;
begin
  delete from user_notifications n
   where n.entity_type = 'tenant_application'
     and n.entity_id is not null
     and not exists (
       select 1 from tenant_applications a where a.id = n.entity_id and a.purged_at is null
     );
  get diagnostics v_deleted = row_count;
  raise notice 'removed % orphaned tenant_application notification(s) (entity tagged)', v_deleted;

  -- 0241's calls never passed p_entity_type, so these carry NULL/NULL and were
  -- never reachable by the delete above. Same derivation the link pattern uses.
  delete from user_notifications n
   where n.entity_type is null
     and n.link ~ '^/dashboard/people/tenancy/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
     and not exists (
       select 1 from tenant_applications a
        where a.id = substring(n.link from '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}')::uuid
          and a.purged_at is null
     );
  get diagnostics v_deleted = row_count;
  raise notice 'removed % orphaned tenant_application notification(s) (undeclared entity)', v_deleted;
end $$;

-- ── 2. `/dashboard/people/tenancy/<id>` derives to `tenant_application` ────
create or replace function notification_entity_from_link(p_link text)
returns table (entity_type text, entity_id uuid)
language sql immutable set search_path = public as $$
  select
    case
      when p_link ~ '^/dashboard/tickets/'         then 'ticket'
      when p_link ~ '^/dashboard/payments/'        then 'payment'
      when p_link ~ '^/dashboard/assets/'          then 'asset'
      when p_link ~ '^/dashboard/properties/'      then 'property'
      when p_link ~ '^/dashboard/leases/'          then 'lease'
      when p_link ~ '^/dashboard/people/tenancy/'  then 'tenant_application'
    end,
    nullif(substring(p_link from '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}'), '')::uuid;
$$;

comment on function notification_entity_from_link is
  'Reads the subject out of a notification link. Exists because entity_type/entity_id are OPTIONAL arguments on notify_user/notify_role, several callers omit them while still linking to a specific row, and 0138''s cleanup keys on exactly those columns -- so the notification outlived its subject and the click 404ed. Deriving it centrally covers every caller, including the ones nobody will remember to update. Tenancy applications added by 0242 after 0241''s completeness-check and escalation notifications were found relying on this derivation and getting nothing back.';

-- Backfill existing rows the same way 0145 did for its five, now that this
-- one derives too.
update user_notifications
   set entity_type = 'tenant_application',
       entity_id   = substring(link from '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}')::uuid
 where entity_id is null
   and link ~ '^/dashboard/people/tenancy/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';

-- ── 3. `target_live` learns to ask `tenant_applications` too ───────────────
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
      when n.entity_type = 'ticket'             then exists (select 1 from tickets t             where t.id = n.entity_id)
      when n.entity_type = 'payment'            then exists (select 1 from payments p            where p.id = n.entity_id)
      when n.entity_type = 'asset'              then exists (select 1 from assets a               where a.id = n.entity_id)
      when n.entity_type = 'property'           then exists (select 1 from properties r           where r.id = n.entity_id)
      when n.entity_type = 'lease'              then exists (select 1 from leases l                where l.id = n.entity_id)
      when n.entity_type = 'tenant_application' then exists (select 1 from tenant_applications a   where a.id = n.entity_id and a.purged_at is null)
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
  'The caller''s own inbox: everything from the last N days, plus every UNREAD notification whatever its age -- an untreated item does not stop mattering because it got old. `target_live` says whether the thing it points at is still reachable BY THIS READER, which is why this is SECURITY INVOKER: a notification can dangle because its subject was deleted (a trigger catches that) or because the reader lost access to it (only a read as the caller can). The UI uses it to stop offering a link that would 404. Tenant applications added by 0242 -- run under the caller''s own tenant_applications_staff_select, so a regional manager notified about a property outside their region now sees the link correctly greyed out instead of a 404, no change to who gets notified.';

-- ── 4. Stop it recurring: a deleted application takes its notifications too ─
-- Reuses 0138's shared trigger function; nothing new to define.
drop trigger if exists tenant_applications_delete_cleans_notifications on tenant_applications;
create trigger tenant_applications_delete_cleans_notifications
  after delete on tenant_applications
  for each row execute function delete_notifications_for_deleted_entity('tenant_application');
