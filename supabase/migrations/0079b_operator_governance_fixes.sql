-- Two runtime faults in 0079, both caught by its own suite on first run.
--
-- ⚠️ **I made the exact mistake `0054` exists to fix, by copying the pattern from
-- the migration that introduced `set_role_permission` instead of from the function
-- that is actually running.** `0050` inserted `metadata` into `audit_log`; `0054`
-- corrected it to `before_state` / `after_state` and its header says so in the
-- first three lines. I read `0050`.
--
-- **A migration file records what was intended once. The catalogue records what
-- is true now.** This is the second time in two days: `0072b` dropped the payment
-- state machine because I rewrote a function from a partial read of the migration
-- that first defined it. Read `pg_get_functiondef`, not the file.
--
-- And `0054`'s other lesson, which applies here too: PL/pgSQL bodies are not
-- checked against the schema until executed, so `0079` applied cleanly and every
-- call raised. The suite is what found it — a migration applying is not evidence
-- that anything in it works.
--
-- Second fault: `delivery_brand` is an enum, and a text parameter needs a cast.

create or replace function provision_org(
  p_name           text,
  p_delivery_brand text,
  p_admin_email    text,
  p_admin_name     text,
  p_reason         text,
  p_token_hash     text
)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_org      uuid;
  v_caller   uuid := auth.uid();
  v_operator uuid := current_user_org_id();
begin
  if v_caller is not null and not caller_is_operator_admin() then
    raise exception 'only an administrator of the OE Group operator organisation may provision an organisation';
  end if;
  if coalesce(trim(p_name), '') = '' then
    raise exception 'the organisation needs a name';
  end if;
  if coalesce(trim(p_admin_email), '') = '' then
    raise exception 'the first administrator needs an email address';
  end if;
  if length(trim(coalesce(p_reason, ''))) < 10 then
    raise exception 'a reason is required, and it has to say something';
  end if;

  insert into orgs (name, delivery_brand)
  values (trim(p_name), p_delivery_brand::delivery_brand)
  returning id into v_org;

  perform seed_b7_permissions(v_org);

  insert into org_modules (org_id, module, enabled)
  values (v_org, 'lettings', p_delivery_brand = 'OEA')
  on conflict do nothing;

  insert into invitations (org_id, email, role, full_name, token_hash, invited_by, expires_at)
  values (v_org, lower(trim(p_admin_email)), 'admin', nullif(trim(p_admin_name), ''),
          p_token_hash, v_caller, now() + interval '14 days');

  insert into operator_actions (actor_id, operator_org, target_org, action, reason, metadata)
  values (v_caller, coalesce(v_operator, v_org), v_org, 'provision_org', trim(p_reason),
          jsonb_build_object('name', trim(p_name), 'brand', p_delivery_brand,
                             'first_admin', lower(trim(p_admin_email))));

  return v_org;
end;
$$;

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

  perform notify_role(u.org_id, array['admin','executive']::user_role[], 'security',
                      'An account was suspended by OE Group',
                      format('%s was suspended. Reason given: %s', u.email, trim(p_reason)),
                      '/dashboard/people');
end;
$$;

create or replace function operator_unsuspend_user(p_user_id uuid, p_reason text)
returns void language plpgsql security definer set search_path = public as $$
declare
  u users%rowtype;
  v_caller uuid := auth.uid();
  v_was_ours boolean;
begin
  if v_caller is not null and not caller_is_operator_admin() then
    raise exception 'only an administrator of the OE Group operator organisation may do this';
  end if;
  if length(trim(coalesce(p_reason, ''))) < 10 then
    raise exception 'a reason is required, and it has to say something';
  end if;

  select * into u from users where id = p_user_id;
  if u.id is null then raise exception 'no such account'; end if;

  select exists (
    select 1 from operator_actions
     where target_user = p_user_id and action = 'suspend_user'
       and created_at > coalesce(
         (select max(created_at) from operator_actions
           where target_user = p_user_id and action = 'unsuspend_user'), '-infinity'::timestamptz)
  ) into v_was_ours;

  if not v_was_ours then
    raise exception
      'this account was not suspended by OE Group — its own administrator restores it';
  end if;

  update users set deactivated_at = null where id = p_user_id;

  insert into operator_actions (actor_id, operator_org, target_org, action, target_user, reason)
  values (v_caller, current_user_org_id(), u.org_id, 'unsuspend_user', p_user_id, trim(p_reason));

  insert into audit_log (org_id, actor_id, action, entity_type, entity_id, before_state, after_state)
  values (u.org_id, v_caller, 'operator.unsuspend_user', 'user', p_user_id,
          jsonb_build_object('active', false),
          jsonb_build_object('active', true, 'reason', trim(p_reason)));
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
    perform notify_role(p_org_id, array['admin','executive']::user_role[], 'security',
                        'OE Group issued an emergency administrator invitation',
                        format('An administrator invitation for %s was issued by OE Group and expires in 24 hours. Reason given: %s',
                               lower(trim(p_email)), trim(p_reason)),
                        '/dashboard/people/invitations');
  end if;

  return v_invite;
end;
$$;
