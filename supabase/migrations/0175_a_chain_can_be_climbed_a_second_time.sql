-- An amount change after approval was meant to force re-approval. It made the
-- payment unpayable instead.
--
-- ⚠️ THE DEAD END. 0151 recorded the amount on every stage decision and made
-- `is_cleared_for_disbursement` require all three stages approved AT THE AMOUNT
-- NOW BEING PAID, so that "approve ₦50,000, disburse ₦5,000,000" cannot work.
-- That part is right and is not weakened here. What was missing is any way to
-- climb the ladder a second time:
--
--   • `unique (payable_type, payable_id, stage_order)` allows exactly one row
--     per stage, for ever — so a second stage-1 approval raises a duplicate-key
--     error;
--   • `trg_approvals_append_only` refuses every UPDATE and DELETE, so the stale
--     row cannot be moved out of the way either;
--   • `enforce_approval_rules`' own separation-of-duties check would refuse the
--     original approver anyway ('you already actioned an earlier stage');
--   • and its "every earlier stage approved" check does not require those
--     earlier approvals to be at the current amount, so stage 3 was reachable
--     over stale stages 1 and 2.
--
-- The result: after any edit to the figure, `ChainTrail` correctly announced
-- "every stage has to be approved again at ₦X" and nothing in the product or the
-- database could do it. The payable sat permanently unapprovable and
-- permanently undisbursable, with the collected money already claimed in the
-- landlord and requisition cases.
--
-- ── Supersession, not deletion ────────────────────────────────────────────
--
-- A decision is still never deleted and never edited: 0151's reasoning that "an
-- approval that can be edited afterwards is not evidence of anything" holds
-- exactly. A stale decision is instead STAMPED as superseded, which is a fourth
-- thing this table can record rather than a licence to rewrite the other three.
-- The old row stays readable, with its actor, its timestamp and the figure it
-- was given for — that trail is the entire explanation of why a payment went
-- back to stage 1, and the audit answer to "who approved the earlier amount".
--
-- The permitted UPDATE is exactly one shape, enforced below: `superseded_at`
-- null → now, on an APPROVED row, with every other column bit-identical. A
-- refusal is never superseded — a refusal is terminal, and a supersedable one
-- could be cleared by nudging the amount, which is the very manoeuvre the
-- amount re-check exists to defeat.

-- ── The stamp ─────────────────────────────────────────────────────────────
alter table payment_approvals
  add column if not exists superseded_at timestamptz;

comment on column payment_approvals.superseded_at is
  'When this decision stopped counting, because the payable''s amount changed and the chain had to be climbed again at the new figure. Null for a live decision. The row is retained, never deleted: it is the record of who approved the earlier amount (0175).';

-- One LIVE row per stage. The old table-level constraint permitted one row per
-- stage for all time, which is what made a second round impossible.
alter table payment_approvals drop constraint if exists payment_approvals_payable_type_payable_id_stage_order_key;
alter table payment_approvals drop constraint if exists payment_approvals_payable_id_stage_order_key;

do $$
declare
  v_name text;
  v_cols smallint[];
begin
  -- The constraint was created inline by `unique (...)` in 0151, so its name is
  -- whatever Postgres chose and the guesses above may miss. Found rather than
  -- guessed, per the 0136 lesson — and matched on its exact COLUMN SET, not
  -- merely "a unique constraint with three columns", so a differently-shaped
  -- constraint added later is never dropped by this block.
  select array_agg(attnum order by attnum) into v_cols
    from pg_attribute
   where attrelid = 'payment_approvals'::regclass
     and attname in ('payable_type', 'payable_id', 'stage_order');

  for v_name in
    select conname
      from pg_constraint
     where conrelid = 'payment_approvals'::regclass
       and contype = 'u'
       and (select array_agg(k order by k) from unnest(conkey) as k) = v_cols
  loop
    execute format('alter table payment_approvals drop constraint %I', v_name);
    raise notice '0175: dropped the all-time unique constraint %', v_name;
  end loop;
end $$;

-- One live row per stage. Also serves every lookup in this file, so no separate
-- non-unique index is added alongside it.
create unique index if not exists payment_approvals_live_stage_uidx
  on payment_approvals (payable_type, payable_id, stage_order)
  where superseded_at is null;

-- ── Append-only, with one exception spelled out ────────────────────────────
create or replace function guard_approval_mutation()
returns trigger language plpgsql set search_path = public as $$
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
  if old.decision <> 'approved' then
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
$$;

drop trigger if exists trg_approvals_append_only on payment_approvals;
create trigger trg_approvals_append_only
  before update or delete on payment_approvals
  for each row execute function guard_approval_mutation();

-- `reject_approval_mutation` is left in place but no longer attached: dropping a
-- function another migration may still reference buys nothing.
comment on function reject_approval_mutation is
  'Superseded by guard_approval_mutation (0175), which permits the one update shape supersession needs and refuses every other. No longer attached to any trigger.';

-- ── The rules, with staleness accounted for ───────────────────────────────
--
-- ⚠️ Rewritten from the LIVE definition, per the 0136 lesson. Three predicates
-- change and one deliberately does not:
--
--   • earlier stages must be approved AT `new.amount` AND live. Previously any
--     approval counted, so stage 3 was reachable over stale stages 1 and 2 —
--     three signatures on the record, only one of them for the figure being
--     paid.
--   • the rejection check stays UNSCOPED by amount. A refusal blocks the
--     payable outright, and scoping it would make a refusal escapable.
--   • separation of duties applies within the LIVE round. Across rounds it is
--     unchanged in effect: a superseded decision authorises nothing, and the
--     round that actually releases money still needs three distinct people.
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
    from payment_chain_stages() s
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
-- ⚠️ `superseded_at is null` is REQUIRED here, not tidiness. Without it an
-- amount edited away and then back again — ₦100 → ₦200 → ₦100 — would find the
-- original superseded rows matching on amount and report a chain that had been
-- invalidated as complete.
create or replace function is_cleared_for_disbursement(
  p_payable_type text,
  p_payable_id   uuid,
  p_amount       numeric
) returns boolean language sql stable set search_path = public as $$
  select not exists (
    select 1 from payment_chain_stages() s
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
  'Every stage approved, live, at the amount now being disbursed. The amount re-check closes "approve small, pay large" (0151); the superseded check closes the same hole reopened by an amount edited away and back again (0175).';

-- ── Why it is not clear, said accurately ───────────────────────────────────
--
-- Diagnostics only — `is_cleared_for_disbursement` above is the gate. But its
-- counts have to exclude superseded rows too, or a payable on its second round
-- would count six approvals, take the `>= 3` branch, and report "the amount
-- changed after it was approved" to someone whose actual problem is that stage 2
-- of the CURRENT round has not been signed yet. A wrong sentence on a money path
-- sends a person to the wrong screen.
create or replace function assert_chain_cleared(p_type text, p_id uuid, p_amount numeric)
returns void language plpgsql stable set search_path = public as $$
declare
  v_done int;
  v_rejected int;
  v_stale int;
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

  raise exception
    'this payment has only cleared % of 3 approval stages and cannot be sent', v_done;
end;
$$;

comment on function assert_chain_cleared is
  'Raises with the reason a payable is not clear to send — incomplete, rejected, or approved at a different amount. Counts LIVE rows only (0175): on a second round a superseded first round would otherwise be counted and reported as an amount change when the real answer is an unsigned stage.';

-- `record_payment_approval` is deliberately UNCHANGED by this migration. It
-- still does nothing but validate the shape of the request and insert; retiring
-- the previous round belongs to the trigger, where every other rule this table
-- enforces already lives, so that no write path can skip it.
comment on function record_payment_approval is
  'Records one stage decision as the CALLER (auth.uid()), never as the service role — the separation-of-duties check is the whole basis of the chain. Every rule, including retiring a round made stale by an amount change (0175), is enforced by enforce_approval_rules rather than here.';

-- ── The last gate before a transfer, for all three payables ────────────────
--
-- ⚠️ Rewritten from the LIVE definition (0152). The maker-checker there derived
-- the payable from `r.party` alone:
--
--     payable_type = case when r.party = 'landlord' then 'landlord_payout'
--                                                   else 'vendor_payment' end
--     payable_id   = coalesce(r.payment_id, r.id)
--
-- A requisition remittance carries `party = 'vendor'` (or `'other'`) with
-- `payment_id` NULL and `requisition_id` set, so that resolved to
-- `('vendor_payment', <the remittance's own id>)` — a pair no approval is ever
-- filed under. The check could not match a row, and the `party = 'landlord'`
-- guard meant the chain was not re-checked either, so for a requisition this
-- gate was a no-op in both of its jobs. 0173 does run both checks when it
-- CREATES the remittance, which is why nothing was exploitable; but the last
-- gate before money moves should not be relying on that.
--
-- The requisition's chain is asserted against the REQUISITION'S TOTAL, not the
-- remittance's net: one requisition is settled as one remittance per payee, so
-- the net here is a subset of the total the chain was approved at, and asserting
-- against it would refuse every correct payout.
drop function if exists claim_remittance_for_sending(uuid, uuid);

create function claim_remittance_for_sending(p_id uuid, p_sent_by uuid)
returns remittances language plpgsql security definer set search_path = public as $$
declare
  r remittances%rowtype;
  v_type text;
  v_payable uuid;
  v_amount numeric;
begin
  select * into r from remittances where id = p_id for update;
  if r.id is null then
    raise exception 'remittance not found';
  end if;
  if r.status <> 'queued' then
    raise exception 'this remittance is already %', r.status;
  end if;

  perform assert_may_disburse(p_sent_by, r.org_id);

  -- Which payable's chain governs this remittance. Ordered by specificity:
  -- a requisition remittance is recognisable only by `requisition_id`, and it
  -- may carry either party.
  if r.requisition_id is not null then
    v_type := 'ops_requisition';
    v_payable := r.requisition_id;
    select total_amount into v_amount from ops_requisitions where id = r.requisition_id;
  elsif r.party = 'landlord' then
    v_type := 'landlord_payout';
    v_payable := r.id;
    v_amount := r.net_amount;
  else
    v_type := 'vendor_payment';
    v_payable := r.payment_id;
    select amount into v_amount from payments where id = r.payment_id;
  end if;

  if v_payable is null then
    raise exception 'this remittance names nothing that can be approved, and cannot be sent';
  end if;

  -- ⚠️ Re-checked for every payable type, not only landlord payouts. A vendor
  -- remittance was gated at creation and a requisition remittance too, but this
  -- is the last point before the money leaves and the cheapest place to be sure.
  perform assert_chain_cleared(v_type, v_payable, v_amount);

  if exists (
    select 1 from payment_approvals a
     where a.payable_type  = v_type
       and a.payable_id    = v_payable
       and a.actor_id      = p_sent_by
       and a.superseded_at is null
  ) then
    raise exception 'you approved this payment and cannot also send it — someone else must release the money';
  end if;

  update remittances set status = 'sending', sent_by = p_sent_by where id = p_id;
  select * into r from remittances where id = p_id;
  return r;
end;
$$;

revoke all on function claim_remittance_for_sending(uuid, uuid) from public, anon, authenticated;
grant execute on function claim_remittance_for_sending(uuid, uuid) to service_role;

-- ⚠️ ONE BEHAVIOURAL CHANGE ON EXISTING DATA, stated at apply time rather than
-- discovered by a finance lead pressing Send.
--
-- The chain is now re-checked at claim for VENDOR remittances too, where before
-- only landlord payouts were. `create_vendor_remittance` has asserted the same
-- thing since 0152, so anything raised since then passes — but a vendor
-- remittance left `queued` from BEFORE the chain existed has no approvals filed
-- against it at all, and will now refuse at send.
--
-- That is the safe direction (an unapproved payment does not leave), and it is
-- deliberately a NOTICE rather than an exception: blocking this migration over
-- historical rows would be worse than reporting them. Anything listed needs a
-- decision — take it through the chain, or void it.
do $$
declare
  v_stuck int;
begin
  select count(*) into v_stuck
    from remittances r
   where r.status = 'queued'
     and r.requisition_id is null
     and r.party <> 'landlord'
     and r.payment_id is not null
     and not is_cleared_for_disbursement(
       'vendor_payment', r.payment_id,
       (select p.amount from payments p where p.id = r.payment_id)
     );

  if v_stuck > 0 then
    raise notice
      '0175: % queued vendor remittance(s) have no complete approval chain at their current amount and will now refuse at send. They predate 0151/0152. Take each through Approvals or void it.',
      v_stuck;
  end if;
end $$;

comment on function claim_remittance_for_sending is
  'Claims a queued remittance for sending, and is the last gate before money moves: the sender must be a finance approver of the paying org, the governing payable''s chain must be complete at its current amount, and the sender must have actioned no live stage of it. Resolves the payable from requisition_id / party / payment_id — before 0175 a requisition remittance resolved to a pair no approval is filed under, making both checks no-ops for it (0152, corrected 0175).';
