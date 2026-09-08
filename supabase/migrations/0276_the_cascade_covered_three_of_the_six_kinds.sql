-- The cascade covered three of the six kinds a notification can be about
-- (8 Sept 2026).
--
-- Found while writing 0275, not by reading: its assertion failed on `dev` with
-- one lease notification it had deliberately declined to repoint, because the
-- lease it names has been hard-deleted. That is not 0275's fault — it is
-- `0138`'s, reached from a direction `0138` did not cover.
--
-- ⚠️ `0138` established the rule and built the mechanism:
-- `delete_notifications_for_deleted_entity()`, one parameterised function, so
-- a notification cannot outlive its subject. It then wired that function to
-- **`tickets` and `payments`** — the two tables the reported 404s came from.
-- `0242` added **`tenant_applications`** when the same 404 arrived from a
-- third. Nobody ever wired **`leases`, `assets` or `properties`**, and all
-- three have been first-class notification subjects the whole time:
-- `my_notifications`'s own `target_live` case lists six entity types, and
-- `verify-notification-links` section B walks the same six. The mechanism was
-- general; the wiring was written once per report.
--
-- 📌 This is the shape decision 24 wrote down and this repo keeps re-finding:
-- **a consumer written when there was one case, still correct for that case,
-- silently wrong for the second.** Here it is the writer rather than a reader,
-- and the tell is the same one — a general helper with an enumerated list of
-- callers beside it, where the list was never checked against the enumeration
-- it is supposed to mirror.
--
-- 📌 And the suite that exists for exactly this had never seen it, because it
-- runs against ONE world. Section B is correct and would have gone red on
-- `dev`; `.env.local` points at staging, where no lease had been hard-deleted.
-- A suite is only evidence about the database it was pointed at.

-- ── 1. What already broke, in the three kinds nothing was watching ────────
do $$
declare v_deleted integer := 0;
begin
  delete from user_notifications n
   where n.entity_type = 'lease'
     and n.entity_id is not null
     and not exists (select 1 from leases l where l.id = n.entity_id);
  get diagnostics v_deleted = row_count;
  raise notice 'removed % orphaned lease notification(s)', v_deleted;

  delete from user_notifications n
   where n.entity_type = 'asset'
     and n.entity_id is not null
     and not exists (select 1 from assets a where a.id = n.entity_id);
  get diagnostics v_deleted = row_count;
  raise notice 'removed % orphaned asset notification(s)', v_deleted;

  delete from user_notifications n
   where n.entity_type = 'property'
     and n.entity_id is not null
     and not exists (select 1 from properties p where p.id = n.entity_id);
  get diagnostics v_deleted = row_count;
  raise notice 'removed % orphaned property notification(s)', v_deleted;
end $$;

-- ── 2. And stop it recurring, on the same mechanism 0138 already built ────
--
-- The function is 0138's, unchanged and not restated — there is nothing to
-- retype here, which is the whole point of it having been written
-- parameterised. Only the wiring was missing.
drop trigger if exists leases_delete_cleans_notifications on leases;
create trigger leases_delete_cleans_notifications
  after delete on leases
  for each row execute function delete_notifications_for_deleted_entity('lease');

drop trigger if exists assets_delete_cleans_notifications on assets;
create trigger assets_delete_cleans_notifications
  after delete on assets
  for each row execute function delete_notifications_for_deleted_entity('asset');

drop trigger if exists properties_delete_cleans_notifications on properties;
create trigger properties_delete_cleans_notifications
  after delete on properties
  for each row execute function delete_notifications_for_deleted_entity('property');

-- ── 3. Assert the ENUMERATION, not this batch ─────────────────────────────
--
-- ⚠️ The failure this migration exists to close is a list that fell behind the
-- set it mirrors, so the check has to be about the list. Every entity type
-- `my_notifications` computes `target_live` for must have a cascade behind it;
-- adding a seventh without a trigger fails the migration that adds it, rather
-- than surfacing as somebody's 404 two releases later.
do $$
declare
  v_missing text[];
begin
  select array_agg(x.tbl order by x.tbl) into v_missing
    from (values
      ('tickets'), ('payments'), ('tenant_applications'),
      ('leases'), ('assets'), ('properties')
    ) as x(tbl)
   where not exists (
     select 1 from pg_trigger t
       join pg_class c on c.oid = t.tgrelid
       join pg_proc p on p.oid = t.tgfoid
      where c.relname = x.tbl
        and p.proname = 'delete_notifications_for_deleted_entity'
        and not t.tgisinternal
   );

  if v_missing is not null then
    raise exception
      'a notification subject with no cascade behind it: %', array_to_string(v_missing, ', ');
  end if;
end $$;

-- And nothing dangles right now, in any of the six.
do $$
declare v_left int;
begin
  select count(*) into v_left from user_notifications n
   where n.entity_id is not null
     and case n.entity_type
       when 'ticket'   then not exists (select 1 from tickets t   where t.id = n.entity_id)
       when 'payment'  then not exists (select 1 from payments p  where p.id = n.entity_id)
       when 'asset'    then not exists (select 1 from assets a    where a.id = n.entity_id)
       when 'property' then not exists (select 1 from properties r where r.id = n.entity_id)
       when 'lease'    then not exists (select 1 from leases l    where l.id = n.entity_id)
       when 'tenant_application'
                       then not exists (select 1 from tenant_applications x where x.id = n.entity_id)
       else false
     end;

  if v_left > 0 then
    raise exception '% notification(s) still point at a row that is gone', v_left;
  end if;
end $$;
