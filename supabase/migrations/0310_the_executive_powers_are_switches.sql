-- The Executive's powers are switches in the permission matrix
-- (requested 3 Oct 2026).
--
-- Almost everything the Executive does was already a capability in the matrix
-- after 0309 — dispatch, assets, vendors, service charges, leases, invites.
-- Three powers were hard-wired instead, so the operator could not turn them
-- off for an organisation. Each becomes a capability here, enforced in the
-- database where the power is exercised, with a baseline that is exactly
-- today's behaviour — so applying this file changes nothing for anyone:
--
--   requisitions.raise                 raise an ops requisition. Every role that
--                                      could raise one keeps it; now switchable
--                                      per role, the Executive included.
--   requisitions.approve_within_limit  the Executive's stage-2 approval up to the
--                                      operator-set limit. Executive only.
--   operations.org_wide                the Executive reaching every property in
--                                      the organisation. Off, they reach what
--                                      they are assigned, like an FM.
--
-- Unlocked (operator-toggleable). The MONEY controls stay locked as before:
-- release, ledger, bank and payment.approve remain fixed. The Executive's
-- approval is a narrow, operator-limited stage-2 signature that still needs
-- the audit review before it and the payment approver after it, so letting the
-- operator switch it off only ever removes authority.
--
-- Rebuilt from pg_get_functiondef of a database holding 0001–0309.

set local lock_timeout = '5s';

insert into capabilities (key, module, label, description, locked, sort_order) values
  ('requisitions.raise', 'Requisitions', 'Raise requisitions',
   'Raise an FM/PM/operations requisition — money requested for a job, which then climbs the approval chain. Never approves it.',
   false, 55),
  ('requisitions.approve_within_limit', 'Requisitions', 'Approve requisitions within the Executive limit',
   'OEA Executive only. Approve an FM/PM/Ops requisition at the Managing Partner''s stage, up to the limit OE Group sets — never one they raised. Above the limit the Managing Partner decides. Has no effect for any other role.',
   false, 56),
  ('operations.org_wide', 'Portfolio', 'Reach every property in the organisation',
   'OEA Executive only. Act on every property, not only those they are assigned to. Off, they work like a facilities manager on their assigned properties. Has no effect for any other role.',
   false, 53)
on conflict (key) do nothing;

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

        -- 0310. The Executive's own powers, as switches. Placed above the admin
        -- arm so an administrator is not shown holding two Executive-only
        -- powers that mean nothing for their role.
        when p_capability = 'requisitions.approve_within_limit' then p_role = 'operations_executive'
        when p_capability = 'operations.org_wide' then p_role = 'operations_executive'
        when p_capability = 'requisitions.raise' then p_role in (
          'fm_ops_staff', 'facility_manager', 'property_manager', 'regional_manager',
          'operations_executive', 'admin'
        )

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
          'facility_manager', 'property_manager', 'regional_manager', 'finance_approver',
          'operations_executive'
        )

        -- 0307. The OEA Executive: org-wide sight of operations, dispatch and
        -- closure, and onboarding. Nothing financial beyond the requisitions
        -- the chain hands them (which is not a capability — decision 7), no
        -- structure (hierarchy, properties, leases), no vendor decisions, no
        -- export. Placed after `payments.record_offline`, which they do not
        -- hold: recording a claim is a confirmation desk's conflict.
        -- 0309: everything a facilities/properties/regional manager holds,
        -- organisation-wide, plus the org-wide reads 0307 gave. Bounded by
        -- `current_user_property_ids()`, which for the Executive is every
        -- property in their organisation.
        when p_role = 'operations_executive' then p_capability in (
          'tickets.read_all', 'tickets.triage_unassigned',
          'tickets.assign', 'tickets.close',
          'properties.read_all', 'assets.read', 'vendors.read',
          'bi.read', 'people.invite',
          'assets.write', 'assets.import',
          'vendors.write', 'vendors.evaluate', 'vendors.recommend', 'vendors.approve',
          'properties.write', 'units.assign_occupant', 'hierarchy.write',
          'applications.recommend', 'applications.approve',
          'sc.manage', 'leases.write'
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

-- Every live org gets the three new rows at baseline; nothing already set is
-- touched (`on conflict do nothing`).
do $$
declare o record;
begin
  for o in select id from orgs loop
    perform seed_b7_permissions(o.id);
  end loop;
end $$;

CREATE OR REPLACE FUNCTION public.current_user_property_ids()
 RETURNS SETOF uuid
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  -- Directly assigned properties, exactly as before.
  select s.property_id
    from property_stakeholders s
   where s.user_id = auth.uid()
     and s.property_id is not null
     and exists (select 1 from users u where u.id = auth.uid() and u.deactivated_at is null and u.sign_in_locked_at is null)

  union

  -- Everything beneath a node they are assigned to, at any depth.
  --
  -- The org comparison is between the node rows and is therefore redundant with
  -- the composite foreign keys above. It is kept because this is the function
  -- that decides what a regionally-assigned manager can reach, and a redundant
  -- check costs one comparison while its absence would cost a cross-brand leak.
  select p.id
    from property_stakeholders s
    join org_nodes anc on anc.id = s.node_id and anc.org_id = s.org_id
    join org_nodes n   on n.path like anc.path || '%' and n.org_id = anc.org_id
    join properties p  on p.site_node_id = n.id and p.org_id = anc.org_id
   where s.user_id = auth.uid()
     and s.node_id is not null
     and anc.deleted_at is null
     and n.deleted_at is null
     and p.deleted_at is null
     and exists (select 1 from users u where u.id = auth.uid() and u.deactivated_at is null and u.sign_in_locked_at is null)

  union

  -- 0309. The OEA Executive's place is the whole organisation: every live
  -- property in it, with no assignment needed. This is the one line that turns
  -- every "an FM, on a property they hold" rule into "the Executive, anywhere
  -- in their organisation" — the same way a node assignment does it for a
  -- regional manager, one level up.
  select p.id
    from properties p
    join users u on u.id = auth.uid()
   where u.role = 'operations_executive'
     and p.org_id = u.org_id
     -- 0310. Switchable per organisation by the operator. Off, the Executive
     -- reaches only properties they are assigned to, like any FM.
     and exists (select 1 from role_permissions rp
                  where rp.org_id = u.org_id
                    and rp.role = 'operations_executive'
                    and rp.capability = 'operations.org_wide'
                    and rp.granted)
     and p.deleted_at is null
     and u.deactivated_at is null
     and u.sign_in_locked_at is null;
$function$;

CREATE OR REPLACE FUNCTION public.ops_executive_requisition_limit(p_org_id uuid)
 RETURNS numeric
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select case
           when auth.uid() is not null
            and p_org_id is distinct from current_user_org_id() then null
           -- 0310. Null when the operator has switched the Executive's approval
           -- off for this organisation: every caller already reads null as
           -- "the Executive may not act here".
           when not exists (select 1 from role_permissions rp
                             where rp.org_id = p_org_id
                               and rp.role = 'operations_executive'
                               and rp.capability = 'requisitions.approve_within_limit'
                               and rp.granted) then null
           else coalesce(
             (select s.ops_executive_requisition_limit
                from payment_settings s where s.org_id = p_org_id),
             500000)
         end;
$function$;

CREATE OR REPLACE FUNCTION public.raise_ops_requisition(p_reference text, p_lines jsonb, p_ticket_id uuid DEFAULT NULL::uuid, p_attachment_path text DEFAULT NULL::text, p_description text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_uid uuid := auth.uid();
  v_role user_role;
  v_org  uuid;
  v_req_id uuid;
  v_path text := nullif(trim(coalesce(p_attachment_path, '')), '');
  v_line jsonb;
  v_order smallint := 0;
  v_desc text;
  v_amount numeric;
  v_vendor uuid;
  v_count int;
begin
  -- 0195. Null-safe by construction: current_user_is_active() returns a
  -- boolean from exists(), never NULL, and the auth.uid() test keeps the
  -- service role (scheduled jobs, webhooks) passing straight through.
  if auth.uid() is not null and not current_user_is_active() then
    raise exception 'this account has been deactivated';
  end if;

  if v_uid is null then
    raise exception 'your session expired — sign in again';
  end if;

  select role, org_id into v_role, v_org from users where id = v_uid;

  -- Raised by the people who do the work and by dispatch authority above
  -- them — the same set 0078a's fm_roles() names, plus the ops staff member
  -- themselves and an administrator.
  if v_role not in ('fm_ops_staff', 'facility_manager', 'property_manager', 'regional_manager', 'operations_executive', 'admin') then
    raise exception 'only operational staff may raise a requisition';
  end if;
  -- 0310. Also a switch in the permission matrix, on by default for every
  -- role above.
  if not has_permission('requisitions.raise') then
    raise exception 'raising requisitions is switched off for your role in this organisation';
  end if;

  if length(trim(coalesce(p_reference, ''))) < 3 then
    raise exception 'give the requisition a reference of your own so you can reconcile it';
  end if;

  if jsonb_typeof(p_lines) is distinct from 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception 'a requisition needs at least one cost line';
  end if;
  if jsonb_array_length(p_lines) > 50 then
    raise exception 'a single requisition may hold at most 50 lines — split this into more than one';
  end if;

  if p_ticket_id is not null then
    if not exists (select 1 from tickets where id = p_ticket_id and org_id = v_org) then
      raise exception 'that job could not be found in your organisation';
    end if;
  end if;

  if v_path is not null and v_path !~ ('^' || v_org::text || '/') then
    raise exception 'that attachment does not belong to your organisation';
  end if;

  insert into ops_requisitions (org_id, ticket_id, raised_by, reference, invoice_attachment_path, description)
  values (v_org, p_ticket_id, v_uid, trim(p_reference), v_path,
          nullif(trim(coalesce(p_description, '')), ''))
  returning id into v_req_id;

  for v_line in select * from jsonb_array_elements(p_lines) loop
    v_order := v_order + 1;
    v_desc := trim(coalesce(v_line->>'description', ''));
    v_amount := nullif(v_line->>'amount', '')::numeric;
    v_vendor := nullif(v_line->>'vendorId', '')::uuid;

    if length(v_desc) < 3 then
      raise exception 'line %: describe the cost in at least 3 characters', v_order;
    end if;
    if v_amount is null or v_amount <= 0 then
      raise exception 'line %: enter a positive amount', v_order;
    end if;
    if v_vendor is not null and not exists (
      select 1 from vendors where id = v_vendor and org_id = v_org
    ) then
      raise exception 'line %: that vendor is not registered in your organisation', v_order;
    end if;

    insert into ops_requisition_lines (requisition_id, org_id, line_order, description, amount, vendor_id)
    values (v_req_id, v_org, v_order, v_desc, v_amount, v_vendor);
  end loop;

  -- Notified the same way a vendor invoice tells finance -- the chain's stage
  -- 1 is a facility/regional manager, and they are who is actually next.
  perform notify_role(
    v_org,
    array['facility_manager', 'property_manager', 'regional_manager', 'operations_executive']::user_role[],
    'payment',
    'A requisition was raised',
    trim(p_reference) || ' awaits your sign-off',
    '/dashboard/approvals/requisitions/' || v_req_id::text
  );

  return v_req_id;
end;
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
    if v_limit is null then
      raise exception 'requisition approval is switched off for the Executive in this organisation — the Managing Partner decides it';
    end if;
    if new.amount > v_limit then
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
    if v_limit is null then
      raise exception 'requisition approval is switched off for the Executive in this organisation — the Managing Partner decides it';
    end if;
    if v_payable.amount > v_limit then
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

do $$
declare v_bad text;
begin
  if (select count(*) from capabilities
       where key in ('requisitions.raise', 'requisitions.approve_within_limit', 'operations.org_wide')
         and not locked) <> 3 then
    raise exception '0310: the three Executive switches must exist and be unlocked';
  end if;

  select string_agg(r::text, ', ') into v_bad
    from unnest(enum_range(null::user_role)) r
   where b7_grants(r, 'requisitions.raise')
         is distinct from (r in ('fm_ops_staff', 'facility_manager', 'property_manager',
                                 'regional_manager', 'operations_executive', 'admin'));
  if v_bad is not null then
    raise exception '0310: requisitions.raise baseline must equal who could raise before: %', v_bad;
  end if;

  if exists (select 1 from unnest(enum_range(null::user_role)) r
              where r <> 'operations_executive'
                and (b7_grants(r, 'requisitions.approve_within_limit')
                     or b7_grants(r, 'operations.org_wide'))) then
    raise exception '0310: the Executive-only switches must be on for the Executive alone';
  end if;

  -- Every org that already had role rows now has the three new ones.
  if exists (select 1 from orgs o
              where exists (select 1 from role_permissions where org_id = o.id)
                and (select count(*) from role_permissions
                      where org_id = o.id
                        and capability in ('requisitions.raise', 'requisitions.approve_within_limit',
                                           'operations.org_wide')) = 0) then
    raise exception '0310: an organisation was left without the new rows';
  end if;
end $$;
