-- `notify_role` refused: `kind` is a checked enumeration and 'security' is not in
-- it. The allowed set is request / assignment / approval / payment / application /
-- invitation / asset / system, and an operator action is a system event.
--
-- Third runtime fault in this migration series, all of the same species: **a
-- PL/pgSQL body is not validated against the schema until it runs.** The
-- migration applied, the function was wrong, and only the suite found it. That is
-- now four times in this build (0029, 0032, 0033, 0054 recorded the same trap) —
-- which is the argument for every database function arriving with a suite that
-- executes it, not merely a migration that defines it.

create or replace function operator_suspend_user(p_user_id uuid, p_reason text)
returns void language plpgsql security definer set search_path = public as $$
declare
  u users%rowtype;
  v_caller uuid := auth.uid();
begin
  if v_caller is not null and not caller_is_operator_admin() then
    raise exception 'only an administrator of the OE Group operator organisation may suspend an account';
  end if;
  if length(trim(coalesce(p_reason, ''))) < 10 then
    raise exception 'a reason is required, and it has to say something';
  end if;

  select * into u from users where id = p_user_id;
  if u.id is null then raise exception 'no such account'; end if;
  if u.deactivated_at is not null then return; end if;

  update users set deactivated_at = now() where id = p_user_id;

  insert into operator_actions (actor_id, operator_org, target_org, action, target_user, reason, metadata)
  values (v_caller, current_user_org_id(), u.org_id, 'suspend_user', p_user_id, trim(p_reason),
          jsonb_build_object('email', u.email, 'role', u.role));

  insert into audit_log (org_id, actor_id, action, entity_type, entity_id, before_state, after_state)
  values (u.org_id, v_caller, 'operator.suspend_user', 'user', p_user_id,
          jsonb_build_object('active', true),
          jsonb_build_object('active', false, 'reason', trim(p_reason),
                             'by_org', (select name from orgs where id = current_user_org_id())));

  perform notify_role(u.org_id, array['admin','executive']::user_role[], 'system',
                      'An account was suspended by OE Group',
                      format('%s was suspended. Reason given: %s', u.email, trim(p_reason)),
                      '/dashboard/people');
end;
$$;


create or replace function operator_break_glass_admin(
  p_org_id     uuid,
  p_email      text,
  p_reason     text,
  p_token_hash text
)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_caller  uuid := auth.uid();
  v_invite  uuid;
  v_org     orgs%rowtype;
  v_actives integer;
  v_expires timestamptz := now() + interval '24 hours';
begin
  if v_caller is not null and not caller_is_operator_admin() then
    raise exception 'only an administrator of the OE Group operator organisation may use break-glass';
  end if;
  if length(trim(coalesce(p_reason, ''))) < 10 then
    raise exception 'break-glass requires a reason, and it has to say something';
  end if;

  select * into v_org from orgs where id = p_org_id;
  if v_org.id is null then raise exception 'that organisation could not be found'; end if;
  if v_org.is_platform_operator then
    raise exception 'break-glass does not apply to the operator organisation itself';
  end if;

  insert into invitations (org_id, email, role, token_hash, invited_by, expires_at)
  values (p_org_id, lower(trim(p_email)), 'admin', p_token_hash, v_caller, v_expires)
  returning id into v_invite;

  insert into operator_actions (actor_id, operator_org, target_org, action, reason, metadata)
  values (v_caller, current_user_org_id(), p_org_id, 'break_glass', trim(p_reason),
          jsonb_build_object('email', lower(trim(p_email)), 'invitation', v_invite,
                             'expires_at', v_expires));

  -- Named on BOTH sides, as the permission crossing already is.
  insert into audit_log (org_id, actor_id, action, entity_type, entity_id, before_state, after_state)
  values (p_org_id, v_caller, 'operator.break_glass', 'invitation', v_invite,
          '{}'::jsonb,
          jsonb_build_object('reason', trim(p_reason), 'email', lower(trim(p_email)),
                             'expires_at', v_expires,
                             'by_org', (select name from orgs where id = current_user_org_id())));
  insert into audit_log (org_id, actor_id, action, entity_type, entity_id, before_state, after_state)
  values (current_user_org_id(), v_caller, 'operator.break_glass', 'invitation', v_invite,
          '{}'::jsonb,
          jsonb_build_object('reason', trim(p_reason), 'target_org', v_org.name));

  select count(*) into v_actives
    from users where org_id = p_org_id and role = 'admin' and deactivated_at is null;

  if v_actives > 0 then
    perform notify_role(p_org_id, array['admin','executive']::user_role[], 'system',
                        'OE Group issued an emergency administrator invitation',
                        format('An administrator invitation for %s was issued by OE Group and expires in 24 hours. Reason given: %s',
                               lower(trim(p_email)), trim(p_reason)),
                        '/dashboard/people/invitations');
  end if;

  return v_invite;
end;
$$;
