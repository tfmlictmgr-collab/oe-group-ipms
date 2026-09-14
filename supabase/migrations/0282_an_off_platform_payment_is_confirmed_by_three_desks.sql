-- An off-platform payment is confirmed by three desks (board, 9 Sept 2026).
--
-- The board's instruction, in full: "The payment confirmation should go through a
-- similar path as the approval chain keeping every payment/transaction
-- information, including payment invoice/receipt/proof upload, visible to payment
-- confirmers which are (auditor, executive, payment approver/finance officer)
-- with the payment officer doing the final confirmation for the ledger record."
--
-- So a claim recorded in 0281 climbs:
--
--     1  payment_audit_approver   checks the proof against the breakdown
--     2  executive                authorises
--     3  finance_approver         confirms, AND POSTS IT TO THE LEDGER
--
-- ⚠️ Why this is a PARALLEL chain and not the existing one. `payment_approvals`
-- is genuinely polymorphic already — it carries `payable_type`/`payable_id` and
-- `resolve_payable` dispatches on it — so teaching it a fourth payable would have
-- been the smaller diff. It would also have been wrong. That table's trigger
-- reaches `resolve_required_tier`, `effective_approval_tier` and the per-org
-- `payment_chain_stages`; its outcomes reach `apply_chain_outcome_to_payment`,
-- `assert_may_disburse` and remittance. Every one of those exists to govern money
-- LEAVING the client-funds account. This governs money arriving in it. Decision 16
-- separated those two acts deliberately, and running them through one control
-- surface would re-join them — with the tier ladder, which decision 23 removed
-- from inbound work entirely, silently applying to a tenant's rent payment.
--
-- The shapes are the same because the reasoning is the same. The machinery is
-- separate because the money is going the other way.
--
-- 📌 The stage list takes NO org argument. That is the statement that it does not
-- vary: decision 28 made the OUTBOUND ladder per-org and operator-set, and the
-- board answered this question directly — all three desks, every organisation.
-- An org-shaped variant would be a lever nobody asked for, on a control decision 7
-- says is never a toggle.

-- ── 1. The ladder ───────────────────────────────────────────────────────────

create or replace function offline_confirmation_stages()
returns table (stage_order smallint, required_roles user_role[], label text, posts_ledger boolean)
language sql immutable set search_path = public as $fn$
  select v.stage_order, v.required_roles, v.label, v.posts_ledger
    from (values
      (1::smallint, array['payment_audit_approver']::user_role[],
       'Audit verification of the evidence'::text, false),
      (2::smallint, array['executive']::user_role[],
       'Executive authorisation'::text, false),
      -- ⚠️ `finance_approver` and NOT `payment_approver`. Decision 23 renamed
      -- this role's LABEL to "Payment Officer" and deliberately left the enum
      -- identifier alone, because it is named in 123 files including every money
      -- path. `payment_approver` is a different role — stage 3 of the OUTBOUND
      -- ladder — and the board confirmed it is not involved here.
      (3::smallint, array['finance_approver']::user_role[],
       'Payment Officer confirmation and ledger posting'::text, true)
    ) as v(stage_order, required_roles, label, posts_ledger);
$fn$;

comment on function offline_confirmation_stages is
  'The three desks an off-platform payment passes before it reaches the ledger. Takes no org argument: unlike the outbound ladder (decision 28) this does not vary by organisation (0282).';

-- The stage list and `offline_confirmation_roles()` (0281) must agree, and they
-- are two functions, so the migration proves it rather than assuming it.
do $$
declare v_from_stages user_role[];
begin
  select array_agg(distinct r order by r) into v_from_stages
    from offline_confirmation_stages() s, unnest(s.required_roles) r;
  if v_from_stages <> (select array_agg(distinct r order by r)
                         from unnest(offline_confirmation_roles()) r) then
    raise exception 'the confirmation ladder and the confirmation-roles resolver disagree';
  end if;
end $$;

-- ── 2. The counter-signatures ───────────────────────────────────────────────

create table offline_payment_confirmations (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  claim_id uuid not null references offline_payment_claims(id) on delete cascade,

  stage_order smallint not null check (stage_order between 1 and 3),

  actor_id uuid not null references users(id),
  -- Snapshotted, not joined. The role a person held WHEN they signed; decision 39's
  -- rule, and the same reason `payment_approvals.actor_role` exists.
  actor_role user_role not null,

  -- The figure this signature was given on. A later revision supersedes rather
  -- than rewrites, so the trail says what each desk actually saw.
  amount numeric(16,2) not null,

  decision text not null check (decision in ('confirmed', 'returned', 'rejected')),
  reason text,

  created_at timestamptz not null default now(),
  superseded_at timestamptz
);

create index offline_payment_confirmations_claim_idx
  on offline_payment_confirmations (claim_id, stage_order);
create index offline_payment_confirmations_actor_idx
  on offline_payment_confirmations (actor_id);

-- One LIVE decision per stage per claim. 0175's rule, and the reason a returned
-- round can be re-climbed without the index refusing the second signature.
create unique index offline_confirmations_one_live_per_stage_uidx
  on offline_payment_confirmations (claim_id, stage_order)
  where superseded_at is null;

alter table offline_payment_confirmations enable row level security;

-- Readable by exactly whoever can read the claim. Restated as a subquery on the
-- claim rather than a copy of its rule — decision 8, and 0184's finding about
-- what happens when a policy is restated instead of reused.
create policy offline_payment_confirmations_select on offline_payment_confirmations for select
  using (may_read_offline_claim(claim_id));

grant select on offline_payment_confirmations to authenticated;

create trigger audit_offline_payment_confirmation
  after insert or update on offline_payment_confirmations
  for each row execute function log_audit('collection.offline_confirmation');

-- ── 3. Every rule, in one trigger ───────────────────────────────────────────
--
-- Mirrors `enforce_approval_rules`, and for its stated reason: every rule this
-- table enforces lives in this function precisely so that no write path can miss
-- one. The columns a caller could lie about are overwritten here from the
-- authoritative records rather than trusted — 0273's finding, that
-- `tickets_insert` constrained two columns and left a snapshot client-settable.
create or replace function enforce_offline_confirmation_rules()
returns trigger language plpgsql security definer set search_path = public as $fn$
declare
  v_actor users%rowtype;
  v_claim offline_payment_claims%rowtype;
  v_stage record;
  v_missing integer;
  v_terminal integer;
  v_self integer;
begin
  -- 0195. Null-safe by construction, and the auth.uid() test keeps the service
  -- role passing through for a scheduled or webhook-driven caller.
  if auth.uid() is not null and not current_user_is_active() then
    raise exception 'this account has been deactivated';
  end if;

  select * into v_actor from users where id = new.actor_id;
  if v_actor.id is null then
    raise exception 'that account could not be found';
  end if;

  select * into v_claim from offline_payment_claims where id = new.claim_id;
  if v_claim.id is null then
    raise exception 'that recorded payment could not be found';
  end if;

  -- Stamped from the records, never from the caller.
  new.org_id := v_claim.org_id;
  new.actor_role := v_actor.role;
  new.amount := coalesce(v_claim.confirmed_amount, v_claim.claimed_amount);
  new.superseded_at := null;

  if v_actor.org_id is distinct from v_claim.org_id then
    raise exception 'a payment can only be confirmed by someone in the organisation it belongs to';
  end if;

  -- Already money. Nothing further to decide.
  if v_claim.posted_at is not null then
    raise exception 'that payment has already been confirmed and posted to the ledger';
  end if;

  select * into v_stage from offline_confirmation_stages() s
   where s.stage_order = new.stage_order;
  if not found then
    raise exception 'there is no confirmation stage %', new.stage_order;
  end if;

  -- ⚠️ THE maker-checker, and the reason `recorded_by` is a separate column from
  -- `payer_user_id`. Per person, per claim — not per role. 0142's rule, and its
  -- own note applies unchanged: this can legitimately refuse a Payment Officer
  -- who recorded the walk-in themselves, that is the rule working, and the answer
  -- is a second pair of hands rather than an exception in the code.
  if v_claim.recorded_by = new.actor_id then
    raise exception
      'you recorded this payment, so you cannot also confirm it — it needs a second pair of hands';
  end if;

  if not (v_actor.role = any (v_stage.required_roles)) then
    raise exception '% is actioned by %, and you are %',
      v_stage.label, array_to_string(v_stage.required_roles, ' or '), v_actor.role;
  end if;

  -- This stage's outstanding return, answered by this decision. 0250b.
  update offline_payment_confirmations x
     set superseded_at = now()
   where x.claim_id = new.claim_id
     and x.stage_order = new.stage_order
     and x.decision = 'returned'
     and x.superseded_at is null;

  -- ⚠️ TERMINAL STATE FIRST, and the order is the point rather than a tidiness
  -- preference. With the earlier-stages test above this one, a claim that had
  -- been REFUSED at stage 1 answered a stage-2 attempt with "this payment has 1
  -- earlier stage(s) still to confirm" — true, unhelpful, and actively
  -- misleading, because it invites somebody to go and get stage 1 signed for a
  -- payment that is dead. Both branches refuse; only one of them explains.
  -- Caught by the suite, which asserted the WORDS and not merely that something
  -- was thrown.
  select count(*) into v_terminal
    from offline_payment_confirmations x
   where x.claim_id = new.claim_id
     and x.decision = 'rejected'
     and x.superseded_at is null;
  if v_terminal > 0 or v_claim.status = 'rejected' then
    raise exception 'this payment was already refused and cannot be actioned further';
  end if;

  -- Every earlier stage confirmed, LIVE, and at the amount now in front of this
  -- desk. No skipping, and no standing on a signature given for a different
  -- figure — which is what makes a correction (section 6) force a re-climb.
  select count(*) into v_missing
    from offline_confirmation_stages() s
   where s.stage_order < new.stage_order
     and not exists (
       select 1 from offline_payment_confirmations x
        where x.claim_id = new.claim_id
          and x.stage_order = s.stage_order
          and x.decision = 'confirmed'
          and x.amount = new.amount
          and x.superseded_at is null
     );
  if v_missing > 0 then
    raise exception 'this payment has % earlier stage(s) still to confirm at %',
      v_missing, trim(to_char(new.amount, 'FM999,999,999,990.00'));
  end if;

  -- Separation of duties: one human, one stage. Holding two of the roles does
  -- not make you two people. A `returned` decision is excluded, per 0250b — the
  -- desk that sent it back has to be able to look at the answer.
  select count(*) into v_self
    from offline_payment_confirmations x
   where x.claim_id = new.claim_id
     and x.actor_id = new.actor_id
     and x.decision <> 'returned'
     and x.superseded_at is null;
  if v_self > 0 then
    raise exception 'you already actioned an earlier stage on this payment — it needs a second pair of hands';
  end if;

  return new;
end;
$fn$;

create trigger offline_confirmation_rules
  before insert on offline_payment_confirmations
  for each row execute function enforce_offline_confirmation_rules();

-- ── 4. The ledger posting ───────────────────────────────────────────────────
--
-- The terminal act. One synthetic `payment_intents` row per allocation line,
-- handed to `record_collection` UNCHANGED — so a rent line gets its fee split
-- from the rate snapshotted on the demand (decision 14), a service-charge line
-- credits that property's own fund (decision 27), a part payment leaves the
-- charge `part_paid`, and the receipt is generated from the ledger rather than
-- from anything typed on a form.
--
-- 📌 The executor is passed EXPLICITLY. Decision 23 records that
-- `remittances.created_by` was NULL on every row ever written, because the
-- function stamped `auth.uid()` and was called through the service-role client
-- where that is null by definition — "the one action that moves real money had
-- been the one action with no attributable actor". This is the inbound twin of
-- that action and it is not repeating the mistake.
create or replace function post_offline_payment_claim(
  p_claim_id uuid,
  p_confirmed_by uuid
)
returns integer
language plpgsql security definer set search_path = public as $fn$
declare
  c offline_payment_claims%rowtype;
  a offline_payment_allocations%rowtype;
  v_intent uuid;
  v_entry uuid;
  v_n integer := 0;
  v_total numeric(16,2) := 0;
begin
  if p_confirmed_by is null then
    raise exception 'a ledger posting has to name who authorised it';
  end if;

  select * into c from offline_payment_claims where id = p_claim_id for update;
  if c.id is null then
    raise exception 'that recorded payment could not be found';
  end if;

  -- Idempotent, for the same reason `record_collection` is: a retry is normal
  -- traffic and must not double-post.
  if c.posted_at is not null then
    return 0;
  end if;

  for a in
    select * from offline_payment_allocations
     where claim_id = c.id order by created_at, id
  loop
    v_n := v_n + 1;
    v_total := v_total + a.amount;

    -- ⚠️ A live checkout link on the same charge is now wrong — the debt is being
    -- settled another way — and it also holds `payment_intents_one_live_per_charge_uidx`,
    -- which the synthetic intent below would collide with. Abandoning it is the
    -- correct domain act, not a workaround: leaving a payable link open on a
    -- settled demand is how a tenant pays twice, which is the exact harm 0045's
    -- one-live-intent rule exists to prevent.
    if a.rent_charge_id is not null then
      update payment_intents set status = 'abandoned'
       where rent_charge_id = a.rent_charge_id and status = 'pending';
    elsif a.service_charge_id is not null then
      update payment_intents set status = 'abandoned'
       where service_charge_id = a.service_charge_id and status = 'pending';
    end if;

    insert into payment_intents (
      org_id, purpose, rent_charge_id, service_charge_id, property_id, unit_id,
      payer_user_id, payer_email, amount_expected, currency,
      gateway, gateway_reference, created_by
    ) values (
      c.org_id, a.purpose, a.rent_charge_id, a.service_charge_id,
      a.property_id, a.unit_id,
      c.payer_user_id, c.payer_email, a.amount, c.currency,
      -- 'manual' has sat in the `payment_gateway` enum since 0032 and nothing
      -- has ever written it. This is what it was for.
      'manual', c.reference || '-' || lpad(v_n::text, 2, '0'),
      -- The person who AUTHORISED the posting, so `ledger_entries.created_by`
      -- names them. Who RECORDED it is on the claim, and the three signatures
      -- are on `offline_payment_confirmations`; between them the trail answers
      -- "who did this and when" at every step.
      p_confirmed_by
    )
    returning id into v_intent;

    -- Dated to the day the money moved, not the day it was confirmed, so it
    -- reconciles against the bank's own line for that date.
    v_entry := record_collection(v_intent, a.amount, c.paid_on::timestamptz);

    update offline_payment_allocations
       set intent_id = v_intent, ledger_entry_id = v_entry
     where id = a.id;
  end loop;

  if v_n = 0 then
    raise exception 'that payment has no breakdown, so there is nothing to post';
  end if;

  update offline_payment_claims
     set status = 'confirmed',
         confirmed_amount = v_total,
         confirmed_by = p_confirmed_by,
         posted_at = now(),
         decided_at = now()
   where id = c.id;

  return v_n;
end;
$fn$;

comment on function post_offline_payment_claim is
  'The terminal act of the confirmation chain: posts each allocation line through record_collection, unchanged, so an off-platform payment reaches the ledger by exactly the path a card payment does (0282).';

-- ── 5. The one way to action a stage ────────────────────────────────────────
--
-- Thin, exactly as `record_payment_approval` is thin: it validates the shape of
-- the request and inserts, and the trigger above owns every rule. Then it
-- applies the consequence, because a decision that is recorded and never acted
-- on is the fault decision 30 found — "the one write path had to admit the third
-- decision", and every rule being in place counts for nothing if the function
-- cannot express the outcome.
create or replace function confirm_offline_payment(
  p_claim_id uuid,
  p_stage smallint,
  p_decision text,
  p_reason text default null,
  p_statement_line_id uuid default null
)
returns uuid
language plpgsql security definer set search_path = public as $fn$
declare
  v_actor uuid := active_uid();
  v_reason text := nullif(trim(coalesce(p_reason, '')), '');
  v_id uuid;
  v_posts boolean;
  v_line bank_statement_lines%rowtype;
  c offline_payment_claims%rowtype;
begin
  if v_actor is null then
    raise exception 'your session expired - sign in again';
  end if;
  if p_decision not in ('confirmed', 'returned', 'rejected') then
    raise exception 'a stage is confirmed, sent back for correction, or refused';
  end if;

  -- Decision 30's rule, and 0142's: a refusal nobody can act on is a dead end.
  -- The person on the other end of this is a tenant who believes they have paid.
  if p_decision in ('returned', 'rejected')
     and (v_reason is null or length(v_reason) < 10) then
    raise exception 'tell them why in at least 10 characters - a refusal nobody can act on is a dead end';
  end if;

  select * into c from offline_payment_claims where id = p_claim_id;
  if c.id is null then
    raise exception 'that recorded payment could not be found';
  end if;

  select s.posts_ledger into v_posts
    from offline_confirmation_stages() s where s.stage_order = p_stage;

  -- ── The optional bank line ───────────────────────────────────────────────
  --
  -- The board settled on a standalone attestation with the match OPTIONAL, so an
  -- organisation that has not yet imported a statement can still confirm a
  -- payment it can see in its banking app. Where one IS named it is vetted, and
  -- it is only accepted at the desk that posts: a match recorded by the audit
  -- desk and then contradicted by the Payment Officer would be two answers to
  -- one question.
  if p_statement_line_id is not null then
    if not coalesce(v_posts, false) then
      raise exception 'a bank line is matched at the Payment Officer desk, where the money is posted';
    end if;
    select * into v_line from bank_statement_lines where id = p_statement_line_id;
    if v_line.id is null or v_line.org_id is distinct from c.org_id then
      raise exception 'that bank statement line could not be found';
    end if;
    if v_line.bank_account_id is distinct from c.destination_bank_account_id then
      raise exception 'that line is on a different account to the one this payment names';
    end if;
    if v_line.status = 'matched' then
      raise exception 'that bank line is already matched to something else';
    end if;
    if v_line.amount <= 0 then
      raise exception 'that line is money leaving the account, not arriving in it';
    end if;
  end if;

  insert into offline_payment_confirmations (
    org_id, claim_id, stage_order, actor_id, actor_role, amount, decision, reason
  ) values (
    -- org, role and amount are overwritten by the trigger from the authoritative
    -- records. These placeholders satisfy NOT NULL and nothing else - the same
    -- shape `record_payment_approval` uses, and for the same reason.
    '00000000-0000-0000-0000-000000000000', p_claim_id, p_stage,
    v_actor, 'viewer', 1, p_decision, v_reason
  )
  returning id into v_id;

  -- ── The consequence ──────────────────────────────────────────────────────
  if p_decision = 'rejected' then
    update offline_payment_claims
       set status = 'rejected', decided_at = now(), decision_reason = v_reason
     where id = p_claim_id;

  elsif p_decision = 'returned' then
    if p_stage = 1 then
      -- No rung below. It goes back to the person who recorded it, and the claim
      -- says so - decision 30's `returned_for_correction`.
      update offline_payment_claims
         set status = 'returned_for_correction', decided_at = now(),
             decision_reason = v_reason
       where id = p_claim_id;
    else
      -- Back one desk. That stage's signature is RETIRED rather than deleted: a
      -- signature given on the figures as they were is not a signature on the
      -- figures as corrected, and the trail has to keep both.
      update offline_payment_confirmations x
         set superseded_at = now()
       where x.claim_id = p_claim_id
         and x.stage_order = p_stage - 1
         and x.decision = 'confirmed'
         and x.superseded_at is null;
    end if;

  elsif coalesce(v_posts, false) then
    -- The terminal desk. Money.
    if p_statement_line_id is not null then
      update offline_payment_claims
         set matched_statement_line_id = p_statement_line_id
       where id = p_claim_id;
    end if;

    perform post_offline_payment_claim(p_claim_id, v_actor);

    if p_statement_line_id is not null then
      update bank_statement_lines
         set status = 'matched',
             matched_entry_id = (
               select a.ledger_entry_id from offline_payment_allocations a
                where a.claim_id = p_claim_id and a.ledger_entry_id is not null
                order by a.created_at limit 1
             ),
             matched_at = now(), matched_by = v_actor
       where id = p_statement_line_id;
    end if;
  end if;

  return v_id;
end;
$fn$;

comment on function confirm_offline_payment is
  'Actions one stage of the off-platform confirmation chain. The terminal stage posts the payment to the ledger. Every rule lives in enforce_offline_confirmation_rules (0282).';

-- ── 6. A returned claim has a way back ──────────────────────────────────────
--
-- ⚠️ Without this the chain is a trap. Decision 30 was written because a refusal
-- at the Managing Partner's desk killed a requisition outright, and 0170's own
-- header admits an ops requisition then had "no path that lets a raised
-- requisition be edited after the fact rather than rejected and re-raised". The
-- same sentence would be true here, about a tenant's rent.
--
-- Only from `returned_for_correction`, only by the person who recorded it or
-- somebody who could have recorded it, and it supersedes every live signature -
-- because they were given on figures that have just moved.
create or replace function correct_offline_payment_claim(
  p_claim_id uuid,
  p_amount numeric,
  p_allocations jsonb,
  p_paid_on date default null,
  p_payer_reference text default null,
  p_payer_note text default null,
  p_proof_path text default null,
  p_proof_filename text default null
)
returns uuid
language plpgsql security definer set search_path = public as $fn$
declare
  v_actor uuid := active_uid();
  c offline_payment_claims%rowtype;
  v_payer uuid;
  v_paid_on date;
begin
  if v_actor is null then
    raise exception 'your session expired - sign in again';
  end if;

  select * into c from offline_payment_claims where id = p_claim_id for update;
  if c.id is null then
    raise exception 'that recorded payment could not be found';
  end if;

  if c.status <> 'returned_for_correction' then
    raise exception
      'that payment is not waiting for a correction - it is %',
      replace(c.status::text, '_', ' ');
  end if;

  if c.recorded_by <> v_actor and not has_permission('payments.record_offline') then
    raise exception 'only the person who recorded this payment can correct it';
  end if;

  if p_amount is null or p_amount <= 0 then
    raise exception 'enter the amount you paid - it has to be more than nothing';
  end if;

  v_paid_on := coalesce(p_paid_on, c.paid_on);
  if v_paid_on > current_date then
    raise exception 'say what date the payment was made - it cannot be in the future';
  end if;

  -- A better photograph is very often exactly what was asked for.
  if p_proof_path is not null and trim(p_proof_path) <> '' then
    if (storage.foldername(p_proof_path))[1] is distinct from c.org_id::text then
      raise exception 'that proof was not uploaded to this organisation';
    end if;
    if not exists (
      select 1 from storage.objects
       where bucket_id = 'payment-proofs' and name = p_proof_path
    ) then
      raise exception 'that proof could not be found — attach the file again';
    end if;
  end if;

  update offline_payment_claims
     set claimed_amount = round(p_amount, 2),
         paid_on = v_paid_on,
         payer_reference = coalesce(nullif(trim(coalesce(p_payer_reference, '')), ''), payer_reference),
         payer_note = coalesce(nullif(trim(coalesce(p_payer_note, '')), ''), payer_note),
         proof_path = coalesce(nullif(trim(coalesce(p_proof_path, '')), ''), proof_path),
         proof_filename = coalesce(nullif(trim(coalesce(p_proof_filename, '')), ''), proof_filename),
         status = 'submitted',
         decided_at = null,
         decision_reason = null
   where id = p_claim_id;

  v_payer := write_offline_claim_allocations(p_claim_id, p_allocations, round(p_amount, 2));

  update offline_payment_claims
     set payer_user_id = coalesce(payer_user_id, v_payer)
   where id = p_claim_id;

  -- Every live signature retired. The ladder re-climbs from the bottom, which is
  -- the same rule 0270 applies when an approved amount moves.
  update offline_payment_confirmations
     set superseded_at = now()
   where claim_id = p_claim_id and superseded_at is null;

  return p_claim_id;
end;
$fn$;

comment on function correct_offline_payment_claim is
  'Corrects a returned off-platform payment and sends it back up the chain from stage 1, retiring every signature given on the old figures (0282).';

-- ── 7. What each audience reads ─────────────────────────────────────────────
--
-- ⚠️ Every reader below is SECURITY DEFINER — a tenant holds no read on
-- `properties`, `units`, `rent_charges` or `users`, and these exist precisely to
-- give them names for their own payment. They therefore CANNOT gate on RLS, and
-- they do not: each one calls `may_read_offline_claim` (0281), the same predicate
-- both policies use.
--
-- 📌 The first draft gated on a SECURITY INVOKER helper, reasoning that the
-- policy should decide. Inside a definer body the current role is the OWNER, so
-- that helper bypassed RLS and answered true for everyone — a gate that reads
-- correctly and admits the whole table. The rule has to be a value the function
-- computes, not a policy it hopes is being applied to it.

-- The breakdown, with names a tenant cannot otherwise read. This is the board's
-- "payment description/breakdown" as every audience sees it.
create or replace function offline_claim_lines(p_claim_id uuid)
returns table (
  line_id uuid,
  purpose text,
  what text,
  period text,
  due_date date,
  charge_total numeric,
  charge_outstanding numeric,
  amount numeric,
  property_id uuid,
  property_name text,
  unit_label text,
  ledger_entry_id uuid
)
language sql stable security definer set search_path = public as $fn$
  select
    a.id,
    a.purpose::text,
    case a.purpose
      when 'rent' then 'Rent'
      when 'service_charge' then 'Service charge'
      when 'deposit' then 'Deposit'
      else 'Credit on account'
    end
      || coalesce(' - ' || p.name, '')
      || coalesce(' - ' || u.label, ''),
    coalesce(
      to_char(rc.period_start, 'Mon YYYY') || ' - ' || to_char(rc.period_end, 'Mon YYYY'),
      sc.billing_period
    ),
    coalesce(rc.due_date, sc.due_date),
    coalesce(rc.amount, sc.amount),
    coalesce(rc.amount - rc.amount_paid, sc.amount - sc.amount_paid),
    a.amount,
    a.property_id, p.name, u.label,
    a.ledger_entry_id
  from offline_payment_allocations a
  left join rent_charges rc on rc.id = a.rent_charge_id
  left join service_charges sc on sc.id = a.service_charge_id
  left join properties p on p.id = a.property_id
  left join units u on u.id = a.unit_id
  where a.claim_id = p_claim_id
    and may_read_offline_claim(p_claim_id)
  order by a.created_at, a.id;
$fn$;

-- The chain, whole. Superseded rounds are RETURNED, not filtered out — decision
-- 30's "even though an approval has been given the approvers should still be
-- able to view the movement", and the reason `getChainState` stopped excluding
-- them at the query.
--
-- 📌 Definer, and it resolves the actor's NAME itself. `users_select` admits
-- `payment_chain_roles()` today (0222), but decision 24 records what happens when
-- a chain reader depends on that and the role list moves underneath it: every
-- completed stage rendered "Approved by someone no longer listed" to the auditor
-- whose stage exists to check it. This cannot fail that way.
create or replace function offline_claim_chain(p_claim_id uuid)
returns table (
  stage_order smallint,
  label text,
  required_roles text[],
  posts_ledger boolean,
  decision text,
  decided_by text,
  decided_by_role text,
  decided_at timestamptz,
  reason text,
  amount numeric,
  superseded boolean,
  is_current boolean
)
language sql stable security definer set search_path = public as $fn$
  with visible as (select may_read_offline_claim(p_claim_id) as ok),
  claim as (select * from offline_payment_claims where id = p_claim_id),
  -- The lowest stage with no live confirmation is where it is waiting.
  next_stage as (
    select min(s.stage_order) as n
      from offline_confirmation_stages() s
     where not exists (
       select 1 from offline_payment_confirmations x
        where x.claim_id = p_claim_id and x.stage_order = s.stage_order
          and x.decision = 'confirmed' and x.superseded_at is null
     )
  )
  select
    s.stage_order, s.label,
    (select array_agg(r::text) from unnest(s.required_roles) r),
    s.posts_ledger,
    x.decision,
    u.full_name,
    x.actor_role::text,
    x.created_at,
    x.reason,
    x.amount,
    x.superseded_at is not null,
    s.stage_order = (select n from next_stage)
      and (select status from claim) = 'submitted'
  from offline_confirmation_stages() s
  left join offline_payment_confirmations x
    on x.claim_id = p_claim_id and x.stage_order = s.stage_order
  left join users u on u.id = x.actor_id
  where (select ok from visible)
  order by s.stage_order, x.created_at nulls first;
$fn$;

-- The caller's own recorded payments. Definer and self-scoped, exactly as
-- `my_rent_charges` is: the WHERE clause below is the whole boundary.
create or replace function my_offline_payment_claims()
returns table (
  claim_id uuid,
  reference text,
  method text,
  claimed_amount numeric,
  confirmed_amount numeric,
  currency text,
  paid_on date,
  status text,
  payer_note text,
  payer_reference text,
  proof_path text,
  proof_filename text,
  decision_reason text,
  bank_label text,
  line_count integer,
  what text,
  stages_done integer,
  stages_total integer,
  current_stage_label text,
  created_at timestamptz,
  posted_at timestamptz
)
language sql stable security definer set search_path = public as $fn$
  select
    c.id, c.reference, c.method::text,
    c.claimed_amount, c.confirmed_amount, c.currency, c.paid_on,
    c.status::text, c.payer_note, c.payer_reference,
    c.proof_path, c.proof_filename, c.decision_reason,
    b.label,
    (select count(*)::integer from offline_payment_allocations a where a.claim_id = c.id),
    (select string_agg(distinct
       case a.purpose when 'rent' then 'Rent'
                      when 'service_charge' then 'Service charge'
                      when 'deposit' then 'Deposit'
                      else 'Credit on account' end, ' + ')
       from offline_payment_allocations a where a.claim_id = c.id),
    (select count(*)::integer from offline_payment_confirmations x
      where x.claim_id = c.id and x.decision = 'confirmed' and x.superseded_at is null),
    (select count(*)::integer from offline_confirmation_stages()),
    (select s.label from offline_confirmation_stages() s
      where s.stage_order = (
        select min(s2.stage_order) from offline_confirmation_stages() s2
         where not exists (
           select 1 from offline_payment_confirmations x
            where x.claim_id = c.id and x.stage_order = s2.stage_order
              and x.decision = 'confirmed' and x.superseded_at is null))),
    c.created_at, c.posted_at
  from offline_payment_claims c
  left join bank_accounts b on b.id = c.destination_bank_account_id
  -- The whole boundary, in two lines.
  where c.payer_user_id = active_uid() or c.recorded_by = active_uid()
  order by c.created_at desc;
$fn$;

-- The staff and confirmer list. SECURITY INVOKER, so
-- `offline_payment_claims_select` decides who sees which row — no second copy of
-- the rule, and no chance of this widening what the policy released.
create or replace function offline_claim_queue()
returns table (
  claim_id uuid,
  reference text,
  method text,
  claimed_amount numeric,
  confirmed_amount numeric,
  currency text,
  paid_on date,
  status text,
  payer_name text,
  payer_note text,
  payer_reference text,
  recorded_by_name text,
  recorded_at timestamptz,
  bank_label text,
  proof_path text,
  proof_filename text,
  what text,
  line_count integer,
  stages_done integer,
  stages_total integer,
  current_stage smallint,
  current_stage_label text,
  is_my_turn boolean,
  i_recorded_it boolean,
  posted_at timestamptz
)
language sql stable security invoker set search_path = public as $fn$
  with next_stage as (
    select c.id as claim_id,
           min(s.stage_order) filter (
             where not exists (
               select 1 from offline_payment_confirmations x
                where x.claim_id = c.id and x.stage_order = s.stage_order
                  and x.decision = 'confirmed' and x.superseded_at is null)
           ) as n
      from offline_payment_claims c
      cross join offline_confirmation_stages() s
     group by c.id
  )
  select
    c.id, c.reference, c.method::text,
    c.claimed_amount, c.confirmed_amount, c.currency, c.paid_on, c.status::text,
    coalesce(pu.full_name, c.payer_email, 'Not a portal user'),
    c.payer_note, c.payer_reference,
    ru.full_name, c.created_at,
    b.label, c.proof_path, c.proof_filename,
    (select string_agg(distinct
       case a.purpose when 'rent' then 'Rent'
                      when 'service_charge' then 'Service charge'
                      when 'deposit' then 'Deposit'
                      else 'Credit on account' end, ' + ')
       from offline_payment_allocations a where a.claim_id = c.id),
    (select count(*)::integer from offline_payment_allocations a where a.claim_id = c.id),
    (select count(*)::integer from offline_payment_confirmations x
      where x.claim_id = c.id and x.decision = 'confirmed' and x.superseded_at is null),
    (select count(*)::integer from offline_confirmation_stages()),
    ns.n,
    (select s.label from offline_confirmation_stages() s where s.stage_order = ns.n),
    -- Their turn: the claim is moving, this is the waiting stage, they hold the
    -- role for it, and they are not the person who recorded it. The last clause
    -- is the maker-checker showing up in the UI rather than only as a refusal
    -- after somebody has pressed the button.
    c.status = 'submitted'
      and ns.n is not null
      -- `exists` rather than `= any (select ...)`: a parenthesised SELECT makes
      -- ANY take its subquery form, which compares user_role to user_role[] and
      -- does not exist as an operator.
      and exists (
        select 1 from offline_confirmation_stages() s
         where s.stage_order = ns.n
           and current_user_role() = any (s.required_roles)
      )
      and c.recorded_by <> auth.uid(),
    c.recorded_by = auth.uid(),
    c.posted_at
  from offline_payment_claims c
  join next_stage ns on ns.claim_id = c.id
  left join users pu on pu.id = c.payer_user_id
  left join users ru on ru.id = c.recorded_by
  left join bank_accounts b on b.id = c.destination_bank_account_id
  order by
    (c.status = 'submitted') desc,
    c.paid_on asc, c.created_at asc;
$fn$;

-- ── 8. Grants ───────────────────────────────────────────────────────────────
revoke all on function offline_confirmation_stages() from public, anon, authenticated;
revoke all on function enforce_offline_confirmation_rules() from public, anon, authenticated;
-- ⚠️ `service_role` included. See 0281's section-13 note: Supabase's default
-- privileges grant it EXECUTE on every new function, and this one writes the
-- ledger without asking who is calling.
revoke all on function post_offline_payment_claim(uuid, uuid)
  from public, anon, authenticated, service_role;
revoke all on function confirm_offline_payment(uuid, smallint, text, text, uuid)
  from public, anon, authenticated;
revoke all on function correct_offline_payment_claim(uuid, numeric, jsonb, date, text, text, text, text)
  from public, anon, authenticated;
revoke all on function may_read_offline_claim(uuid) from public, anon, authenticated;
revoke all on function offline_claim_lines(uuid) from public, anon, authenticated;
revoke all on function offline_claim_chain(uuid) from public, anon, authenticated;
revoke all on function my_offline_payment_claims() from public, anon, authenticated;
revoke all on function offline_claim_queue() from public, anon, authenticated;

grant execute on function offline_confirmation_stages() to authenticated, service_role;
grant execute on function confirm_offline_payment(uuid, smallint, text, text, uuid)
  to authenticated, service_role;
grant execute on function correct_offline_payment_claim(uuid, numeric, jsonb, date, text, text, text, text)
  to authenticated, service_role;
grant execute on function may_read_offline_claim(uuid) to authenticated, service_role;
grant execute on function offline_claim_lines(uuid) to authenticated, service_role;
grant execute on function offline_claim_chain(uuid) to authenticated, service_role;
grant execute on function my_offline_payment_claims() to authenticated, service_role;
grant execute on function offline_claim_queue() to authenticated, service_role;

-- ⚠️ `post_offline_payment_claim` is granted to NOBODY, not even service_role.
-- It writes the ledger and it does not ask who the caller is - it trusts that
-- `confirm_offline_payment` has already established a complete chain. Reachable
-- only from inside that function's definer body. Granting it would be handing
-- out a way to post a collection with no signatures at all, which is the whole
-- control this pair of migrations exists to build.

-- ── 9. Assertions ───────────────────────────────────────────────────────────
do $$
declare v_stages integer;
begin
  select count(*) into v_stages from offline_confirmation_stages();
  if v_stages <> 3 then
    raise exception 'the confirmation chain is not three stages';
  end if;

  if (select required_roles from offline_confirmation_stages() where stage_order = 1)
     <> array['payment_audit_approver']::user_role[] then
    raise exception 'stage 1 is not the auditor';
  end if;
  if (select required_roles from offline_confirmation_stages() where stage_order = 2)
     <> array['executive']::user_role[] then
    raise exception 'stage 2 is not the executive';
  end if;
  -- The board was explicit that the Payment Officer, and not `payment_approver`,
  -- closes this chain. A typo here would be a money bug (0183's own example).
  if (select required_roles from offline_confirmation_stages() where stage_order = 3)
     <> array['finance_approver']::user_role[] then
    raise exception 'stage 3 is not the Payment Officer';
  end if;
  if (select count(*) from offline_confirmation_stages() where posts_ledger) <> 1 then
    raise exception 'exactly one stage posts the ledger';
  end if;
  if (select stage_order from offline_confirmation_stages() where posts_ledger) <> 3 then
    raise exception 'the ledger is posted anywhere but the last desk';
  end if;

  -- Named client roles only. The function's OWNER always appears in
  -- routine_privileges and cannot be revoked from itself — which is exactly how
  -- `confirm_offline_payment` reaches this from inside its own definer body.
  if (select count(*) from information_schema.routine_privileges
       where routine_schema = 'public' and routine_name = 'post_offline_payment_claim'
         and grantee in ('anon', 'authenticated', 'service_role', 'PUBLIC')) > 0 then
    raise exception 'the ledger poster is callable from outside the chain';
  end if;

  if (select count(*) from information_schema.routine_privileges
       where routine_schema = 'public'
         and routine_name in ('confirm_offline_payment', 'correct_offline_payment_claim',
                              'offline_claim_queue', 'my_offline_payment_claims')
         and grantee in ('anon', 'PUBLIC')) > 0 then
    raise exception 'a confirmation function is callable anonymously';
  end if;

  if exists (
    select 1 from pg_policies
     where schemaname = 'public' and tablename = 'offline_payment_confirmations'
       and cmd <> 'SELECT'
  ) then
    raise exception 'a write policy appeared on the confirmations table';
  end if;

  -- `offline_claim_queue` must stay SECURITY INVOKER: it is the only reader that
  -- is not self-scoped, and as a definer it would return every claim in the
  -- database to anyone who called it.
  if (select prosecdef from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname = 'offline_claim_queue') then
    raise exception 'offline_claim_queue became SECURITY DEFINER - it would bypass its own RLS';
  end if;
  -- The predicate MUST be definer: as an invoker it would be bypassed inside
  -- every reader above, and would recurse inside the policies that call it.
  if not (select prosecdef from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname = 'may_read_offline_claim') then
    raise exception 'may_read_offline_claim must be SECURITY DEFINER';
  end if;
  if (select count(*) from pg_policies where schemaname='public'
       and tablename in ('offline_payment_claims','offline_payment_allocations','offline_payment_confirmations')
       and qual not like '%may_read_offline_claim%') > 0 then
    raise exception 'a claim policy states the read rule itself instead of calling the one predicate';
  end if;
end $$;

-- ── 10. A notification about a claim is a seventh notification subject ──────
--
-- ⚠️ 0276 wired the orphan cascade for six entity types and closed with an
-- assertion designed to fail 'the migration that adds a seventh subject with no
-- cascade behind it'. This is that seventh subject, so it arrives with its own
-- wiring rather than waiting to be reported.
--
-- It matters more here than the type list suggests: `my_notifications` decides
-- `target_live` from a CASE whose fall-through is **else true**, so an unknown
-- entity type is reported as live forever — the bell would keep offering a link
-- to a claim that no longer exists, and the suite watching for dangling links
-- would see nothing wrong. An unlisted type does not fail loudly; it fails by
-- being believed.
create trigger offline_payment_claims_notification_cascade
  after delete on offline_payment_claims
  for each row execute function delete_notifications_for_deleted_entity('offline_payment');

-- Rebuilt from the live catalogue with one branch inserted (0183). The six other
-- branches and the whole WHERE clause are `pg_get_functiondef` output, and the
-- signature (invoker, `stable`, one argument) is the live one — a definer here
-- would hand every caller everyone's notifications.
create or replace function my_notifications(p_days integer default 30)
returns table (
  id uuid, kind text, title text, body text, link text,
  read_at timestamptz, created_at timestamptz,
  entity_type text, entity_id uuid, target_live boolean
)
language sql stable set search_path = public as $fn$
  select
    n.id, n.kind, n.title, n.body, n.link, n.read_at, n.created_at,
    n.entity_type, n.entity_id,
    case
      when n.entity_id is null then true          -- a static link cannot dangle
      when n.entity_type = 'ticket'             then exists (select 1 from tickets t             where t.id = n.entity_id)
      when n.entity_type = 'payment'            then exists (select 1 from payments p            where p.id = n.entity_id)
      when n.entity_type = 'asset'              then exists (select 1 from assets a               where a.id = n.entity_id)
      when n.entity_type = 'property'           then exists (select 1 from properties r           where r.id = n.entity_id)
      when n.entity_type = 'lease'              then exists (select 1 from leases l                where l.id = n.entity_id)
      when n.entity_type = 'tenant_application' then exists (select 1 from tenant_applications a   where a.id = n.entity_id and a.purged_at is null)
      when n.entity_type = 'offline_payment'    then exists (select 1 from offline_payment_claims c where c.id = n.entity_id)
      else true
    end
  from user_notifications n
  where n.user_id = active_uid()
    and (n.read_at is null or n.created_at >= now() - make_interval(days => greatest(p_days, 1)))
  order by n.read_at nulls first, n.created_at desc;
$fn$;

revoke all on function my_notifications(integer) from public, anon;
grant execute on function my_notifications(integer) to authenticated, service_role;

do $$
begin
  if not exists (
    select 1 from pg_trigger t
      join pg_class c on c.oid = t.tgrelid
      join pg_proc pr on pr.oid = t.tgfoid
     where c.relname = 'offline_payment_claims'
       and pr.proname = 'delete_notifications_for_deleted_entity'
       and not t.tgisinternal
  ) then
    raise exception 'the seventh notification subject shipped with no orphan cascade';
  end if;
  if pg_get_functiondef((select p.oid from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                          where n.nspname = 'public' and p.proname = 'my_notifications'))
     not like '%offline_payment%' then
    raise exception 'my_notifications cannot tell a live offline payment from a deleted one';
  end if;
  -- 0221's wound: a create-or-replace re-states the WHOLE function, so anything
  -- an earlier migration put there and this author did not know about is gone.
  -- 0195 made this function deactivation-aware; prove that survived.
  if pg_get_functiondef((select p.oid from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                          where n.nspname = 'public' and p.proname = 'my_notifications'))
     not like '%active_uid()%' then
    raise exception 'my_notifications lost its deactivation guard in the rebuild';
  end if;
end $$;
