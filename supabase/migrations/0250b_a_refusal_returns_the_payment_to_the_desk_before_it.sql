-- A refusal returns the payment to the desk before it (decision 30, 5 Sept 2026).
--
-- Reported as: "money requisition approval flow should also correctly go back to
-- the previous sender if the request is refused/rejected at any stage. Say if
-- audit rejects it, it goes back to pm/fm/rm who sent it for correction and
-- resend. If it was rejected by mp/executive, it goes back to auditor for
-- correction and resubmission."
--
-- None of that existed. `apply_chain_outcome_to_payment` (0173) set the WHOLE
-- payable to `rejected` on a refusal at ANY stage — a typo caught at the
-- Managing Partner's desk killed the requisition outright, and:
--   • for an ops requisition there was no way back at all. 0170 says so in its
--     own words: "there is deliberately no path that lets a raised requisition
--     be edited after the fact rather than rejected and re-raised". The raiser
--     retypes it from scratch and it climbs all three rungs again.
--   • for a vendor payment the only way back was `finance_approver`/`admin`
--     flipping it to `pending_verification`, which restarts the ENTIRE B4 gate —
--     service verification and performance validation included — discarding
--     stage 1's and stage 2's correct work along with the mistake.
--
-- So a refusal is now two different acts, and the difference is whether the
-- thing is WRONG or merely INCORRECT:
--   • `rejected` — terminal, unchanged, still ends the payable.
--   • `returned` — sent back one rung for correction. At stage N>1 it retires
--     the approval at stage N-1, so that desk must look again and re-give it.
--     At stage 1 there is no rung below, so it goes to the raiser and the
--     payable says `returned_for_correction`.
--
-- ⚠️ A returned item re-climbs FROM the rung it was returned to, not from the
-- bottom. Stage 2 sending something back does not make stage 1's earlier,
-- correct approval disappear from the record — but it does void it, because a
-- signature given on the figures as they were is not a signature on the figures
-- as corrected. That is the same reasoning `enforce_approval_rules` already
-- applies when an amount moves, and it is why the return supersedes rather than
-- deletes: the trail keeps every round, and only the live round counts.

-- ── 1. The vocabulary ────────────────────────────────────────────────────────
alter table payment_approvals drop constraint if exists payment_approvals_decision_check;
alter table payment_approvals add constraint payment_approvals_decision_check
  check (decision = any (array['approved'::text, 'rejected'::text, 'returned'::text]));

-- `rejection_requires_reason` already reads "approved, OR a reason of >= 10
-- characters", so a return is required to say what to correct without being
-- touched here. That is the constraint being general rather than lucky.

alter table ops_requisitions drop constraint if exists ops_requisitions_status_check;
alter table ops_requisitions add constraint ops_requisitions_status_check
  check (status = any (array['pending_approval'::text, 'approved'::text,
                             'remitted'::text, 'rejected'::text,
                             'returned_for_correction'::text]));

alter table ops_requisitions add column if not exists returned_at timestamptz;
alter table payments          add column if not exists returned_at timestamptz;

-- The reason and the person live on the chain row, which is append-only and
-- already rendered on the payable's own screen. Copying them onto the payable
-- would create a second copy free to disagree with the first — the fault
-- decision 24 recorded when two lists of one thing drifted apart.

-- ── 2. A return is not terminal, and the guard has to know it ────────────────
--
-- Rebuilt from the live catalogue. One line changes: "anything that is not an
-- approval is terminal" becomes "a rejection is terminal", because a return is
-- now the third thing and its whole purpose is to be undone by a corrected
-- resubmission.
create or replace function guard_approval_mutation()
returns trigger
language plpgsql set search_path = public as $fn$
begin
  if tg_op = 'DELETE' then
    raise exception 'payment_approvals is append-only — a decision is never deleted';
  end if;

  if old.superseded_at is not null then
    raise exception 'this decision has already been superseded';
  end if;
  if new.superseded_at is null then
    raise exception 'payment_approvals is append-only — the only permitted update is superseding a decision';
  end if;
  if old.decision = 'rejected' then
    raise exception 'a refusal is terminal and cannot be superseded';
  end if;

  -- Everything else must be untouched. Without this, "supersede" would be a
  -- general-purpose UPDATE with a flag set, and the record of the decision
  -- would be editable after all.
  if (old.id, old.org_id, old.payable_type, old.payable_id, old.stage_order,
      old.actor_id, old.actor_role, old.actor_tier, old.amount,
      old.required_tier, old.decision, old.reason, old.created_at)
     is distinct from
     (new.id, new.org_id, new.payable_type, new.payable_id, new.stage_order,
      new.actor_id, new.actor_role, new.actor_tier, new.amount,
      new.required_tier, new.decision, new.reason, new.created_at)
  then
    raise exception 'superseding a decision may not alter the record of it';
  end if;

  return new;
end;
$fn$;

-- ── 3. The rules that admit a return ─────────────────────────────────────────
--
-- Rebuilt from the live catalogue (0183). Exactly two things change, both
-- consequences of a stage now being actionable twice:
--
--   (a) a live `returned` row at this stage is retired before the new decision
--       is written, because `payment_approvals_live_stage_uidx` permits one
--       live row per stage and the returned row is one;
--   (b) the separation-of-duties count ignores returned rows. Sending something
--       back for correction is not "actioning a stage" in the sense that rule
--       protects — a desk that returns a requisition and then approves the
--       corrected version is doing its job twice, not standing in for a second
--       pair of hands. A rejection and an approval both still count.
create or replace function enforce_approval_rules()
returns trigger
language plpgsql security definer set search_path = public as $fn$
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

  -- (a) 0250b. This stage's outstanding return, answered by this decision.
  update payment_approvals a
     set superseded_at = now()
   where a.payable_type  = new.payable_type
     and a.payable_id    = new.payable_id
     and a.stage_order   = new.stage_order
     and a.decision      = 'returned'
     and a.superseded_at is null;

  if v_actor.org_id is distinct from new.org_id then
    raise exception 'a payment can only be approved by someone in the organisation it belongs to';
  end if;

  if not (v_actor.role = any (v_stage.required_roles)) then
    raise exception '% is actioned by %, and you are %',
      v_stage.label, array_to_string(v_stage.required_roles, ' or '), v_actor.role;
  end if;

  -- Every earlier stage approved, LIVE, and at the amount now being approved.
  -- No skipping, and no standing on a signature given for a different figure.
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
  -- the header.
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
$fn$;

-- ⚠️ One behaviour above is deliberately widened beyond the mechanical rebuild:
-- the tier check now applies to `decision = 'approved'` only. Refusing or
-- returning something you are not senior enough to APPROVE is not an
-- escalation — it is the cheapest possible outcome, and requiring a tier to say
-- "this is wrong" would have meant a junior payment approver could neither
-- approve a large payment nor send it back, which is the state where things sit
-- untouched. A rejection at stage 3 was already reachable without a tier before
-- this migration, because `apply_chain_outcome_to_payment` short-circuits on a
-- refusal — but `enforce_approval_rules` still demanded the tier first, so the
-- two disagreed. They now agree.

-- ── 4. Where a return sends it ───────────────────────────────────────────────
create or replace function apply_chain_outcome_to_payment()
returns trigger
language plpgsql security definer set search_path = public as $fn$
declare
  v_final smallint := (select max(s.stage_order) from payment_chain_stages(new.org_id) s);
begin
  -- A return, at any stage, on either payable. Handled before the per-type
  -- branches because the rule is identical for both and duplicating it is how
  -- 0212 ended up with `current_user_payable_ticket_ids()` knowing about one
  -- payable type and not the other.
  if new.decision = 'returned' then
    if new.stage_order > 1 then
      -- Back one rung. The desk below must look again; its earlier approval is
      -- retired rather than removed, so the trail still shows it was given.
      update payment_approvals a
         set superseded_at = now()
       where a.payable_type  = new.payable_type
         and a.payable_id    = new.payable_id
         and a.stage_order   = new.stage_order - 1
         and a.decision      = 'approved'
         and a.superseded_at is null;
    else
      -- No rung below stage 1: it goes to whoever raised it.
      if new.payable_type = 'ops_requisition' then
        update ops_requisitions
           set status = 'returned_for_correction', returned_at = now()
         where id = new.payable_id
           and status = 'pending_approval';
      elsif new.payable_type = 'vendor_payment' then
        update payments
           set status = 'returned_for_correction', returned_at = now()
         where id = new.payable_id
           and status = 'recommended';
      end if;
    end if;
    return new;
  end if;

  if new.payable_type = 'vendor_payment' then
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

    if new.stage_order = v_final
       and is_cleared_for_disbursement(new.payable_type, new.payable_id, new.amount) then
      update payments
         set status      = 'approved',
             approved_by = new.actor_id,
             approved_at = now()
       where id = new.payable_id
         and status = 'recommended';
    end if;
    return new;
  end if;

  if new.payable_type = 'ops_requisition' then
    if new.decision = 'rejected' then
      update ops_requisitions
         set status          = 'rejected',
             rejected_reason = new.reason,
             rejected_by     = new.actor_id,
             rejected_at     = now()
       where id = new.payable_id
         and status = 'pending_approval';
      return new;
    end if;

    if new.stage_order = v_final
       and is_cleared_for_disbursement(new.payable_type, new.payable_id, new.amount) then
      update ops_requisitions
         set status      = 'approved',
             approved_by = new.actor_id,
             approved_at = now()
       where id = new.payable_id
         and status = 'pending_approval';
    end if;
    return new;
  end if;

  return new;
end;
$fn$;

-- ── 5. The transitions a payment is now allowed ──────────────────────────────
--
-- Rebuilt from the live catalogue; two transitions added and nothing removed.
-- `returned_for_correction -> rejected` is included because a return is a
-- request to correct, and "on reflection, this should not be paid at all" has
-- to remain reachable without inventing a round trip.
create or replace function enforce_payment_transition()
returns trigger
language plpgsql security definer set search_path = public as $fn$
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
    or (old.status = 'recommended'       and new.status in ('approved','rejected','returned_for_correction'))
    or (old.status = 'approved'          and new.status = 'remitted')
    or (old.status = 'rejected'          and new.status = 'pending_verification')
    or (old.status = 'returned_for_correction' and new.status in ('recommended','rejected'))
  ) then
    raise exception 'illegal payment transition: % -> %', old.status, new.status;
  end if;

  if old.status = 'rejected' and new.status = 'pending_verification' then
    if caller_role not in ('finance_approver','admin') then
      raise exception 'only the payment officer or an administrator may reopen a rejected invoice';
    end if;
    if new.service_verified_at is not null or new.performance_validated is true then
      raise exception 'a reopened invoice starts the gate again -- clear the verification and performance flags';
    end if;
  end if;

  -- ⚠️ Deliberately NOT the reopen rule. A reopen restarts the B4 gate and so
  -- is finance's to authorise; a resubmission after a return keeps the gate
  -- satisfied and merely re-enters the chain at the rung it was sent back to.
  -- Gating it on finance would put the payment officer in the middle of a
  -- correction between two other desks.
  if old.status = 'returned_for_correction' and new.status = 'recommended' then
    if new.service_verified_at is null or new.performance_validated is not true then
      raise exception 'a resubmitted invoice must still satisfy the verification and performance gate';
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
    if caller_role <> 'finance_approver' then
      raise exception 'only the payment officer may remit payments — oversight authorises, the payment officer disburses';
    end if;
  end if;

  return new;
end;
$fn$;

-- ── 5b. The one write path has to admit the third decision ───────────────────
--
-- 📌 Easy to miss, and it would have been silent in the worst way: every rule
-- above would be in place, the UI would offer a "Send back" button, and
-- `record_payment_approval` — the ONLY way in, by design — would answer "a
-- stage is either approved or rejected". Rebuilt from the live catalogue with
-- the decision list and the reason rule widened, and nothing else touched.
create or replace function record_payment_approval(
  p_payable_type text,
  p_payable_id uuid,
  p_stage smallint,
  p_decision text,
  p_reason text default null
)
returns uuid
language plpgsql security definer set search_path = public as $fn$
declare
  v_id uuid;
  v_actor uuid := auth.uid();
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
  -- A return has to say what to correct just as a refusal has to say why. The
  -- person receiving it can act on neither without words.
  if p_decision in ('rejected', 'returned')
     and length(trim(coalesce(p_reason, ''))) < 10 then
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
$fn$;

revoke all on function record_payment_approval(text, uuid, smallint, text, text) from public, anon;
grant execute on function record_payment_approval(text, uuid, smallint, text, text) to authenticated, service_role;

-- ── 6. Sending it back up ────────────────────────────────────────────────────
--
-- Only needed for a stage-1 return, where the payable left the chain entirely.
-- A return at stage 2 or 3 needs no function at all: the rung below is simply
-- outstanding again, and the desk that owns it approves as it always did. That
-- asymmetry is the design working — the chain is the state machine, and only
-- the step OUTSIDE the chain needs a door back in.
create or replace function resubmit_returned_payable(
  p_payable_type text,
  p_payable_id uuid,
  p_note text default null
)
returns void
language plpgsql security definer set search_path = public as $fn$
declare
  v_org uuid;
  v_may boolean := false;
  v_prop uuid;
begin
  if p_payable_type = 'ops_requisition' then
    select r.org_id into v_org from ops_requisitions r where r.id = p_payable_id;
    if v_org is null then raise exception 'requisition not found'; end if;
    if v_org is distinct from current_user_org_id() then
      raise exception 'that requisition belongs to another organisation';
    end if;

    v_prop := payable_property_id('ops_requisition', p_payable_id);
    select (
      r.raised_by = auth.uid()
      or current_user_role() = 'admin'
      or (current_user_role() = any (fm_roles())
          and v_prop in (select current_user_property_ids()))
    ) into v_may
      from ops_requisitions r where r.id = p_payable_id;

    if not coalesce(v_may, false) then
      raise exception 'only the person who raised this requisition, a manager of its property, or an administrator may resend it';
    end if;

    update ops_requisitions
       set status = 'pending_approval', returned_at = null
     where id = p_payable_id
       and status = 'returned_for_correction';
    if not found then
      raise exception 'that requisition is not waiting to be corrected';
    end if;

  elsif p_payable_type = 'vendor_payment' then
    select p.org_id into v_org from payments p where p.id = p_payable_id;
    if v_org is null then raise exception 'payment not found'; end if;
    if v_org is distinct from current_user_org_id() then
      raise exception 'that payment belongs to another organisation';
    end if;
    if current_user_role() not in ('finance_approver', 'admin') then
      raise exception 'only the payment officer or an administrator may resend a returned invoice';
    end if;

    update payments
       set status = 'recommended', returned_at = null
     where id = p_payable_id
       and status = 'returned_for_correction';
    if not found then
      raise exception 'that invoice is not waiting to be corrected';
    end if;

  else
    raise exception 'unknown payable type %', p_payable_type;
  end if;

  -- Clear the outstanding return so stage 1 has a free slot to decide into.
  update payment_approvals a
     set superseded_at = now()
   where a.payable_type  = p_payable_type
     and a.payable_id    = p_payable_id
     and a.decision      = 'returned'
     and a.superseded_at is null;

  insert into audit_log (org_id, actor_id, action, entity_type, entity_id,
                         before_state, after_state)
  values (
    v_org, auth.uid(), 'payment.resubmitted_after_return',
    case p_payable_type when 'ops_requisition' then 'ops_requisitions' else 'payments' end,
    p_payable_id,
    jsonb_build_object('status', 'returned_for_correction'),
    jsonb_build_object('resubmitted_at', now(), 'note', p_note)
  );
end;
$fn$;

comment on function resubmit_returned_payable(text, uuid, text) is
  'Re-enters a payable that was returned to its raiser at stage 1 back into the approval chain (0250b).';

revoke all on function resubmit_returned_payable(text, uuid, text) from public, anon;
grant execute on function resubmit_returned_payable(text, uuid, text) to authenticated, service_role;

-- 📌 The four trigger functions above were found open to `anon` and `PUBLIC` on
-- staging BEFORE this migration touched them — a pre-existing gap, and the
-- fifth instance of the pattern 0204/0209/0210/0214 keep recording: Supabase
-- grants EXECUTE to PUBLIC by default, and `create or replace` re-applies that
-- default to a function somebody had correctly closed. `record_collection` and
-- `recognise_vendor_payable`, closed by an earlier migration, were correctly
-- still closed — which is what makes this a gap rather than a policy.
--
-- Closing them costs nothing: PostgreSQL checks EXECUTE on a trigger function
-- when the TRIGGER IS CREATED, not on every firing, and a direct call is
-- refused outright ("trigger functions can only be called as triggers"). The
-- explicit grant to `authenticated` is belt-and-braces on that reading — under
-- either semantics, no signed-in user's write path can be broken by this.
revoke all on function guard_approval_mutation() from public, anon;
revoke all on function enforce_approval_rules() from public, anon;
revoke all on function apply_chain_outcome_to_payment() from public, anon;
revoke all on function enforce_payment_transition() from public, anon;

grant execute on function guard_approval_mutation() to authenticated, service_role;
grant execute on function enforce_approval_rules() to authenticated, service_role;
grant execute on function apply_chain_outcome_to_payment() to authenticated, service_role;
grant execute on function enforce_payment_transition() to authenticated, service_role;

do $$
declare v_bad text;
begin
  select string_agg(distinct routine_name || ' → ' || grantee, ', ')
    into v_bad
    from information_schema.routine_privileges
   where specific_schema = 'public'
     and grantee in ('anon', 'PUBLIC')
     and routine_name in ('resubmit_returned_payable', 'enforce_approval_rules',
                          'apply_chain_outcome_to_payment', 'enforce_payment_transition',
                          'guard_approval_mutation', 'record_payment_approval');
  if v_bad is not null then
    raise exception 'these functions are callable by anon or PUBLIC and must not be: %', v_bad;
  end if;
end $$;
