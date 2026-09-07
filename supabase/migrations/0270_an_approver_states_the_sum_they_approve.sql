-- An approver states the sum they approve, and the ladder re-climbs at it
-- (7 Sept 2026).
--
-- From the live OEA portal, three payables in a row:
--
--   stage 1  "I cannot pay the required amount, it is too expensive. MP approve 150,000"
--   stage 2  "Go ahead with ₦150,000.00 Thank you."
--   stage 3  "Why was only 150k approve sir? Can we do more?"
--   …and the payable still said ₦166,000. On another, ₦632,200.
--
-- ⚠️ The revised figure lived in PROSE and nothing acted on it. Three desks
-- believed they had authorised ₦150,000; the record said something else; and
-- the payment officer was left to reconcile a comment thread against a number.
-- That is not a display problem — it is an authorisation that exists nowhere
-- the system can act on, on the one field that decides how much money leaves.
--
-- ── What already worked, and is not rebuilt here ──────────────────────────
--
-- `enforce_approval_rules` has been right about this since 0151. It takes the
-- amount from the PAYABLE and never from the insert ("the line that defeats
-- approve-a-small-amount, disburse-a-large-one"), it supersedes every approval
-- given at a different figure, and it refuses a stage whose predecessors signed
-- for a different number. So the moment a payable's amount moves, the ladder is
-- already void and already has to be re-climbed. Nothing in that changes.
--
-- What is added is the ACT: a way for an approver to say the number, so the
-- rules above have something to act on.
--
-- ── Why a revision is recorded as a RETURN ───────────────────────────────
--
-- Because it cannot be recorded as an approval without contradicting the rule
-- above. Revise at stage 2 and stage 1's signature is instantly void — so an
-- `approved` row at stage 2 would fail its own predecessor check ("1 earlier
-- stage still to be approved at 150,000.00"), and forcing it through would mean
-- standing on a signature nobody gave. Decision 30 already built the vocabulary
-- for "this is not right, look again": `returned`. A revision is that, with a
-- figure attached.
--
-- 📌 It voids the WHOLE ladder, not one rung. Decision 30's ordinary return
-- goes back one desk because the work below it is still good; a changed amount
-- makes every signature below it a signature on a different payable. The
-- supersede clause in `enforce_approval_rules` already says exactly this, and
-- has since before this migration — it just had nothing that could move the
-- amount.
--
-- Board-confirmed shape (7 Sept 2026): "the approver states it; the chain
-- re-climbs; the payment officer pays what was approved and cannot edit it."
-- The alternative put to the board — making the sum editable at the point of
-- disbursement — was declined, because it makes the person who RELEASES the
-- money the person who SETS it, which is the concentration decision 16 exists
-- to break.

-- ── 1. The figures, kept ─────────────────────────────────────────────────
--
-- `requested_amount` is what was asked for, written once and never moved, so a
-- screen can show "requested ₦632,200 · approved ₦150,000" rather than only
-- the survivor. Backfilled from the current amount: for everything raised
-- before today those are the same number by definition.
alter table payments          add column if not exists requested_amount numeric(14,2);
alter table ops_requisitions  add column if not exists requested_amount numeric(14,2);

update payments         set requested_amount = amount       where requested_amount is null;
update ops_requisitions set requested_amount = total_amount  where requested_amount is null;

comment on column payments.requested_amount is
  'What was originally claimed, written once at raise time and never moved. `amount` is what is currently authorised and may have been revised by an approver (0270); this is what it started as, so a screen can show both.';
comment on column ops_requisitions.requested_amount is
  'What was originally requested, written once at raise time and never moved (0270).';

-- What THIS approver authorised, on the decision row itself. `amount` on the
-- same row is the payable's figure at the moment of the decision — the two
-- differ only on the row that made the change, which is what makes the trail
-- readable: one row says "this is where the number moved, and who moved it".
alter table payment_approvals add column if not exists approved_amount numeric(14,2);

comment on column payment_approvals.approved_amount is
  'The sum this approver authorised, when they revised it. NULL on an ordinary decision, where the figure is simply `amount`. The row carrying a non-null value is the one that moved the number, and it is a `returned` decision because a revision voids every signature below it (0270).';

-- ── 2. The one write path admits the figure ──────────────────────────────
--
-- Rebuilt from `pg_get_functiondef` (0183). The deactivation guard, the actor
-- resolution and the reason rules are moved unchanged; what is new is the
-- amount branch, and it runs BEFORE the insert so `enforce_approval_rules`
-- reads the amended payable exactly as it reads any other.
create or replace function record_payment_approval(
  p_payable_type text,
  p_payable_id uuid,
  p_stage smallint,
  p_decision text,
  p_reason text default null,
  p_amount numeric default null
)
returns uuid
language plpgsql security definer set search_path = public as $function$
declare
  v_id uuid;
  v_actor uuid := auth.uid();
  v_payable record;
  v_decision text := p_decision;
  v_reason text := nullif(trim(coalesce(p_reason, '')), '');
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

-- ⚠️ The five-argument form is DROPPED FIRST, and before the comment below.
-- With both signatures present, `comment on function record_payment_approval`
-- with no argument list is ambiguous and the migration fails on "function name
-- is not unique" — but the deeper reason to drop it is 0263's: an optional
-- sixth argument leaves two callable signatures for one act, and the old one
-- silently ignores a figure a caller passes.
drop function if exists record_payment_approval(text, uuid, smallint, text, text);

comment on function record_payment_approval(text, uuid, smallint, text, text, numeric) is
  'The one way a stage decision is written. Optionally carries the sum the approver actually authorises (0270): if it differs from the payable, the payable is amended, the decision is recorded as a RETURN whatever was asked for, and the ladder re-climbs at the new figure — because enforce_approval_rules has always refused a stage standing on a signature given for a different number, and a revision makes every signature below it exactly that.';

revoke all on function record_payment_approval(text, uuid, smallint, text, text, numeric) from public, anon;
grant execute on function record_payment_approval(text, uuid, smallint, text, text, numeric) to authenticated, service_role;

-- ── 3. The ordering check learns about the act that voids it ─────────────
--
-- ⚠️ Found by running section 14 of `verify-approval-chain`, not by reading:
-- the revision was refused with
--
--     this payment has 1 earlier stage(s) still to be approved at 150,000.00
--
-- and that refusal is RIGHT for every other decision. "No standing on a
-- signature given for a different figure" is the rule this whole migration
-- rests on — but the row carrying `approved_amount` IS the act that makes those
-- signatures stale. Requiring them to be fresh first asks the revision to
-- happen after its own consequence.
--
-- So the check is skipped for exactly that row and for no other. Everything
-- else runs unchanged: the rejection check, the separation of duties, the tier
-- band, and the supersede-at-a-different-amount clause — which is what retires
-- the stale signatures a few lines above.
--
-- Rebuilt from `pg_get_functiondef` (0183) with one condition added.
create or replace function enforce_approval_rules()
returns trigger
language plpgsql security definer set search_path = public as $function$
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

revoke all on function enforce_approval_rules() from public, anon;
grant execute on function enforce_approval_rules() to authenticated, service_role;


-- ── 4. Prove the rule the whole migration rests on ───────────────────────
--
-- Not "a revision works" (an instance) but "no live approval can survive its
-- payable's amount moving" (the class). If this ever stops holding, every
-- revision above becomes a silent authorisation of a figure nobody signed.
do $$
declare v_def text;
begin
  select pg_get_functiondef(p.oid) into v_def
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'enforce_approval_rules';

  if v_def !~ 'a\.amount\s+<>\s+new\.amount' then
    raise exception 'enforce_approval_rules no longer supersedes approvals given at a different amount — a revision would leave stale signatures standing';
  end if;
  if v_def !~ 'a\.amount\s+=\s+new\.amount' then
    raise exception 'enforce_approval_rules no longer requires earlier stages to have approved at THIS amount';
  end if;
end $$;
