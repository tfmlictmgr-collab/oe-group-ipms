-- A service charge states how it was split, and a person may state it directly.
--
-- Apportionment has been pro-rata-by-area since 0003 and hardwired ever since:
-- `sc_budgets` carries a total and a period and nothing about METHOD, so the
-- rule lives entirely in `lib/apportionment.ts` and cannot be varied, recorded,
-- or explained on a statement. `lib/apportionment.ts`'s own header has said so
-- from the start — *"this is the conventional pro-rata-by-area method … the
-- brief names sample SC and electricity-apportionment workbooks as the source of
-- truth; reconcile these formulas against those files when they're available"*.
--
-- Two things follow, and only the second is new work:
--
--   **The method becomes a recorded fact.** `area` (what every existing budget
--   is), `equal` (per unit, ignoring size — how a small estate actually splits
--   security and waste), and `manual` (a person states each unit's share). The
--   default is `area`, so every budget already in the database keeps the meaning
--   it was created with and every existing verification suite exercises the same
--   arithmetic it always did. **Nothing about `area` changes.**
--
--   **`manual` needs somewhere to put the numbers.** That is `sc_budget_shares`,
--   one row per unit per budget. Deliberately an AMOUNT, not a percentage: a
--   percentage has to be multiplied and rounded to become money, and the whole
--   point of stating a split by hand is that the person has already decided what
--   each unit pays. Percentages are derived for display, never stored.
--
-- ⚠️ **The reconciliation rule, and where it lives.** Manual shares must sum to
-- the budget total exactly — the invariant `apportion()` guarantees by
-- construction for `area` and `equal` (it pushes the rounding residual onto the
-- largest weight). It CANNOT be a check constraint: it is a cross-row aggregate
-- compared against a column on the parent, and shares are edited one unit at a
-- time over minutes, so every intermediate state is legitimately unbalanced. A
-- deferred constraint trigger would only fire at commit of a single transaction
-- and would therefore never see the whole set.
--
-- So it is enforced where the money is actually created — at generation — and
-- `sc_manual_shares_state()` below is the ONE place the question is answered.
-- Both the screen and the server action that refuses generation read it, so the
-- figure a person is shown and the figure the guard applies cannot disagree.
-- That is decision 8's "one resolver, extended" applied to a rule rather than to
-- scoping, and it is the direct lesson of decision 22, where "vacant" had two
-- definitions free to disagree and did.

-- ── The method ────────────────────────────────────────────────────────────
do $$ begin
  create type sc_apportion_method as enum ('area', 'equal', 'manual');
exception when duplicate_object then null; end $$;

alter table sc_budgets
  add column if not exists apportion_method sc_apportion_method not null default 'area';

comment on column sc_budgets.apportion_method is
  'How this budget is split across the property''s units. area = pro-rata by occupied space x quantity (the original rule, and the default, so every budget written before 0227 keeps its meaning). equal = per unit regardless of size. manual = stated per unit in sc_budget_shares. Recorded on the budget so a statement can say how the figure was arrived at, which until now no screen could.';

-- Required before a composite foreign key can reference it, the same shape
-- `properties` and (since 0225) `units` already carry.
alter table sc_budgets
  add constraint sc_budgets_id_org_uniq unique (id, org_id);

-- ── Stated shares ─────────────────────────────────────────────────────────
create table sc_budget_shares (
  id         uuid primary key default gen_random_uuid(),
  org_id     uuid not null references orgs(id) on delete cascade,
  budget_id  uuid not null,
  unit_id    uuid not null,

  -- An amount, not a percentage. See the header: a person stating a split by
  -- hand has already decided what each unit pays, and re-deriving it through a
  -- percentage is a rounding step nobody asked for.
  amount     numeric(14,2) not null check (amount >= 0),

  -- Why this unit carries this share. A manual apportionment is a judgement,
  -- and a judgement with no reason recorded is indistinguishable from a typo
  -- when someone queries their bill three years later.
  note       text,

  set_by     uuid references users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint sc_budget_shares_one_per_unit unique (budget_id, unit_id),
  constraint sc_budget_shares_budget_same_org_fk
    foreign key (budget_id, org_id) references sc_budgets (id, org_id) on delete cascade,
  constraint sc_budget_shares_unit_same_org_fk
    foreign key (unit_id, org_id) references units (id, org_id)
);

create index sc_budget_shares_budget_idx on sc_budget_shares (budget_id);

create trigger sc_budget_shares_touch before update on sc_budget_shares
  for each row execute function touch_updated_at();

-- A manual apportionment decides what a person is billed. It is audited for the
-- same reason `landlord_terms` is: somebody chose this number.
create trigger audit_sc_budget_shares
  after insert or update or delete on sc_budget_shares
  for each row execute function log_audit('sc.share');

comment on table sc_budget_shares is
  'A per-unit share stated by a person, for a budget whose apportion_method is manual. One row per unit per budget. Must reconcile to the budget total before invoices can be generated -- enforced at generation via sc_manual_shares_state(), not as a constraint, because it is a cross-row aggregate and every intermediate editing state is legitimately unbalanced.';

alter table sc_budget_shares enable row level security;

-- Read follows the budget: whoever can see the budget can see how it was split.
-- Anything narrower would mean a manager could read a total they could not
-- explain.
create policy sc_budget_shares_select on sc_budget_shares for select to authenticated
  using (
    org_id = current_user_org_id()
    and budget_id in (select id from sc_budgets)
  );

-- Write is `sc.manage`, exactly as the budget itself. Stating a share IS setting
-- what a unit is billed, so it can be no easier than creating the budget.
create policy sc_budget_shares_write on sc_budget_shares for all to authenticated
  using (
    org_id = current_user_org_id()
    and (select has_permission('sc.manage'::text))
    and budget_id in (select id from sc_budgets)
  )
  with check (
    org_id = current_user_org_id()
    and (select has_permission('sc.manage'::text))
    and budget_id in (select id from sc_budgets)
  );

-- ⚠️ A policy is not a grant. `authenticated` needs both, and this is the exact
-- pair 0216 found missing on `vendor_registrations` — an UPDATE policy with no
-- UPDATE grant, where the client's upsert hid it because the failing branch is
-- the one that never runs on a first save.
grant select, insert, update, delete on sc_budget_shares to authenticated;

-- ── The one answer to "does this reconcile" ───────────────────────────────
/**
 * The state of a manual apportionment: what the budget wants, what has been
 * stated, which units are still unstated, and whether the two agree.
 *
 * Read by BOTH the budget screen and the server action that refuses to
 * generate. One question, one answer — so the number a person is shown and the
 * number the guard applies cannot drift apart, which is decision 22's finding
 * about "vacant" applied before rather than after the fact.
 *
 * SECURITY DEFINER over `sc_budgets` and `units`, so the org check below is the
 * whole boundary and is stated explicitly. `stated_units` counts rows rather
 * than trusting the caller to have supplied all of them.
 */
create or replace function sc_manual_shares_state(p_budget_id uuid)
returns table (
  budget_total  numeric,
  stated_total  numeric,
  variance      numeric,
  unit_count    bigint,
  stated_units  bigint,
  missing_units bigint,
  reconciles    boolean
)
language sql stable security definer set search_path = public as $$
  with b as (
    select sb.id, sb.total_amount, sb.property_id
      from sc_budgets sb
     where sb.id = p_budget_id
       and sb.org_id = current_user_org_id()
  ),
  u as (
    select count(*) n from units, b
     where units.property_id = b.property_id and units.deleted_at is null
  ),
  s as (
    select coalesce(sum(sh.amount), 0) total, count(*) n
      from sc_budget_shares sh, b
     where sh.budget_id = b.id
  )
  select
    b.total_amount,
    s.total,
    round(b.total_amount - s.total, 2),
    u.n,
    s.n,
    greatest(u.n - s.n, 0),
    -- Exact to the kobo. "Close enough" on an apportionment is a unit paying
    -- somebody else's share, and the residual has to land somewhere a person
    -- chose rather than wherever the arithmetic dropped it.
    (round(b.total_amount - s.total, 2) = 0 and s.n = u.n and u.n > 0)
  from b, u, s;
$$;

revoke all on function sc_manual_shares_state(uuid) from public;
revoke execute on function sc_manual_shares_state(uuid) from anon;
grant execute on function sc_manual_shares_state(uuid) to authenticated;

comment on function sc_manual_shares_state is
  'Whether a manual apportionment is complete and reconciles to the budget total, to the kobo, with every unit stated. The single answer read by both the budget screen and the generation guard, so what a person is shown and what refuses them cannot disagree. Definer-scoped to current_user_org_id().';

-- ── The method a budget was invoiced under, on the invoice ───────────────
--
-- `service_charges.apportionment_pct` records the SHARE and has never recorded
-- how that share was arrived at. A tenant querying a bill is owed the method,
-- and a manual split is exactly the case where "pro-rata by floor area" would be
-- the wrong explanation to print.
alter table service_charges
  add column if not exists apportion_method sc_apportion_method;

comment on column service_charges.apportion_method is
  'How this invoice''s share was arrived at, snapshotted at generation from the budget. Nullable: every invoice raised before 0227 was area, and back-filling a value nobody recorded would be inventing evidence. Null reads as "area (unrecorded)" on a statement.';
