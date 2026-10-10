-- A voided budget frees its property and period, on every world (10 Oct 2026).
--
-- 0315 replaced 0109's one-budget-per-property-per-period index with one that
-- leaves voided budgets out (`where status <> 'void'`), so that voiding a budget
-- filed on the wrong property or in the wrong period frees that slot for the
-- correct one. Measured on staging during the rc10 run: the live index was
-- still 0109's, with no WHERE clause at all, although `_migrations` records 0315
-- as applied and the rest of 0315 (the void columns, `guard_sc_budget_update`)
-- is live. `verify-sc-budget-void` §G failed on it: a voided budget still held
-- its slot, and the correct budget could not be raised.
--
-- Cause, found the same day: `scripts/verify-sc-budget-uniqueness.mjs` §E drops
-- this index to prove the race it guards against is real, then rebuilt it from
-- a hard-coded copy of 0109's DDL. Every full suite run on dev or staging
-- therefore stripped 0315's WHERE clause again (it did so once more right after
-- 0335 was first applied). The suite now restores the live definition it read.
-- Production never runs the suites, so its index is as 0315 left it. What
-- matters for this file is that a world can have 0315 in its ledger and not
-- have its index.
--
-- So this asks the catalogue rather than the ledger. Where the index already
-- leaves voided budgets out (any world where 0315 landed whole) it does
-- nothing. Elsewhere it rebuilds 0315's index exactly. Rebuilding cannot fail on
-- existing rows: the index it replaces is strictly stricter (it counts voided
-- budgets too), so no two live budgets can share a slot today.

set local lock_timeout = '5s';

do $$
declare
  v_def text;
begin
  select indexdef into v_def from pg_indexes
   where schemaname = 'public' and indexname = 'sc_budgets_one_per_property_period_uidx';

  if v_def is not null and v_def ~* 'where.*status.*<>.*void' then
    raise notice '0335 sc_budgets_one_per_property_period_uidx already leaves voided budgets out; nothing to do';
    return;
  end if;

  drop index if exists sc_budgets_one_per_property_period_uidx;
  create unique index sc_budgets_one_per_property_period_uidx
    on sc_budgets (property_id, lower(btrim(period)))
    where status <> 'void';
end $$;

comment on index sc_budgets_one_per_property_period_uidx is
  'One live budget per property per billing period (audit 0805-C1, 0109), keyed on lower(btrim(period)). A voided budget is left out so the correct one can be raised in its place (0315, re-asserted by 0335).';

-- ── Assertion ──────────────────────────────────────────────────────────────
do $$
begin
  if not exists (select 1 from pg_indexes
                  where schemaname = 'public'
                    and indexname = 'sc_budgets_one_per_property_period_uidx'
                    and indexdef ~* 'unique index'
                    and indexdef ~* 'lower\(btrim\(period\)\)'
                    and indexdef ~* 'where.*status.*<>.*void') then
    raise exception '0335 sc_budgets_one_per_property_period_uidx is not 0315''s partial unique index';
  end if;
end $$;
