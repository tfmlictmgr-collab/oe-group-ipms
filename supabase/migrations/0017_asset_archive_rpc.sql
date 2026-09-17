-- Fix: archiving an asset was impossible.
--
-- assets_select requires `deleted_at is null`. PostgreSQL applies SELECT
-- policies to the NEW row when an UPDATE carries a RETURNING clause (which
-- PostgREST always adds), so the moment deleted_at was set the row became
-- invisible and the update itself failed with
--   new row violates row-level security policy for table "assets"
-- i.e. the soft-delete guardrail made soft-delete unusable.
--
-- Rather than weaken the read policy (which is what actually hides archived
-- assets), expose archive/restore as explicit, permission-checked operations.
-- Intent is clearer than writing a magic column, and the checks live in one
-- place instead of being re-derived by every caller.

create or replace function archive_asset(p_asset_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_org uuid;
  v_property uuid;
  v_role user_role := current_user_role();
begin
  select org_id, property_id into v_org, v_property
  from assets where id = p_asset_id and deleted_at is null;

  if v_org is null then
    raise exception 'asset not found or already archived';
  end if;

  -- Same org as the caller, always.
  if v_org is distinct from current_user_org_id() then
    raise exception 'asset belongs to another organisation';
  end if;

  -- Admin org-wide; FM/PM only on properties they are staked to.
  if not (
    v_role = 'admin'
    or (v_role = 'facility_manager'
        and v_property in (select current_user_property_ids()))
  ) then
    raise exception 'only an administrator or the managing FM/PM may archive this asset';
  end if;

  -- Fires audit_asset_write, so archiving is recorded like any other change.
  update assets set deleted_at = now() where id = p_asset_id;
end;
$$;

create or replace function restore_asset(p_asset_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_org uuid;
  v_property uuid;
  v_tag text;
  v_role user_role := current_user_role();
begin
  select org_id, property_id, asset_tag into v_org, v_property, v_tag
  from assets where id = p_asset_id and deleted_at is not null;

  if v_org is null then
    raise exception 'archived asset not found';
  end if;

  if v_org is distinct from current_user_org_id() then
    raise exception 'asset belongs to another organisation';
  end if;

  if not (
    v_role = 'admin'
    or (v_role = 'facility_manager'
        and v_property in (select current_user_property_ids()))
  ) then
    raise exception 'only an administrator or the managing FM/PM may restore this asset';
  end if;

  -- The unique tag index ignores archived rows, so the tag may have been reused
  -- while this asset was archived. Refuse rather than silently create a clash.
  if exists (
    select 1 from assets
    where org_id = v_org and lower(asset_tag) = lower(v_tag)
      and deleted_at is null and id <> p_asset_id
  ) then
    raise exception 'asset tag % is now in use by an active asset', v_tag;
  end if;

  update assets set deleted_at = null where id = p_asset_id;
end;
$$;

-- Listing archived assets needs a read path that the deleted_at filter blocks.
-- SECURITY DEFINER + the same scoping rules as assets_select.
create or replace function archived_assets()
returns setof assets language sql security definer stable set search_path = public as $$
  select * from assets
  where deleted_at is not null
    and org_id = current_user_org_id()
    and (
      current_user_role() = any (array['admin','finance_approver']::user_role[])
      or property_id in (select current_user_property_ids())
    );
$$;

revoke all on function archive_asset(uuid)  from public;
revoke all on function restore_asset(uuid)  from public;
revoke all on function archived_assets()    from public;
grant execute on function archive_asset(uuid)  to authenticated;
grant execute on function restore_asset(uuid)  to authenticated;
grant execute on function archived_assets()    to authenticated;
