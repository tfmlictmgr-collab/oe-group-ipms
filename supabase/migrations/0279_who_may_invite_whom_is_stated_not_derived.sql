-- Who may invite whom is stated, not derived (board, 8 Sept 2026).
--
-- Asked as: "only admin should have the privilege to invite everyone and none
-- other, not the regional manager, not any other role. The regional manager
-- may be able to add fm/pm/vendor/tenant/property-owner only, but not
-- executive, admin or any other role."
--
-- ── What was actually true ────────────────────────────────────────────────
--
-- The escalation half was already held: `0078c` replaced a guard naming one
-- role with `role_rank(role) < role_rank(current_user_role())`, so a regional
-- manager (60) could never issue `executive` (90), `admin` (100), or any of
-- the three payment desks (64/65/70). Measured, not assumed, in the assertion
-- at the foot of this file.
--
-- What the rank rule DID give them, beyond the board's five, was
-- `fm_ops_staff` (30) and `viewer` (15). And the reason to state the set
-- rather than keep deriving it is the failure mode of a rank: it is one
-- number, it is consulted by three different files, and the roles it must
-- never reach are exactly the ones where being one number wrong is an
-- escalation. `0078c`'s own header records the previous version of this
-- lesson — a guard that named ONE privileged role protected only against the
-- roles that existed the day it was written. A rank is that guard generalised,
-- and it is still a heuristic standing in for a decision.
--
-- 📌 `fm_ops_staff` is OUT, and that is a real narrowing to record: decision 9
-- says the regional manager exists partly to invite "operational staff", which
-- is what that role is. The instruction enumerated five roles and said "only",
-- so this takes the narrower reading — the reversible direction. Restoring it
-- is one array element here and one in `lib/roles.ts`.
--
-- ── The shape ─────────────────────────────────────────────────────────────
--
-- `invitable_roles(inviter)` is the ONE place the question is answered
-- (decision 8), so a future change is one function and not three files. The
-- administrator's answer is *every value of the enum*, read from the catalogue
-- rather than typed — a role added tomorrow is automatically an
-- administrator's to issue and nobody else's by default, which is decision 7's
-- "defaults are the most restrictive workable state" applied to this question.

create or replace function invitable_roles(p_inviter user_role)
returns user_role[]
language sql stable set search_path = public as $$
  select case
    -- ⚠️ The administrator, and only the administrator, may issue any role at
    -- all — including a peer administrator, so an organisation is never one
    -- resignation away from having nobody who can add anyone (0078d). Read
    -- from `enum_range` so a new role needs no edit here to be covered, and
    -- cannot be silently unreachable to everyone.
    when p_inviter = 'admin' then
      (select array_agg(r order by r::text) from unnest(enum_range(null::user_role)) r)

    -- The board's stated set. Not a rank, not a subtraction — a list.
    when p_inviter = 'regional_manager' then
      array['facility_manager', 'property_manager',
            'property_owner', 'tenant', 'vendor']::user_role[]

    -- The facilities and property managers keep 0078c's rule: strictly below
    -- your own rank — `fm_ops_staff`, `property_owner`, `viewer`, `vendor`,
    -- `tenant`, and nobody else. The board's instruction narrowed the regional
    -- manager and said nothing about them.
    when p_inviter = any (fm_roles()) then
      (select coalesce(array_agg(r order by r::text), '{}'::user_role[])
         from unnest(enum_range(null::user_role)) r
        where role_rank(r) < role_rank(p_inviter))

    -- ⚠️ EVERYONE ELSE ISSUES NOTHING, and saying so here is the point.
    --
    -- The first draft fell through to the rank rule for every remaining role,
    -- which answered that a `finance_approver` (70) may invite a
    -- `payment_approver` (65), a `payment_audit_approver` (64) and a
    -- `regional_manager` (60). Harmless in effect — `invitations_insert` has
    -- admitted only `admin` and `fm_roles()` since 0078c, so finance cannot
    -- issue an invitation at all — and wrong as an ANSWER, which is exactly
    -- how a rank stops being a summary of the rule and becomes a second,
    -- disagreeing statement of it. Caught by this file's own assertion.
    --
    -- So the function is the whole truth: a role that may not invite reaches
    -- nothing. The policy's own "who may issue" clause is kept as defence in
    -- depth, not as the only thing holding this.
    else '{}'::user_role[]
  end;
$$;

comment on function invitable_roles(user_role) is
  'The roles this role may issue an invitation for. The one answer to "may A create B" (board, 8 Sept 2026): an administrator may issue any role including a peer administrator; a regional manager may issue the facilities and property managers, owners, tenants and vendors and nothing else; everyone else keeps 0078c''s "strictly below your own rank". Stated rather than derived because the roles this must never reach are the ones where a rank being one number wrong is an escalation.';

revoke all on function invitable_roles(user_role) from public, anon;
grant execute on function invitable_roles(user_role) to authenticated, service_role;

-- ── The policy now asks that one question ─────────────────────────────────
--
-- Rewritten from 0078d's live expression with the rank/peer pair replaced by
-- the single call. Every other clause is moved, not retyped: the org, the
-- self-attribution, who may issue at all, and the subtree check that stops a
-- regional manager for the North inviting someone into the South.
drop policy if exists invitations_insert on invitations;
create policy invitations_insert on invitations for insert
  with check (
    org_id = current_user_org_id()
    and invited_by = auth.uid()

    and (
      current_user_role() = 'admin'
      or current_user_role() = any (fm_roles())
    )

    -- One question, one place.
    and role = any (invitable_roles(current_user_role()))

    and (
      node_id is null
      or current_user_role() = 'admin'
      or exists (
        select 1
          from property_stakeholders s
          join org_nodes mine on mine.id = s.node_id and mine.org_id = s.org_id
          join org_nodes target on target.id = invitations.node_id and target.org_id = s.org_id
         where s.user_id = auth.uid()
           and s.node_id is not null
           and target.path like mine.path || '%'
      )
    )
  );

comment on policy invitations_insert on invitations is
  'An invitation may only be issued by an administrator or an operational manager, for a role `invitable_roles()` allows them, into a part of the hierarchy they actually hold (0279).';

comment on function role_rank is
  'Invitation seniority, now consulted THROUGH invitable_roles() rather than directly by the policy (0279). It still answers for the facilities and property managers; the administrator and the regional manager are stated sets. Nobody may create a role above their own.';

-- ── Assert the rule, for every role, both directions ──────────────────────
--
-- ⚠️ Written as the full matrix rather than as spot checks, because the whole
-- point of stating the set is that the next role added must not quietly land
-- inside somebody's reach. A rank has no opinion about a role it has never
-- heard of; this does.
do $$
declare
  r user_role;
  v_admin user_role[];
  v_rm user_role[];
  v_fm user_role[];
begin
  v_admin := invitable_roles('admin');
  v_rm    := invitable_roles('regional_manager');
  v_fm    := invitable_roles('facility_manager');

  -- 1. The administrator reaches every role in the enum, including their own.
  foreach r in array enum_range(null::user_role) loop
    if not (r = any (v_admin)) then
      raise exception 'an administrator cannot invite %, and should be able to invite everyone', r;
    end if;
  end loop;

  -- 2. The regional manager reaches exactly the five the board named.
  if not (v_rm @> array['facility_manager','property_manager','property_owner','tenant','vendor']::user_role[]
          and array['facility_manager','property_manager','property_owner','tenant','vendor']::user_role[] @> v_rm) then
    raise exception 'the regional manager''s invitable set is not the five stated: %', v_rm;
  end if;

  -- 3. Nobody but the administrator reaches the roles that must never be
  --    minted sideways. Asked of EVERY role in the enum, so this survives a
  --    role being added.
  foreach r in array enum_range(null::user_role) loop
    if r = 'admin' then continue; end if;
    if 'admin'::user_role = any (invitable_roles(r))
       or 'executive'::user_role = any (invitable_roles(r))
       or 'finance_approver'::user_role = any (invitable_roles(r))
       or 'payment_approver'::user_role = any (invitable_roles(r))
       or 'payment_audit_approver'::user_role = any (invitable_roles(r)) then
      raise exception
        '% can invite into an administrator, the executive or a payment desk: %', r, invitable_roles(r);
    end if;
  end loop;

  -- 3b. And a role that may not issue an invitation at all answers with
  --     nothing, rather than with a rank's opinion about a question it is
  --     never asked. The two halves must agree: `invitations_insert` admits
  --     `admin` and `fm_roles()`, and those are exactly the roles with a
  --     non-empty set here.
  foreach r in array enum_range(null::user_role) loop
    if r = 'admin' or r = any (fm_roles()) then
      if array_length(invitable_roles(r), 1) is null then
        raise exception '% may issue invitations but reaches no role', r;
      end if;
    elsif array_length(invitable_roles(r), 1) is not null then
      raise exception
        '% cannot issue an invitation, yet invitable_roles says %', r, invitable_roles(r);
    end if;
  end loop;

  -- 4. And the managers are untouched by this change — they keep 0078c's rule.
  if not (v_fm @> array['fm_ops_staff','property_owner','viewer','vendor','tenant']::user_role[]) then
    raise exception 'the facilities manager lost part of their existing reach: %', v_fm;
  end if;
  if 'regional_manager'::user_role = any (v_fm) or 'property_manager'::user_role = any (v_fm) then
    raise exception 'a facilities manager can now invite a peer or their senior: %', v_fm;
  end if;
end $$;
