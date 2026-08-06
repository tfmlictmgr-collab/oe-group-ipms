-- Audit 0805-C1 — `createBudget`'s duplicate-period guard is a read-then-insert
-- race, and nothing at the database layer backs it up.
--
-- `app/dashboard/sc/actions.ts` SELECTs for an existing budget on
-- (property_id, period) and refuses if it finds one. That check is real and
-- worth keeping — it produces a message a person can act on — but between its
-- SELECT and its INSERT there is nothing holding the gap closed. Two
-- submissions landing together (a double-clicked button is the ordinary case,
-- not an exotic one) both read "no clash" and both insert.
--
-- What makes this worth a migration rather than a debounce: the duplicate is
-- not a cosmetic extra row. `app/dashboard/sc/[id]/actions.ts` apportions a
-- budget across every unit of its property and raises a real invoice per unit.
-- Two budgets for the same property and period therefore bill every tenant in
-- that property TWICE, through the normal invoicing path, with no error
-- anywhere — the second run looks exactly like a legitimate first run for a
-- different budget. The regenerate guard already in that file protects against
-- re-invoicing the SAME budget; it has no way to know a second budget is a
-- duplicate of the first.
--
-- The codebase already solves precisely this shape one table over:
-- `rent_charges_one_per_period unique (lease_id, period_start)` (0090), which
-- is why rent demands can be raised by both a button and a nightly cron
-- without ever double-charging. Service charge simply never got the same
-- treatment.
--
-- ── Why the key is normalised, not the raw text ───────────────────────────
-- `period` is free text a person types ('2026', 'FY2026', 'Q1 2026'). A plain
-- unique (property_id, period) would let 'FY2026' and 'fy2026' coexist on one
-- property — two rows the database considers distinct and every human
-- considers the same billing period, which is the double-invoice this
-- migration exists to prevent. Normalising the KEY (not the stored value, so
-- what the user typed is still what statements display) closes that too. This
-- follows the per-org case-insensitive asset tag (0016), the same decision for
-- the same reason: a human-entered identifier whose case is presentation.
--
-- Checked against the live data before adding: 6 rows, zero duplicate
-- (property_id, period) groups, zero near-duplicate spellings — so this
-- constrains future writes and does not reject anything already recorded.
--
-- `sc_budgets` has no `deleted_at` (it is hard-deletable by `sc_budgets_delete`,
-- 0055), so unlike the soft-deleted tables elsewhere in this schema no
-- `where deleted_at is null` clause is needed: deleting a budget genuinely
-- frees its period again.
create unique index sc_budgets_one_per_property_period_uidx
  on sc_budgets (property_id, lower(btrim(period)));

comment on index sc_budgets_one_per_property_period_uidx is
  'One budget per property per billing period (audit 0805-C1). The application checks this first for a readable message, but the check is a read-then-insert race and a second budget silently double-invoices EVERY unit of the property through the ordinary apportionment path. Keyed on lower(btrim(period)) rather than the raw text so FY2026 and fy2026 cannot both exist -- the stored value is untouched, only the uniqueness key is normalised. Mirrors rent_charges_one_per_period (0090).';
