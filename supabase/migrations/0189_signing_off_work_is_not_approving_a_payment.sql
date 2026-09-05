-- Stage 1 is a SIGN-OFF, not an approval. And an approver's tier can be
-- changed after they are appointed. (Board direction, 22 Aug 2026.)
--
-- ── 1. What stage 1 actually is ───────────────────────────────────────────
--
-- `payment_chain_stages()` has called stage 1 *"Job sign-off and approval for
-- payment"* since 0151, and the second half of that name is wrong in a way that
-- matters. A facility or property manager confirms **the work was done** — they
-- have been to the building, the roof is fixed, the job card and the photos
-- match. They hold no spending limit, no tier, and no authority over whether
-- the organisation should part with the money.
--
-- The approval tiers are stages 2 and 3. Calling stage 1 an approval invites
-- exactly the reading the board corrected: that an FM/PM is the first of three
-- approvers, rather than the person whose evidence the two approvers then
-- check. It also made "Requires Tier 2" appear above a stage no tier applies
-- to.
--
-- Nothing about WHO may action stage 1 changes — it was `fm_roles()` before and
-- it is `fm_roles()` now. Only the name changes, and the name was the part
-- misleading people.
create or replace function payment_chain_stages()
returns table(stage_order smallint, required_roles user_role[], tier_resolved boolean, label text)
language sql immutable set search_path = public as $$
  select * from (values
    (1::smallint, fm_roles(), false,
     'Work completed and signed off'),
    (2::smallint, array['payment_audit_approver']::user_role[],              false,
     'Audit verification'),
    (3::smallint, array['payment_approver','executive','admin']::user_role[], true,
     'Final approval')
  ) as t(stage_order, required_roles, tier_resolved, label);
$$;

comment on function payment_chain_stages is
  'The three pairs of hands every payment out passes through. Stage 1 is a SIGN-OFF — the FM/PM confirms the work was done, holds no spending limit and approves no money; the approval tiers are stages 2 and 3 (board, 22 Aug 2026). Stage 1''s roles come from fm_roles() rather than a literal array, so the next operational role added reaches it automatically — the 0183 lesson, applied where it was still owed.';

-- ── 2. An approver's tier is appointed, and can be corrected ──────────────
--
-- `users.approval_tier` was written in exactly one place: `accept_invitation`
-- (0153), when the approver first signs in. There was no way to change it
-- afterwards — so an approver invited at the wrong tier, or promoted, could
-- only be fixed by someone with database access. That is how a standing
-- "super admin" gets built, and this system deliberately has none (0053).
--
-- ⚠️ `payment_approver` ONLY. The executive's tier 3 and the administrator's
-- tier 2 are set by `effective_approval_tier()` from the ROLE, per decisions 9
-- and 16, and are non-delegable controls under decision 7 — they must never
-- become an editable field. An executive co-holds approval above the threshold
-- because the board says so, not because someone typed a 3 into a box.
create or replace function set_user_approval_tier(
  p_user_id uuid,
  p_tier    smallint
)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_actor uuid := auth.uid();
  v_org   uuid := current_user_org_id();
  u       users%rowtype;
begin
  if v_actor is null or v_org is null then
    raise exception 'you are not signed in to an organisation';
  end if;
  if current_user_role() is distinct from 'admin' then
    raise exception 'only an administrator may set an approver''s tier';
  end if;

  select * into u from users where id = p_user_id;
  if u.id is null or u.org_id is distinct from v_org then
    raise exception 'that person is not in your organisation';
  end if;

  if u.role is distinct from 'payment_approver' then
    raise exception
      'only a payment approver carries a tier — % holds theirs by role, which is not editable',
      u.role;
  end if;

  if p_tier is null or p_tier not between 1 and 3 then
    raise exception 'a tier is 1, 2 or 3';
  end if;

  -- ⚠️ An administrator setting their OWN tier would be raising the limit they
  -- then approve against — the concentration decisions 9 and 16 exist to
  -- break. It cannot arise today (an admin is not a payment_approver, so the
  -- role check above already refuses), and it is stated anyway because the
  -- role check is about the TARGET and this is about the ACTOR.
  if p_user_id = v_actor then
    raise exception 'you cannot set your own approval tier';
  end if;

  update users set approval_tier = p_tier where id = p_user_id;

  insert into audit_log (org_id, actor_id, action, entity_type, entity_id,
                         before_state, after_state)
  values (v_org, v_actor, 'user.approval_tier', 'user', p_user_id,
          jsonb_build_object('approval_tier', u.approval_tier),
          jsonb_build_object('approval_tier', p_tier));
end;
$$;

revoke all on function set_user_approval_tier(uuid, smallint) from public, anon;
grant execute on function set_user_approval_tier(uuid, smallint) to authenticated;

comment on function set_user_approval_tier is
  'Sets a payment approver''s tier after appointment — the band of amounts they may clear at stage 3. Administrator only, audited, and refused on any other role: an executive is tier 3 and an administrator tier 2 BY ROLE (decisions 9 and 16), which is a non-delegable control and never an editable field. An administrator may not set their own.';

-- ── 3. The bands, readable ────────────────────────────────────────────────
--
-- `resolve_required_tier` already decides which tier an amount needs, from
-- two columns the settings screen exposed only one of. This states both, so
-- the screen can show what it is actually configuring rather than one number
-- and an implication.
create or replace function org_approval_bands(p_org_id uuid)
returns table(tier smallint, floor_amount numeric, ceiling_amount numeric, label text)
language sql stable set search_path = public as $$
  -- Named columns on the subselect, so ORDER BY can reference them. A bare
  -- `select *` over a UNION exposes the FIRST branch's column names, which are
  -- positional here and not `tier`.
  select b.tier, b.floor_amount, b.ceiling_amount, b.label from (
    select 1::smallint as tier,
           0::numeric  as floor_amount,
           coalesce(s.tier1_threshold_amount, 100000)::numeric as ceiling_amount,
           'Tier 1'::text as label
      from (select 1) _ left join payment_settings s on s.org_id = p_org_id
    union all
    select 2::smallint,
           coalesce(s.tier1_threshold_amount, 100000)::numeric,
           coalesce(s.approval_threshold_amount, 1000000)::numeric,
           'Tier 2'::text
      from (select 1) _ left join payment_settings s on s.org_id = p_org_id
    union all
    select 3::smallint,
           coalesce(s.approval_threshold_amount, 1000000)::numeric,
           null::numeric,
           'Tier 3 (unlimited)'::text
      from (select 1) _ left join payment_settings s on s.org_id = p_org_id
  ) b order by b.tier;
$$;

revoke all on function org_approval_bands(uuid) from public, anon;
grant execute on function org_approval_bands(uuid) to authenticated;

comment on function org_approval_bands is
  'The three amount bands and who each needs, derived from the same two columns resolve_required_tier() reads. Exists so the settings screen shows the ladder it is configuring instead of one threshold and an implication — tier1_threshold_amount had no field at all and sat silently at its ₦100,000 default on every organisation.';
