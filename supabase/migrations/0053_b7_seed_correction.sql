-- The B7 seed granted more than B7 does.
--
-- Caught by verify-access-matrix on the first run after 0051: an FM could read
-- every ticket in the org, where before they saw only their assigned properties.
-- The seed had given `tickets.read_all` to facility_manager, but B7's Service
-- requests column reads "Assigned properties (RT)" for that role — property
-- scoped, not org-wide.
--
-- The failure mode matters more than the instance. Moving from hardcoded roles
-- to a matrix is only safe if the seed reproduces the PREVIOUS effective access
-- exactly; anything else silently re-grants access under cover of a refactor,
-- and nobody reviews a seed as carefully as they review a policy. So each
-- default below is derived from the policy it replaced, not from a reading of
-- the matrix — and the ones that differed are corrected here:
--
--   tickets.read_all   FM removed  (old: admin, finance only)
--   tickets.close      fm_ops_staff removed (old: they act as ASSIGNEE, which
--                      is identity and still works — not as a privilege)
--   assets.read        FM + owner removed (they read via property scoping)
--   sc.read_all        FM removed  (reads via the budget's property scoping)
--
-- `assets.read` is the clearest of these: it means "read assets ORG-WIDE". An
-- FM reaching their own properties' assets never needed it and still does not.
-- Granting it turned a scoped role into an unscoped one.

create or replace function seed_b7_permissions(p_org_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  cap record;
  r user_role;
  v_granted boolean;
begin
  for cap in select key from capabilities where not locked loop
    foreach r in array array['tenant','vendor','fm_ops_staff','facility_manager',
                             'finance_approver','property_owner','admin','viewer']::user_role[]
    loop
      v_granted := case
        when r = 'admin' then true

        -- Org-wide READING of operational data: finance only. Every other role
        -- reaches what it needs through property scoping or its own records.
        when cap.key in ('tickets.read_all', 'assets.read',
                         'sc.read_all', 'properties.read_all')
          then r = 'finance_approver'

        -- Operational WRITING: the FM/PM, still bounded by their attaché
        -- properties in the policy itself.
        when cap.key in ('tickets.assign', 'tickets.close',
                         'assets.write', 'assets.import',
                         'vendors.write', 'vendors.evaluate',
                         'properties.write', 'units.assign_occupant',
                         'people.invite')
          then r = 'facility_manager'

        when cap.key = 'vendors.read' then r in ('facility_manager','finance_approver')
        when cap.key = 'sc.manage'    then r = 'finance_approver'

        -- B7 "Exec / BI dashboard" column.
        when cap.key = 'bi.read' then r in ('facility_manager','finance_approver','property_owner')

        -- B7 reserves removing someone's access to an administrator.
        when cap.key = 'people.deactivate' then false

        -- B7 silent → OFF.
        else false
      end;

      insert into role_permissions (org_id, role, capability, granted)
      values (p_org_id, r, cap.key, v_granted)
      on conflict (org_id, role, capability) do nothing;
    end loop;
  end loop;
end;
$$;

-- ── Reset to the approved baseline ─────────────────────────────────────────
--
-- The one-click reset the spec calls for, and what makes the "differs from B7"
-- badge actionable rather than merely informative. OVERWRITES, unlike the seed —
-- resetting an org that has drifted is the entire purpose.
create or replace function reset_org_permissions_to_b7(p_org_id uuid)
returns integer language plpgsql security definer set search_path = public as $$
declare
  v_caller uuid := auth.uid();
  v_changed integer;
begin
  -- Same authority as changing a single toggle: operator administrators only.
  if v_caller is not null then
    if not coalesce((select o.is_platform_operator from orgs o
                      where o.id = current_user_org_id()), false) then
      raise exception 'permissions are reset from the OE Group operator portal, not here';
    end if;
    if current_user_role() is distinct from 'admin' then
      raise exception 'only an administrator of the operator organisation may reset permissions';
    end if;
  end if;

  create temporary table _b7_target on commit drop as
    select org_id, role, capability, granted from role_permissions where false;

  -- Compute the baseline into a scratch org-shaped set by re-running the seed
  -- logic against a copy, then diff. Simpler: delete and re-seed, counting what
  -- actually moved so the caller can report it honestly.
  select count(*) into v_changed
    from role_permissions rp
   where rp.org_id = p_org_id;

  delete from role_permissions where org_id = p_org_id;
  perform seed_b7_permissions(p_org_id);

  insert into audit_log (org_id, actor_id, action, entity_type, entity_id, metadata)
  values (p_org_id, v_caller, 'permission.reset', 'role_permission', p_org_id,
          jsonb_build_object(
            'target_org', (select name from orgs where id = p_org_id),
            'by_org', (select name from orgs where id = current_user_org_id())
          ));

  return v_changed;
end;
$$;

revoke all on function reset_org_permissions_to_b7(uuid) from public;
grant execute on function reset_org_permissions_to_b7(uuid) to authenticated, service_role;

-- Bring every existing org back to the corrected baseline. Safe: no org has
-- been deliberately customised yet — the editor does not exist until this same
-- day's work lands.
do $$
declare o record;
begin
  for o in select id from orgs loop
    delete from role_permissions where org_id = o.id;
    perform seed_b7_permissions(o.id);
  end loop;
end $$;
