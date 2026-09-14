-- A payment made off-platform is recorded with its proof (board, 9 Sept 2026).
--
-- Asked for directly: an optional rent / lease / service-charge payment route by
-- DIRECT BANK TRANSFER or PHYSICAL IN-BANK DEPOSIT, where attaching clear proof
-- and stating the amount paid are both compulsory, and where the amount entered
-- is captured and computed correctly against the thing it paid for.
--
-- The gap is real and it is the ordinary case in this market. Every route money
-- can currently take into this platform ends at a gateway: `payment_intents`
-- (0032) → Paystack/Flutterwave checkout → the HMAC webhook → `record_collection`.
-- A tenant who transfers straight into OE Group's designated client-funds account
-- — which decision 2 requires to exist, and which is the account printed on every
-- demand — produces no intent, no webhook and no ledger posting. Their statement
-- goes on showing arrears they have already cleared, the rent roll understates
-- collections, and the landlord's remittance is short. The money is in the bank
-- and the product does not know.
--
-- ── What this migration deliberately is NOT ─────────────────────────────────
--
-- ⚠️ It is not a second way to post a collection. A claim recorded here has NO
-- ledger effect whatsoever until it has been confirmed (0282). That separation is
-- the whole design, for three reasons that all point the same way:
--
--   • An unverified assertion of payment must never reduce real arrears. The
--     failure mode is silent and it is the bad direction: a tenant stops being
--     chased for money nobody received.
--   • Rent collected is remittable to a landlord net of fees (B4). A claim that
--     posted on submission would let a forged teller slip pull real money OUT of
--     the client-funds account to a landlord.
--   • Decision 36 already records that advance-fee fraud against tenants is
--     ordinary here. A convincing bank-app screenshot is cheap to produce; the
--     defence is a person checking the designated account, which is exactly what
--     decision 2's daily reconciliation already exists to do.
--
-- So this file records the CLAIM and its evidence. 0282 builds the chain that
-- turns it into money.
--
-- 📌 The posting itself, when it comes, goes through `record_collection`
-- UNCHANGED — one synthetic `payment_intents` row per allocation, carrying
-- `gateway = 'manual'` (a value 0032 put in the enum on day one and nothing has
-- ever used). That is not a shortcut; it is the point. `record_collection` is
-- where the management-fee snapshot is applied (decision 14), where a service
-- charge finds its own property's fund (decision 27), where a part payment gets
-- `part_paid` rather than `paid`, and where the charge's `amount_paid` moves.
-- Re-implementing any of that for a second payment method is how the two
-- disagree, and this repo has recorded that failure — a consumer written for one
-- case and silently wrong for the second — often enough to know better
-- (decisions 23, 24, and 0247 itself).

-- ── 1. What kind of payment, and where it got to ────────────────────────────

create type offline_payment_method as enum ('bank_transfer', 'bank_deposit');

comment on type offline_payment_method is
  'bank_transfer: an electronic transfer into the designated account. bank_deposit: cash or a cheque paid in over the counter (0281).';

-- Deliberately NOT a mirror of the chain's position. Where a claim has got to in
-- the confirmation chain is answered by `offline_payment_confirmations` and by
-- nothing else — a status column that also tried to say it would be a second
-- source of truth for one fact, which is the fault decision 24 recorded about
-- two copies of one list.
--
-- These four are the states the chain does NOT tell you: it is still moving, it
-- finished one way, it finished the other, or it is back with the person who
-- recorded it.
create type offline_claim_status as enum (
  'submitted',
  'confirmed',
  'rejected',
  'returned_for_correction'
);

-- ── 2. The claim ────────────────────────────────────────────────────────────

create table offline_payment_claims (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,

  -- A human-quotable handle. A person who has paid at a bank counter needs
  -- something to say on the phone, and "the uuid ending in 4f2" is not it.
  reference text not null,

  -- Who the money is FOR. Nullable on purpose: decision 22 records that a
  -- company let has no portal user at all, and staff take walk-in payments from
  -- people who have never signed in. The payer is identified by the allocation's
  -- charge in that case, which is the fact that actually matters.
  payer_user_id uuid references users(id),
  payer_email text,

  -- Who typed it in. NOT the same question, and the difference is load-bearing:
  -- this is the person barred from every stage of the confirmation chain (0282).
  recorded_by uuid not null references users(id),

  method offline_payment_method not null,

  -- ⚠️ COMPULSORY, half one. The board asked for the amount paid to be entered,
  -- and `not null` + `> 0` is what makes that a rule rather than a placeholder
  -- on a form. What a person typed; never what the system assumed.
  claimed_amount numeric(16,2) not null check (claimed_amount > 0),
  currency text not null default 'NGN',

  -- The date on the evidence, not the date it was keyed in. This is what the
  -- ledger entry is dated to, so a transfer made on Friday and reported on
  -- Monday reconciles against Friday's bank line.
  paid_on date not null,

  -- Which of the organisation's own designated accounts it was paid into.
  -- Required, because "confirm this reached us" is unanswerable until somebody
  -- says where to look, and decision 2's segregated client-funds account is the
  -- only correct answer for a tenant's money.
  destination_bank_account_id uuid not null references bank_accounts(id),

  -- The bank's own transfer/teller reference as the payer read it off their
  -- receipt. A HINT for whoever reconciles, never an authority — the same
  -- standing decision 24 gave a quoted ticket reference.
  payer_reference text,

  -- ⚠️ The board's "further note / payment description / breakdown" field. The
  -- structured breakdown is `offline_payment_allocations`; this is the payer's
  -- own words about it, and it travels to every confirmer.
  payer_note text,

  -- ⚠️ COMPULSORY, half two. `not null` at the table, so no write path — this
  -- one, or one written next year — can record a payment claim with no evidence
  -- behind it. 0216's lesson: the control belongs where every path meets.
  proof_path text not null,
  proof_filename text,

  status offline_claim_status not null default 'submitted',

  -- Set once, by the terminal confirmation in 0282. Its presence IS the "already
  -- posted" flag, exactly as `payment_intents.ledger_entry_id` is — so there is
  -- no separate boolean to drift out of step with reality.
  posted_at timestamptz,
  confirmed_amount numeric(16,2) check (confirmed_amount is null or confirmed_amount > 0),
  confirmed_by uuid references users(id),
  decided_at timestamptz,
  decision_reason text,

  -- Optional link to the bank's own evidence. Optional because an organisation
  -- that has not yet imported a statement must still be able to confirm a
  -- payment it can see in its banking app — but recorded when it exists, because
  -- that is the strongest form the confirmation can take.
  matched_statement_line_id uuid references bank_statement_lines(id),

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- A payment cannot have been made in the future. Cheap, and it catches the
  -- commonest date-picker slip before it becomes a reconciliation hunt.
  constraint offline_claims_paid_on_not_future check (paid_on <= current_date),

  -- A decided claim says how it was decided. A confirmed one carries the figure
  -- actually confirmed; a refused or returned one carries the reason, because
  -- decision 36's rule is that a refusal a person cannot act on is a dead end.
  constraint offline_claims_decision_complete check (
    case status
      when 'confirmed' then confirmed_amount is not null and confirmed_by is not null
      when 'rejected' then decision_reason is not null
      when 'returned_for_correction' then decision_reason is not null
      else true
    end
  )
);

create unique index offline_payment_claims_ref_uidx
  on offline_payment_claims (org_id, reference);
create index offline_payment_claims_status_idx
  on offline_payment_claims (org_id, status);
create index offline_payment_claims_payer_idx
  on offline_payment_claims (payer_user_id) where payer_user_id is not null;
create index offline_payment_claims_recorder_idx
  on offline_payment_claims (recorded_by);
create index offline_payment_claims_paid_on_idx
  on offline_payment_claims (org_id, paid_on desc);

create trigger offline_payment_claims_touch before update on offline_payment_claims
  for each row execute function touch_updated_at();

-- ── 3. What the money pays for ──────────────────────────────────────────────
--
-- The board's third requirement, in a table: "the amount paid/entered should be
-- captured by the system and computed correctly for the property lease / rent /
-- service-charge / etc paid for." One lump transfer routinely settles a rent
-- demand and a service-charge invoice at once, so the claim is a header and this
-- is its breakdown.

create table offline_payment_allocations (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  claim_id uuid not null references offline_payment_claims(id) on delete cascade,

  -- Reusing 0032's enum rather than inventing a parallel one, because this value
  -- is handed to `record_collection` verbatim and IT decides which liability the
  -- money is held against. Two enums meaning the same thing is how the ledger
  -- ends up crediting the wrong account.
  purpose collection_purpose not null,

  rent_charge_id uuid references rent_charges(id),
  service_charge_id uuid references service_charges(id),

  -- Denormalised at submission from the charge's own lease/budget. Carried so
  -- the RLS place clause below is one index lookup rather than a four-table join
  -- evaluated per row, and so a deposit or an on-account credit — which name no
  -- charge — can still be scoped to a building.
  property_id uuid references properties(id),
  unit_id uuid references units(id),

  amount numeric(16,2) not null check (amount > 0),

  -- The synthetic intent this line became at confirmation, and the ledger entry
  -- that intent posted. Null until 0282's terminal stage runs.
  intent_id uuid references payment_intents(id),
  ledger_entry_id uuid references ledger_entries(id),

  created_at timestamptz not null default now(),

  -- A line names exactly the target its purpose implies. Written as one check
  -- rather than three so there is no gap between them for a future purpose to
  -- fall through.
  constraint offline_allocation_target_matches_purpose check (
    case purpose
      when 'rent' then rent_charge_id is not null and service_charge_id is null
      when 'service_charge' then service_charge_id is not null and rent_charge_id is null
      else rent_charge_id is null and service_charge_id is null
    end
  )
);

create index offline_payment_allocations_claim_idx
  on offline_payment_allocations (claim_id);
create index offline_payment_allocations_rent_idx
  on offline_payment_allocations (rent_charge_id) where rent_charge_id is not null;
create index offline_payment_allocations_sc_idx
  on offline_payment_allocations (service_charge_id) where service_charge_id is not null;
create index offline_payment_allocations_property_idx
  on offline_payment_allocations (property_id) where property_id is not null;

-- ⚠️ There is deliberately NO unique index stopping two allocations naming one
-- charge. A tenant paying an annual demand in two instalments by two separate
-- transfers is ordinary here, and a unique index would refuse the second. The
-- rule that actually needs enforcing — the same transfer reported twice — needs
-- the claim's status, which lives on the other table, so an index cannot express
-- it. It is the trigger in section 5.

-- ── 4. The breakdown has to add up ──────────────────────────────────────────
--
-- The invariant the board's third requirement rests on: if the lines do not sum
-- to the payment, then "computed correctly for the thing paid for" is not true
-- of at least one of them.
--
-- A DEFERRED CONSTRAINT TRIGGER rather than a check in the writing function,
-- because a function can be joined by a second function later and this cannot.
-- Deferred because the header is inserted before its lines, so the only honest
-- moment to test it is COMMIT. Same shape decision 25 used refusing to generate
-- a manually-apportioned budget whose stated shares do not reconcile.
create or replace function assert_offline_claim_reconciles()
returns trigger language plpgsql set search_path = public as $fn$
declare
  v_claim_id uuid;
  v_claim offline_payment_claims%rowtype;
  v_sum numeric(16,2);
  v_lines integer;
begin
  -- ⚠️ IF branches, not a CASE expression. This one trigger function serves two
  -- tables whose rows have different shapes, and PL/pgSQL resolves NEW/OLD field
  -- references when it PREPARES an expression — not when it evaluates the branch
  -- it lands on. So `case ... then new.id else new.claim_id end` fails with
  -- 'record "new" has no field "claim_id"' on the claims table, on the branch it
  -- never takes. The short-circuit people expect from CASE does not apply to
  -- record field resolution.
  if tg_table_name = 'offline_payment_claims' then
    if tg_op = 'DELETE' then v_claim_id := old.id; else v_claim_id := new.id; end if;
  else
    if tg_op = 'DELETE' then v_claim_id := old.claim_id; else v_claim_id := new.claim_id; end if;
  end if;

  select * into v_claim from offline_payment_claims where id = v_claim_id;
  -- The claim went away in this same transaction (a cascade). Nothing to check.
  if v_claim.id is null then
    return null;
  end if;

  select count(*), coalesce(sum(amount), 0) into v_lines, v_sum
    from offline_payment_allocations where claim_id = v_claim.id;

  if v_lines = 0 then
    raise exception
      'a recorded payment has to say what it pays for — add at least one line to the breakdown';
  end if;

  if v_sum <> coalesce(v_claim.confirmed_amount, v_claim.claimed_amount) then
    raise exception
      'the breakdown comes to % but the payment is % — every % has to be allocated to something',
      trim(to_char(v_sum, 'FM999,999,999,990.00')),
      trim(to_char(coalesce(v_claim.confirmed_amount, v_claim.claimed_amount), 'FM999,999,999,990.00')),
      v_claim.currency;
  end if;

  return null;
end;
$fn$;

comment on function assert_offline_claim_reconciles is
  'Deferred: an off-platform claim''s breakdown must name at least one thing and must sum to the amount recorded (0281).';

create constraint trigger offline_claim_reconciles
  after insert or update of claimed_amount, confirmed_amount on offline_payment_claims
  deferrable initially deferred
  for each row execute function assert_offline_claim_reconciles();

create constraint trigger offline_allocation_reconciles
  after insert or update or delete on offline_payment_allocations
  deferrable initially deferred
  for each row execute function assert_offline_claim_reconciles();

-- ── 5. One live claim per charge ────────────────────────────────────────────
--
-- Needs the claim's status, which lives on the other table, so it cannot be an
-- index. A tenant may legitimately report two transfers against one demand (two
-- instalments); what they may not do is have the SAME transfer sitting in the
-- chain twice, and what staff must not do is record a claim a tenant has already
-- reported. Both are the same shape as 0045's one-live-intent-per-invoice rule.
create or replace function assert_offline_allocation_not_duplicated()
returns trigger language plpgsql set search_path = public as $fn$
declare
  v_dupe record;
begin
  select c.reference, c.claimed_amount, c.paid_on, c.currency into v_dupe
    from offline_payment_allocations a
    join offline_payment_claims c on c.id = a.claim_id
   where a.claim_id <> new.claim_id
     and c.status = 'submitted'
     and (
       (new.rent_charge_id is not null and a.rent_charge_id = new.rent_charge_id)
       or (new.service_charge_id is not null and a.service_charge_id = new.service_charge_id)
     )
     -- The same money, reported twice: same day, same figure. Two genuinely
     -- different instalments on one demand differ in at least one of those, and
     -- refusing those would be refusing an ordinary way to pay.
     and c.paid_on = (select paid_on from offline_payment_claims where id = new.claim_id)
     and a.amount = new.amount
   limit 1;

  if v_dupe.reference is not null then
    raise exception
      'a payment of % on % against this charge is already waiting to be confirmed (%). If this is a second, separate payment, it needs its own date or amount.',
      trim(to_char(v_dupe.claimed_amount, 'FM999,999,999,990.00')),
      to_char(v_dupe.paid_on, 'DD Mon YYYY'), v_dupe.reference;
  end if;

  return new;
end;
$fn$;

create trigger offline_allocation_not_duplicated
  before insert on offline_payment_allocations
  for each row execute function assert_offline_allocation_not_duplicated();

-- ── 6. Who confirms — named once ────────────────────────────────────────────
--
-- Decision 8's rule. The stage list in 0282 reads this, the read policies below
-- read this, and `lib/roles.ts` mirrors it: three string literals in three files
-- is exactly the drift 0185 was written about.
--
-- ⚠️ These are hardwired and appear in no permission matrix. Decision 7 lists
-- payment approval and ledger write among the controls that "stay hardwired and
-- never appear as toggles" — and the terminal stage of this chain writes the
-- ledger. A per-org switch deciding who may confirm money into the client-funds
-- account is the same escalation decision 23 removed when it took
-- `delivery_brand` out of the org-writable allowlist.
create or replace function offline_confirmation_roles()
returns user_role[]
language sql immutable set search_path = public as $fn$
  select array['payment_audit_approver', 'executive', 'finance_approver']::user_role[];
$fn$;

comment on function offline_confirmation_roles is
  'The three desks that confirm an off-platform payment: auditor, executive, then the Payment Officer who posts it. Hardwired per decision 7 — never a toggle (0281).';

-- ── 7. Who may see one ──────────────────────────────────────────────────────

alter table offline_payment_claims enable row level security;
alter table offline_payment_allocations enable row level security;

-- ⚠️ ONE function answers "may this person read this claim", and the policies,
-- the child tables and every definer reader in 0282 all call it. Decision 8's
-- rule — but here it is not merely tidiness, it is the only shape that works,
-- for two reasons that both bit during authoring:
--
--   • RECURSION. The first draft put the rule in the claims policy and had the
--     allocations policy say "exists (select 1 from offline_payment_claims)".
--     But the claims policy has to look at ALLOCATIONS to answer the FM/PM place
--     branch — so the two policies called each other and Postgres refused with
--     "infinite recursion detected in policy". A SECURITY DEFINER predicate
--     reads both tables without re-entering either policy, and the cycle is gone.
--
--   • ⚠️ A `SECURITY INVOKER` helper would NOT have worked, and would have failed
--     silently rather than loudly. 0282's readers are SECURITY DEFINER (a tenant
--     holds no read on `properties`, `units` or `users`), and inside a definer
--     body the current role IS THE OWNER — so an invoker helper called from
--     there evaluates RLS as the owner, bypasses it, and returns true for
--     everybody. The gate would have looked right in the source and admitted
--     the whole table.
--
-- The board's "every payment/transaction information visible to payment
-- confirmers" is the fourth branch. It is deliberately wider than the chain's
-- CURRENT stage: an auditor who has already signed must still be able to re-read
-- what they signed, because a record you cannot re-open is not evidence — the
-- same reasoning decision 19 used keeping a request visible to a payment desk
-- after they acted.
create or replace function may_read_offline_claim(p_claim_id uuid)
returns boolean
language sql stable security definer set search_path = public as $fn$
  select exists (
    select 1 from offline_payment_claims c
     where c.id = p_claim_id
       and c.org_id = current_user_org_id()
       and (
         c.payer_user_id = auth.uid()
         or c.recorded_by = auth.uid()
         or current_user_role() = any (oversight_roles())
         or current_user_role() = any (offline_confirmation_roles())
         or (
           current_user_role() = any (fm_roles())
           and exists (
             select 1 from offline_payment_allocations a
              where a.claim_id = c.id
                and a.property_id in (select current_user_property_ids())
           )
         )
       )
  );
$fn$;

comment on function may_read_offline_claim is
  'The single rule for who may read an off-platform payment claim: the payer, whoever recorded it, oversight, any of the three confirmation desks, or an FM/PM whose properties it touches. Read by both policies and by every reader in 0282 (0281).';

create policy offline_payment_claims_select on offline_payment_claims for select
  using (may_read_offline_claim(id));

create policy offline_payment_allocations_select on offline_payment_allocations for select
  using (may_read_offline_claim(claim_id));

-- ⚠️ NO insert, update or delete policy on either table, for anybody.
--
-- 0216's lesson, applied before it can bite rather than after: a vendor could
-- file their own registration as `approved` because the insert policy constrained
-- the row's org and never its status. Every write here goes through a SECURITY
-- DEFINER function that owns the rules — `submit_offline_payment_claim` below,
-- and `confirm_offline_payment` in 0282. `authenticated` holds SELECT and
-- nothing else, so there is no second path for a status, a confirmed amount or
-- an allocation to be written by whoever the row is about.
grant select on offline_payment_claims to authenticated;
grant select on offline_payment_allocations to authenticated;

create trigger audit_offline_payment_claim
  after insert or update on offline_payment_claims
  for each row execute function log_audit('collection.offline_claim');

create trigger audit_offline_payment_allocation
  after insert or update or delete on offline_payment_allocations
  for each row execute function log_audit('collection.offline_allocation');

-- ── 8. Recording one on somebody else's behalf ──────────────────────────────
--
-- A tenant recording their OWN payment needs no capability: standing comes from
-- holding the charge, exactly as `create_service_charge_payment_intent` (0123)
-- lets the person billed open their own checkout. This governs the other case —
-- a walk-in at the office, a transfer phoned in — and it is a capability rather
-- than a role literal so the operator can withdraw it per role per org.
-- ⚠️ `locked = false`, and that is the deliberate half of decision 7 rather than
-- an oversight. RECORDING a claim is a clerical act with no consequence — the
-- three desks in 0282 are hardwired and appear in no matrix, exactly as
-- `payment.approve`, `ledger.write` and `bank.configure` (the four rows above
-- this one in the Money module) all are. What an operator may withdraw is who
-- may type a walk-in payment in; what nobody may edit is who turns it into money.
insert into capabilities (key, module, label, description, locked, sort_order) values (
  'payments.record_offline',
  'Money',
  'Record an off-platform payment',
  'Record a payment somebody made by bank transfer or over a bank counter, on their behalf, with its proof attached. Records a claim only — it has no effect on any ledger, statement or landlord remittance until the audit, executive and Payment Officer desks have each confirmed it.',
  false,
  85
) on conflict (key) do update
  set module = excluded.module,
      label = excluded.label,
      description = excluded.description,
      locked = excluded.locked,
      sort_order = excluded.sort_order;

-- ⚠️ Rebuilt from `pg_get_functiondef` against the LIVE catalogue, with exactly
-- one arm inserted. 0280 broke this rule in the file written immediately after
-- 0277 — whose own header is four paragraphs about it — by taking a policy from
-- a copy three migrations stale. The arm below is the only line that is not
-- catalogue output.
create or replace function b7_grants(p_role user_role, p_capability text)
returns boolean
language sql immutable set search_path = public as $fn$
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
        -- says.
        when p_capability = 'payments.record_offline' then p_role in (
          'facility_manager', 'property_manager', 'regional_manager', 'finance_approver'
        )

        when p_role = 'executive' then p_capability in (
          'tickets.read_all', 'assets.read', 'sc.read_all', 'properties.read_all',
          'vendors.read', 'bi.read', 'tickets.triage_unassigned'
        )

        when p_role = 'payment_audit_approver' then p_capability in (
          'tickets.read_all', 'vendors.read', 'bi.read', 'properties.read_all'
        )

        -- 0246. The payment approver is the senior accounting desk: it holds
        -- everything the payment officer holds, and the difference between them
        -- is DISBURSEMENT, which is not a capability at all. Releasing money is
        -- guarded by an explicit `finance_approver` literal inside
        -- `assert_may_disburse` and `enforce_payment_transition`, so nothing
        -- granted here can reach it — that is what makes "the same set" safe to
        -- state rather than a list somebody has to keep trimming.
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
          -- 0238. They hold BOTH, and that is not a contradiction: the
          -- maker-checker in approve_vendor_application is per application and
          -- per person, so a regional manager who recommended one must hand it
          -- to a colleague or the administrator. Holding both is what lets a
          -- region run without an administrator in the loop for every vendor;
          -- it is not permission to do both on the same application.
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
                         -- 0238: the FM/PM put a contractor forward. They do
                         -- NOT hold vendors.approve, which is the whole change.
                         'vendors.recommend',
                         -- Board, 31 Aug 2026. Restored: this is the FIRST tier of
                         -- decision 10's two-tier tenant review, and the seeder had
                         -- silently lost it. record_application_recommendation is
                         -- already scoped to `applications.review_all OR property_id
                         -- in current_user_property_ids()`, so granting it here is
                         -- property-scoped by construction, not by a second rule.
                         'applications.recommend')
          then p_role in ('facility_manager', 'property_manager')

        when p_capability = 'vendors.read'
          then p_role in ('facility_manager', 'property_manager', 'finance_approver')

        -- 0249. The property manager joins the payment officer here, and the
        -- facilities manager deliberately does not. Every write this unlocks is
        -- bounded to a property the holder actually manages, by the clause
        -- decision 26 put on sc_budgets_* and service_charges_* — this grants
        -- the capability, never the reach.
        when p_capability = 'sc.manage'
          then p_role in ('finance_approver', 'property_manager')

        -- 0249. leases.write reached no generic arm at all and fell to `else
        -- false`, so only admin and the regional manager held it.
        -- leases_write has carried `property_id in current_user_property_ids()`
        -- since 0090, so this is likewise capability-only.
        when p_capability = 'leases.write'
          then p_role = 'property_manager'

        when p_capability = 'bi.read'
          then p_role in ('facility_manager', 'property_manager',
                     'finance_approver', 'property_owner')
        when p_capability = 'people.deactivate' then false
        when p_capability = 'tickets.triage_unassigned' then false

        else false
  end;
$fn$;

-- Every live org gets the new row at its baseline value. `seed_b7_permissions`
-- is `on conflict do nothing`, so this touches no deliberate deviation an
-- operator has already recorded.
do $$
declare o record;
begin
  for o in select id from orgs loop
    perform seed_b7_permissions(o.id);
  end loop;
end $$;

-- ── 9. Where the evidence lives ─────────────────────────────────────────────
--
-- Its own bucket. Not `invoice-attachments`, whose read policy joins `payments`
-- and `ops_requisitions` — money going OUT — and which 0217 had to go back and
-- fix precisely because a third payable type was added to the system and the
-- storage policy was not thought of as a consumer. Adding a fourth, inbound,
-- kind of object to that bucket would be volunteering for the same finding.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'payment-proofs', 'payment-proofs', false,
  5242880,
  -- HEIC included. Decision 23 records that offering it in neither layer was a
  -- defect: it is what an iPhone produces by default, and a tenant photographing
  -- a teller slip is the exact person this affects.
  array['application/pdf','image/jpeg','image/png','image/webp','image/heic','image/heif']
) on conflict (id) do update
  set file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- ⚠️ ONE size limit — 5 MB, here, and `lib/offline-payments.ts` exports the same
-- number to the client so the form can state it BEFORE the file picker. 0213
-- found three different limits (15 MB bucket / 5 MB client / the board's 2 MB in
-- neither) on the vendor pack, which is how "Send for review" stayed disabled
-- with nothing on screen saying why.

-- The org id is the first path segment. `<org>/<claim reference>/<file>` — the
-- convention 0164 requires and which 0213 found the product itself was not
-- following, so every attach in the vendor pack failed RLS silently.
create policy "payment proofs are uploaded to the org prefix"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'payment-proofs'
    and ((storage.foldername(name))[1])::uuid = current_user_org_id()
  );

-- Readable by whoever can read the claim — the subquery runs as the caller, so
-- `offline_payment_claims_select` above is the whole rule and there is no second
-- copy of it here to drift. The `owner` branch covers the moments before the
-- claim row exists: the file is uploaded first, and a payer who cannot read back
-- what they just attached cannot check they attached the right thing.
create policy "payment proofs readable by whoever can see the claim"
  on storage.objects for select to authenticated
  using (
    bucket_id = 'payment-proofs'
    and (
      owner = auth.uid()
      or exists (
        select 1 from offline_payment_claims c where c.proof_path = storage.objects.name
      )
    )
  );

-- Replacing a file before the claim is submitted is ordinary (wrong photo,
-- unreadable scan). Replacing it AFTER is tampering with evidence three desks
-- are about to look at, so it stops being possible the moment a claim points at
-- it. 0215's reasoning, from the other side: the subject of a verification does
-- not hold the keys to their own evidence.
--
-- ⚠️ There is deliberately NO UPDATE policy on this bucket, which means an
-- `upsert` upload is impossible here — evidence is written once, and replaced by
-- DELETING the unclaimed object and uploading again, never overwritten in place.
-- A correction (0282) likewise attaches a NEW object rather than overwriting the
-- old one. 📌 Worth knowing when reading a bug report: Supabase Storage answers a
-- refused upsert with "The database schema is invalid or incompatible" and a 503,
-- which reads like a broken deployment rather than the permission failure it is.
create policy "payment proofs may be replaced only before they are claimed"
  on storage.objects for delete to authenticated
  using (
    bucket_id = 'payment-proofs'
    and owner = auth.uid()
    and not exists (
      select 1 from offline_payment_claims c where c.proof_path = storage.objects.name
    )
  );


-- ── 10. What a person can allocate a payment to ─────────────────────────────
--
-- The form's source of truth, and the same predicates the writer validates
-- against — so a charge that is offered can always be allocated, and one that is
-- not offered is refused for a reason the caller can read. A picker built from a
-- different query to the rule that vets it is how decision 26's nav-versus-page
-- disagreement happens.
create or replace function offline_allocatable_charges()
returns table (
  kind text,
  charge_id uuid,
  label text,
  period text,
  due_date date,
  amount numeric,
  outstanding numeric,
  currency text,
  property_id uuid,
  property_name text,
  unit_id uuid,
  unit_label text,
  payer_user_id uuid,
  is_own boolean
)
language sql stable security definer set search_path = public as $fn$
  -- Rent demands: the caller's own, or ones on a property they manage.
  select
    'rent'::text, rc.id,
    p.name || coalesce(' · ' || u.label, ''),
    to_char(rc.period_start, 'Mon YYYY') || ' - ' || to_char(rc.period_end, 'Mon YYYY'),
    rc.due_date, rc.amount, rc.amount - rc.amount_paid, rc.currency,
    l.property_id, p.name, l.unit_id, u.label, l.tenant_user_id,
    l.tenant_user_id = active_uid()
  from rent_charges rc
  join leases l on l.id = rc.lease_id and l.deleted_at is null
  join properties p on p.id = l.property_id
  left join units u on u.id = l.unit_id
  where rc.amount - rc.amount_paid > 0
    and rc.org_id = current_user_org_id()
    and (
      l.tenant_user_id = active_uid()
      or (
        has_permission('payments.record_offline')
        and (
          current_user_role() = any (oversight_roles())
          or l.property_id in (select current_user_property_ids())
        )
      )
    )

  union all

  -- Service-charge invoices, reached through the budget for the property, which
  -- is the join 0247 and decision 25 both established as the correct one — the
  -- unit column is not populated on every path.
  select
    'service_charge'::text, sc.id,
    coalesce(sc.property_or_unit, p.name, 'Service charge'),
    sc.billing_period, sc.due_date, sc.amount, sc.amount - sc.amount_paid, 'NGN',
    sb.property_id, p.name, sc.unit_id, u.label, sc.billed_to_user_id,
    sc.billed_to_user_id = active_uid()
  from service_charges sc
  left join sc_budgets sb on sb.id = sc.budget_id
  left join properties p on p.id = sb.property_id
  left join units u on u.id = sc.unit_id
  where sc.deleted_at is null
    and sc.amount - sc.amount_paid > 0
    and sc.org_id = current_user_org_id()
    and (
      sc.billed_to_user_id = active_uid()
      or (
        has_permission('payments.record_offline')
        and (
          current_user_role() = any (oversight_roles())
          or sb.property_id in (select current_user_property_ids())
        )
      )
    )
  order by 5 nulls last, 3;
$fn$;

comment on function offline_allocatable_charges is
  'Every outstanding rent demand and service-charge invoice the caller may record an off-platform payment against - their own, or ones on a property they manage while holding payments.record_offline (0281).';

-- ── 10b. Which account they paid into ───────────────────────────────────────
--
-- `submit_offline_payment_claim` requires a `destination_bank_account_id`, and
-- `bank_accounts_select` admits `oversight_roles()` only — so without this a
-- tenant could not name the account they had just paid money into, and the
-- compulsory field would be unfillable by the person the feature exists for.
--
-- ⚠️ Safe to show, and more than safe — it is a CONTROL. Decision 36 records
-- that advance-fee fraud against tenants is ordinary in this market and that the
-- defence is "a person who knows the real figures and expects to be told them in
-- writing"; the offer letter already says pay only into an account in this name.
-- Showing the designated account names on the form a tenant uses to report a
-- payment is that same defence at the moment it is most useful: somebody who
-- paid the wrong account finds out here.
--
-- Only ever the LAST FOUR digits, which is all the column holds — decision 17's
-- rule that bank details are stated and evidenced, never actionable.
create or replace function org_client_funds_accounts()
returns table (
  id uuid,
  label text,
  bank_name text,
  account_name text,
  account_number_last4 text,
  currency text
)
language sql stable security definer set search_path = public as $fn$
  select b.id, b.label, b.bank_name, b.account_name, b.account_number_last4, b.currency
    from bank_accounts b
   where b.org_id = current_user_org_id()
     and b.purpose = 'client_funds'
     and b.active
   order by b.currency, b.label;
$fn$;

comment on function org_client_funds_accounts is
  'The organisation''s own designated client-funds accounts, as a payer needs to see them to say which one they paid into. Last four digits only (0281).';

-- ── 11. The breakdown, written and vetted in ONE place ──────────────────────
--
-- ⚠️ Extracted rather than inlined into the submit path, because 0282 gives a
-- returned claim a way to be CORRECTED, and a correction writes exactly these
-- rows under exactly these rules. Two copies of this validation is how the
-- correction path ends up admitting a line the submit path refuses — which is
-- the shape of nearly every defect in this repo's own record (decisions 23, 24,
-- 0247, 0184). The standing test is identical in both cases because it is a
-- question about the CALLER, not about which button they pressed.
--
-- Replaces the claim's lines wholesale. A partial edit would need a diff, and a
-- diff of money against charges is a place to be wrong quietly.
create or replace function write_offline_claim_allocations(
  p_claim_id uuid,
  p_allocations jsonb,
  p_amount numeric
)
returns uuid
language plpgsql security definer set search_path = public as $fn$
declare
  v_actor uuid := active_uid();
  c offline_payment_claims%rowtype;
  v_line jsonb;
  v_sum numeric(16,2) := 0;
  v_amount numeric(16,2);
  v_purpose collection_purpose;
  v_rc rent_charges%rowtype;
  v_sc service_charges%rowtype;
  v_lease leases%rowtype;
  v_property uuid;
  v_unit uuid;
  v_outstanding numeric(16,2);
  v_own boolean;
  v_payer uuid;
  v_own_properties uuid[] := array[]::uuid[];
  v_staff boolean;
begin
  select * into c from offline_payment_claims where id = p_claim_id for update;
  if c.id is null then
    raise exception 'that recorded payment could not be found';
  end if;

  if p_allocations is null or jsonb_typeof(p_allocations) <> 'array'
     or jsonb_array_length(p_allocations) = 0 then
    raise exception 'say what this payment is for - pick at least one demand or invoice';
  end if;

  v_staff := has_permission('payments.record_offline');
  v_payer := c.payer_user_id;

  delete from offline_payment_allocations where claim_id = c.id;

  -- ── PASS ONE: lines that name a charge ───────────────────────────────────
  for v_line in select * from jsonb_array_elements(p_allocations) loop
    v_purpose := (v_line->>'purpose')::collection_purpose;
    v_amount := round((v_line->>'amount')::numeric, 2);
    v_property := null;
    v_unit := null;
    v_own := false;

    if v_amount is null or v_amount <= 0 then
      raise exception 'every line of the breakdown needs an amount';
    end if;
    v_sum := v_sum + v_amount;

    if v_purpose = 'rent' then
      select * into v_rc from rent_charges where id = (v_line->>'rent_charge_id')::uuid;
      if v_rc.id is null or v_rc.org_id is distinct from c.org_id then
        raise exception 'one of the rent demands on this payment could not be found';
      end if;
      select * into v_lease from leases where id = v_rc.lease_id;
      v_property := v_lease.property_id;
      v_unit := v_lease.unit_id;
      v_own := v_lease.tenant_user_id = v_actor;
      v_outstanding := v_rc.amount - v_rc.amount_paid;
      v_payer := coalesce(v_payer, v_lease.tenant_user_id);

      if upper(v_rc.currency) <> upper(c.currency) then
        raise exception 'that rent demand is in % and this payment is in %',
          v_rc.currency, c.currency;
      end if;

    elsif v_purpose = 'service_charge' then
      select * into v_sc from service_charges
       where id = (v_line->>'service_charge_id')::uuid and deleted_at is null;
      if v_sc.id is null or v_sc.org_id is distinct from c.org_id then
        raise exception 'one of the service-charge invoices on this payment could not be found';
      end if;
      select sb.property_id into v_property from sc_budgets sb where sb.id = v_sc.budget_id;
      v_unit := v_sc.unit_id;
      v_own := v_sc.billed_to_user_id = v_actor;
      v_outstanding := v_sc.amount - v_sc.amount_paid;
      v_payer := coalesce(v_payer, v_sc.billed_to_user_id);

    else
      -- deposit / other. Pass two, once we know which properties the caller has
      -- standing on through their own charges.
      continue;
    end if;

    -- Standing. Your own charge, or somebody else's while holding the capability
    -- AND reaching the place - decision 26's rule that a capability grants the
    -- act and never the reach.
    if not coalesce(v_own, false) then
      if not v_staff then
        raise exception 'that demand is billed to somebody else';
      end if;
      if not (current_user_role() = any (oversight_roles()))
         and not (v_property in (select current_user_property_ids())) then
        raise exception 'you do not manage the property that demand belongs to';
      end if;
    else
      v_own_properties := v_own_properties || v_property;
    end if;

    -- Checked, and NOT silently trimmed. If somebody transferred more than a
    -- demand is worth, the excess is real money that has to be accounted for
    -- somewhere; quietly reducing the line would lose it. The remedy the form
    -- offers is a "credit on account" line, which is pass two.
    if v_amount > v_outstanding then
      raise exception
        'you have put % against a demand with only % outstanding - reduce it, or put the difference on account',
        trim(to_char(v_amount, 'FM999,999,999,990.00')),
        trim(to_char(v_outstanding, 'FM999,999,999,990.00'));
    end if;

    insert into offline_payment_allocations (
      org_id, claim_id, purpose, rent_charge_id, service_charge_id,
      property_id, unit_id, amount
    ) values (
      c.org_id, c.id, v_purpose,
      case when v_purpose = 'rent' then v_rc.id end,
      case when v_purpose = 'service_charge' then v_sc.id end,
      v_property, v_unit, v_amount
    );
  end loop;

  -- ── PASS TWO: deposits and money on account ──────────────────────────────
  --
  -- These name no charge, so there is no billed-to column to establish standing
  -- from. Staff may record them against any property they reach. A tenant may
  -- only put money on account at a property they are ALREADY paying something at
  -- on this same claim - which is exactly the overpayment case, and stops the
  -- field being a way to attach a credit to a building you have nothing to do
  -- with.
  for v_line in select * from jsonb_array_elements(p_allocations) loop
    v_purpose := (v_line->>'purpose')::collection_purpose;
    if v_purpose in ('rent', 'service_charge') then
      continue;
    end if;
    v_amount := round((v_line->>'amount')::numeric, 2);
    v_property := nullif(v_line->>'property_id', '')::uuid;

    if v_property is null then
      raise exception 'a deposit or a credit on account has to say which property it belongs to';
    end if;
    if not exists (select 1 from properties where id = v_property and org_id = c.org_id) then
      raise exception 'that property could not be found';
    end if;

    if v_staff then
      if not (current_user_role() = any (oversight_roles()))
         and not (v_property in (select current_user_property_ids())) then
        raise exception 'you do not manage that property';
      end if;
    elsif not (v_property = any (v_own_properties)) then
      raise exception
        'you can only leave money on account at a property you are also paying a demand for on this payment';
    end if;

    insert into offline_payment_allocations (
      org_id, claim_id, purpose, property_id, unit_id, amount
    ) values (
      c.org_id, c.id, v_purpose, v_property,
      nullif(v_line->>'unit_id', '')::uuid, v_amount
    );
  end loop;

  -- The deferred trigger checks this too, at COMMIT, and its message is the one
  -- that matters. Stated here as well so the caller is told before the rest of
  -- the transaction runs, with the figure they actually typed in front of them.
  if v_sum <> round(p_amount, 2) then
    raise exception
      'the breakdown comes to % but the payment is % - every part of it has to be allocated to something',
      trim(to_char(v_sum, 'FM999,999,999,990.00')),
      trim(to_char(round(p_amount, 2), 'FM999,999,999,990.00'));
  end if;

  return v_payer;
end;
$fn$;

comment on function write_offline_claim_allocations is
  'Replaces an off-platform claim breakdown, vetting every line against the caller standing and the charge outstanding balance. Shared by the submit path (0281) and the correction path (0282) so the two cannot diverge.';

-- ── 12. Recording one ───────────────────────────────────────────────────────
--
-- The ONE write path. Neither table carries an insert policy, so this function
-- is not merely the convenient way in - it is the only one, and every rule the
-- board asked for is therefore unavoidable rather than merely usual.
--
-- SECURITY DEFINER because it has to read `leases`, `sc_budgets` and
-- `bank_accounts` to work out what a payment is FOR, and a tenant holds no read
-- on any of them.
create or replace function submit_offline_payment_claim(
  p_method offline_payment_method,
  p_amount numeric,
  p_paid_on date,
  p_bank_account_id uuid,
  p_proof_path text,
  p_allocations jsonb,
  p_currency text default 'NGN',
  p_payer_reference text default null,
  p_payer_note text default null,
  p_proof_filename text default null,
  p_payer_user_id uuid default null
)
returns uuid
language plpgsql security definer set search_path = public as $fn$
declare
  v_actor uuid := active_uid();
  v_org uuid;
  v_currency text := upper(trim(coalesce(p_currency, 'NGN')));
  v_bank bank_accounts%rowtype;
  v_claim_id uuid;
  v_ref text;
  v_payer uuid;
  v_email text;
  v_staff boolean;
begin
  if v_actor is null then
    raise exception 'your session expired - sign in again';
  end if;

  select org_id, email into v_org, v_email from users where id = v_actor;
  if v_org is null then
    raise exception 'your account is not attached to an organisation';
  end if;
  v_staff := has_permission('payments.record_offline');

  -- ── The two compulsory halves, checked before anything else ──────────────
  --
  -- Both are also table constraints. Checked here as well so the person gets a
  -- sentence they can act on rather than a constraint name: a refusal nobody can
  -- read is the dead end decision 30 was written about.
  if p_amount is null or p_amount <= 0 then
    raise exception 'enter the amount you paid - it has to be more than nothing';
  end if;

  if p_proof_path is null or trim(p_proof_path) = '' then
    raise exception 'attach your payment proof - a transfer receipt, bank-app screenshot or teller slip';
  end if;

  -- The uploaded object must sit under this organisation own prefix. The storage
  -- policy says the same thing on the way in; this says it again on the way out,
  -- because a path is a caller-supplied string and 0273's finding was exactly
  -- that a caller-supplied column reached a table with nothing checking it.
  if (storage.foldername(p_proof_path))[1] is distinct from v_org::text then
    raise exception 'that proof was not uploaded to this organisation';
  end if;

  -- ⚠️ And the object has to actually be there. Without this, "proof is
  -- compulsory" is a check on a STRING: a caller reaching the RPC directly could
  -- pass any well-formed path and record a payment with no evidence behind it,
  -- which the audit desk would then open and find nothing at. `not null` makes
  -- the column mandatory; this makes the EVIDENCE mandatory.
  if not exists (
    select 1 from storage.objects
     where bucket_id = 'payment-proofs' and name = p_proof_path
  ) then
    raise exception 'that proof could not be found — attach the file again';
  end if;

  if p_paid_on is null or p_paid_on > current_date then
    raise exception 'say what date the payment was made - it cannot be in the future';
  end if;

  -- ── Where it was paid in ─────────────────────────────────────────────────
  select * into v_bank from bank_accounts where id = p_bank_account_id;
  if v_bank.id is null or v_bank.org_id is distinct from v_org then
    raise exception 'choose which of our accounts you paid into';
  end if;
  if not v_bank.active then
    raise exception 'that account is no longer in use - choose the account named on your demand';
  end if;
  if v_bank.purpose <> 'client_funds' then
    raise exception 'a tenant payment is paid into the client-funds account, not %', v_bank.label;
  end if;
  if upper(v_bank.currency) <> v_currency then
    raise exception 'that account holds %, and this payment is in %', v_bank.currency, v_currency;
  end if;

  -- Refused HERE rather than discovered at posting time, three desks later, when
  -- somebody has already signed twice. `raisePaymentRequest` learned this for
  -- the gateway path and the reasoning transfers exactly.
  if collection_bank_account(v_org, v_currency) is null then
    raise exception
      'no % client-funds account is set up for this organisation - an administrator needs to add one under Settings before a payment in that currency can be recorded',
      v_currency;
  end if;

  v_ref := 'OPC-' || to_char(p_paid_on, 'YYYYMM') || '-' ||
           upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 6));

  insert into offline_payment_claims (
    org_id, reference, payer_user_id, payer_email, recorded_by, method,
    claimed_amount, currency, paid_on, destination_bank_account_id,
    payer_reference, payer_note, proof_path, proof_filename
  ) values (
    v_org, v_ref, p_payer_user_id, null, v_actor, p_method,
    round(p_amount, 2), v_currency, p_paid_on, p_bank_account_id,
    nullif(trim(coalesce(p_payer_reference, '')), ''),
    nullif(trim(coalesce(p_payer_note, '')), ''),
    p_proof_path, nullif(trim(coalesce(p_proof_filename, '')), '')
  )
  returning id into v_claim_id;

  v_payer := write_offline_claim_allocations(v_claim_id, p_allocations, round(p_amount, 2));

  -- Who the money is for, and where a receipt goes. 0253's lesson is that the
  -- address has to be KEPT, because for a payer with no portal account it is the
  -- only one that will ever exist.
  update offline_payment_claims
     set payer_user_id = v_payer,
         payer_email = coalesce(
           (select u.email from users u where u.id = v_payer),
           case when v_payer is null and not v_staff then v_email end
         )
   where id = v_claim_id;

  return v_claim_id;
end;
$fn$;

comment on function submit_offline_payment_claim is
  'Records a payment made by bank transfer or over a bank counter, with its proof and its breakdown. The ONE write path - neither table carries an insert policy. Records a claim only: nothing reaches the ledger until 0282 three desks have confirmed it.';

-- ── 13. Grants ──────────────────────────────────────────────────────────────
--
-- 📌 `revoke ... from public, anon` is NOT the list, and this repo has now
-- recorded that four times (0204, 0209, 0210, 0264). Supabase's default
-- privileges grant EXECUTE to `authenticated` on every new function, so the
-- reflex that names only `anon` is precisely the one that leaves the signed-in
-- world holding it.
--
-- ⚠️ FIFTH INSTANCE, found by this migration's own assertion during authoring,
-- and it is a role further on again: the default grant covers `service_role`
-- TOO. `write_offline_claim_allocations` below rewrites a claim's breakdown and
-- deliberately does not vet who owns the claim — its two callers have already
-- done that — so leaving `service_role` holding it would expose it to every
-- server-side path in this app that uses `supabaseAdmin`, which is most of them.
-- 0264's header says "the role that gets left standing is authenticated". It was
-- one role short. The list is: public, anon, authenticated, service_role — and
-- then grant back exactly what is intended.
revoke all on function offline_confirmation_roles() from public, anon, authenticated;
revoke all on function may_read_offline_claim(uuid) from public, anon, authenticated;
revoke all on function assert_offline_claim_reconciles() from public, anon, authenticated;
revoke all on function assert_offline_allocation_not_duplicated() from public, anon, authenticated;
revoke all on function offline_allocatable_charges() from public, anon, authenticated;
revoke all on function org_client_funds_accounts() from public, anon, authenticated;
revoke all on function write_offline_claim_allocations(uuid, jsonb, numeric)
  from public, anon, authenticated, service_role;
revoke all on function submit_offline_payment_claim(
  offline_payment_method, numeric, date, uuid, text, jsonb, text, text, text, text, uuid
) from public, anon, authenticated;

grant execute on function offline_confirmation_roles() to authenticated, service_role;
-- Granted: 0282 readers call it, and it discloses only whether the CALLER may
-- read a claim they already name. It cannot be made to list.
grant execute on function may_read_offline_claim(uuid) to authenticated, service_role;
grant execute on function offline_allocatable_charges() to authenticated, service_role;
grant execute on function org_client_funds_accounts() to authenticated, service_role;
grant execute on function submit_offline_payment_claim(
  offline_payment_method, numeric, date, uuid, text, jsonb, text, text, text, text, uuid
) to authenticated, service_role;

-- ⚠️ `write_offline_claim_allocations` is granted to NOBODY. It is an internal
-- half of two public functions and it takes a claim id it does not vet ownership
-- of - by design, because its two callers have already done that. Reached only
-- from inside a SECURITY DEFINER body, where the effective role is the owner and
-- these grants do not apply. Called directly it would let a caller rewrite the
-- breakdown of a claim already sitting in front of the audit desk.

-- ── 14. Assertions ──────────────────────────────────────────────────────────
--
-- A migration that states its rules in prose and does not test them is how
-- 0271's wreck survived two files. These fail the migration, not a suite run
-- days later.
do $$
begin
  if exists (
    select 1 from pg_policies
     where schemaname = 'public'
       and tablename in ('offline_payment_claims', 'offline_payment_allocations')
       and cmd <> 'SELECT'
  ) then
    raise exception 'a write policy appeared on the claim tables - every write goes through the definer functions';
  end if;

  if (select count(*) from information_schema.routine_privileges
       where routine_schema = 'public'
         and routine_name in ('submit_offline_payment_claim', 'offline_allocatable_charges')
         and grantee in ('anon', 'PUBLIC')) > 0 then
    raise exception 'an off-platform payment function is callable anonymously';
  end if;

  -- `service_role` is named here deliberately. Leaving it out is what let this
  -- same function ship reachable during authoring — see the note above section 13.
  if (select count(*) from information_schema.routine_privileges
       where routine_schema = 'public'
         and routine_name = 'write_offline_claim_allocations'
         and grantee in ('anon', 'authenticated', 'service_role', 'PUBLIC')) > 0 then
    raise exception 'the internal allocation writer is reachable from outside its two callers';
  end if;

  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'offline_payment_claims'
       and column_name = 'proof_path' and is_nullable = 'NO'
  ) then
    raise exception 'proof is not compulsory - the board asked for it to be';
  end if;

  if not exists (select 1 from capabilities where key = 'payments.record_offline') then
    raise exception 'the record-offline capability did not land';
  end if;

  if b7_grants('payment_audit_approver', 'payments.record_offline')
     or b7_grants('executive', 'payments.record_offline')
     or b7_grants('payment_approver', 'payments.record_offline') then
    raise exception 'a confirmation desk was granted recording - that is a way out of the chain';
  end if;

  if not b7_grants('property_manager', 'payments.record_offline')
     or not b7_grants('admin', 'payments.record_offline') then
    raise exception 'the recording capability did not reach the desks that take walk-in payments';
  end if;

  -- 0249 / 0245 / 0239: prove the rebuild carried the arms it was supposed to,
  -- rather than a stale copy of them. These are the ones the last three
  -- migrations to touch this function each moved.
  if not b7_grants('property_manager', 'leases.write')
     or not b7_grants('property_manager', 'sc.manage')
     or not b7_grants('regional_manager', 'applications.approve')
     or b7_grants('admin', 'records.export') then
    raise exception 'b7_grants was rebuilt from a stale copy - a previous decision was dropped';
  end if;
end $$;
