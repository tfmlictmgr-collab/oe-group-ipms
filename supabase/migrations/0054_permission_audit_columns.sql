-- `set_role_permission` wrote to a column that does not exist.
--
-- It inserted `metadata` into audit_log, which has `before_state` / `after_state`
-- and no `metadata`. Every call therefore raised, and because the audit insert
-- is inside the same function as the permission write, the WHOLE call rolled
-- back: the toggle silently did nothing while the UI would have reported success.
--
-- Two things worth keeping from this:
--
-- 1. The migration applied cleanly. PL/pgSQL bodies are not checked against the
--    schema until executed — the same trap as 0029, 0032 and 0033 in this build.
--    **After writing any function, CALL it.** This one was caught by
--    verify-permissions on its first run, which is the argument for writing the
--    gate before trusting the feature.
--
-- 2. Putting the audit write inside the transaction is CORRECT and stays. A
--    permission change that succeeded while its audit record failed is worse
--    than one that failed cleanly — governance evidence is not optional
--    decoration, and an auditor reading this table must be able to trust that
--    it is complete.

create or replace function set_role_permission(
  p_org_id uuid,
  p_role user_role,
  p_capability text,
  p_granted boolean
)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_caller uuid := auth.uid();
  v_is_operator boolean;
  v_locked boolean;
  v_target_name text;
  v_before boolean;
begin
  select locked into v_locked from capabilities where key = p_capability;
  if v_locked is null then
    raise exception 'unknown capability %', p_capability;
  end if;
  if v_locked then
    raise exception
      'capability % is not delegable and cannot be granted or revoked', p_capability;
  end if;

  if v_caller is not null then
    select o.is_platform_operator into v_is_operator
      from orgs o where o.id = current_user_org_id();

    if not coalesce(v_is_operator, false) then
      raise exception 'permissions are set on the OE Group operator portal, not here';
    end if;
    if current_user_role() is distinct from 'admin' then
      raise exception 'only an administrator of the operator organisation may change permissions';
    end if;
  end if;

  select name into v_target_name from orgs where id = p_org_id;
  if v_target_name is null then
    raise exception 'that organisation could not be found';
  end if;

  select granted into v_before from role_permissions
   where org_id = p_org_id and role = p_role and capability = p_capability;

  insert into role_permissions (org_id, role, capability, granted, set_by, set_at)
  values (p_org_id, p_role, p_capability, p_granted, v_caller, now())
  on conflict (org_id, role, capability)
    do update set granted = excluded.granted, set_by = excluded.set_by, set_at = now();

  -- Named on BOTH sides: whose matrix changed, and who changed it. A cross-org
  -- write that only records the target tells you nothing about the crossing.
  insert into audit_log (org_id, actor_id, action, entity_type, entity_id,
                         before_state, after_state)
  values (
    p_org_id, v_caller, 'permission.set', 'role_permission', p_org_id,
    jsonb_build_object('role', p_role, 'capability', p_capability, 'granted', v_before),
    jsonb_build_object(
      'role', p_role, 'capability', p_capability, 'granted', p_granted,
      'target_org', v_target_name,
      'by_org', coalesce((select name from orgs where id = current_user_org_id()),
                         'platform (service role)')
    )
  );
end;
$$;

revoke all on function set_role_permission(uuid, user_role, text, boolean) from public;
grant execute on function set_role_permission(uuid, user_role, text, boolean)
  to authenticated, service_role;

-- Same defect in the reset.
create or replace function reset_org_permissions_to_b7(p_org_id uuid)
returns integer language plpgsql security definer set search_path = public as $$
declare
  v_caller uuid := auth.uid();
  v_changed integer;
begin
  if v_caller is not null then
    if not coalesce((select o.is_platform_operator from orgs o
                      where o.id = current_user_org_id()), false) then
      raise exception 'permissions are reset from the OE Group operator portal, not here';
    end if;
    if current_user_role() is distinct from 'admin' then
      raise exception 'only an administrator of the operator organisation may reset permissions';
    end if;
  end if;

  select count(*) into v_changed from role_permissions where org_id = p_org_id;

  delete from role_permissions where org_id = p_org_id;
  perform seed_b7_permissions(p_org_id);

  insert into audit_log (org_id, actor_id, action, entity_type, entity_id, after_state)
  values (p_org_id, v_caller, 'permission.reset', 'role_permission', p_org_id,
          jsonb_build_object(
            'target_org', (select name from orgs where id = p_org_id),
            'by_org', coalesce((select name from orgs where id = current_user_org_id()),
                               'platform (service role)'),
            'rows_replaced', v_changed
          ));

  return v_changed;
end;
$$;

revoke all on function reset_org_permissions_to_b7(uuid) from public;
grant execute on function reset_org_permissions_to_b7(uuid) to authenticated, service_role;
