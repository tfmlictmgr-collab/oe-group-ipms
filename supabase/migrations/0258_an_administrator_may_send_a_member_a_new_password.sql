-- An administrator may send a member a password reset, and staff exports are
-- theirs alone (5 Sept 2026).
--
-- Two asks from the board, one of them a narrowing and one an addition.
--
-- ── 1. The staff roster is not the property manager's to download ──────────
--
-- `records.export` is ONE capability covering five rosters — staff, tenants,
-- vendors, landlords, and the tenancy schedule. Granting it to the property and
-- regional managers (5 Sept) therefore handed them the STAFF list as well:
-- every colleague's name, email, role and approval tier, as a file.
--
-- That is a different kind of list from the others. Tenants, vendors and
-- landlords are the counterparties a property manager deals with daily and
-- already reads one by one on screen; the staff roster is the organisation's
-- own people, and it carries the approval tiers — i.e. who can clear what
-- amount, which is a map of the payment chain's soft spots.
--
-- ⚠️ NOT solved by splitting the capability. A second capability
-- (`records.export_staff`) would have to be seeded, added to the matrix, and
-- granted per org — and would then sit there OFF for every admin until somebody
-- noticed, quietly removing a thing administrators have always had. The rule
-- the board actually stated is simpler than a capability: the staff roster is
-- the administrator's, full stop. It is enforced in the route as a role check
-- beside the capability check, and the button is not rendered for anyone else.
-- Recorded here rather than only in TypeScript because the rule is a permission
-- rule, and this file is where those are read.
--
-- ── 2. Resetting somebody's password ──────────────────────────────────────
--
-- Shaped exactly like `release_member_email` (0193), for the same reason: the
-- authorisation and the audit belong in SQL where no write path can miss them,
-- and the auth-provider step belongs in the server action because GoTrue's
-- tables are not ours to write.
--
-- ⚠️ It issues a RECOVERY LINK to the member's own address. It does not set a
-- password and hand it to the administrator, and that is deliberate: an
-- administrator who can choose another person's password can sign in as them,
-- and every approval that person has ever given stops being evidence of
-- anything. The chain's whole value is that `payment_approvals.actor_id` names
-- a human who alone could have acted. A reset link keeps that true — the member
-- sets their own secret and the administrator never learns it.
--
-- Refuses a DEACTIVATED or RELEASED account: sending a working sign-in link to
-- an account that is supposed to be closed would undo `set_member_active` and
-- `release_member_email` in one click.
create or replace function authorise_member_password_reset(p_user_id uuid)
returns text
language plpgsql security definer set search_path = public as $fn$
declare
  v_org uuid;
  v_email text;
  v_deactivated timestamptz;
  v_released timestamptz;
  v_name text;
begin
  -- ⚠️ POSITIVE comparison, per 0197's recorded defect class: `<> 'admin'` is
  -- NULL for a deactivated caller (current_user_role() returns NULL since
  -- 0194), so the guard would not fire and execution would fall through it.
  if not (current_user_is_active() and current_user_role() = 'admin') then
    raise exception 'only an active administrator may send a member a password reset';
  end if;

  select org_id, email, deactivated_at, email_released_at, full_name
    into v_org, v_email, v_deactivated, v_released, v_name
    from users where id = p_user_id;

  if v_org is null then
    raise exception 'member not found';
  end if;
  if v_org is distinct from current_user_org_id() then
    raise exception 'that member belongs to another organisation';
  end if;
  if p_user_id = auth.uid() then
    raise exception
      'use the "Forgot password?" link on the sign-in page for your own account';
  end if;
  if v_deactivated is not null then
    raise exception
      '% is deactivated — restore the account first, or a reset link would let a closed account back in',
      coalesce(v_name, v_email);
  end if;
  if v_released is not null then
    raise exception
      'that address has been released; the person is invited afresh rather than reset';
  end if;

  insert into audit_log (org_id, actor_id, action, entity_type, entity_id,
                         before_state, after_state)
  values (
    v_org, auth.uid(), 'member.password_reset_sent', 'user', p_user_id,
    null,
    jsonb_build_object('email', v_email, 'full_name', v_name, 'sent_at', now())
  );

  return v_email;
end;
$fn$;

comment on function authorise_member_password_reset(uuid) is
  'Authorises and audits an administrator sending one of their members a password-reset link, and returns the address to send it to. Never sets a password (0258).';

revoke all on function authorise_member_password_reset(uuid) from public, anon;
grant execute on function authorise_member_password_reset(uuid) to authenticated, service_role;

do $$
declare v_bad text;
begin
  select string_agg(distinct routine_name || ' → ' || grantee, ', ')
    into v_bad
    from information_schema.routine_privileges
   where specific_schema = 'public'
     and grantee in ('anon', 'PUBLIC')
     and routine_name = 'authorise_member_password_reset';
  if v_bad is not null then
    raise exception 'these functions are callable by anon or PUBLIC and must not be: %', v_bad;
  end if;
end $$;
