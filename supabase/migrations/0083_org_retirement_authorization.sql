-- Audit 0729d-M1. `deleted_at` was added to `orgs` with no authorisation
-- boundary of its own — it rode on `orgs_admin_update`, the pre-existing policy
-- that grants an org's own administrator UPDATE on every column of their own row
-- (originally written for theming). Two faults from the same omission:
--
--   • the WRONG actor could do it: any brand admin could set or clear their own
--     org's `deleted_at` directly via PostgREST, with no reason, no operator
--     involvement, and none of the double-audit / `operator_actions` /
--     notify_role machinery every other operator crossing in `0079` gets. A
--     careless PATCH silently stops that org's tenant applications, and the only
--     trace is a generic `org.updated` row indistinguishable from a colour change.
--
--   • the RIGHT actor could not: `orgs_admin_update`'s `id = current_user_org_id()`
--     means an OPERATOR admin — whose own org_id is the operator's, not the
--     target's — could never retire another org through this policy at all.
--     "Org retirement" was reachable only via direct database access for its
--     intended purpose, while reachable by the wrong actor through the normal
--     app-facing path.
--
-- Fixed the way every other operator crossing already is: a narrow function, not
-- a widened policy. `orgs_admin_update` is unchanged — a brand admin keeps their
-- theming write — and `deleted_at` is carved out of it explicitly.

-- No ordinary UPDATE may touch `deleted_at`, by anyone, including the org's own
-- admin. Retirement goes through the function below and nowhere else.
create or replace function orgs_block_direct_retirement()
returns trigger language plpgsql set search_path = public as $$
begin
  if new.deleted_at is distinct from old.deleted_at and auth.uid() is not null then
    raise exception
      'an organisation is retired through the operator console, not by editing this field directly';
  end if;
  return new;
end;
$$;

drop trigger if exists orgs_no_direct_retirement on orgs;
create trigger orgs_no_direct_retirement before update on orgs
  for each row execute function orgs_block_direct_retirement();

create or replace function retire_org(p_org_id uuid, p_reason text)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_caller uuid := auth.uid();
  v_org orgs%rowtype;
begin
  if v_caller is not null and not caller_is_operator_admin() then
    raise exception 'only an administrator of the OE Group operator organisation may retire an organisation';
  end if;
  if length(trim(coalesce(p_reason, ''))) < 10 then
    raise exception 'a reason is required, and it has to say something';
  end if;

  select * into v_org from orgs where id = p_org_id;
  if v_org.id is null then
    raise exception 'that organisation could not be found';
  end if;
  if v_org.is_platform_operator then
    raise exception 'the operator organisation cannot retire itself';
  end if;
  if v_org.deleted_at is not null then
    return;
  end if;

  -- The trigger above blocks this exact write for a human session; it does not
  -- block the function, because SECURITY DEFINER runs as the function's owner,
  -- which is how every gated write in this system already works — the door is
  -- the function, not a bypassable flag on the row.
  update orgs set deleted_at = now(), tenant_applications_open = false where id = p_org_id;

  insert into operator_actions (actor_id, operator_org, target_org, action, reason)
  values (v_caller, current_user_org_id(), p_org_id, 'retire_org', trim(p_reason));

  insert into audit_log (org_id, actor_id, action, entity_type, entity_id, before_state, after_state)
  values (p_org_id, v_caller, 'operator.retire_org', 'org', p_org_id,
          '{}'::jsonb,
          jsonb_build_object('reason', trim(p_reason),
                             'by_org', (select name from orgs where id = current_user_org_id())));

  if v_caller is not null then
    perform notify_role(p_org_id, array['admin','executive']::user_role[], 'system',
                        'This organisation was retired by OE Group',
                        format('Reason given: %s', trim(p_reason)),
                        '/dashboard');
  end if;
end;
$$;

revoke all on function retire_org(uuid, text) from public;
grant execute on function retire_org(uuid, text) to authenticated, service_role;

comment on function retire_org is
  'The only way deleted_at moves on an org outside a migration. Operator-only, reasoned, recorded in both audit logs and operator_actions, announced to the target org — the same shape as every other operator crossing (audit 0729d-M1).';

create or replace function unretire_org(p_org_id uuid, p_reason text)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_caller uuid := auth.uid();
  v_org orgs%rowtype;
begin
  if v_caller is not null and not caller_is_operator_admin() then
    raise exception 'only an administrator of the OE Group operator organisation may reinstate an organisation';
  end if;
  if length(trim(coalesce(p_reason, ''))) < 10 then
    raise exception 'a reason is required, and it has to say something';
  end if;

  select * into v_org from orgs where id = p_org_id;
  if v_org.id is null then raise exception 'that organisation could not be found'; end if;
  if v_org.deleted_at is null then return; end if;

  update orgs set deleted_at = null where id = p_org_id;

  insert into operator_actions (actor_id, operator_org, target_org, action, reason)
  values (v_caller, current_user_org_id(), p_org_id, 'unretire_org', trim(p_reason));

  insert into audit_log (org_id, actor_id, action, entity_type, entity_id, before_state, after_state)
  values (p_org_id, v_caller, 'operator.unretire_org', 'org', p_org_id,
          '{}'::jsonb, jsonb_build_object('reason', trim(p_reason)));
end;
$$;

revoke all on function unretire_org(uuid, text) from public;
grant execute on function unretire_org(uuid, text) to authenticated, service_role;

-- `operator_actions.action` was checked against a fixed list (0079) that did not
-- anticipate this pair.
alter table operator_actions drop constraint if exists operator_actions_action_check;
alter table operator_actions add constraint operator_actions_action_check
  check (action in ('provision_org', 'suspend_user', 'unsuspend_user', 'break_glass',
                    'retire_org', 'unretire_org'));
