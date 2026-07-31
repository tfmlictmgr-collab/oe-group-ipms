-- What the OE Group operator may do inside a brand, and what it may never do.
--
-- The operator already holds one crossing of org isolation: `set_role_permission`
-- decides what a ROLE may do. It has never decided WHO HOLDS a role, and that
-- separation is load-bearing. If OE Group could quietly add an administrator to
-- OEA, then "OEA's finance approver approved this payment" stops being a claim
-- anyone can rely on — an operator could have minted that approver an hour
-- earlier. Every control built on the ledger rests on the brand's roster being
-- the brand's own.
--
-- So the rule across all three functions below: **the operator may never grant a
-- privilege to a person.** It may create the conditions for a brand to appoint
-- someone (an invitation the brand's own nominee must accept), and it may take
-- privilege away. Revoking does not corrupt an audit trail; granting does.
--
--   1. provision_org        — a new brand org and an invitation for its FIRST
--                             administrator, because nobody else exists to do it
--   2. operator_suspend_user — freeze a compromised account; NEVER unfreeze one
--                             the operator did not freeze, and never grant a role
--   3. operator_break_glass  — a short-lived administrator invitation when an org
--                             has locked itself out, audited on both sides and
--                             announced to the org it concerns
--
-- Plus last-admin protection, because the lockout that break-glass cures should
-- mostly never happen in the first place.

-- ── Who is the operator ────────────────────────────────────────────────────
--
-- One predicate, so the three functions cannot drift apart on the most important
-- question any of them asks.
create or replace function caller_is_operator_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce(
    (select o.is_platform_operator and current_user_role() = 'admin'
       from orgs o where o.id = current_user_org_id()),
    false
  );
$$;

revoke all on function caller_is_operator_admin() from public;
grant execute on function caller_is_operator_admin() to authenticated, service_role;

comment on function caller_is_operator_admin is
  'An administrator OF the OE Group operator org. Not "an admin" and not "the operator org" — both, which is the condition every cross-org function below requires.';

-- ── Operator actions get their own record ──────────────────────────────────
--
-- These land in `audit_log` for both orgs as well. This table exists so the
-- crossings can be listed on their own without filtering a million rows, and so
-- a break-glass grant has somewhere to record its expiry and its reason.
create table operator_actions (
  id          uuid primary key default gen_random_uuid(),
  actor_id    uuid references users(id),
  operator_org uuid not null references orgs(id),
  target_org  uuid not null references orgs(id),
  action      text not null check (action in ('provision_org', 'suspend_user', 'unsuspend_user', 'break_glass')),
  target_user uuid references users(id),
  reason      text not null check (length(trim(reason)) >= 10),
  metadata    jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);

create index operator_actions_target_idx on operator_actions (target_org, created_at desc);

alter table operator_actions enable row level security;

-- Readable by the operator, AND by the org it was done to. An operator action a
-- brand cannot see is exactly the kind of access an auditor objects to.
create policy operator_actions_select on operator_actions for select to authenticated
  using (
    target_org = current_user_org_id()
    or (select caller_is_operator_admin())
  );
-- No write policy: written only by the functions below.

comment on table operator_actions is
  'Every crossing of the org boundary by OE Group. Visible to the organisation it was done TO, not only to the operator — silent operator access is the thing auditors object to, not operator access as such.';

-- ── Last-admin protection ──────────────────────────────────────────────────
--
-- An org that removes its own final administrator has nobody who can add anyone,
-- and the only way back is an operator crossing the boundary. Preventing the
-- lockout is cheaper than curing it.
create or replace function block_removing_last_admin()
returns trigger language plpgsql set search_path = public as $$
declare
  v_remaining integer;
begin
  -- Only interested in an admin ceasing to be an active admin.
  if old.role <> 'admin' or old.deactivated_at is not null then
    return new;
  end if;
  if new.role = 'admin' and new.deactivated_at is null then
    return new;
  end if;

  select count(*) into v_remaining
    from users
   where org_id = old.org_id
     and role = 'admin'
     and deactivated_at is null
     and id <> old.id;

  if v_remaining = 0 then
    raise exception
      'this is the last active administrator of the organisation — appoint another before removing this one';
  end if;

  return new;
end;
$$;

drop trigger if exists users_keep_one_admin on users;
create trigger users_keep_one_admin before update on users
  for each row execute function block_removing_last_admin();

-- ── 1. Provisioning a new brand org ────────────────────────────────────────
--
-- Creates the org and an INVITATION for its first administrator. Deliberately not
-- an account: the operator never chooses anyone's password, and the person
-- appointed accepts on their own. The operator's power stops at "this address may
-- become the administrator of this new organisation".
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
  values (trim(p_name), p_delivery_brand)
  returning id into v_org;

  -- A new org starts from the B7 baseline: the most restrictive workable state.
  perform seed_b7_permissions(v_org);

  -- Lettings is OEA-only; the registry decides, not the role.
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

revoke all on function provision_org(text, text, text, text, text, text) from public;
grant execute on function provision_org(text, text, text, text, text, text) to authenticated, service_role;

-- ── 2. Suspending a compromised account ────────────────────────────────────
--
-- The asymmetry that makes this safe: suspending REMOVES access. It cannot be
-- used to approve a payment, read a tenant's documents, or put a friendly name on
-- a roster. An operator noticing a credential leak at 2am should be able to stop
-- it without waiting for a brand administrator to wake up.
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
  if u.id is null then
    raise exception 'no such account';
  end if;
  if u.deactivated_at is not null then
    return;   -- already suspended; nothing to do and nothing to record
  end if;

  update users set deactivated_at = now() where id = p_user_id;

  insert into operator_actions (actor_id, operator_org, target_org, action, target_user, reason, metadata)
  values (v_caller, current_user_org_id(), u.org_id, 'suspend_user', p_user_id, trim(p_reason),
          jsonb_build_object('email', u.email, 'role', u.role));

  insert into audit_log (org_id, actor_id, action, entity_type, entity_id, metadata)
  values (u.org_id, v_caller, 'operator.suspend_user', 'user', p_user_id,
          jsonb_build_object('reason', trim(p_reason),
                             'by_org', (select name from orgs where id = current_user_org_id())));

  -- The org finds out. Every administrator and executive, immediately.
  perform notify_role(u.org_id, array['admin','executive']::user_role[], 'security',
                      'An account was suspended by OE Group',
                      format('%s was suspended. Reason given: %s', u.email, trim(p_reason)),
                      '/dashboard/people');
end;
$$;

revoke all on function operator_suspend_user(uuid, text) from public;
grant execute on function operator_suspend_user(uuid, text) to authenticated, service_role;

-- Undoing the operator's OWN suspension. Not a general "restore access" — an
-- operator may only reverse a suspension it applied, which is an undo rather than
-- a grant. A brand's own administrator restores anyone else.
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

  insert into audit_log (org_id, actor_id, action, entity_type, entity_id, metadata)
  values (u.org_id, v_caller, 'operator.unsuspend_user', 'user', p_user_id,
          jsonb_build_object('reason', trim(p_reason)));
end;
$$;

revoke all on function operator_unsuspend_user(uuid, text) from public;
grant execute on function operator_unsuspend_user(uuid, text) to authenticated, service_role;

-- ── 3. Break-glass ─────────────────────────────────────────────────────────
--
-- For the case last-admin protection cannot cover: the sole administrator dies,
-- leaves without handover, or loses their account. Somebody must be able to
-- restore the org to self-governance.
--
-- What it does NOT do: create a session, set a password, or make the operator an
-- administrator of the brand. It issues a SHORT-LIVED invitation which a named
-- person at the org must accept. The operator opens a door; it never walks
-- through it.
--
-- And it is loud. Both audit logs, the operator_actions table the brand can read,
-- and a notification to every remaining administrator and executive. Silent
-- operator access is the thing auditors object to — not operator access as such.
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
  values (p_org_id, lower(trim(p_email)), 'admin', p_token_hash, v_caller,
          -- Deliberately short. A standing invitation to become an administrator
          -- of somebody else's organisation is the thing we are trying not to
          -- have.
          now() + interval '24 hours')
  returning id into v_invite;

  insert into operator_actions (actor_id, operator_org, target_org, action, reason, metadata)
  values (v_caller, current_user_org_id(), p_org_id, 'break_glass', trim(p_reason),
          jsonb_build_object('email', lower(trim(p_email)), 'invitation', v_invite,
                             'expires_at', now() + interval '24 hours'));

  -- Named on BOTH sides, as the permission crossing already is.
  insert into audit_log (org_id, actor_id, action, entity_type, entity_id, metadata)
  values (p_org_id, v_caller, 'operator.break_glass', 'invitation', v_invite,
          jsonb_build_object('reason', trim(p_reason), 'email', lower(trim(p_email)),
                             'by_org', (select name from orgs where id = current_user_org_id())));
  insert into audit_log (org_id, actor_id, action, entity_type, entity_id, metadata)
  values (current_user_org_id(), v_caller, 'operator.break_glass', 'invitation', v_invite,
          jsonb_build_object('reason', trim(p_reason), 'target_org', v_org.name));

  select count(*) into v_actives
    from users where org_id = p_org_id and role = 'admin' and deactivated_at is null;

  -- If anyone is left to tell, tell them. A break-glass into an org that still
  -- has administrators is exactly the case they need to know about.
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

revoke all on function operator_break_glass_admin(uuid, text, text, text) from public;
grant execute on function operator_break_glass_admin(uuid, text, text, text) to authenticated, service_role;

comment on function operator_break_glass_admin is
  'Emergency administrator invitation into a brand org. 24 hours, reason required, recorded in both audit logs and in operator_actions which the target org can read, and announced to every administrator and executive still standing. Issues an invitation a human must accept — the operator never holds a credential in a brand.';
