-- A service charge names its own unit, not just its type (5 Sept 2026).
--
-- Reported live: eleven invoices at "Lake River" all read
-- "Lake River · Office Suite" — indistinguishable from one another on the
-- Collections screen, which is how a genuine set of eleven separate suites
-- gets mistaken for one invoice billed eleven times.
--
-- ⚠️ They are not duplicates. Traced to `generateInvoices`
-- (`app/dashboard/sc/[id]/actions.ts`), which has built `property_or_unit` as:
--
--     `${property.name} · ${unit.label}`
--
-- since it was written — `label` alone, which since 0198 is a unit TYPE
-- ("Office Suite"), never the DISTINGUISHER. `unit_display_label()` exists
-- precisely for this ("the label alone is a TYPE, so twelve stalls print
-- twelve identical labels without this") and is used by the tenancy schedule
-- and the vacant-units picker — `generateInvoices` never selected `description`
-- from `units` in the first place, so it could not have called it.
--
-- The write path is fixed in the same commit as this migration. This backfills
-- every invoice already generated under the old convention, so the fix is not
-- only for budgets invoiced from today.
--
-- ── Why this is a label backfill, not a regenerate ──────────────────────────
--
-- `generateInvoices` regenerates by DELETING every invoice on the budget and
-- re-apportioning from scratch — the right shape when the apportionment itself
-- might change, and the wrong one for a pure display-text fix: it would
-- recompute amounts through the same rounding-residual logic a second time,
-- touch `amount_paid`/`status` on rows nobody asked to reopen, and refuse
-- outright wherever a payment has already been requested against any line
-- (0230's own guard). This UPDATE touches text only. No `amount`, `pct`,
-- `status`, `amount_paid` or foreign key changes.
--
-- ── The guard that makes it safe to run everywhere, once ────────────────────
--
-- Three conditions, all required:
--   1. the unit has a real, non-blank DESCRIPTION — nothing to disambiguate
--      otherwise, and nothing changes for it;
--   2. the row's stored text is EXACTLY `property.name || ' · ' || unit.label`
--      — the precise shape the buggy code produced. A row that reads anything
--      else — already correct, or hand-edited to something else entirely — is
--      left alone;
--   3. reached through the SAME `unit_display_label()` every other screen
--      calls, so the corrected text cannot drift from the tenancy schedule's
--      or the vacant-units picker's spelling of the same suite.
update service_charges sc
   set property_or_unit = p.name || ' · ' || unit_display_label(u.label, u.description)
  from units u
  join properties p on p.id = u.property_id
 where sc.unit_id = u.id
   and nullif(trim(coalesce(u.description, '')), '') is not null
   and sc.property_or_unit = p.name || ' · ' || u.label;

-- Proof, not a hope. If any invoice on a multi-unit property still shares its
-- text with a sibling after this runs, the guard above missed something and
-- the migration should say so rather than ship a partial fix silently.
do $$
declare
  v_still_ambiguous int;
begin
  select count(*) into v_still_ambiguous
    from (
      select sc.property_or_unit, count(distinct sc.unit_id) as units
        from service_charges sc
        join units u on u.id = sc.unit_id
       where sc.deleted_at is null
         and nullif(trim(coalesce(u.description, '')), '') is not null
       group by sc.property_or_unit
      having count(distinct sc.unit_id) > 1
    ) dupes;

  if v_still_ambiguous > 0 then
    raise notice
      '% property_or_unit string(s) are still shared by more than one distinguishable unit — review manually, they were not touched because their stored text did not match the known buggy pattern exactly',
      v_still_ambiguous;
  else
    raise notice 'every service-charge label now names a unit that no sibling on the same property shares.';
  end if;
end $$;
