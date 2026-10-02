-- The Executive coordinates OEA's operations and clears small requisitions
-- (requested 2 Oct 2026). Uses the value 0306 added.
--
-- WHAT THE ROLE IS
--
--   • OEA only. Refused on any member row or invitation in a non-OEA
--     organisation, and an organisation holding one cannot leave OEA.
--   • Ranked above the regional manager (60) and below the Managing Partner
--     (`executive`, 90): 62. Rank decides little since 0279 — who may invite
--     whom is a list — but it is what sorts the role in every roster.
--   • Org-wide sight of operations (B7: tickets.read_all, triage_unassigned,
--     properties.read_all, assets.read, vendors.read, bi.read), dispatch and
--     closure (tickets.assign, tickets.close), and onboarding (people.invite)
--     of facilities managers, properties managers and operations staff.
--     Baseline only: an operator can move any of it in the matrix, as for
--     every other role (decision 7).
--   • On the OEA chain they may action STAGE 2 — "Managing Partner approval" —
--     for an `ops_requisition` at or below `payment_settings.
--     ops_executive_requisition_limit` (₦500,000 by default), and never one
--     they raised. Above the limit, and for every vendor payment and landlord
--     payout, stage 2 is the Managing Partner's exactly as before.
--
-- WHAT IT IS NOT
--
--   • Not a skip. The audit review (stage 1) still precedes them and the
--     payment approver (stage 3) still follows; the payment officer still
--     releases. An Executive approval REPLACES the MP's signature on a small
--     requisition, it does not shorten the ladder. Separation of duties is the
--     trigger's existing "one human, one stage" plus the raiser rule here.
--   • Not tier-resolved and not in `effective_approval_tier()`. The limit is
--     theirs alone and lives in its own column, rather than borrowing the
--     tier bands that govern stage 3 — those answer a different question
--     (which payment approver) and moving them would move stage 3 too.
--   • Not in `fm_roles()`. That resolver is "operates a building" and reaches
--     ~30 policies, the standard chain's stage 1 and the requisition raise
--     path. The Executive coordinates the people who operate buildings; they
--     do not sign off work, raise requisitions, or approve their own.
--   • Not able to set the limit. It is operator-governed like the tier
--     limits (0149): `enforce_payment_gate_config_authority` refuses a change
--     from anyone but an OE Group operator administrator, and the only write
--     path is `operator_set_ops_executive_limit`, which records a reason.
--
-- 📌 Every function rewritten below was rebuilt from `pg_get_functiondef` of a
-- database holding 0001–0306, with only the marked `0307` lines inserted (the
-- 0183 rule: the live catalogue is the source, never the migration that last
-- wrote it). CREATE OR REPLACE keeps each function's existing grants.

set local lock_timeout = '5s';

-- ── 1. The limit ────────────────────────────────────────────────────────────
-- A constant default: no table rewrite.

alter table payment_settings
  add column if not exists ops_executive_requisition_limit numeric(14,2) not null default 500000;

alter table payment_settings
  drop constraint if exists payment_settings_ops_executive_limit_positive;
alter table payment_settings
  add constraint payment_settings_ops_executive_limit_positive
  check (ops_executive_requisition_limit > 0);

comment on column payment_settings.ops_executive_requisition_limit is
  'The largest FM/PM/Ops requisition an OEA Executive (operations_executive) may action at the Managing Partner''s stage. Operator-governed (0307).';

-- The figure for one organisation. SECURITY DEFINER because the chain desks
-- that need to SHOW it (auditor, payment approver) cannot read
-- payment_settings; it answers only for the caller's own organisation, so it
-- is not a way to read another org's settings. The service role and the
-- approval trigger (whose caller is the actor, in the payable's org) pass.
create or replace function ops_executive_requisition_limit(p_org_id uuid)
returns numeric
language sql
stable
security definer
set search_path = public
as $$
  select case
           when auth.uid() is not null
            and p_org_id is distinct from current_user_org_id() then null
           else coalesce(
             (select s.ops_executive_requisition_limit
                from payment_settings s where s.org_id = p_org_id),
             500000)
         end;
$$;

revoke all on function ops_executive_requisition_limit(uuid) from public, anon;
grant execute on function ops_executive_requisition_limit(uuid) to authenticated, service_role;

CREATE OR REPLACE FUNCTION public.enforce_payment_gate_config_authority()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_changed text[] := '{}';
begin
  if auth.uid() is null then
    return new;
  end if;

  if tg_op = 'INSERT' then
    if new.approval_threshold_amount is distinct from 1000000
       or new.min_performance_score is distinct from 70
       or new.tier1_threshold_amount is distinct from 100000
       or new.ops_executive_requisition_limit is distinct from 500000 then
      if not caller_is_operator_admin() then
        raise exception
          'the approval limits and the performance gate are set by OE Group, not by the organisation — ask your OE Group contact to change them';
      end if;
    end if;
    return new;
  end if;

  if new.approval_threshold_amount is distinct from old.approval_threshold_amount then
    v_changed := array_append(v_changed, 'the approval limit');
  end if;
  if new.tier1_threshold_amount is distinct from old.tier1_threshold_amount then
    v_changed := array_append(v_changed, 'the tier 1 limit');
  end if;
  if new.min_performance_score is distinct from old.min_performance_score then
    v_changed := array_append(v_changed, 'the performance gate');
  end if;
  -- 0307. The Executive's requisition limit is an approval limit like the
  -- other two, and governed the same way.
  if new.ops_executive_requisition_limit is distinct from old.ops_executive_requisition_limit then
    v_changed := array_append(v_changed, 'the Executive''s requisition limit');
  end if;

  if array_length(v_changed, 1) is null then
    return new;
  end if;

  if not caller_is_operator_admin() then
    raise exception
      '% % set by OE Group, not by the organisation — an administrator who can raise the limit they approve against has not been limited',
      array_to_string(v_changed, ' and '),
      case when array_length(v_changed, 1) > 1 then 'are' else 'is' end;
  end if;

  return new;
end;
$function$;

-- The only write path. Same shape as `operator_set_payment_gate`: operator
-- administrator only, a reason of at least ten characters, the before and
-- after on `operator_actions` where the organisation can read it.
create or replace function operator_set_ops_executive_limit(
  p_org_id uuid, p_limit numeric, p_reason text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_operator_org uuid;
  v_old numeric;
begin
  if not caller_is_operator_admin() then
    raise exception 'only an OE Group operator administrator may set an approval limit';
  end if;
  if length(trim(coalesce(p_reason, ''))) < 10 then
    raise exception 'say why this limit is changing, in at least 10 characters — it is the record an auditor reads';
  end if;
  if p_limit is null or p_limit <= 0 then
    raise exception 'the Executive''s requisition limit must be greater than zero';
  end if;
  if not exists (select 1 from orgs where id = p_org_id) then
    raise exception 'that organisation could not be found';
  end if;

  select ops_executive_requisition_limit into v_old
    from payment_settings where org_id = p_org_id;
  select id into v_operator_org from orgs where id = current_user_org_id();

  insert into payment_settings (org_id, ops_executive_requisition_limit, updated_at)
  values (p_org_id, p_limit, now())
  on conflict (org_id) do update
    set ops_executive_requisition_limit = excluded.ops_executive_requisition_limit,
        updated_at = now();

  insert into operator_actions (actor_id, operator_org, target_org, action, reason, metadata)
  values (
    auth.uid(), v_operator_org, p_org_id, 'set_payment_gate', trim(p_reason),
    jsonb_build_object(
      'setting', 'ops_executive_requisition_limit',
      'ops_executive_limit_before', coalesce(v_old, 500000),
      'ops_executive_limit_after',  p_limit
    )
  );
end;
$$;

revoke all on function operator_set_ops_executive_limit(uuid, numeric, text) from public, anon;
grant execute on function operator_set_ops_executive_limit(uuid, numeric, text) to authenticated, service_role;

-- ── 2. OEA only ─────────────────────────────────────────────────────────────
-- In the database, not the invite dialog: a role is whatever a member row
-- says, whichever path wrote it.

create or replace function operations_executive_is_oea_only()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.role = 'operations_executive'
     and not exists (select 1 from orgs o
                      where o.id = new.org_id and o.delivery_brand = 'OEA') then
    raise exception 'the Executive role exists on OEA only';
  end if;
  return new;
end;
$$;

revoke all on function operations_executive_is_oea_only() from public, anon, authenticated;

drop trigger if exists users_operations_executive_is_oea_only on users;
create trigger users_operations_executive_is_oea_only
  before insert or update of role, org_id on users
  for each row execute function operations_executive_is_oea_only();

drop trigger if exists invitations_operations_executive_is_oea_only on invitations;
create trigger invitations_operations_executive_is_oea_only
  before insert or update of role, org_id on invitations
  for each row execute function operations_executive_is_oea_only();

-- And the other direction: an organisation holding an active Executive cannot
-- stop being OEA underneath them.
create or replace function org_keeps_oea_while_it_has_an_executive()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if old.delivery_brand = 'OEA' and new.delivery_brand is distinct from 'OEA'
     and exists (select 1 from users u
                  where u.org_id = new.id
                    and u.role = 'operations_executive'
                    and u.deactivated_at is null) then
    raise exception 'this organisation has an active Executive, a role that exists on OEA only — deactivate them first';
  end if;
  return new;
end;
$$;

revoke all on function org_keeps_oea_while_it_has_an_executive() from public, anon, authenticated;

drop trigger if exists orgs_keep_oea_while_executive on orgs;
create trigger orgs_keep_oea_while_executive
  before update of delivery_brand on orgs
  for each row execute function org_keeps_oea_while_it_has_an_executive();

-- ── 3. Rank, onboarding and sight ───────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.role_rank(p_role user_role)
 RETURNS integer
 LANGUAGE sql
 IMMUTABLE
AS $function$
  select case p_role
           when 'admin'                  then 100
           when 'executive'              then 90
           when 'finance_approver'       then 70
           when 'payment_approver'       then 65
           when 'payment_audit_approver' then 64
           when 'operations_executive'   then 62
           when 'regional_manager'       then 60
           when 'facility_manager'       then 50
           when 'property_manager'       then 50
           when 'fm_ops_staff'           then 30
           when 'property_owner'         then 20
           when 'viewer'                 then 15
           when 'vendor'                 then 10
           when 'tenant'                 then 10
           else 0
         end;
$function$;

CREATE OR REPLACE FUNCTION public.invitable_roles(p_inviter user_role)
 RETURNS user_role[]
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  select case
    -- ⚠️ The administrator, and only the administrator, may issue any role at
    -- all — including a peer administrator, so an organisation is never one
    -- resignation away from having nobody who can add anyone (0078d). Read
    -- from `enum_range` so a new role needs no edit here to be covered, and
    -- cannot be silently unreachable to everyone.
    when p_inviter = 'admin' then
      (select array_agg(r order by r::text) from unnest(enum_range(null::user_role)) r)

    -- 0307. The Executive onboards the people they coordinate, and nobody
    -- else: not a regional manager, not a payment desk, not a peer. A list,
    -- for the same reason the regional manager's is one.
    when p_inviter = 'operations_executive' then
      array['facility_manager', 'fm_ops_staff', 'property_manager']::user_role[]

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
$function$;

CREATE OR REPLACE FUNCTION public.current_user_may_attach_property(p_property_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select p_property_id is null
      or current_user_role() = 'admin'
      -- 0307. The Executive coordinates the whole organisation's operations,
      -- so may place an FM/PM/Ops invitee on any live property OF THEIR OWN
      -- organisation. The org test is stated, not assumed: unlike the
      -- admin arm above, this one is new and gets no benefit of the doubt.
      or (current_user_role() = 'operations_executive'
          and exists (select 1 from properties p
                       where p.id = p_property_id
                         and p.org_id = current_user_org_id()
                         and p.deleted_at is null))
      or p_property_id in (select current_user_property_ids());
$function$;

-- Read-only sight of members, invitation deliveries, the outbound message log
-- and the payment settings (so they can see their own limit). Every consumer
-- of this resolver is a SELECT policy — checked, not assumed.
CREATE OR REPLACE FUNCTION public.oversight_roles_with_fm()
 RETURNS user_role[]
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
  select array['admin', 'facility_manager', 'property_manager', 'regional_manager',
               'finance_approver', 'executive',
               'operations_executive']::user_role[];
$function$;

-- `invitations_insert`, rebuilt from the live policy with exactly two changes:
-- the Executive may issue an invitation at all, and may name any node of
-- their own organisation (the composite FK on (node_id, org_id) plus the
-- `org_id = current_user_org_id()` test keep it inside it). Properties and
-- units go through `current_user_may_attach_property`, widened above; the
-- vendor clause is untouched because a vendor is not theirs to invite.
drop policy if exists invitations_insert on invitations;
create policy invitations_insert on invitations
  for insert
  with check (
    (org_id = current_user_org_id())
    and (invited_by = auth.uid())
    and ((current_user_role() = 'admin'::user_role)
         or (current_user_role() = 'operations_executive'::user_role)
         or (current_user_role() = any (fm_roles())))
    and (role = any (invitable_roles(current_user_role())))
    and ((node_id is null)
         or (current_user_role() = 'admin'::user_role)
         or (current_user_role() = 'operations_executive'::user_role)
         or (exists (select 1
                       from ((property_stakeholders s
                         join org_nodes mine on (((mine.id = s.node_id) and (mine.org_id = s.org_id))))
                         join org_nodes target on (((target.id = invitations.node_id) and (target.org_id = s.org_id))))
                      where ((s.user_id = auth.uid()) and (s.node_id is not null)
                             and (target.path ~~ (mine.path || '%'::text))))))
    and (not (exists (select 1
                        from unnest(coalesce(invitations.property_ids, '{}'::uuid[])) pid(pid)
                       where (not current_user_may_attach_property(pid.pid)))))
    and ((unit_id is null)
         or (current_user_role() = 'admin'::user_role)
         or (exists (select 1 from units u
                      where ((u.id = invitations.unit_id) and (u.org_id = invitations.org_id)
                             and current_user_may_attach_property(u.property_id)))))
    and ((vendor_id is null)
         or (current_user_role() = 'admin'::user_role)
         or (vendor_id in (select current_user_scoped_vendor_ids() as current_user_scoped_vendor_ids)))
  );

-- ── 4. The permission baseline ──────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.b7_grants(p_role user_role, p_capability text)
 RETURNS boolean
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
  select case
        when p_capability = 'tickets.assign_without_review' then false
        when p_capability = 'training.read' then false
        when p_capability = 'records.export' then false

        when p_role = 'admin' then true

        -- 0281. Placed ABOVE the role-specific arms deliberately: those arms are
        -- closed lists, and a capability added to the bottom of this CASE would
        -- never be reached for `executive`, `regional_manager` or either payment
        -- desk. The three confirmation desks are absent by intent, not omission
        -- — recording a claim disqualifies you from confirming it (0282's
        -- maker-checker), so granting it to a chain role hands them a way to
        -- take themselves out of the chain. `finance_approver` is the deliberate
        -- exception: taking a walk-in payment at the finance desk is the single
        -- commonest way one of these arrives, and the consequence — that a
        -- colleague must confirm it — is the control working, exactly as 0142
        -- says. 13 Sept 2026: unchanged by the board's reversal above — the
        -- Officer still takes the walk-in, the Approver still confirms it, and
        -- a walk-in the Officer takes is confirmed by someone else regardless.
        when p_capability = 'payments.record_offline' then p_role in (
          'facility_manager', 'property_manager', 'regional_manager', 'finance_approver'
        )

        -- 0307. The OEA Executive: org-wide sight of operations, dispatch and
        -- closure, and onboarding. Nothing financial beyond the requisitions
        -- the chain hands them (which is not a capability — decision 7), no
        -- structure (hierarchy, properties, leases), no vendor decisions, no
        -- export. Placed after `payments.record_offline`, which they do not
        -- hold: recording a claim is a confirmation desk's conflict.
        when p_role = 'operations_executive' then p_capability in (
          'tickets.read_all', 'tickets.triage_unassigned',
          'tickets.assign', 'tickets.close',
          'properties.read_all', 'assets.read', 'vendors.read',
          'bi.read', 'people.invite'
        )

        when p_role = 'executive' then p_capability in (
          'tickets.read_all', 'assets.read', 'sc.read_all', 'properties.read_all',
          'vendors.read', 'bi.read', 'tickets.triage_unassigned'
        )

        when p_role = 'payment_audit_approver' then p_capability in (
          'tickets.read_all', 'vendors.read', 'bi.read', 'properties.read_all'
        )

        -- 0246, unchanged by 13 Sept 2026's reversal: the payment approver is
        -- the senior accounting desk and already held sc.manage before this
        -- migration. What moved is who else does.
        when p_role = 'payment_approver' then p_capability in (
          'vendors.read', 'bi.read', 'properties.read_all',
          'assets.read', 'sc.read_all', 'sc.manage'
        )

        when p_role = 'regional_manager' then p_capability in (
          'tickets.assign', 'tickets.close', 'tickets.triage_unassigned',
          'assets.write', 'assets.import',
          'vendors.read', 'vendors.write', 'vendors.evaluate',
          'properties.write', 'units.assign_occupant',
          'people.invite', 'bi.read',
          'applications.recommend', 'applications.approve',
          'hierarchy.write', 'sc.manage', 'leases.write',
          'vendors.recommend', 'vendors.approve'
        )

        when p_capability = 'tickets.read_all' then false

        when p_capability in ('assets.read', 'sc.read_all', 'properties.read_all')
          then p_role = 'finance_approver'

        when p_capability in ('tickets.assign', 'tickets.close',
                         'assets.write', 'assets.import',
                         'vendors.write', 'vendors.evaluate',
                         'properties.write', 'units.assign_occupant',
                         'people.invite', 'hierarchy.write',
                         'vendors.recommend',
                         'applications.recommend')
          then p_role in ('facility_manager', 'property_manager')

        when p_capability = 'vendors.read'
          then p_role in ('facility_manager', 'property_manager', 'finance_approver')

        -- 13 Sept 2026 (board). Was `p_role in ('finance_approver',
        -- 'property_manager')` since 0249. The Payment Officer's role narrows
        -- to disbursement; administering the service-charge budget and its
        -- apportionment is not part of "dispensing outward payments" and moves
        -- fully to the Approver, who already held it via the closed-list arm
        -- above. property_manager's own grant (0249) is untouched — every
        -- write it unlocks is still bounded to a property they hold.
        when p_capability = 'sc.manage'
          then p_role = 'property_manager'

        when p_capability = 'leases.write'
          then p_role = 'property_manager'

        when p_capability = 'bi.read'
          then p_role in ('facility_manager', 'property_manager',
                     'finance_approver', 'property_owner')
        when p_capability = 'people.deactivate' then false
        when p_capability = 'tickets.triage_unassigned' then false

        else false
  end;
$function$;

CREATE OR REPLACE FUNCTION public.b7_baseline()
 RETURNS TABLE(role user_role, capability text, granted boolean)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select r.role, c.key, b7_grants(r.role, c.key)
    from (select unnest(array['tenant','vendor','fm_ops_staff','facility_manager',
                              'property_manager','finance_approver','property_owner',
                              'admin','viewer','executive','regional_manager','operations_executive',
                              'payment_audit_approver','payment_approver']::user_role[]) as role) r
   cross join capabilities c
   where not c.locked;
$function$;

CREATE OR REPLACE FUNCTION public.seed_b7_permissions(p_org_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  cap record;
  r user_role;
begin
  for cap in select key from capabilities where not locked loop
    foreach r in array array['tenant','vendor','fm_ops_staff','facility_manager',
                             'property_manager',
                             'finance_approver','property_owner','admin','viewer',
                             'executive','regional_manager','operations_executive',
                             'payment_audit_approver','payment_approver']::user_role[]
    loop
      insert into role_permissions (org_id, role, capability, granted)
      values (p_org_id, r, cap.key, b7_grants(r, cap.key))
      on conflict (org_id, role, capability) do nothing;
    end loop;
  end loop;
end;
$function$;

-- Every live org gets the new role's rows at baseline. `on conflict do
-- nothing`, so no deviation an operator has recorded is touched.
do $$
declare o record;
begin
  for o in select id from orgs loop
    perform seed_b7_permissions(o.id);
  end loop;
end $$;

-- ── 5. The chain ────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.payment_chain_stages(p_org_id uuid)
 RETURNS TABLE(stage_order smallint, required_roles user_role[], tier_resolved boolean, label text)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  select v.stage_order, v.required_roles, v.tier_resolved, v.label
    from (
      select org_payment_chain(p_org_id) as shape,
             coalesce(
               (select o.approval_tiers_enabled from orgs o where o.id = p_org_id),
               false
             ) as tiers
    ) c
    cross join lateral (values
      (1::smallint,
       case c.shape when 'oea'          then array['payment_audit_approver']::user_role[]
                    when 'single_stage' then array['payment_approver','executive']::user_role[]
                    else fm_roles() end,
       case c.shape when 'single_stage' then c.tiers else false end,
       case c.shape when 'oea'          then 'Audit review and recommendation'
                    when 'single_stage' then 'Payment approval'
                    else 'Work completed and signed off' end::text),
      (2::smallint,
       case c.shape when 'oea' then array['executive', 'operations_executive']::user_role[]
                    else array['payment_audit_approver']::user_role[] end,
       false,
       case c.shape when 'oea' then 'Managing Partner approval'
                    else 'Audit verification' end::text),
      (3::smallint,
       case c.shape when 'oea' then array['payment_approver']::user_role[]
                    else array['payment_approver','executive']::user_role[] end,
       c.tiers,
       case c.shape when 'oea' then 'Payment approval'
                    else 'Final approval' end::text)
    ) as v(stage_order, required_roles, tier_resolved, label)
   where c.shape <> 'single_stage' or v.stage_order = 1;
$function$;

CREATE OR REPLACE FUNCTION public.enforce_approval_rules()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_stage    record;
  v_actor    users%rowtype;
  v_payable  record;
  v_missing  int;
  v_rejected int;
  v_self     int;
  v_required smallint;
  v_tier     smallint;
  v_limit    numeric;
begin
  -- The actor's role and tier come from THEIR ROW, never from the insert. A
  -- caller who could name their own role would be naming their own authority.
  select * into v_actor from users where id = new.actor_id;
  if v_actor.id is null then
    raise exception 'the person approving this payment could not be found';
  end if;
  if v_actor.deactivated_at is not null then
    raise exception 'that account is deactivated and cannot approve payments';
  end if;
  new.actor_role := v_actor.role;
  new.actor_tier := v_actor.approval_tier;

  -- The amount and the org come from the PAYABLE, never from the insert. This
  -- is the line that defeats "approve a small amount, disburse a large one" —
  -- and, since 0211, the line that decides WHICH LADDER is being climbed.
  select * into v_payable from resolve_payable(new.payable_type, new.payable_id);
  if v_payable.org_id is null then
    raise exception 'that payable could not be found';
  end if;
  new.org_id := v_payable.org_id;
  new.amount := v_payable.amount;

  select * into v_stage
    from payment_chain_stages(new.org_id) s
   where s.stage_order = new.stage_order;
  if not found then
    raise exception 'there is no approval stage %', new.stage_order;
  end if;

  -- A new decision is always a live one.
  new.superseded_at := null;

  -- Retiring the previous round happens here, in the trigger, and not in
  -- `record_payment_approval` — every rule this table enforces lives in this
  -- function precisely so that no write path can miss one.
  update payment_approvals a
     set superseded_at = now()
   where a.payable_type  = new.payable_type
     and a.payable_id    = new.payable_id
     and a.decision      = 'approved'
     and a.amount        <> new.amount
     and a.superseded_at is null;

  -- (a) 0250b, widened by 0295. Every outstanding return at this stage OR
  -- ABOVE it is answered by this decision: a return at stage N goes to the desk
  -- at N-1, so it is that desk — not stage N — that answers it.
  update payment_approvals a
     set superseded_at = now()
   where a.payable_type  = new.payable_type
     and a.payable_id    = new.payable_id
     and a.stage_order   >= new.stage_order
     and a.decision      = 'returned'
     and a.superseded_at is null;

  if v_actor.org_id is distinct from new.org_id then
    raise exception 'a payment can only be approved by someone in the organisation it belongs to';
  end if;

  if not (v_actor.role = any (v_stage.required_roles)) then
    raise exception '% is actioned by %, and you are %',
      v_stage.label, array_to_string(v_stage.required_roles, ' or '), v_actor.role;
  end if;

  -- 0307. The Executive holds the Managing Partner's stage NARROWER than the
  -- MP does: requisitions only, at or below the operator-set limit, and never
  -- one they raised. Every decision — approve, return, refuse — is held to it,
  -- because a refusal is as much an exercise of the stage as an approval.
  -- `new.amount` is the payable's own figure (set above), never the caller's.
  if v_actor.role = 'operations_executive' then
    if new.payable_type <> 'ops_requisition' then
      raise exception 'an Executive acts on FM, PM and operations requisitions only — a % is the Managing Partner''s',
        replace(new.payable_type, '_', ' ');
    end if;
    v_limit := ops_executive_requisition_limit(new.org_id);
    if v_limit is null or new.amount > v_limit then
      raise exception '₦% is above the Executive''s limit of ₦% — the Managing Partner decides it',
        trim(to_char(new.amount, 'FM999,999,999,990.00')),
        trim(to_char(coalesce(v_limit, 0), 'FM999,999,999,990.00'));
    end if;
    if exists (select 1 from ops_requisitions q
                where q.id = new.payable_id and q.raised_by = new.actor_id) then
      raise exception 'you raised this requisition — it needs a second pair of hands';
    end if;
  end if;

  -- Every earlier stage approved, LIVE, and at the amount now being approved.
  -- No skipping, and no standing on a signature given for a different figure.
  --
  -- (c) 0270. Skipped for the row that CARRIES a revised figure, and for
  -- nothing else. That row is the act which makes the earlier signatures stale
  -- — the supersede clause above has just retired them — so demanding they be
  -- fresh first would be demanding the revision happen after its own
  -- consequence. An ordinary approval, return or refusal is checked exactly as
  -- it was.
  if new.approved_amount is null then
    select count(*) into v_missing
      from payment_chain_stages(new.org_id) s
     where s.stage_order < new.stage_order
       and not exists (
         select 1 from payment_approvals a
          where a.payable_type  = new.payable_type
            and a.payable_id    = new.payable_id
            and a.stage_order   = s.stage_order
            and a.decision      = 'approved'
            and a.amount        = new.amount
            and a.superseded_at is null
       );
    if v_missing > 0 then
      raise exception 'this payment has % earlier stage(s) still to be approved at %',
        v_missing, trim(to_char(new.amount, 'FM999,999,999,990.00'));
    end if;
  end if;

  -- Terminal, and not amount-scoped.
  select count(*) into v_rejected
    from payment_approvals a
   where a.payable_type  = new.payable_type
     and a.payable_id    = new.payable_id
     and a.decision      = 'rejected'
     and a.superseded_at is null;
  if v_rejected > 0 then
    raise exception 'this payment was already rejected and cannot be actioned further';
  end if;

  -- Separation of duties: one human, one stage. Holding two of the roles does
  -- not make you two people. (b) 0250b: a returned decision is excluded — see
  -- that migration's header.
  select count(*) into v_self
    from payment_approvals a
   where a.payable_type  = new.payable_type
     and a.payable_id    = new.payable_id
     and a.actor_id      = new.actor_id
     and a.decision      <> 'returned'
     and a.superseded_at is null;
  if v_self > 0 then
    raise exception 'you already actioned an earlier stage on this payment — it needs a second pair of hands';
  end if;

  if v_stage.tier_resolved and new.decision = 'approved' then
    v_required := resolve_required_tier(new.org_id, new.amount);
    new.required_tier := v_required;
    v_tier := effective_approval_tier(v_actor.role, v_actor.approval_tier);

    if v_tier is null then
      raise exception 'you do not carry an approval limit and cannot give final approval';
    end if;

    -- `>=`, never `=`. A higher tier may always approve a lower amount;
    -- otherwise ₦50,000 would be unapprovable whenever only the MD is in.
    if v_tier < v_required then
      raise exception
        '₦% needs a tier % approver or above, and you are tier %',
        trim(to_char(new.amount, 'FM999,999,999,990.00')), v_required, v_tier;
    end if;
  else
    new.required_tier := null;
  end if;

  return new;
end;
$function$;

CREATE OR REPLACE FUNCTION public.record_payment_approval(p_payable_type text, p_payable_id uuid, p_stage smallint, p_decision text, p_reason text DEFAULT NULL::text, p_amount numeric DEFAULT NULL::numeric)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_id uuid;
  v_actor uuid := auth.uid();
  v_payable record;
  v_decision text := p_decision;
  v_reason text := nullif(trim(coalesce(p_reason, '')), '');
  v_limit numeric;
begin
  -- 0195. Null-safe by construction: current_user_is_active() returns a
  -- boolean from exists(), never NULL, and the auth.uid() test keeps the
  -- service role (scheduled jobs, webhooks) passing straight through.
  if auth.uid() is not null and not current_user_is_active() then
    raise exception 'this account has been deactivated';
  end if;

  if v_actor is null then
    raise exception 'your session expired — sign in again';
  end if;
  if p_decision not in ('approved', 'rejected', 'returned') then
    raise exception 'a stage is approved, sent back for correction, or refused';
  end if;

  -- 0307. Checked against the figure BEFORE any revision below. The trigger
  -- holds the Executive to their limit too, but it sees the payable after a
  -- revision has been written — so without this, an Executive could revise a
  -- requisition above their limit down into it and so bring it within their
  -- own authority. Lowering a figure is still a decision on it, and an
  -- above-limit requisition is the Managing Partner's to decide.
  if current_user_role() = 'operations_executive' then
    if p_payable_type <> 'ops_requisition' then
      raise exception 'an Executive acts on FM, PM and operations requisitions only — a % is the Managing Partner''s',
        replace(p_payable_type, '_', ' ');
    end if;
    select * into v_payable from resolve_payable(p_payable_type, p_payable_id);
    if v_payable.org_id is null then
      raise exception 'that payable could not be found';
    end if;
    v_limit := ops_executive_requisition_limit(v_payable.org_id);
    if v_limit is null or v_payable.amount > v_limit then
      raise exception '₦% is above the Executive''s limit of ₦% — the Managing Partner decides it',
        trim(to_char(v_payable.amount, 'FM999,999,999,990.00')),
        trim(to_char(coalesce(v_limit, 0), 'FM999,999,999,990.00'));
    end if;
  end if;

  -- ── 0270. A revised figure ──────────────────────────────────────────────
  if p_amount is not null then
    select * into v_payable from resolve_payable(p_payable_type, p_payable_id);
    if v_payable.org_id is null then
      raise exception 'that payable could not be found';
    end if;

    if p_amount <= 0 then
      raise exception 'an approved amount has to be more than nothing';
    end if;

    if p_amount <> v_payable.amount then
      -- A refusal does not carry a figure: there is nothing left to authorise.
      if p_decision = 'rejected' then
        raise exception 'a refusal does not name an amount — reject it, or send it back at the figure you will approve';
      end if;

      -- The reason is REQUIRED here even on an approval, because the person
      -- receiving it has to know why the number moved. Decision 30 already
      -- demands one for a return; this is the same argument for the same act.
      if v_reason is null or length(v_reason) < 10 then
        raise exception 'say why the amount changed, in at least 10 characters — the desks below have to re-approve it';
      end if;

      if p_payable_type = 'vendor_payment' then
        update payments
           set amount = p_amount,
               requested_amount = coalesce(requested_amount, amount)
         where id = p_payable_id;
      elsif p_payable_type = 'ops_requisition' then
        update ops_requisitions
           set total_amount = p_amount,
               requested_amount = coalesce(requested_amount, total_amount)
         where id = p_payable_id;
      else
        raise exception 'unknown payable type %', p_payable_type;
      end if;

      -- ⚠️ Recorded as a RETURN whatever the caller asked for. An `approved`
      -- row here would have to stand on signatures that this very statement
      -- just voided — `enforce_approval_rules` would refuse it, and it would be
      -- wrong if it did not. The ladder re-climbs at the new figure.
      v_decision := 'returned';
      v_reason := v_reason || ' [amount revised to ' ||
                  trim(to_char(p_amount, 'FM999,999,999,990.00')) || ']';
    end if;
  end if;

  if v_decision in ('rejected', 'returned')
     and (v_reason is null or length(v_reason) < 10) then
    raise exception 'tell them why in at least 10 characters — a refusal nobody can act on is a dead end';
  end if;

  insert into payment_approvals (
    org_id, payable_type, payable_id, stage_order,
    actor_id, actor_role, actor_tier, amount, decision, reason, approved_amount
  ) values (
    -- org, role, tier and amount are all overwritten by the trigger from the
    -- authoritative records. These placeholders satisfy NOT NULL and nothing else.
    '00000000-0000-0000-0000-000000000000', p_payable_type, p_payable_id, p_stage,
    v_actor, 'viewer', null, 1, v_decision, v_reason,
    case when p_amount is not null then p_amount else null end
  )
  returning id into v_id;

  return v_id;
end;
$function$;

-- Seeing what they approve. Requisitions in their organisation, and the
-- approval trail on requisitions only — not on vendor payments or landlord
-- payouts, which are not theirs. Lines and the invoice attachment follow
-- `ops_requisitions` visibility already (0170, 0217).
drop policy if exists ops_requisitions_select on ops_requisitions;
create policy ops_requisitions_select on ops_requisitions
  for select to authenticated
  using (
    (org_id = current_user_org_id())
    and ((current_user_role() = any (oversight_roles()))
         or (current_user_role() = any (payment_chain_roles()))
         or (current_user_role() = any (fm_roles()))
         or (current_user_role() = 'operations_executive'::user_role)
         or (raised_by = auth.uid()))
  );

drop policy if exists payment_approvals_select on payment_approvals;
create policy payment_approvals_select on payment_approvals
  for select to authenticated
  using (
    (org_id = current_user_org_id())
    and ((current_user_role() = any (oversight_roles()))
         or (current_user_role() = any (fm_roles()))
         or (current_user_role() = any (array['payment_approver'::user_role, 'payment_audit_approver'::user_role]))
         or ((current_user_role() = 'operations_executive'::user_role)
             and (payable_type = 'ops_requisition'))
         or (actor_id = auth.uid()))
  );

-- ── 6. Assertions ───────────────────────────────────────────────────────────
do $$
declare
  v_bad text;
  o record;
  v_last user_role[];
begin
  if not (role_rank('regional_manager') < role_rank('operations_executive')
          and role_rank('operations_executive') < role_rank('executive')) then
    raise exception '0307: the Executive must rank above the regional manager and below the MP';
  end if;

  if invitable_roles('operations_executive')
     is distinct from array['facility_manager', 'fm_ops_staff', 'property_manager']::user_role[] then
    raise exception '0307: the Executive invites FM/PM/Ops only, got %', invitable_roles('operations_executive');
  end if;

  if 'operations_executive' = any (invitable_roles('regional_manager'))
     or 'operations_executive' = any (invitable_roles('facility_manager'))
     or 'operations_executive' = any (invitable_roles('property_manager'))
     or 'operations_executive' = any (invitable_roles('executive')) then
    raise exception '0307: only an administrator may appoint an Executive';
  end if;

  if 'operations_executive' = any (fm_roles())
     or 'operations_executive' = any (oversight_roles())
     or 'operations_executive' = any (payment_chain_roles())
     or 'operations_executive' = any (request_read_all_roles()) then
    raise exception '0307: the Executive was placed in a resolver it must stay out of';
  end if;

  if effective_approval_tier('operations_executive', 3::smallint) is not null then
    raise exception '0307: the Executive must hold no approval tier';
  end if;

  select string_agg(c.key, ', ' order by c.key) into v_bad
    from capabilities c
   where not c.locked
     and b7_grants('operations_executive', c.key)
         is distinct from (c.key in ('tickets.read_all', 'tickets.triage_unassigned',
                                     'tickets.assign', 'tickets.close',
                                     'properties.read_all', 'assets.read', 'vendors.read',
                                     'bi.read', 'people.invite'));
  if v_bad is not null then
    raise exception '0307: Executive baseline differs from the stated set at: %', v_bad;
  end if;

  if not exists (select 1 from b7_baseline() where role = 'operations_executive') then
    raise exception '0307: b7_baseline does not cover the Executive';
  end if;

  -- On every org: never on the final stage (that is the payment approver's
  -- and decides the disbursement gate); on stage 2 exactly where the shape is
  -- OEA's.
  for o in select id, org_payment_chain(id) as shape from orgs loop
    select s.required_roles into v_last
      from payment_chain_stages(o.id) s order by s.stage_order desc limit 1;
    if 'operations_executive' = any (v_last) then
      raise exception '0307: the Executive reached the final stage on org %', o.id;
    end if;
    if o.shape = 'oea' and not exists (
         select 1 from payment_chain_stages(o.id) s
          where s.stage_order = 2 and 'operations_executive' = any (s.required_roles)
            and 'executive' = any (s.required_roles)) then
      raise exception '0307: OEA stage 2 must admit the MP and the Executive on org %', o.id;
    end if;
    if o.shape <> 'oea' and exists (
         select 1 from payment_chain_stages(o.id) s
          where 'operations_executive' = any (s.required_roles)) then
      raise exception '0307: the Executive reached a non-OEA chain on org %', o.id;
    end if;
  end loop;

  if exists (select 1 from users u join orgs g on g.id = u.org_id
              where u.role = 'operations_executive' and g.delivery_brand <> 'OEA')
     or exists (select 1 from invitations i join orgs g on g.id = i.org_id
                 where i.role = 'operations_executive' and i.status = 'pending'
                   and g.delivery_brand <> 'OEA') then
    raise exception '0307: an Executive exists outside OEA';
  end if;
end $$;
