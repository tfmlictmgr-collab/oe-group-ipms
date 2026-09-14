-- 0295 — A return is answered by the desk it was sent to (14 Sept 2026).
--
-- Reported from the OEA Payment Approver's own Approvals screen: kemi soft
-- services, invoice CC004C97, ₦200,000 — "this approval is supposed to be at
-- the payment approver desk but not active to act", under "Waiting on someone
-- else", with the card reading "Sent back to stage 2 for correction … Every
-- stage is already approved."
--
-- ── What the record says ──────────────────────────────────────────────────
--
--   12:06  stage 1 (auditor)          approved
--   12:08  stage 2 (Managing Partner) approved      → retired 12:33 by the return
--   12:33  stage 3 (payment approver) RETURNED to stage 2   ← still live
--   12:35  stage 2 (Managing Partner) approved again
--
-- Decision 30 built a return as "back one rung": stage N sends the payable to
-- stage N-1 and retires N-1's signature, so that desk must look again. The
-- desk that ANSWERS a stage-N return is therefore N-1. But the rule that retires
-- an answered return — `enforce_approval_rules` clause (a), 0250b — retired only
-- a return at the SAME stage as the new decision:
--
--     and a.stage_order = new.stage_order
--
-- which is right for a stage-1 return (the payable goes to the raiser, and the
-- next stage-1 decision answers it) and wrong for every other return. Stage 2's
-- re-approval at 12:35 answered the stage-3 return and left it live. The read
-- side (`getChainState`) then saw a live return at stage 3, concluded stage 3
-- had decided, found no undecided rung, and printed "Every stage is already
-- approved" over a payment nobody could act on. Its own comment stated the
-- premise that made this invisible: "at most one can be live: answering a stage
-- supersedes its own return" — true only of the stage-1 case.
--
-- 📌 The shape decision 24 keeps finding: a rule written for the case in front
-- of the author (a return to the raiser) and silently wrong for the second (a
-- return between desks) — and `verify-approval-chain` tested exactly the first.
--
-- ⚠️ `enforce_offline_confirmation_rules` (0282, decision 45's inbound chain)
-- carries the identical clause. No claim is stuck there today; it would be the
-- first time a stage-2 or stage-3 return is answered from below.
--
-- ── What this does ────────────────────────────────────────────────────────
--
--   1. Both rules retire every live return at this stage OR ABOVE it. A return
--      at stage j can only have been made before anything at a lower stage k
--      acts again (the payable went down to j-1 and re-climbs from there), so a
--      decision at k answers every live return above it. Rebuilt from the live
--      catalogue through a swap that refuses unless it matches exactly once.
--   2. The one stuck payable is repaired: its stage-3 return is retired, dated
--      to the stage-2 re-approval that actually answered it. `guard_approval_
--      mutation` permits exactly this update (superseded_at, once, nothing else),
--      and `audit_payment_approval_supersede` records it in the trail.
--   3. The eight demo payment-approver accounts lose "(tier N)" from their
--      names. Approval bands are off (0261), and the tier in a NAME printed in
--      every decision trail — "OEA Payment Approver (tier 1)" — as though a tier
--      were in play. Demo accounts only (@oegroup.test); a no-op in production.

create or replace function pg_temp.swap(p_def text, p_from text, p_to text, p_what text)
returns text language plpgsql as $$
declare n int;
begin
  n := (length(p_def) - length(replace(p_def, p_from, ''))) / greatest(length(p_from), 1);
  if n <> 1 then
    raise exception '0295 rebuild of %: expected exactly one match, found %', p_what, n;
  end if;
  return replace(p_def, p_from, p_to);
end $$;

-- ── 1a. The outbound chain ────────────────────────────────────────────────
do $$
declare d text;
begin
  d := pg_get_functiondef('public.enforce_approval_rules()'::regprocedure);
  d := pg_temp.swap(d,
    $x$-- (a) 0250b. This stage's outstanding return, answered by this decision.$x$,
    $x$-- (a) 0250b, widened by 0295. Every outstanding return at this stage OR
  -- ABOVE it is answered by this decision: a return at stage N goes to the desk
  -- at N-1, so it is that desk — not stage N — that answers it.$x$,
    'enforce_approval_rules (clause a comment)');
  d := pg_temp.swap(d,
    $x$a.stage_order   = new.stage_order$x$,
    $x$a.stage_order   >= new.stage_order$x$,
    'enforce_approval_rules (clause a)');
  execute d;
end $$;

-- ── 1b. The inbound (off-platform) chain ──────────────────────────────────
do $$
declare d text;
begin
  d := pg_get_functiondef('public.enforce_offline_confirmation_rules()'::regprocedure);
  d := pg_temp.swap(d,
    $x$-- This stage's outstanding return, answered by this decision. 0250b.$x$,
    $x$-- Every outstanding return at this stage OR ABOVE it, answered by this
  -- decision (0250b, widened by 0295): a return at stage N is answered by N-1.$x$,
    'enforce_offline_confirmation_rules (comment)');
  d := pg_temp.swap(d,
    $x$x.stage_order = new.stage_order$x$,
    $x$x.stage_order >= new.stage_order$x$,
    'enforce_offline_confirmation_rules (return clause)');
  execute d;
end $$;

-- ── 2. Repair what is already stuck ───────────────────────────────────────
do $$
declare n int;
begin
  update payment_approvals r
     set superseded_at = (
       select min(a.created_at) from payment_approvals a
        where a.payable_type = r.payable_type and a.payable_id = r.payable_id
          and a.superseded_at is null and a.decision <> 'returned'
          and a.stage_order < r.stage_order and a.created_at > r.created_at)
   where r.decision = 'returned'
     and r.superseded_at is null
     and exists (
       select 1 from payment_approvals a
        where a.payable_type = r.payable_type and a.payable_id = r.payable_id
          and a.superseded_at is null and a.decision <> 'returned'
          and a.stage_order < r.stage_order and a.created_at > r.created_at);
  get diagnostics n = row_count;
  raise notice '0295: % answered return(s) retired on the outbound chain', n;

  update offline_payment_confirmations r
     set superseded_at = (
       select min(a.created_at) from offline_payment_confirmations a
        where a.claim_id = r.claim_id
          and a.superseded_at is null and a.decision <> 'returned'
          and a.stage_order < r.stage_order and a.created_at > r.created_at)
   where r.decision = 'returned'
     and r.superseded_at is null
     and exists (
       select 1 from offline_payment_confirmations a
        where a.claim_id = r.claim_id
          and a.superseded_at is null and a.decision <> 'returned'
          and a.stage_order < r.stage_order and a.created_at > r.created_at);
  get diagnostics n = row_count;
  raise notice '0295: % answered return(s) retired on the inbound chain', n;
end $$;

-- ── 3. No tier in a demo approver's name ──────────────────────────────────
update users
   set full_name = regexp_replace(full_name, ' Payment Approver \(tier 3\)$', ' Second Payment Approver')
 where email like '%.approver3@oegroup.test'
   and full_name ~ ' Payment Approver \(tier 3\)$';

update users
   set full_name = regexp_replace(full_name, ' \(tier [0-9]\)$', '')
 where email like '%@oegroup.test'
   and full_name ~ ' \(tier [0-9]\)$';

-- ── 4. Assert the rule, not this batch ────────────────────────────────────
do $$
declare v_def text; v_left int;
begin
  v_def := pg_get_functiondef('public.enforce_approval_rules()'::regprocedure);
  if v_def !~ 'a\.stage_order\s+>=\s+new\.stage_order' then
    raise exception '0295: the outbound rule still retires only a same-stage return';
  end if;
  -- The rest of clause (a), and the controls around it, survived the rebuild.
  if v_def !~ 'separation of duties' and v_def !~ 'one human, one stage' then
    raise exception '0295: enforce_approval_rules lost its separation-of-duties clause';
  end if;
  if v_def !~ 'resolve_payable' or v_def !~ 'deactivated' then
    raise exception '0295: enforce_approval_rules lost a clause in the rebuild';
  end if;

  v_def := pg_get_functiondef('public.enforce_offline_confirmation_rules()'::regprocedure);
  if v_def !~ 'x\.stage_order\s+>=\s+new\.stage_order' then
    raise exception '0295: the inbound rule still retires only a same-stage return';
  end if;
  if v_def !~ 'you recorded this payment' then
    raise exception '0295: enforce_offline_confirmation_rules lost its maker-checker clause';
  end if;

  -- Nothing is left holding a return its lower desk has already answered.
  select count(*) into v_left from payment_approvals r
   where r.decision = 'returned' and r.superseded_at is null
     and exists (select 1 from payment_approvals a
                  where a.payable_type = r.payable_type and a.payable_id = r.payable_id
                    and a.superseded_at is null and a.decision <> 'returned'
                    and a.stage_order < r.stage_order and a.created_at > r.created_at);
  if v_left > 0 then
    raise exception '0295: % outbound payable(s) still hold an answered return', v_left;
  end if;
  select count(*) into v_left from offline_payment_confirmations r
   where r.decision = 'returned' and r.superseded_at is null
     and exists (select 1 from offline_payment_confirmations a
                  where a.claim_id = r.claim_id
                    and a.superseded_at is null and a.decision <> 'returned'
                    and a.stage_order < r.stage_order and a.created_at > r.created_at);
  if v_left > 0 then
    raise exception '0295: % off-platform claim(s) still hold an answered return', v_left;
  end if;

  if exists (select 1 from users where email like '%@oegroup.test'
                                   and full_name ~ '\(tier [0-9]\)') then
    raise exception '0295: a demo account is still named with a tier';
  end if;
end $$;
