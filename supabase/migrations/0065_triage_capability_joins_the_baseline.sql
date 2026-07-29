-- 0064 granted `tickets.triage_unassigned` with a one-off INSERT and never told
-- the baseline about it.
--
-- `seed_b7_permissions()` is the single definition of what an org starts with
-- and what a reset returns it to. A capability that is not named there falls to
-- its `else false` branch — so the grant survived exactly until the next reset,
-- which happened within the hour, and every org created afterwards would have
-- started without it. The grant and the baseline disagreed, and the baseline
-- always wins.
--
-- The same lesson as the ledger resolver: **a rule applied in one place and not
-- in the source of that rule is worse than no rule, because it looks applied.**
--
-- Correcting it also settles what the default should be. B7's Facility Manager
-- row reads "Assigned properties (RT)" for service requests, and a request with
-- no property is in no assigned property. B7 is therefore silent on this, and
-- locked decision 7 is explicit that silence means OFF. So the capability
-- defaults OFF for everyone except an administrator — who already reads every
-- request through `tickets.read_all` — and an OE Group operator turns it on per
-- org if they want Facility Managers triaging unrecognised senders.
--
-- Nothing is lost by that default: an administrator and a finance approver see
-- unassigned requests today, and once a request resolves to a property the
-- Facility Manager sees it through ordinary property scoping.

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

        -- Named explicitly so it is a decision on the record rather than a
        -- capability that quietly fell through to the default. B7 scopes the
        -- Facility Manager to assigned properties, and an unassigned request is
        -- in none of them — so this stays OFF until an operator turns it on.
        when cap.key = 'tickets.triage_unassigned' then false

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

-- Bring the one-off grant back in line with the baseline it contradicted, so an
-- org's current state and its reset state are the same thing.
update role_permissions
   set granted = false
 where capability = 'tickets.triage_unassigned'
   and role <> 'admin'
   and granted;
