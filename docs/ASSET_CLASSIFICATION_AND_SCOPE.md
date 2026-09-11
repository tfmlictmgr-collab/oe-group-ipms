# Asset classification & scope — confirmed design + proposed additions

**Date:** 2026-08-05 · **Status:** proposal — nothing here has been applied.
**By:** PC2, from a design review requested by the account owner.

> **For PC1 to implement.** Part 1 is **confirmation, not instruction** — the
> existing design is correct; don't rebuild it. Part 2 is the actual work:
> three concrete, additive gaps, each with the exact migration shape needed.
> Next free migration number as of this doc: check `supabase/migrations/`
> (last was `0120` when this was written) — don't hardcode `0121`, the branch
> moves fast.

## Why this doc exists
"How best should assets be classified to fully define the asset scope?" has
two different correct answers in this codebase, and they're easy to conflate:

1. **Taxonomy** — *what* an asset is (category, criticality, compliance…).
2. **Access scope** — *who* can see/touch it (the RLS boundary).

Both are already well-designed. This doc confirms that, then adds the three
things a full FM asset register still needs that neither currently covers.

---

## Part 1 — Confirmed correct, keep as-is

### 1a. Taxonomy (`supabase/migrations/0016`–`0019`)

| Dimension | Field(s) | Purpose |
|---|---|---|
| System/category | `asset_category` enum — hvac, electrical, power_generation, plumbing, fire_safety, security, lifts_escalators, building_fabric, furniture_fittings, it_communications, other | Which vendor specialism handles it |
| Physical location | `property_id` (required), `unit_id` (optional), `location_detail` (free text) | Where — also the RLS scoping key, see 1b |
| Identity | `asset_tag`, `manufacturer`, `model`, `serial_number` | The make/model/serial triad every FM register needs |
| Lifecycle | `status` (in_service…disposed), `condition` (new…unserviceable) | State — deliberately separate from criticality |
| Criticality | `asset_criticality` (critical/high/medium/low) | Drives maintenance priority + SLA inheritance |
| Compliance | `compliance_required`, `regulatory_standard`, `certifying_body`, `certificate_number/expiry`, `last/next_inspection` | Statutory obligations, independent of criticality |
| Financial | `purchase_cost`, `replacement_cost`, insurer/policy/insured_value/expiry | Value + insurance — **not** depreciation, deliberately (that's the ledger's job) |
| Responsibility | `assigned_vendor_id` (maintains), `custodian_user_id` (accountable in-house) | Who |
| Extensible | `custom_fields jsonb` | Org-specific attributes without a schema change |

**Combine, don't add a field:** `category='fire_safety'` + `compliance_required=true`
+ `criticality='critical'` together already fully classify "this is a
life-safety asset" — resist adding a redundant flag for that.

### 1b. Access scope (RLS) — already the right two-tier model
```sql
org_id = current_user_org_id() AND (
  has_permission('assets.read')                     -- org-wide capability grant
  or property_id in (current_user_property_ids())    -- property-attaché scoping
)
```
Same property-scoping model as tickets/SC/budgets. `property_id` is the pivot
for *both* meanings of "scope" in this doc's title — the taxonomy field and
the RLS boundary are the same column. **No change needed here.**

---

## Part 2 — Three genuine, additive gaps

### 2a. No asset hierarchy / assembly relationship
Every asset is a flat, independent row. A chiller plant made of a chiller +
AHUs + ducting has no way to say "these belong together" — no system-level
rollup ("total spend on the HVAC plant," not just one unit) is possible.

**Implementation:**
```sql
alter table assets add column if not exists parent_asset_id uuid references assets(id);

-- Guard against cycles and cross-property/cross-org assemblies — a parent
-- must be a real ancestor, in the same org, same property.
create or replace function assets_parent_is_valid()
returns trigger language plpgsql as $$
begin
  if new.parent_asset_id is null then return new; end if;
  if new.parent_asset_id = new.id then
    raise exception 'an asset cannot be its own parent';
  end if;
  if not exists (
    select 1 from assets p
     where p.id = new.parent_asset_id
       and p.org_id = new.org_id
       and p.property_id = new.property_id
  ) then
    raise exception 'parent asset must exist in the same org and property';
  end if;
  -- Cheap cycle guard: walk up from the proposed parent; refuse if we reach NEW.
  if exists (
    with recursive up as (
      select id, parent_asset_id from assets where id = new.parent_asset_id
      union all
      select a.id, a.parent_asset_id from assets a join up on a.id = up.parent_asset_id
    )
    select 1 from up where id = new.id
  ) then
    raise exception 'that assignment would create a cycle';
  end if;
  return new;
end;
$$;

create trigger assets_parent_valid before insert or update of parent_asset_id
  on assets for each row execute function assets_parent_is_valid();

create index assets_parent_idx on assets (parent_asset_id) where parent_asset_id is not null;
```
UI: an optional "Part of" picker on the asset form, scoped to the same
property; the asset detail page gains a "Components" list (children) and a
breadcrumb up to the parent.

### 2b. No fixed-vs-movable distinction
A lift is permanently bound to a property; a portable generator or tool kit
could legitimately transfer between properties. Nothing currently
distinguishes "this can be reassigned" from "this is structurally part of
the building" — so a relocation has no correct/incorrect path, and no audit
trail of the move.

**Implementation:**
```sql
alter table assets add column if not exists mobility text
  not null default 'fixed' check (mobility in ('fixed', 'movable'));

comment on column assets.mobility is
  'fixed: structurally part of this property, never reassigned. movable:
   portable equipment that may transfer between properties in the same org —
   a reassignment updates property_id and is audited like any other change.';
```
No new function needed — the existing `assets` audit trigger already fires
on `property_id` changes; this column only *documents intent* and can gate
the UI ("Reassign" action only offered when `mobility = 'movable'"). Keep the
DB permissive (an admin can still hand-correct a miscategorised fixed asset)
— this is a workflow guide, not a hard constraint, matching how `condition`/
`status` are advisory-enforced rather than DB-locked elsewhere in this table.

### 2c. Maintenance is a snapshot date, not a strategy
`last_serviced_at`/`next_service_due` (0016, Phase-2 seams) are single dates
— no classification of *how* maintenance is triggered. Confirmed before
writing this doc: **`meters`/`sensor_readings`/`ml_features` still do not
exist** (`grep` across all migrations through `0120`, none found) — so the
usage-metered half of this is still genuinely Phase 2, exactly as originally
scoped (`CLAUDE.md` B9), not a regression. The **calendar-interval** half,
however, is cheap and Phase-1-appropriate:

```sql
alter table assets add column if not exists maintenance_strategy text
  not null default 'reactive'
  check (maintenance_strategy in ('reactive', 'calendar', 'usage'));

alter table assets add column if not exists service_interval_days integer
  check (service_interval_days is null or service_interval_days > 0);

alter table assets add constraint assets_calendar_needs_interval
  check (maintenance_strategy <> 'calendar' or service_interval_days is not null);

comment on column assets.maintenance_strategy is
  'reactive: serviced only on failure/report, the default. calendar: serviced
   on a fixed interval (service_interval_days) — next_service_due can then be
   computed/reset automatically after each service. usage: meter/hours-based
   — Phase 2, requires the meters/sensor_readings tables; the column exists
   now so no re-architecture is needed when that lands, but nothing sets it
   yet and no code should offer it in the UI until Phase 2.';
```
Phase-1 UI: only expose `reactive`/`calendar` as selectable; on a `calendar`
asset, recompute `next_service_due = last_serviced_at + service_interval_days`
after each logged service (mirrors how `rent_demand_lead_days` already drives
a scheduled job in this codebase — same pattern, different table). Leave
`usage` in the check constraint (so the column doesn't need widening later)
but keep it unreachable from the UI until the meter tables exist.

---

## Suggested sequencing
All three are independent — can land as one migration or three. If one:
group under a single file (e.g. `NNNN_asset_hierarchy_mobility_maintenance.sql`)
with each section clearly commented, matching this codebase's existing style.
None of the three touch RLS, the payment gate, or any money path — pure
schema + optional UI, safe to build without the extra scrutiny those areas
need.
