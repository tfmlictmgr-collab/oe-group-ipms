-- 0294 — A notice is filed as the thing its link opens, and opens the thing it
-- is about (14 Sept 2026).
--
-- Reported with a screenshot of the bell: "A reported payment is waiting for
-- you — OPC-202609-D38B22 — ₦6,000,000.00", not clickable; "all notifications
-- should point to the action pages … where to fully view the notification to
-- take action or read its full details."
--
-- ── What was measured, before anything was written ────────────────────────
--
-- Every stored notice on staging carries a link; none is missing one. The bell
-- renders an item as plain text only when `my_notifications()` says its subject
-- is no longer reachable, and that is what happened here — for the wrong reason.
--
--   • The offline-payment actions call `notify_role` with NO subject id. When
--     that happens, `notify_role` asks `notification_entity_from_link()` to work
--     the subject out from the link. That resolver knew `^/dashboard/payments/`
--     and nothing more specific, so `/dashboard/payments/offline/<claim id>` was
--     filed as a **payment** with the **claim's** id. `my_notifications` then
--     looked for that id in `payments`, found nothing, reported the target gone,
--     and the bell switched the link off. 13 notices, every one of them a live
--     claim a confirming desk was being asked to act on. The one notice written
--     with the right type (`offline_payment`, 0282's own payer letter) worked,
--     which is why it looked intermittent.
--   • 📌 0282 wired `offline_payment` into `my_notifications` and gave it an
--     orphan cascade (decision 45: "a seventh notification subject ships with
--     its own orphan cascade") — and never taught the RESOLVER the link shape.
--     The subject type existed; the one function that assigns it by default did
--     not know it. Decision 24's sentence once more: adding the second case is
--     finished when every reader of the first has been re-read, and the
--     resolver is a reader.
--   • "A requisition was raised" — 2,312 notices — linked to `/dashboard/
--     approvals`, the whole queue, not the requisition. It resolves, so no suite
--     saw it; decision 40's point exactly: a link that resolves is not thereby a
--     destination. 589 can be matched to their own requisition by the reference
--     in their body; 1,723 name requisitions that no longer exist (test
--     fixtures, hard-deleted) and are removed, as 0276 removed orphans — a bell
--     item is not the record (decision 41).
--   • 400 vendor notices carried an id with NO type (the resolver returned the
--     uuid for any link, typed or not), so `my_notifications` fell through to
--     `else true` and believed them forever: 273 name vendors since deleted, and
--     were offered as links to a page that 404s. The failure decision 45 named —
--     "an unlisted type does not fail loudly; it fails by being believed".
--
-- ── What this does ────────────────────────────────────────────────────────
--
--   1. The resolver learns the offline-claim, requisition, remittance and vendor
--      page shapes — offline BEFORE the general payments branch — and returns an
--      id only when it recognised the shape, so an unknown link is a static link
--      rather than a half-filed one.
--   2. `my_notifications` gains `ops_requisition` and `vendor`, rebuilt from the
--      LIVE catalogue with those two lines inserted (0183), and both tables gain
--      0138's cleanup trigger — 0276's enumeration, extended.
--   3. `raise_ops_requisition` links to the requisition's own page, rebuilt from
--      the live catalogue with that one literal changed.
--   4. Every existing notice is repaired, and the result is asserted.
--
-- Deliberately unchanged: "Welcome aboard" and "This organisation was retired"
-- land on the dashboard home — they announce, and there is nothing to act on;
-- "Invoice … reopened" lands on the vendor's My Work, where that invoice's
-- status is shown; "New vendor application" lands on the applications list,
-- where it is decided.

-- ── Helper: replace exactly one occurrence, or refuse ─────────────────────
create or replace function pg_temp.swap(p_def text, p_from text, p_to text, p_what text)
returns text language plpgsql as $$
declare n int;
begin
  n := (length(p_def) - length(replace(p_def, p_from, ''))) / greatest(length(p_from), 1);
  if n <> 1 then
    raise exception '0294 rebuild of %: expected exactly one match, found %', p_what, n;
  end if;
  return replace(p_def, p_from, p_to);
end $$;

-- ── 1. The resolver ───────────────────────────────────────────────────────
-- Live body read 14 Sept 2026; the six original branches are unchanged and in
-- their original order, with the four new shapes added.
create or replace function public.notification_entity_from_link(p_link text)
 returns table(entity_type text, entity_id uuid)
 language sql
 immutable
 set search_path to 'public'
as $function$
  select t.kind,
         -- An id only for a shape we recognise. Returning the uuid for ANY link
         -- is what filed 400 vendor notices with an id and no type.
         case when t.kind is not null then
           nullif(substring(p_link from '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}'), '')::uuid
         end
    from (select case
      when p_link ~ '^/dashboard/tickets/'                then 'ticket'
      -- ⚠️ Before the general payments branch, or every claim is a "payment".
      when p_link ~ '^/dashboard/payments/offline/'       then 'offline_payment'
      when p_link ~ '^/dashboard/payments/'               then 'payment'
      when p_link ~ '^/dashboard/assets/'                 then 'asset'
      when p_link ~ '^/dashboard/properties/'             then 'property'
      when p_link ~ '^/dashboard/leases/'                 then 'lease'
      when p_link ~ '^/dashboard/people/tenancy/'         then 'tenant_application'
      when p_link ~ '^/dashboard/approvals/requisitions/' then 'ops_requisition'
      when p_link ~ '^/dashboard/remittances/'            then 'remittance'
      when p_link ~ '^/dashboard/vendors/'                then 'vendor'
    end as kind) t;
$function$;
-- Grants are left as they stand: this is a pure function over its argument and
-- reads no table, so there is nothing for any caller to reach through it.

-- ── 2. my_notifications learns the two new subjects ───────────────────────
do $$
declare d text;
begin
  d := pg_get_functiondef('public.my_notifications(integer)'::regprocedure);
  d := pg_temp.swap(d,
    $x$when n.entity_type = 'remittance'$x$,
    $x$when n.entity_type = 'ops_requisition'    then exists (select 1 from ops_requisitions q        where q.id = n.entity_id)
      when n.entity_type = 'vendor'             then exists (select 1 from vendors v                 where v.id = n.entity_id)
      when n.entity_type = 'remittance'$x$,
    'my_notifications (the remittance branch)');
  execute d;
end $$;

revoke all on function public.my_notifications(integer) from public, anon, authenticated, service_role;
grant execute on function public.my_notifications(integer) to authenticated, service_role;

-- And the cascade behind each, on 0138's one parameterised function.
drop trigger if exists ops_requisitions_delete_cleans_notifications on ops_requisitions;
create trigger ops_requisitions_delete_cleans_notifications
  after delete on ops_requisitions
  for each row execute function delete_notifications_for_deleted_entity('ops_requisition');

drop trigger if exists vendors_delete_cleans_notifications on vendors;
create trigger vendors_delete_cleans_notifications
  after delete on vendors
  for each row execute function delete_notifications_for_deleted_entity('vendor');

-- ── 3. A requisition notice opens the requisition ─────────────────────────
do $$
declare d text;
begin
  d := pg_get_functiondef('public.raise_ops_requisition(text,jsonb,uuid,text,text)'::regprocedure);
  d := pg_temp.swap(d,
    $x$'/dashboard/approvals'$x$,
    $x$'/dashboard/approvals/requisitions/' || v_req_id::text$x$,
    'raise_ops_requisition (the notice link)');
  execute d;
end $$;

revoke all on function public.raise_ops_requisition(text,jsonb,uuid,text,text) from public, anon, authenticated, service_role;
grant execute on function public.raise_ops_requisition(text,jsonb,uuid,text,text) to authenticated, service_role;

-- ── 4. Repair what is already in people's bells ───────────────────────────
do $$
declare n int;
begin
  -- a. Offline claims filed as payments.
  update user_notifications
     set entity_type = 'offline_payment'
   where entity_type = 'payment'
     and link ~ '^/dashboard/payments/offline/';
  get diagnostics n = row_count;
  raise notice '0294: % offline-claim notice(s) re-filed as offline_payment', n;

  -- b. Requisition notices that can name their requisition: exactly one match,
  --    by reference, inside the notice's own organisation.
  with m as (
    select n2.id as nid, min(r.id::text)::uuid as rid, count(r.id) as c
      from user_notifications n2
      join ops_requisitions r
        on r.org_id = n2.org_id
       and n2.body = r.reference || ' awaits your sign-off'
     where n2.title = 'A requisition was raised'
       and n2.link = '/dashboard/approvals'
     group by n2.id
  )
  update user_notifications u
     set link = '/dashboard/approvals/requisitions/' || m.rid::text,
         entity_type = 'ops_requisition',
         entity_id = m.rid
    from m
   where u.id = m.nid and m.c = 1;
  get diagnostics n = row_count;
  raise notice '0294: % requisition notice(s) now open their own requisition', n;

  -- c. …and the ones whose requisition no longer exists describe nothing.
  delete from user_notifications n3
   where n3.title = 'A requisition was raised'
     and n3.link = '/dashboard/approvals'
     and not exists (
       select 1 from ops_requisitions r
        where r.org_id = n3.org_id
          and n3.body = r.reference || ' awaits your sign-off');
  get diagnostics n = row_count;
  raise notice '0294: % requisition notice(s) removed — their requisition no longer exists', n;

  -- d. Vendor notices: typed, and the ones naming a deleted vendor removed.
  update user_notifications
     set entity_type = 'vendor'
   where entity_type is null
     and entity_id is not null
     and link ~ '^/dashboard/vendors/';
  get diagnostics n = row_count;
  raise notice '0294: % vendor notice(s) now say what they are about', n;

  delete from user_notifications n4
   where n4.entity_type = 'vendor'
     and not exists (select 1 from vendors v where v.id = n4.entity_id);
  get diagnostics n = row_count;
  raise notice '0294: % vendor notice(s) removed — their vendor no longer exists', n;
end $$;

-- ── 5. Assert the rule, not this batch ────────────────────────────────────
do $$
declare
  v_type text; v_id uuid; v_missing text[]; v_left int; v_def text;
  k constant uuid := '00000000-0000-0000-0000-000000000001';
begin
  -- The resolver files each shape as its own subject.
  select entity_type, entity_id into v_type, v_id
    from notification_entity_from_link('/dashboard/payments/offline/' || k);
  if v_type is distinct from 'offline_payment' or v_id is distinct from k then
    raise exception '0294: an offline-claim link resolved as % (%)', v_type, v_id;
  end if;
  select entity_type into v_type from notification_entity_from_link('/dashboard/payments/' || k);
  if v_type is distinct from 'payment' then
    raise exception '0294: a payment link resolved as %', v_type;
  end if;
  select entity_type into v_type from notification_entity_from_link('/dashboard/approvals/requisitions/' || k);
  if v_type is distinct from 'ops_requisition' then
    raise exception '0294: a requisition link resolved as %', v_type;
  end if;
  select entity_type, entity_id into v_type, v_id from notification_entity_from_link('/dashboard/somewhere/' || k);
  if v_type is not null or v_id is not null then
    raise exception '0294: an unrecognised link was half-filed as % / %', v_type, v_id;
  end if;

  -- Every subject my_notifications checks has a cascade behind it (0276,
  -- extended with every type added since).
  select array_agg(x.tbl order by x.tbl) into v_missing
    from (values
      ('tickets'), ('payments'), ('tenant_applications'), ('leases'), ('assets'),
      ('properties'), ('offline_payment_claims'), ('remittances'),
      ('ops_requisitions'), ('vendors')
    ) as x(tbl)
   where not exists (
     select 1 from pg_trigger t
       join pg_class c on c.oid = t.tgrelid
       join pg_proc p on p.oid = t.tgfoid
      where c.relname = x.tbl
        and p.proname = 'delete_notifications_for_deleted_entity'
        and not t.tgisinternal);
  if v_missing is not null then
    raise exception '0294: a notification subject with no cascade behind it: %', array_to_string(v_missing, ', ');
  end if;

  -- The rebuilt functions carry what they had AND what was added. active_uid()
  -- is 0195's deactivation rule — lost once before by a rebuild (decision 38).
  v_def := pg_get_functiondef('public.my_notifications(integer)'::regprocedure);
  if v_def !~ 'active_uid\(\)' or v_def !~ 'ops_requisition' or v_def !~ '''vendor''' or v_def !~ '''offline_payment''' then
    raise exception '0294: my_notifications lost a clause in the rebuild';
  end if;
  v_def := pg_get_functiondef('public.raise_ops_requisition(text,jsonb,uuid,text,text)'::regprocedure);
  if v_def !~ '/dashboard/approvals/requisitions/' then
    raise exception '0294: raise_ops_requisition still links to the whole queue';
  end if;

  -- Nothing is filed as a different subject than its link opens.
  select count(*) into v_left
    from user_notifications n
    cross join lateral notification_entity_from_link(n.link) r
   where r.entity_type is not null
     and (n.entity_type is distinct from r.entity_type or n.entity_id is distinct from r.entity_id);
  if v_left > 0 then
    raise exception '0294: % notice(s) are filed as a different subject than their link opens', v_left;
  end if;

  -- And nothing dangles, in any subject.
  select count(*) into v_left from user_notifications n
   where n.entity_id is not null
     and case n.entity_type
       when 'ticket'             then not exists (select 1 from tickets x                where x.id = n.entity_id)
       when 'payment'            then not exists (select 1 from payments x               where x.id = n.entity_id)
       when 'asset'              then not exists (select 1 from assets x                 where x.id = n.entity_id)
       when 'property'           then not exists (select 1 from properties x             where x.id = n.entity_id)
       when 'lease'              then not exists (select 1 from leases x                 where x.id = n.entity_id)
       when 'tenant_application' then not exists (select 1 from tenant_applications x    where x.id = n.entity_id)
       when 'offline_payment'    then not exists (select 1 from offline_payment_claims x where x.id = n.entity_id)
       when 'remittance'         then not exists (select 1 from remittances x            where x.id = n.entity_id)
       when 'ops_requisition'    then not exists (select 1 from ops_requisitions x       where x.id = n.entity_id)
       when 'vendor'             then not exists (select 1 from vendors x                where x.id = n.entity_id)
       else false
     end;
  if v_left > 0 then
    raise exception '0294: % notice(s) still name a record that no longer exists', v_left;
  end if;

  -- Grants: neither rebuilt function is reachable anonymously.
  if exists (
    select 1 from information_schema.routine_privileges
     where routine_schema = 'public'
       and routine_name in ('my_notifications', 'raise_ops_requisition')
       and grantee in ('anon', 'PUBLIC')) then
    raise exception '0294: a rebuilt function is callable anonymously';
  end if;
end $$;
