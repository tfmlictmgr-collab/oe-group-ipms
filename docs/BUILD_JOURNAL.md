# Build Journal

Append-only. One entry per milestone: what shipped, what was **verified** (not
assumed), and any decision worth remembering. Newest last.

Conventions: 🟢 shipped · 🔎 verified · ⚖️ decision · ⚠️ defect found & fixed.

---

## 2026-07-24 · Phase 1 Day 1 — environment split
🟢 `phase-1` branch; dev Supabase (`uszwigxdvjlwcwkjsjmc`, eu-west-2) migrated +
seeded; Upstash rate-limiting on both intake webhooks; Sentry across
server/edge/client; isolated `oe-group-ipms-dev` Vercel project; UptimeRobot.

🔎 Seeding dev left the demo DB unchanged (demo 26 tickets on its own host, dev
22 on another). Limiter: 5 allowed then 6th blocked, independent per sender,
fail-open when unconfigured. Sentry test event delivered; no-DSN path sends
nothing. Deployed bundle references the **dev** Supabase; demo untouched.

⚖️ Two **separate Vercel projects**, not Preview-scoping — the demo project's env
vars are set for all environments, so a phase-1 preview there would have
inherited the demo database.

⚖️ Rate limiting **fails open**, webhook auth **fails closed**. Protection must
not take intake down; authentication must not be skippable.

---

## 2026-07-24 · Phase 1 Day 2 — brand isolation (from a prior session)
🟢 Per-org inbound channel routing (kills hardcoded `DEMO_ORG_ID`), JWT org
claims + brand middleware, S5 money-side property scoping.

⚠️ Found a **duplicate `0012` migration number** while resuming; renamed the
theming migration to `0013` and re-pointed the ledger row.

---

## 2026-07-24 · UI overhaul + per-org branding
🟢 Design system (semantic tokens, light/dark, elevation, focus rings); component
library (Button, Card, Badge, Input, Table, DropdownMenu, Sheet, Avatar…) and
patterns (PageHeader, StatCard, EmptyState, StatusBadge); SaaS app shell with
sidebar + mobile drawer + theme toggle + user menu; **every screen restyled**;
per-org branding — colours, monogram, **logo upload**, portal name, tagline,
support contacts, all admin-editable with no code.

🔎 Brand var resolves to TFML navy `#003366`; no horizontal overflow at 375px on
any screen; charts theme-aware (dark bars `#63a4ef`, grid `#2a2f3d`); logo
storage rules — admin can upload to own org, **cannot** to another org, non-admin
cannot at all, public read works; dev serves the new UI while the demo still
serves the old.

⚠️ **`<Button asChild>` crashed `/dashboard` with a 500** — `@radix-ui/react-slot`
calls `createContext`, which cannot run in a Server Component. Marked it
`"use client"`.

⚠️ **Theming silently never saved.** The audit trigger on `orgs` violated
`audit_log.org_id NOT NULL` because that table has no `org_id` (its identity is
`id`), and the audit fires in the same transaction, so every branding update
rolled back. Fixed in `0014`.

⚖️ **No per-org login headline.** Login is pre-auth and both brands share one
domain ("no urls"), so there is no way to know whose branding to show — the
control would have been dead. Column kept for when per-domain routing lands.

---

## 2026-07-25 · Asset register (Phase 1 core)
**Why now:** a careful check found asset management was *not* in Phase 1 at all —
`CLAUDE.md` B9 promised an `assets` stub "from Day 1" that was never built, B2
lets tenants raise "asset issues" against assets that didn't exist, and the
roadmap had **zero** mentions of "asset". Assets are a hub (tickets, work orders,
Phase-2 meters/sensors point at them), so building it now avoids backfilling
every relationship later.

🟢 `0016` assets — org → property → (optional) unit hierarchy; identity,
make/model/serial, lifecycle, condition, criticality, commercials, responsibility;
enums not free text; per-org case-insensitive unique tag; property-scoped RLS
(FM/PM write only their properties); integrity trigger so a unit must belong to
the asset's property; hard delete blocked; every write audited; `tickets.asset_id`.

🟢 `0017` archive/restore RPC. 🟢 `0018` insurance + statutory compliance columns
(indexed for expiry alerting), `asset_certificates` child table, and
**admin-definable custom fields** (`asset_field_definitions` + `custom_fields`
JSONB).

🟢 CSV template (per-org, includes custom fields), bulk import with row-level
validation preview, single-entry form, list with search/filter/expiry state,
detail page, nav entry.

🔎 Access: 14 checks — FM creates on managed properties but not unmanaged;
tenant/vendor blocked; reads property-scoped and cross-org isolated; mismatched
unit rejected; archive/restore/audit all correct. Import logic: 25 checks against
a deliberately messy file. **End-to-end against the dev DB:** 2 valid rows written,
3 blocked (unmanaged property, duplicate tag, typo'd enum), rejected rows
provably absent, `"1,250,000"` stored as `1250000`, audit entries present.

⚠️ **Soft-delete was impossible.** PostgreSQL applies SELECT policies to the NEW
row when an UPDATE carries `RETURNING` (PostgREST always adds it), so setting
`deleted_at` made the row invisible and the update was rejected outright — the
guardrail made the feature unusable. Replaced with explicit permission-checked
`archive_asset` / `restore_asset` / `archived_assets()`.

⚠️ **Import previewed rows the write would refuse.** Properties are readable
org-wide but assets are writable only on staked properties, so the picker offered
"Victoria Court" to an FM who doesn't manage it. Added `writableProperties()` and
routed every picker and lookup through it.

⚖️ **Hybrid extensibility:** core fields stay typed columns (indexed, validated,
importable); client-specific fields are admin-defined and stored in JSONB — so
fields can be **appended with no code and no migration**, and they appear in the
CSV template automatically.

⚖️ **Only 3 of 44 fields are required** (property, tag, name). Compliance and
insurance are optional so a quick register stays valid.

⚖️ **FM/PM is one role, two labels.** `facility_manager` renders as "Facilities
Manager" for TFML and "Properties Manager" for OEA. Permissions are identical;
splitting the role would double every RLS policy for no security gain.

📌 Carried to Day 3: FM/PM **attaché** assignment (staff or vendor) is defined
during onboarding — `property_stakeholders` already models it.
