-- Four hands on an OEA payment, and the administrator's are not among them.
-- (Board direction, 28 Aug 2026 — decision 23.)
--
-- ── What the board actually changed ───────────────────────────────────────
--
-- OEA's outbound flow becomes:
--
--     requester → AUDIT review/approval → MP (executive) → PAYMENT APPROVER
--                                                        → PAYMENT OFFICER
--
-- and two sentences beside it do most of the work:
--
--   • *"FM/PM/ADMIN not part of the finance approval flow, only signs off a
--     job as complete for the finance approval flow to commence."*
--   • *"every outbound payment, especially those going through Paystack."*
--
-- The first removes the FM/PM sign-off from the LADDER without removing it from
-- the PROCESS — it becomes the precondition that starts the chain rather than
-- its first rung, which is what 0189 already said it was in everything but
-- position. The second makes the MP's approval unconditional: decision 9 gave
-- the executive approval "including above the threshold", and on OEA it is now
-- every payment at every amount.
--
-- ── 1. The chain is per-organisation for the first time ───────────────────
--
-- ⚠️ This is the part to read carefully, because decision 7 lists payment
-- approval among the non-delegable controls that "stay hardwired and never
-- appear as toggles", and 0151 built `payment_chain_stages()` immutable and
-- argument-less for exactly that reason.
--
-- That rule is kept. The chain is still hardwired and still un-configurable by
-- anybody, inside or outside the organisation: what it now reads is
-- `orgs.delivery_brand`, which is set once when the operator provisions the org
-- and — as of this migration — cannot be changed by anyone at all.
--
-- 📌 **`delivery_brand` was in the `authenticated` UPDATE column allowlist**
-- (0083c). Until this file it was a branding field, so that was harmless. The
-- moment the approval ladder reads it, it becomes a control input, and an
-- administrator could have moved their own organisation from OEA to TFML and
-- walked straight back into stage 3 — the concentration decisions 9 and 16
-- exist to break, reached through the theming form. It leaves the allowlist
-- below. This is the whole reason a brand-keyed chain is safe to build, and it
-- would have been a live hole if the column had been left where it was.
--
-- ── 2. The administrator leaves approval everywhere, not only on OEA ───────
--
-- Decision 16 said "an administrator approves within the threshold and
-- configures it". The board has now removed the first half: **admin is not part
-- of money approval.** That is a separation-of-duties rule about who may
-- authorise spending, not a description of OEA's workflow, so it is applied to
-- BOTH chains rather than only the one whose shape moved. A rule that holds on
-- one brand and not the other is precisely the drift 0185 was written about.
--
-- An administrator still configures nothing here either: the ladder's AMOUNTS
-- have been operator-governed since 0149. What they keep is the org's
-- administration; what they lose is the ability to approve against a limit.
--
-- 📌 Consequence, stated rather than discovered: on the standard chain the
-- executive is now the only role at stage 3 besides `payment_approver`. On OEA
-- the executive is stage 2 and CANNOT also action stage 3 — the
-- separation-of-duties check refuses one person two stages. An OEA org
-- therefore needs a `payment_approver` carrying a tier high enough for the
-- amount. That is the board's answer to the question, verbatim: **a config gap
-- the org fixes by appointing one**, not a code exception.

-- ── Which chain an organisation climbs ────────────────────────────────────
--
-- One function, so the shape is named once and every consumer reads the same
-- answer. `standard` for TFML, `direct` and the operator; `oea` for OEA.
create or replace function org_payment_chain(p_org_id uuid)
returns text language sql stable set search_path = public as $$
  select coalesce(
    (select case when o.delivery_brand = 'OEA' then 'oea' else 'standard' end
       from orgs o where o.id = p_org_id),
    'standard'
  );
$$;

revoke all on function org_payment_chain(uuid) from public, anon;
grant execute on function org_payment_chain(uuid) to authenticated, service_role;

comment on function org_payment_chain is
  'Which approval ladder an organisation climbs — ''oea'' (audit → MP → payment approver) or ''standard'' (FM/PM sign-off → audit → final approval). Reads orgs.delivery_brand, which is set once at provisioning and is writable by nobody: it left the authenticated UPDATE allowlist in 0211, because a branding field that selects an approval chain is a control input (decision 23).';

-- ── The stages, still hardwired, now per organisation ─────────────────────
--
-- ⚠️ SIGNATURE CHANGE. The argument-less `payment_chain_stages()` is dropped
-- rather than kept beside this one. A zero-argument version would have to guess
-- the org — from `current_user_org_id()`, which is NULL under the service role
-- that every verification suite and every job route uses — and would then
-- silently answer "standard" for an OEA payable. Two functions that must agree
-- eventually disagree; on a money path the disagreement is a missing approval.
--
-- 📌 Both shapes are deliberately THREE stages. `payment_approvals.stage_order
-- between 1 and 3`, the one-live-row-per-stage unique index (0175) and every
-- "% of 3 stages" message keep working unchanged, and nothing about supersession
-- or the amount re-check has to be re-reasoned.
--
-- Every literal is cast. 0166's lesson: a CASE of untyped literals resolves to
-- `text`, plpgsql bodies are not parsed until they run, and the migration
-- applies cleanly with the function broken.
drop function if exists payment_chain_stages();

create or replace function payment_chain_stages(p_org_id uuid)
returns table (stage_order smallint, required_roles user_role[], tier_resolved boolean, label text)
language sql stable set search_path = public as $$
  select v.stage_order, v.required_roles, v.tier_resolved, v.label
    from (select org_payment_chain(p_org_id) as shape) c
    cross join lateral (values
      (1::smallint,
       case c.shape when 'oea' then array['payment_audit_approver']::user_role[]
                    else fm_roles() end,
       false,
       case c.shape when 'oea' then 'Audit review and approval'
                    else 'Work completed and signed off' end::text),
      (2::smallint,
       case c.shape when 'oea' then array['executive']::user_role[]
                    else array['payment_audit_approver']::user_role[] end,
       false,
       case c.shape when 'oea' then 'Managing Partner approval'
                    else 'Audit verification' end::text),
      (3::smallint,
       case c.shape when 'oea' then array['payment_approver']::user_role[]
                    else array['payment_approver','executive']::user_role[] end,
       true,
       case c.shape when 'oea' then 'Payment approval'
                    else 'Final approval' end::text)
    ) as v(stage_order, required_roles, tier_resolved, label);
$$;

revoke all on function payment_chain_stages(uuid) from public, anon;
grant execute on function payment_chain_stages(uuid) to authenticated, service_role;

comment on function payment_chain_stages is
  'The three pairs of hands every payment out passes through, for one organisation. OEA (decision 23): audit review → Managing Partner → payment approver, with the FM/PM sign-off a PRECONDITION that commences the chain rather than a rung of it. Standard: FM/PM sign-off → audit → final approval. Hardwired in both cases and configurable by nobody — what varies is delivery_brand, set at provisioning and writable by no one. The administrator appears in neither: decision 23 removed them from money approval on both chains.';

-- ── The tier a person carries ─────────────────────────────────────────────
--
-- ⚠️ Rewritten from the live definition (0151). One branch is removed:
-- `admin` no longer resolves to tier 2, so an administrator carries no approval
-- limit and `enforce_approval_rules` refuses them at the tier-resolved stage
-- with "you do not carry an approval limit and cannot give final approval".
--
-- The executive keeps tier 3. On the standard chain that is what decision 9's
-- "including above the threshold" means and it is unchanged. On OEA the
-- executive's stage is not tier-resolved at all, so this value is never
-- consulted for them there — kept rather than special-cased, because a tier
-- that varies by brand is a second rule to keep in step for no gain.
create or replace function effective_approval_tier(p_role user_role, p_tier smallint)
returns smallint language sql immutable set search_path = public as $$
  select case p_role
           when 'payment_approver' then p_tier
           when 'executive'        then 3::smallint
           else null::smallint
         end;
$$;

comment on function effective_approval_tier is
  'The amount band a person may clear at the tier-resolved stage. payment_approver carries it as a column; executive is tier 3 (decision 9). ADMIN IS DELIBERATELY ABSENT since decision 23 — "admin not part of money approval" — where 0151 had them at tier 2 under decision 16. Everyone else is null and cannot action that stage at all.';

-- ── The rules ─────────────────────────────────────────────────────────────
--
-- ⚠️ Rewritten from the LIVE definition (0175), per the 0136 lesson. Exactly
-- one thing changes and it is an ORDERING change:
--
--   `payment_chain_stages()` needs the org, and the org is resolved from the
--   PAYABLE. 0175 looked the stage up first, at the top of the function. The
--   lookup therefore moves below the payable resolution. Every predicate below
--   it is carried across byte-identical.
--
-- Nothing else moves. In particular the supersession UPDATE stays exactly where
-- 0175 put it — before the checks, so the unique index sees the retired rows —
-- and the rejection check stays unscoped by amount, because a refusal is
-- terminal and scoping it would make one escapable by nudging the figure.
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

  -- ⚠️ MOVED (0211). The stage lookup is org-dependent now, so it cannot happen
  -- before the payable has told us which organisation this is.
  select * into v_stage
    from payment_chain_stages(new.org_id) s
   where s.stage_order = new.stage_order;
  if not found then
    raise exception 'there is no approval stage %', new.stage_order;
  end if;

  -- A new decision is always a live one.
  new.superseded_at := null;

  -- ⚠️ RETIRING THE PREVIOUS ROUND HAPPENS HERE, IN THE TRIGGER, and not in
  -- `record_payment_approval`. Every rule this table enforces lives in this
  -- function precisely so that no write path can miss one, and the table is
  -- written by more than the RPC: the verification suites insert through the
  -- service role directly (scripts/verify-approval-chain.mjs), and a
  -- supersession that only ran inside the RPC would give those paths a
  -- duplicate-key error where the RPC succeeds — the same rule enforced in one
  -- place and absent in another.
  --
  -- Not just the stage being actioned: if the amount moved, the whole round is
  -- void, and leaving stages 2 and 3 standing would let a re-signed stage 1
  -- carry two stale signatures to disbursement. Refusals are untouched — they
  -- are terminal, and `guard_approval_mutation` refuses to supersede one even if
  -- asked.
  --
  -- Updating this table from its own BEFORE INSERT trigger is deliberate and
  -- terminates: the UPDATE fires `guard_approval_mutation` (BEFORE UPDATE), which
  -- inserts nothing, so this function is not re-entered. Doing it before the
  -- checks below is what makes the unique index see the retired rows.
  update payment_approvals a
     set superseded_at = now()
   where a.payable_type  = new.payable_type
     and a.payable_id    = new.payable_id
     and a.decision      = 'approved'
     and a.amount        <> new.amount
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
  -- not make you two people. Same principle as two-tier application review
  -- (0082), where the recommender may not also decide.
  select count(*) into v_self
    from payment_approvals a
   where a.payable_type  = new.payable_type
     and a.payable_id    = new.payable_id
     and a.actor_id      = new.actor_id
     and a.superseded_at is null;
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

-- ── The gate ──────────────────────────────────────────────────────────────
--
-- ⚠️ Rewritten from the LIVE definition (0175). The only change is that the
-- stage list is now resolved for the payable's OWN organisation. `superseded_at
-- is null` and the amount equality are carried across unchanged — without them
-- an amount edited away and back again (₦100 → ₦200 → ₦100) would find the
-- original superseded rows matching on amount and report an invalidated chain
-- as complete.
--
-- A payable that cannot be resolved yields a NULL org, which
-- `org_payment_chain` answers as 'standard'. That returns three stages with no
-- approvals against them, so the answer is "not cleared" — the safe direction
-- for a row nobody can find.
create or replace function is_cleared_for_disbursement(
  p_payable_type text,
  p_payable_id   uuid,
  p_amount       numeric
) returns boolean language sql stable set search_path = public as $$
  select not exists (
    select 1
      from payment_chain_stages(
             (select rp.org_id from resolve_payable(p_payable_type, p_payable_id) rp)
           ) s
     where not exists (
       select 1 from payment_approvals a
        where a.payable_type  = p_payable_type
          and a.payable_id    = p_payable_id
          and a.stage_order   = s.stage_order
          and a.decision      = 'approved'
          and a.amount        = p_amount
          and a.superseded_at is null
     )
  );
$$;

comment on function is_cleared_for_disbursement is
  'Every stage of THIS ORGANISATION''S chain approved, live, at the amount now being disbursed. The amount re-check closes "approve small, pay large" (0151); the superseded check closes the same hole reopened by an amount edited away and back again (0175); the org-resolved stage list is decision 23''s OEA ladder (0211).';

-- ── The chain, read up to a point ─────────────────────────────────────────
--
-- ⚠️ Rewritten from the LIVE definition (0184). Same single change: the stages
-- come from the payable's own organisation.
create or replace function chain_cleared_before(
  p_payable_type text,
  p_payable_id   uuid,
  p_amount       numeric,
  p_stage        smallint
)
returns boolean language sql stable set search_path = public as $$
  select not exists (
    select 1
      from payment_chain_stages(
             (select rp.org_id from resolve_payable(p_payable_type, p_payable_id) rp)
           ) s
     where s.stage_order < p_stage
       and not exists (
         select 1 from payment_approvals a
          where a.payable_type  = p_payable_type
            and a.payable_id    = p_payable_id
            and a.stage_order   = s.stage_order
            and a.decision      = 'approved'
            and a.amount        = p_amount
            and a.superseded_at is null
       )
  );
$$;

comment on function chain_cleared_before is
  'Whether every approval stage BEFORE p_stage is approved at p_amount — "has this reached my desk yet". The bounded form of is_cleared_for_disbursement, which is this function with p_stage past the last stage. One definition so the two cannot disagree about what counts as an approval; in particular an approval given at a different amount counts as none (0175), and the stage list is the payable''s own organisation''s (0211).';

-- ── Why it is not clear, said accurately ───────────────────────────────────
--
-- ⚠️ Rewritten from the LIVE definition (0175). Two changes: the stage total is
-- read from the org's own chain rather than the literal `3`, and the message
-- names the ladder. Everything else — the rejection branch, the live-only
-- counts, the stale/incomplete distinction — is carried across unchanged.
create or replace function assert_chain_cleared(p_type text, p_id uuid, p_amount numeric)
returns void language plpgsql stable set search_path = public as $$
declare
  v_done int;
  v_rejected int;
  v_stale int;
  v_total int;
begin
  if is_cleared_for_disbursement(p_type, p_id, p_amount) then
    return;
  end if;

  select count(*) into v_rejected from payment_approvals
   where payable_type = p_type and payable_id = p_id
     and decision = 'rejected' and superseded_at is null;
  if v_rejected > 0 then
    raise exception 'this payment was rejected and must not be sent';
  end if;

  -- Live approvals for the figure being paid, and live approvals for some other
  -- figure. The second is what "it changed after approval" actually means.
  select
    count(*) filter (where a.amount = p_amount),
    count(*) filter (where a.amount <> p_amount)
    into v_done, v_stale
    from payment_approvals a
   where a.payable_type = p_type and a.payable_id = p_id
     and a.decision = 'approved' and a.superseded_at is null;

  if v_stale > 0 then
    raise exception
      'the amount changed after it was approved — it has to go back through approval at ₦%',
      trim(to_char(p_amount, 'FM999,999,999,990.00'));
  end if;

  select count(*) into v_total
    from payment_chain_stages(
           (select rp.org_id from resolve_payable(p_type, p_id) rp)
         );

  raise exception
    'this payment has only cleared % of % approval stages and cannot be sent', v_done, v_total;
end;
$$;

comment on function assert_chain_cleared is
  'Raises with the reason a payable is not clear to send — incomplete, rejected, or approved at a different amount. Counts LIVE rows only (0175), and the stage total is the paying organisation''s own chain rather than a hardcoded 3 (0211).';

-- ── Bulk approval follows the same ladder ─────────────────────────────────
--
-- ⚠️ Rewritten from the LIVE definition (0155). Two changes:
--
--   1. the "which stage is next" lookup reads the PAYMENT'S OWN org chain;
--   2. 📌 it now excludes superseded and wrong-amount rows. 0155 predates 0175
--      and asked only whether a row existed for the stage, so on a payable
--      whose amount had changed it found the retired rows, concluded every
--      stage was complete, and answered "every approval stage on this payment
--      is already complete" for a payment that in fact had to be re-approved
--      from stage 1. That is the same staleness bug 0175 fixed in four other
--      places and missed here; it is fixed while the function is open rather
--      than filed, because it is one predicate on a money path.
create or replace function approve_payments(p_ids uuid[])
returns table (payment_id uuid, approved boolean, reason text)
language plpgsql as $$
declare
  v_id uuid;
  v_stage smallint;
  v_org uuid;
  v_amount numeric;
begin
  if p_ids is null or array_length(p_ids, 1) is null then
    return;
  end if;

  if array_length(p_ids, 1) > 200 then
    raise exception 'a batch may hold at most 200 payments (this one has %)', array_length(p_ids, 1);
  end if;

  foreach v_id in array p_ids loop
    begin
      select p.org_id, p.amount into v_org, v_amount from payments p where p.id = v_id;

      -- Which stage is actually next on THIS payment, on THIS organisation's
      -- ladder. A batch will usually be all one stage, but a mixed selection is
      -- legitimate and hardcoding a stage number would refuse them for the
      -- wrong reason.
      select s.stage_order into v_stage
        from payment_chain_stages(v_org) s
       where not exists (
         select 1 from payment_approvals a
          where a.payable_type  = 'vendor_payment'
            and a.payable_id    = v_id
            and a.stage_order   = s.stage_order
            and a.decision      = 'approved'
            and a.amount        = v_amount
            and a.superseded_at is null
       )
       order by s.stage_order
       limit 1;

      if v_stage is null then
        payment_id := v_id; approved := false;
        reason := 'every approval stage on this payment is already complete';
        return next;
        continue;
      end if;

      -- Visibility check first, so an id that is not this caller's produces the
      -- same deliberately ambiguous answer 0127 gave rather than a trigger
      -- exception that might describe someone else's payment.
      if not exists (select 1 from payments where id = v_id and status = 'recommended') then
        payment_id := v_id; approved := false;
        reason := 'not awaiting approval, or not yours to approve';
        return next;
        continue;
      end if;

      perform record_payment_approval('vendor_payment', v_id, v_stage, 'approved', null);

      payment_id := v_id; approved := true; reason := null;
      return next;

    exception when others then
      payment_id := v_id; approved := false; reason := sqlerrm;
      return next;
    end;
  end loop;
end;
$$;

revoke all on function approve_payments(uuid[]) from public;
revoke execute on function approve_payments(uuid[]) from anon;
grant execute on function approve_payments(uuid[]) to authenticated;

comment on function approve_payments is
  'Records one stage decision on many payments in a single call, each through record_payment_approval individually — so tier, role, separation of duties and the server-resolved amount all apply exactly as they do to a single approval. Reads each payment''s OWN organisation chain (0211) and counts only live approvals at the current amount, which 0155 did not: on a payable whose amount had moved it reported a re-approvable payment as already complete.';

-- ── Only the payment officer releases money ───────────────────────────────
--
-- ⚠️ Rewritten from the LIVE definition (0151). One predicate changes: the
-- `remitted` guard drops `admin`.
--
-- `assert_may_disburse` (0142) has been finance-only since decision 16, so
-- every remittance path already refused an administrator. This is the second,
-- looser gate on the same act — the status write itself — and it disagreed with
-- the first. Decision 23 settles it in the strict direction.
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
      raise exception 'only the payment officer or an administrator may reopen a rejected invoice';
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

    -- Approval is the CHAIN's outcome, not a role's prerogative. The threshold
    -- escalation that used to live here moved into resolve_required_tier(),
    -- which decides it per band and is enforced at the tier-resolved stage.
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
    -- ⚠️ `admin` removed (decision 23). Oversight authorises; the payment
    -- officer disburses. assert_may_disburse has enforced exactly this on every
    -- remittance path since 0142 — this gate is the one that disagreed.
    if caller_role <> 'finance_approver' then
      raise exception 'only the payment officer may remit payments — oversight authorises, the payment officer disburses';
    end if;
  end if;

  return new;
end;
$$;

comment on function enforce_payment_transition is
  'The B4 gate. Legal transitions, verification/performance conditions, and approval only as the OUTCOME OF THE CHAIN rather than an act available to a role (0151). Since decision 23 the `remitted` transition is the payment officer alone — an administrator may still reopen a rejected invoice, which is administration, not disbursement.';

-- ── The brand can no longer be edited by the organisation ─────────────────
--
-- ⚠️ THE CONTROL THIS WHOLE MIGRATION RESTS ON. `delivery_brand` selects the
-- approval ladder as of today, so it stops being a branding preference and
-- becomes a non-delegable control under decision 7.
--
-- 0083c's pattern, reused exactly: the table-level grant was already revoked
-- there, so it is enough to re-issue the allowlist WITHOUT this column — a
-- column left off is unwritable by construction, not by a revoke that a future
-- table-level grant could silently re-cover.
--
-- Nothing in the application writes it. `operator_provision_org` (0079b) sets
-- it on INSERT as the table owner, which this does not touch; the 47 other
-- references across the app are reads, for theming and role labels.
grant update (
  name, parent_org_id,
  theme_primary, theme_accent, theme_logo_text, logo_url, portal_name, tagline,
  support_email, support_phone, login_headline,
  vendor_applications_open, finance_email, it_email,
  email_from_name, email_from_address,
  tenant_applications_open
) on orgs to authenticated;

revoke update (delivery_brand) on orgs from authenticated, anon;

comment on column orgs.delivery_brand is
  'Which brand delivers this organisation''s work — and, since decision 23, which approval ladder it climbs (org_payment_chain). NOT in the UPDATE column allowlist: set once by operator_provision_org and changed by nobody afterwards. It was grantable to `authenticated` until 0211, which was harmless while it only chose a colour palette and an escalation the moment it chose an approval chain.';

-- ── In-flight OEA payables re-climb the new ladder ────────────────────────
--
-- ⚠️ A BEHAVIOURAL CHANGE ON EXISTING DATA, stated at apply time rather than
-- discovered by a finance lead pressing Send.
--
-- An OEA payable part-way up the old ladder carries a stage-1 row signed by an
-- FM/PM. Stage 1 is now the audit review, and nothing in
-- `is_cleared_for_disbursement` looks at WHO signed a stage — only that an
-- approved, live row exists for it at the current amount. Left alone, those
-- payables would count the FM's sign-off as the audit's review and reach
-- disbursement having been seen by neither the auditor nor the MP. That is the
-- exact outcome the board's direction exists to prevent.
--
-- So every live approval on an undisbursed OEA payable is SUPERSEDED — 0175's
-- mechanism, used for the purpose it was built for: the round is void, the
-- record of who signed what at which figure is retained in full, and the chain
-- is climbed again under the shape that now applies.
--
-- 📌 Scoped to payables that have NOT been paid. A remitted payment's approval
-- trail is history and history is not rewritten; `guard_approval_mutation`
-- would permit the update, and it is this WHERE clause that declines to make
-- it. Rejections are untouched — they are terminal, and 0175's guard refuses to
-- supersede one even if asked.
do $$
declare
  v_voided int;
begin
  with retired as (
    update payment_approvals a
       set superseded_at = now()
     where a.superseded_at is null
       and a.decision = 'approved'
       and org_payment_chain(a.org_id) = 'oea'
       and not exists (
         -- Every state in which money may already have moved. `unknown` is in
         -- the list deliberately — 0040b defines it as "we asked, and do not
         -- know", which is the strongest possible reason not to rewrite the
         -- approval trail behind it. `queued` and `failed` are absent: nothing
         -- has left, and a queued payable that now refuses at send is the
         -- correct outcome, exactly as 0175 accepted for the same reason.
         select 1 from remittances r
          where r.status in ('sending', 'sent', 'unknown', 'reversed')
            and (
              (a.payable_type = 'vendor_payment'  and r.payment_id     = a.payable_id)
              or (a.payable_type = 'landlord_payout' and r.id           = a.payable_id)
              or (a.payable_type = 'ops_requisition' and r.requisition_id = a.payable_id)
            )
       )
       and not (
         a.payable_type = 'vendor_payment'
         and exists (select 1 from payments p where p.id = a.payable_id and p.status = 'remitted')
       )
    returning a.id, a.org_id, a.payable_type, a.payable_id, a.stage_order, a.actor_id
  ),
  logged as (
    insert into audit_log (org_id, actor_id, action, entity_type, entity_id,
                           before_state, after_state)
    select r.org_id, null, 'payment.chain_reshaped', 'payment_approval', r.id,
           jsonb_build_object('payable_type', r.payable_type,
                              'payable_id', r.payable_id::text,
                              'stage_order', r.stage_order,
                              'actor_id', r.actor_id::text,
                              'superseded_at', null),
           jsonb_build_object('payable_type', r.payable_type,
                              'payable_id', r.payable_id::text,
                              'stage_order', r.stage_order,
                              'reason',
                              'OEA approval chain reshaped to audit → MP → payment approver; the round was void under the new shape and must be climbed again — board 28 Aug 2026, decision 23')
      from retired r
    returning 1
  )
  select count(*) into v_voided from logged;

  if v_voided > 0 then
    raise notice
      '0211: % live approval(s) on undisbursed OEA payables were superseded — they were given under the old ladder and the payables now re-climb audit → MP → payment approver. Nothing already remitted was touched.',
      v_voided;
  end if;
end $$;
