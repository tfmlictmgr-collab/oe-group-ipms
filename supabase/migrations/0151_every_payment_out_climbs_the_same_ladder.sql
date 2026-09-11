-- One payment out of the door, three pairs of hands before it, and a fourth to
-- send it. For BOTH kinds of outbound money, not just the one that had a gate.
--
-- ⚠️ THE GAP THIS CLOSES. There are exactly two paths by which money leaves
-- this system, and they were governed very differently:
--
--   1. `create_vendor_remittance` — the full B4 gate. Verification, KPI,
--      approval, threshold escalation, and since 0142 a maker-checker on the
--      executor. Strong.
--   2. `create_rent_remittance` — a landlord payout. `assert_may_disburse` and
--      NOTHING ELSE. No approver, no threshold, no second pair of hands. One
--      finance approver, acting alone, could move a landlord's entire collected
--      rent for a property. It is custodial client money (OEA decision 1) and
--      it had strictly weaker controls than a vendor's invoice for a light
--      fitting.
--
-- That asymmetry was not a decision anyone took; it is what happens when a
-- second payout path is added beside the first and the gate is not carried
-- over. Both now climb the same ladder.
--
-- ── The shape ─────────────────────────────────────────────────────────────
--   stage 1  FM / PM (fm_roles)        the job or the period is signed off
--   stage 2  payment_audit_approver    the invoice is checked against evidence
--   stage 3  payment_approver, tiered  final approval, bounded by AMOUNT
--   stage 4  finance_approver          disbursement only — never an approval
--
-- ── Four things this does deliberately differently from the reference ─────
--
-- 1. **Naira, not kobo.** Every money column in this schema is
--    `numeric(14,2)`. A second unit at a financial boundary is how a ×100 error
--    gets written; the ladder uses the same unit as the amounts it compares.
--
-- 2. **The stages are HARDWIRED, not config rows.** Decision 7 lists payment
--    approval among the non-delegable controls that "stay hardwired and never
--    appear as toggles: these are what an auditor checks; they are not
--    preferences." A per-org table of stages is exactly such a toggle. The
--    AMOUNTS are configurable — and, since 0149, only by the operator.
--
-- 3. **The ladder lives in `payment_settings`, not a new table.** That table
--    already holds `approval_threshold_amount`, already governs the
--    admin/executive escalation, and is already operator-governed and audited.
--    A parallel `approval_thresholds` table would be a second resolver for the
--    same question, which decision 8 forbids in as many words. Tier 2's upper
--    bound IS the existing threshold — they were always the same number.
--
-- 4. **The amount is resolved by the TRIGGER, not merely by the caller.** The
--    attack on a tiered ladder is a client-supplied amount that selects a lower
--    tier. Refusing a wrong amount still trusts the caller to send one; this
--    OVERWRITES it from the payable record, so there is no value a caller can
--    send that changes which tier is required.

-- ── The tier a person carries ─────────────────────────────────────────────

alter table users add column if not exists approval_tier smallint;

alter table users drop constraint if exists users_approval_tier_check;
alter table users add constraint users_approval_tier_check check (
  (role = 'payment_approver' and approval_tier in (1, 2, 3))
  or (role <> 'payment_approver' and approval_tier is null)
);

comment on column users.approval_tier is
  'payment_approver only. The highest band this person may approve. `executive` and `admin` also action stage 3 and get their tier from effective_approval_tier() instead — an office, not a column (0151).';

-- ── The ladder, on the table that already held its top rung ───────────────

alter table payment_settings add column if not exists tier1_threshold_amount numeric(14,2);
update payment_settings set tier1_threshold_amount = 100000 where tier1_threshold_amount is null;
alter table payment_settings alter column tier1_threshold_amount set default 100000;

alter table payment_settings drop constraint if exists payment_settings_tier_ladder_ascends;
alter table payment_settings add constraint payment_settings_tier_ladder_ascends check (
  tier1_threshold_amount is null
  or approval_threshold_amount is null
  or tier1_threshold_amount < approval_threshold_amount
);

comment on column payment_settings.tier1_threshold_amount is
  'Inclusive upper bound of tier 1, in naira. Tier 2''s bound is approval_threshold_amount — the SAME number that governs the admin/executive escalation, because they were always the same question. Above it is tier 3. Operator-governed (0149/0151).';

-- The 0149 guard has to learn the new column, or the ladder would be
-- operator-governed at the top and admin-writable at the bottom — which is the
-- same defect 0149 was written to close, one rung down.
create or replace function enforce_payment_gate_config_authority()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_changed text[] := '{}';
begin
  if auth.uid() is null then
    return new;
  end if;

  if tg_op = 'INSERT' then
    if new.approval_threshold_amount is distinct from 1000000
       or new.min_performance_score is distinct from 70
       or new.tier1_threshold_amount is distinct from 100000 then
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
$$;

-- The operator sets the whole ladder in one call, so the two rungs cannot be
-- left crossed between two separate writes.
drop function if exists operator_set_payment_gate(uuid, numeric, numeric, text);

create function operator_set_payment_gate(
  p_org_id    uuid,
  p_threshold numeric,
  p_min_score numeric,
  p_reason    text,
  p_tier1     numeric default null
)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_operator_org uuid;
  v_old payment_settings%rowtype;
  v_tier1 numeric;
begin
  if not caller_is_operator_admin() then
    raise exception 'only an OE Group operator administrator may set an approval limit';
  end if;
  if length(trim(coalesce(p_reason, ''))) < 10 then
    raise exception 'say why this limit is changing, in at least 10 characters — it is the record an auditor reads';
  end if;
  if p_threshold is null or p_threshold <= 0 then
    raise exception 'an approval limit must be greater than zero';
  end if;
  if p_min_score is null or p_min_score < 0 or p_min_score > 100 then
    raise exception 'the performance gate must be a score between 0 and 100';
  end if;

  select * into v_old from payment_settings where org_id = p_org_id;
  v_tier1 := coalesce(p_tier1, v_old.tier1_threshold_amount, 100000);

  if v_tier1 <= 0 then
    raise exception 'the tier 1 limit must be greater than zero';
  end if;
  if v_tier1 >= p_threshold then
    raise exception
      'the tier 1 limit (%) must sit below the approval limit (%) — a ladder whose rungs cross has no middle band',
      v_tier1, p_threshold;
  end if;

  select id into v_operator_org from orgs where id = current_user_org_id();

  insert into payment_settings (org_id, approval_threshold_amount, min_performance_score, tier1_threshold_amount, updated_at)
  values (p_org_id, p_threshold, p_min_score, v_tier1, now())
  on conflict (org_id) do update
    set approval_threshold_amount = excluded.approval_threshold_amount,
        min_performance_score     = excluded.min_performance_score,
        tier1_threshold_amount    = excluded.tier1_threshold_amount,
        updated_at                = now();

  insert into operator_actions (actor_id, operator_org, target_org, action, reason, metadata)
  values (
    auth.uid(), v_operator_org, p_org_id, 'set_payment_gate', trim(p_reason),
    jsonb_build_object(
      'approval_threshold_before', v_old.approval_threshold_amount,
      'approval_threshold_after',  p_threshold,
      'tier1_before',              v_old.tier1_threshold_amount,
      'tier1_after',               v_tier1,
      'min_score_before',          v_old.min_performance_score,
      'min_score_after',           p_min_score
    )
  );
end;
$$;

revoke all on function operator_set_payment_gate(uuid, numeric, numeric, text, numeric) from public, anon;
grant execute on function operator_set_payment_gate(uuid, numeric, numeric, text, numeric) to authenticated, service_role;

comment on function operator_set_payment_gate is
  'The one audited path by which the approval ladder and KPI gate change. Operator administrators only, requires a stated reason, refuses a ladder whose rungs cross, and records before/after where the affected organisation can read it (0149, extended 0151).';

-- ── Seniority ─────────────────────────────────────────────────────────────
--
-- Without a rank the new roles fall to role_rank's `else 0`, which would let
-- ANY inviter issue them — a facility manager could mint the tier-3 approver
-- who signs off unlimited amounts. They sit above fm_ops_staff and below
-- finance, and only an administrator can issue them.
create or replace function role_rank(p_role user_role)
returns integer language sql immutable as $$
  select case p_role
           when 'admin'                  then 100
           when 'executive'              then 90
           when 'finance_approver'       then 70
           when 'payment_approver'       then 65
           when 'payment_audit_approver' then 64
           when 'regional_manager'       then 60
           when 'facility_manager'       then 50
           when 'fm_ops_staff'           then 30
           when 'property_owner'         then 20
           when 'viewer'                 then 15
           when 'vendor'                 then 10
           when 'tenant'                 then 10
           else 0
         end;
$$;

comment on function role_rank is
  'Invitation seniority only. You may invite a role strictly below your own — so a new role needs a rank, rather than every escalation guard needing a new exception. The two payment-chain roles (0151) sit below finance and above the operational staff: an FM cannot mint the approver who signs off above their own head.';

-- ── What tier a person actually carries ───────────────────────────────────
--
-- Three roles action stage 3, and only one of them carries a column:
--   • `payment_approver` — the explicit tier on the row.
--   • `executive`        — the MD / Managing Partner. Decision 9 gives them
--                          approval "including above the threshold", which is
--                          tier 3 by definition.
--   • `admin`            — decision 16, verbatim: "An administrator approves
--                          within the threshold and configures it; an executive
--                          approves above it." Within the threshold is tier 2.
--
-- Admin sits at 2 rather than 3 for the reason 0149 exists: the administrator
-- is the role the escalation escalates TO, so letting them clear the top band
-- alone would restore the concentration by another door.
create or replace function effective_approval_tier(p_role user_role, p_tier smallint)
returns smallint language sql immutable set search_path = public as $$
  select case p_role
           when 'payment_approver' then p_tier
           when 'executive'        then 3::smallint
           when 'admin'            then 2::smallint
           else null::smallint
         end;
$$;

comment on function effective_approval_tier is
  'The amount band a person may clear at stage 3. payment_approver carries it as a column; executive is tier 3 by decision 9 ("including above the threshold"); admin is tier 2 by decision 16 ("approves within the threshold"). Everyone else is null and cannot action stage 3 at all (0151).';

-- ── Which tier an amount demands ──────────────────────────────────────────
--
-- Bounds are INCLUSIVE at the top of each band: exactly ₦100,000 is tier 1,
-- exactly ₦1,000,000 is tier 2, one kobo more is tier 3. Callers must compare
-- `>=`, never `=` — a ladder that stops the MD approving ₦50,000 is broken.
create or replace function resolve_required_tier(p_org_id uuid, p_amount numeric)
returns smallint language sql stable set search_path = public as $$
  select case
           when p_amount <= coalesce(s.tier1_threshold_amount, 100000)      then 1::smallint
           when p_amount <= coalesce(s.approval_threshold_amount, 1000000)  then 2::smallint
           else 3::smallint
         end
    from (select 1) _
    left join payment_settings s on s.org_id = p_org_id;
$$;

comment on function resolve_required_tier is
  'The MINIMUM tier permitted to approve this amount. Inclusive at the top of each band. An unconfigured org falls back to ₦100,000 / ₦1,000,000 — the same defaults enforce_payment_transition already assumes, so the two layers cannot disagree about what is unlimited (0151).';

-- ── What is being paid, read from the record ──────────────────────────────
--
-- One resolver for both payable kinds. Returns the org and the amount that the
-- chain will be held to; the trigger uses it to OVERWRITE whatever the caller
-- sent.
create or replace function resolve_payable(p_type text, p_id uuid)
returns table (org_id uuid, amount numeric)
language plpgsql stable security definer set search_path = public as $$
begin
  if p_type = 'vendor_payment' then
    return query select p.org_id, p.amount from payments p where p.id = p_id;
  elsif p_type = 'landlord_payout' then
    return query select r.org_id, r.net_amount from remittances r where r.id = p_id;
  else
    raise exception 'unknown payable type %', p_type;
  end if;
end;
$$;

comment on function resolve_payable is
  'The org and amount of a payable, read from its own record. The single place the chain learns what is being paid — a client-supplied amount never reaches the tier comparison (0151).';

-- ── The stages, stated once and not configurable ──────────────────────────
create or replace function payment_chain_stages()
returns table (stage_order smallint, required_roles user_role[], tier_resolved boolean, label text)
language sql immutable set search_path = public as $$
  select * from (values
    (1::smallint, array['facility_manager','regional_manager']::user_role[], false,
     'Job sign-off and approval for payment'),
    (2::smallint, array['payment_audit_approver']::user_role[],              false,
     'Audit verification'),
    (3::smallint, array['payment_approver','executive','admin']::user_role[], true,
     'Final approval')
  ) as t(stage_order, required_roles, tier_resolved, label);
$$;

comment on function payment_chain_stages is
  'The approval ladder, hardwired. NOT a config table: decision 7 lists payment approval among the non-delegable controls that "stay hardwired and never appear as toggles". The amounts are configurable; the sequence of hands is not (0151).';

-- ── The record ────────────────────────────────────────────────────────────

create table if not exists payment_approvals (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references orgs(id),
  payable_type  text not null check (payable_type in ('vendor_payment', 'landlord_payout')),
  payable_id    uuid not null,
  stage_order   smallint not null check (stage_order between 1 and 3),
  actor_id      uuid not null references users(id),
  actor_role    user_role not null,
  actor_tier    smallint,
  -- The amount AS RESOLVED FROM THE PAYABLE at the moment of decision. Not what
  -- the caller said it was.
  amount        numeric(14,2) not null check (amount > 0),
  required_tier smallint,
  decision      text not null check (decision in ('approved', 'rejected')),
  reason        text,
  created_at    timestamptz not null default now(),

  unique (payable_type, payable_id, stage_order),

  constraint rejection_requires_reason check (
    decision = 'approved'
    or (reason is not null and length(trim(reason)) >= 10)
  )
);

create index if not exists payment_approvals_payable_idx
  on payment_approvals (payable_type, payable_id, stage_order);
create index if not exists payment_approvals_org_idx
  on payment_approvals (org_id, created_at desc);

alter table payment_approvals enable row level security;

-- Readable by oversight, by the operational managers, and by the person who
-- made the decision. No INSERT/UPDATE/DELETE policy at all: the only way in is
-- `record_payment_approval`, and there is deliberately no way out.
drop policy if exists payment_approvals_select on payment_approvals;
create policy payment_approvals_select on payment_approvals for select to authenticated
  using (
    org_id = current_user_org_id()
    and (
      current_user_role() = any (oversight_roles())
      or current_user_role() = any (fm_roles())
      or current_user_role() in ('payment_approver', 'payment_audit_approver')
      or actor_id = auth.uid()
    )
  );

comment on table payment_approvals is
  'Every stage decision on every outbound payment, vendor or landlord. Append-only, like audit_log: an approval that can be edited afterwards is not evidence of anything (0151).';

-- ── The rules, in the database ────────────────────────────────────────────
create or replace function enforce_approval_rules()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_stage    record;
  v_actor    users%rowtype;
  v_payable  record;
  v_missing  int;
  v_rejected int;
  v_self     int;
  v_required smallint;
  v_tier     smallint;
begin
  select * into v_stage from payment_chain_stages() s where s.stage_order = new.stage_order;
  if not found then
    raise exception 'there is no approval stage %', new.stage_order;
  end if;

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
  -- is the line that defeats "approve a small amount, disburse a large one".
  select * into v_payable from resolve_payable(new.payable_type, new.payable_id);
  if v_payable.org_id is null then
    raise exception 'that payable could not be found';
  end if;
  new.org_id := v_payable.org_id;
  new.amount := v_payable.amount;

  if v_actor.org_id is distinct from new.org_id then
    raise exception 'a payment can only be approved by someone in the organisation it belongs to';
  end if;

  if not (v_actor.role = any (v_stage.required_roles)) then
    raise exception '% is actioned by %, and you are %',
      v_stage.label, array_to_string(v_stage.required_roles, ' or '), v_actor.role;
  end if;

  -- Every earlier stage approved. No skipping.
  select count(*) into v_missing
    from payment_chain_stages() s
   where s.stage_order < new.stage_order
     and not exists (
       select 1 from payment_approvals a
        where a.payable_type = new.payable_type
          and a.payable_id   = new.payable_id
          and a.stage_order  = s.stage_order
          and a.decision     = 'approved'
     );
  if v_missing > 0 then
    raise exception 'this payment has % earlier stage(s) still to be approved', v_missing;
  end if;

  select count(*) into v_rejected
    from payment_approvals a
   where a.payable_type = new.payable_type
     and a.payable_id   = new.payable_id
     and a.decision     = 'rejected';
  if v_rejected > 0 then
    raise exception 'this payment was already rejected and cannot be actioned further';
  end if;

  -- Separation of duties: one human, one stage. Holding two of the roles does
  -- not make you two people. Same principle as two-tier application review
  -- (0082), where the recommender may not also decide.
  select count(*) into v_self
    from payment_approvals a
   where a.payable_type = new.payable_type
     and a.payable_id   = new.payable_id
     and a.actor_id     = new.actor_id;
  if v_self > 0 then
    raise exception 'you already actioned an earlier stage on this payment — it needs a second pair of hands';
  end if;

  if v_stage.tier_resolved then
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
$$;

drop trigger if exists trg_enforce_approval_rules on payment_approvals;
create trigger trg_enforce_approval_rules
  before insert on payment_approvals
  for each row execute function enforce_approval_rules();

create or replace function reject_approval_mutation()
returns trigger language plpgsql as $$
begin
  raise exception 'payment_approvals is append-only — a decision is corrected by rejecting and re-raising, never by editing the record of it';
end;
$$;

drop trigger if exists trg_approvals_append_only on payment_approvals;
create trigger trg_approvals_append_only
  before update or delete on payment_approvals
  for each row execute function reject_approval_mutation();

-- ── The gate ──────────────────────────────────────────────────────────────
--
-- True only when every stage is approved AT THE AMOUNT NOW BEING PAID. An
-- upward edit after stage 3 therefore invalidates the chain and forces
-- re-approval at the correct tier — which is the whole point of recording the
-- amount on each row.
create or replace function is_cleared_for_disbursement(
  p_payable_type text,
  p_payable_id   uuid,
  p_amount       numeric
) returns boolean language sql stable set search_path = public as $$
  select not exists (
    select 1 from payment_chain_stages() s
     where not exists (
       select 1 from payment_approvals a
        where a.payable_type = p_payable_type
          and a.payable_id   = p_payable_id
          and a.stage_order  = s.stage_order
          and a.decision     = 'approved'
          and a.amount       = p_amount
     )
  );
$$;

comment on function is_cleared_for_disbursement is
  'Every stage approved, at the amount now being disbursed. The amount re-check is what closes "approve small, pay large": a change after approval leaves the chain incomplete rather than merely logged (0151).';

-- ── Recording a decision ──────────────────────────────────────────────────
--
-- SECURITY DEFINER so it can read the payable and the actor's row, but every
-- rule above is re-checked by the trigger regardless of how the row arrives.
-- The two layers are deliberately redundant: this one exists for a sentence a
-- person can act on, the trigger is the control.
create or replace function record_payment_approval(
  p_payable_type text,
  p_payable_id   uuid,
  p_stage        smallint,
  p_decision     text,
  p_reason       text default null
) returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_id uuid;
  v_actor uuid := auth.uid();
begin
  if v_actor is null then
    raise exception 'your session expired — sign in again';
  end if;
  if p_decision not in ('approved', 'rejected') then
    raise exception 'a stage is either approved or rejected';
  end if;
  if p_decision = 'rejected' and length(trim(coalesce(p_reason, ''))) < 10 then
    raise exception 'tell them why in at least 10 characters — a refusal nobody can act on is a dead end';
  end if;

  insert into payment_approvals (
    org_id, payable_type, payable_id, stage_order,
    actor_id, actor_role, actor_tier, amount, decision, reason
  ) values (
    -- org, role, tier and amount are all overwritten by the trigger from the
    -- authoritative records. These placeholders satisfy NOT NULL and nothing else.
    '00000000-0000-0000-0000-000000000000', p_payable_type, p_payable_id, p_stage,
    v_actor, 'viewer', null, 1, p_decision, nullif(trim(coalesce(p_reason, '')), '')
  )
  returning id into v_id;

  return v_id;
end;
$$;

revoke all on function record_payment_approval(text, uuid, smallint, text, text) from public, anon;
grant execute on function record_payment_approval(text, uuid, smallint, text, text) to authenticated, service_role;

comment on function record_payment_approval is
  'Records one stage decision. Org, role, tier and amount are resolved from the authoritative records by the trigger, so nothing a caller sends can widen their own authority (0151).';

-- ── Stage 3 IS the approval ───────────────────────────────────────────────
--
-- Rather than leaving someone to flip `payments.status` afterwards — which
-- would be a fourth approval nobody counted — the completed chain moves the
-- payment itself. `approved_by` becomes the stage-3 approver, which is exactly
-- who 0142's maker-checker then refuses to let disburse it.
create or replace function apply_chain_outcome_to_payment()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.payable_type <> 'vendor_payment' then
    return new;
  end if;

  if new.decision = 'rejected' then
    update payments
       set status          = 'rejected',
           rejected_reason = new.reason,
           rejected_by     = new.actor_id,
           rejected_at     = now()
     where id = new.payable_id
       and status in ('pending_verification', 'verified', 'recommended');
    return new;
  end if;

  if new.stage_order = 3
     and is_cleared_for_disbursement(new.payable_type, new.payable_id, new.amount) then
    update payments
       set status      = 'approved',
           approved_by = new.actor_id,
           approved_at = now()
     where id = new.payable_id
       and status = 'recommended';
  end if;

  return new;
end;
$$;

drop trigger if exists trg_apply_chain_outcome on payment_approvals;
create trigger trg_apply_chain_outcome
  after insert on payment_approvals
  for each row execute function apply_chain_outcome_to_payment();

-- ── The old single-stage approval is closed off ───────────────────────────
--
-- ⚠️ Rewritten from the LIVE definition (`pg_proc.prosrc`), per the 0136
-- lesson. The change is the `recommended -> approved` branch: approval is no
-- longer something a role does, it is something the CHAIN produces. Finance
-- keeps everything else it had, including reopening a rejected invoice.
create or replace function enforce_payment_transition()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  caller_role user_role := current_user_role();
begin
  if auth.uid() is null then
    return new;
  end if;

  if new.status is not distinct from old.status then
    return new;
  end if;

  if not (
    (old.status = 'pending_verification' and new.status in ('verified','rejected'))
    or (old.status = 'verified'          and new.status in ('recommended','rejected'))
    or (old.status = 'recommended'       and new.status in ('approved','rejected'))
    or (old.status = 'approved'          and new.status = 'remitted')
    or (old.status = 'rejected'          and new.status = 'pending_verification')
  ) then
    raise exception 'illegal payment transition: % -> %', old.status, new.status;
  end if;

  if old.status = 'rejected' and new.status = 'pending_verification' then
    if caller_role not in ('finance_approver','admin') then
      raise exception 'only finance or an administrator may reopen a rejected invoice';
    end if;
    if new.service_verified_at is not null or new.performance_validated is true then
      raise exception 'a reopened invoice starts the gate again -- clear the verification and performance flags';
    end if;
  end if;

  if new.status = 'rejected'
     and length(trim(coalesce(new.rejected_reason, ''))) < 10 then
    raise exception 'a rejection needs a reason of at least 10 characters';
  end if;

  if new.status = 'recommended' and (new.service_verified_at is null or new.performance_validated is not true) then
    raise exception 'cannot recommend: verification + performance gate not satisfied';
  end if;

  if new.status = 'approved' then
    if new.service_verified_at is null or new.performance_validated is not true then
      raise exception 'cannot approve: gate not satisfied';
    end if;

    -- Approval is the CHAIN's outcome now, not a role's prerogative. The
    -- threshold escalation that used to live here has not been dropped — it
    -- moved into resolve_required_tier(), which decides it per band instead of
    -- once at a single line, and is enforced at stage 3.
    if not is_cleared_for_disbursement('vendor_payment', new.id, new.amount) then
      raise exception
        'this payment has not completed its approval chain at ₦% — it cannot be marked approved',
        trim(to_char(new.amount, 'FM999,999,999,990.00'));
    end if;
  end if;

  if new.status = 'remitted' then
    if new.approved_at is null then
      raise exception 'cannot remit: payment not approved';
    end if;
    if caller_role not in ('finance_approver','admin') then
      raise exception 'only finance or an administrator may remit payments';
    end if;
  end if;

  return new;
end;
$$;

comment on function enforce_payment_transition is
  'The B4 gate. Legal transitions, verification/performance conditions, and — since 0151 — approval only as the OUTCOME OF THE CHAIN rather than an act available to a role. The threshold escalation moved into resolve_required_tier(), which bands it rather than applying one cut-off.';

-- ── Vendor disbursement re-checks the amount ──────────────────────────────
--
-- 0142 established WHO may send. This adds WHAT they may send: the chain must
-- be complete at the amount on the payment right now.
create or replace function assert_chain_cleared(p_type text, p_id uuid, p_amount numeric)
returns void language plpgsql stable set search_path = public as $$
declare
  v_done int;
  v_rejected int;
begin
  if is_cleared_for_disbursement(p_type, p_id, p_amount) then
    return;
  end if;

  select count(*) into v_rejected from payment_approvals
   where payable_type = p_type and payable_id = p_id and decision = 'rejected';
  if v_rejected > 0 then
    raise exception 'this payment was rejected and must not be sent';
  end if;

  select count(*) into v_done from payment_approvals
   where payable_type = p_type and payable_id = p_id and decision = 'approved';

  if v_done >= 3 then
    raise exception
      'the amount changed after it was approved — it has to go back through approval at ₦%',
      trim(to_char(p_amount, 'FM999,999,999,990.00'));
  end if;

  raise exception
    'this payment has only cleared % of 3 approval stages and cannot be sent', v_done;
end;
$$;

comment on function assert_chain_cleared is
  'Raises with the reason a payable is not clear to send — incomplete, rejected, or approved at a different amount. One message per cause, because "not cleared" tells the person nothing about what to do next (0151).';
