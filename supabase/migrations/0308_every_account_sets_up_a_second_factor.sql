-- Every account sets up a second factor (requested 2 Oct 2026).
--
-- Until now two-factor sign-in was a preference under Settings → Security.
-- This makes it an organisation-wide requirement, switched on per organisation
-- by the OE Group operator, for EVERY role:
--
--   • `orgs.mfa_enforced_from` — null means "not required" (today's behaviour,
--     unchanged by this file). Before the date, a member with no verified
--     factor sees a banner naming the deadline. From the date, the app sends
--     them to the setup page on every visit to the dashboard until they enrol,
--     and anyone who joins after it is sent there straight after their first
--     sign-in.
--   • An administrator can reset a member's factor when they have lost both
--     their authenticator and their backup codes. Mandatory MFA without that
--     is a support ticket that ends in someone editing the auth schema by hand.
--
-- ⚠️ What this file does NOT do: require AAL2 in any RLS policy. The app sends
-- people to enrol; it does not yet stop a session that skipped the app from
-- reading through PostgREST at AAL1. That is phase 3, deliberately later: a
-- restrictive policy written before everyone has a factor locks out exactly the
-- people the banner is still asking. `operator_mfa_enrolment()` below is the
-- number that says when phase 3 is safe.
--
-- Additive only: one nullable column, four new functions, one widened check.
-- The running app ignores all of it until the matching code is deployed.

set local lock_timeout = '5s';

-- ── 1. The date ─────────────────────────────────────────────────────────────
-- Nullable, no default: no rewrite, and every org stays exactly as it is until
-- an operator sets a date. NOT added to the column-level UPDATE grant that
-- admits an organisation's own administrator to `orgs` — loosening this is not
-- the organisation's call any more than its approval ladder is (decision 7).

alter table orgs add column if not exists mfa_enforced_from timestamptz;

comment on column orgs.mfa_enforced_from is
  'From this moment every member must hold a verified second factor to use the dashboard. Null = not required. Operator-governed (0308).';

-- The caller's own organisation's date — what the middleware and the banner
-- ask on each request from someone who has not enrolled. Answers for the
-- caller's org only.
create or replace function my_mfa_enforced_from()
returns timestamptz
language sql
stable
security definer
set search_path = public
as $$
  select o.mfa_enforced_from from orgs o where o.id = current_user_org_id();
$$;

revoke all on function my_mfa_enforced_from() from public, anon;
grant execute on function my_mfa_enforced_from() to authenticated, service_role;

-- ── 2. The operator sets it ─────────────────────────────────────────────────

alter table operator_actions drop constraint if exists operator_actions_action_check;
alter table operator_actions add constraint operator_actions_action_check
  check (action = any (array[
    'provision_org', 'suspend_user', 'unsuspend_user', 'break_glass',
    'retire_org', 'unretire_org', 'set_org_domain', 'set_payment_gate',
    'set_mfa_enforcement'
  ]));

create or replace function operator_set_mfa_enforcement(
  p_org_id uuid, p_from timestamptz, p_reason text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_operator_org uuid;
  v_old timestamptz;
begin
  if not caller_is_operator_admin() then
    raise exception 'only an OE Group operator administrator may set two-factor enforcement';
  end if;
  if length(trim(coalesce(p_reason, ''))) < 10 then
    raise exception 'say why this is changing, in at least 10 characters — it is the record an auditor reads';
  end if;

  select mfa_enforced_from into v_old from orgs where id = p_org_id;
  if not found then
    raise exception 'that organisation could not be found';
  end if;

  select id into v_operator_org from orgs where id = current_user_org_id();

  update orgs set mfa_enforced_from = p_from where id = p_org_id;

  insert into operator_actions (actor_id, operator_org, target_org, action, reason, metadata)
  values (
    auth.uid(), v_operator_org, p_org_id, 'set_mfa_enforcement', trim(p_reason),
    jsonb_build_object('enforced_from_before', v_old, 'enforced_from_after', p_from)
  );
end;
$$;

revoke all on function operator_set_mfa_enforcement(uuid, timestamptz, text) from public, anon;
grant execute on function operator_set_mfa_enforcement(uuid, timestamptz, text) to authenticated, service_role;

-- How many active members of each org hold a verified factor. Operator only:
-- anyone else gets an empty set, as `operator_org_directory()` does. This is
-- the figure that decides when phase 3 (AAL2 in RLS) is safe to ship.
create or replace function operator_mfa_enrolment()
returns table (org_id uuid, mfa_enforced_from timestamptz, active_members int, enrolled_members int)
language sql
stable
security definer
set search_path = public
as $$
  select o.id,
         o.mfa_enforced_from,
         count(u.id)::int,
         count(u.id) filter (where exists (
           select 1 from auth.mfa_factors f
            where f.user_id = u.id and f.status = 'verified'))::int
    from orgs o
    left join users u on u.org_id = o.id and u.deactivated_at is null
   where caller_is_operator_admin()
   group by o.id, o.mfa_enforced_from;
$$;

revoke all on function operator_mfa_enrolment() from public, anon;
grant execute on function operator_mfa_enrolment() to authenticated, service_role;

-- ── 3. An administrator resets a member who lost their authenticator ────────
-- Authorises and records; it does not delete. The factor is removed by the
-- server action through the auth provider's admin API (as lib/mfa.ts already
-- does for a used backup code), never by editing auth.mfa_factors from SQL.
-- Same order as `authorise_member_password_reset`: the audit row exists before
-- anything is changed, so a reset that half-fails is still on the record.

create or replace function authorise_member_mfa_reset(p_user_id uuid, p_reason text)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org uuid;
  v_email text;
  v_deactivated timestamptz;
  v_name text;
begin
  if not (current_user_is_active() and current_user_role() = 'admin') then
    raise exception 'only an active administrator may reset a member''s two-factor sign-in';
  end if;

  -- An administrator who has enrolled must be signed in WITH their factor to
  -- remove someone else's. Otherwise a stolen administrator password alone —
  -- the thing MFA exists to make insufficient — could strip a colleague's.
  if exists (select 1 from auth.mfa_factors f
              where f.user_id = auth.uid() and f.status = 'verified')
     and coalesce(auth.jwt() ->> 'aal', 'aal1') <> 'aal2' then
    raise exception 'sign in with your own authenticator code first — this needs a fully verified session';
  end if;

  if length(trim(coalesce(p_reason, ''))) < 10 then
    raise exception 'say why, in at least 10 characters — for example how you confirmed it was really them';
  end if;

  select org_id, email, deactivated_at, full_name
    into v_org, v_email, v_deactivated, v_name
    from users where id = p_user_id;

  if v_org is null then
    raise exception 'member not found';
  end if;
  if v_org is distinct from current_user_org_id() then
    raise exception 'that member belongs to another organisation';
  end if;
  if p_user_id = auth.uid() then
    raise exception 'use one of your own backup codes at sign-in for your own account';
  end if;
  if v_deactivated is not null then
    raise exception '% is deactivated — restore the account first', coalesce(v_name, v_email);
  end if;

  insert into audit_log (org_id, actor_id, action, entity_type, entity_id,
                         before_state, after_state)
  values (
    v_org, auth.uid(), 'member.mfa_reset', 'user', p_user_id,
    null,
    jsonb_build_object('email', v_email, 'full_name', v_name,
                       'reason', trim(p_reason), 'reset_at', now())
  );

  -- Their backup codes recover a factor that will no longer exist.
  delete from mfa_backup_codes where user_id = p_user_id;

  return v_email;
end;
$$;

revoke all on function authorise_member_mfa_reset(uuid, text) from public, anon;
grant execute on function authorise_member_mfa_reset(uuid, text) to authenticated, service_role;

-- ── 4. Assertions ───────────────────────────────────────────────────────────
do $$
begin
  if exists (select 1 from information_schema.column_privileges
              where table_schema = 'public' and table_name = 'orgs'
                and column_name = 'mfa_enforced_from'
                and grantee in ('authenticated', 'anon')
                and privilege_type = 'UPDATE') then
    raise exception '0308: an organisation''s own users must not be able to write mfa_enforced_from';
  end if;
end $$;
