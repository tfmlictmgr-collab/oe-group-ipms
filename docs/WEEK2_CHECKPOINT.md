# Week 2 Checkpoint — Full Access-Matrix Pass & Module State

**Date:** 2026-07-21 · **Owner:** Build Lead
**Verification artifact:** `scripts/verify-access-matrix.mjs` (re-runnable)

## Access matrix — result: NO VIOLATIONS

Checked at the RLS layer (the enforced boundary; UI nav gating + page RoleGates
sit on top) for all 9 users across 3 orgs:

- **Org isolation:** every readable row belongs to the caller's org — **0 cross-org
  rows** in any table, for every user. ✅
- **Role scoping:** tenant sees 0 tickets/payments; vendor sees only its own record
  and 0 SC rows; finance sees all payments (= admin). ✅
- **Cross-brand (Week 4 test):** TFML and OEA users read **disjoint** data — neither
  sees the other's tickets. ✅

Browser spot-checks (3 combinations): tenant → /payments = RoleGate; tenant nav =
Requests+Statements only; tenant → /bi = blocked. ✅

**Fix applied this pass:** added page-level `RoleGate` to the Payments, Vendors and
SC list pages. Previously a restricted role reaching those URLs directly saw an
empty (RLS-protected) shell; now they get a clean "not available for your role".

## Six modules — state

| # | Module | State | Notes |
|---|--------|-------|-------|
| 1 | Resident/Tenant Portal | ✅ Working | login, RLS ticket list, detail, new request, **realtime**, brand theming |
| 2 | Vendor Management | ✅ Working | ranked list, weighted composite scorecards, evaluation form (math verified) |
| 3 | Service Charge Admin | ✅ Working | properties/units/budgets, apportionment engine (sums exact), invoice gen, resident statements |
| 4 | Vendor Payment & Remittance | ✅ Working | B4 gate (verify→performance→approve→remit), **server-enforced**, simulated remittance, admin-configurable thresholds |
| 5 | Audit & Compliance | ✅ Working | DB-trigger audit, **immutable**, filterable viewer, notification delivery tracking |
| 6 | BI Dashboard | ✅ Working | role-scoped KPIs + charts, validated palette |

Plus: dual-brand instantiated & isolated (TFML/OEA), dispatch/assignment (job routed
& acknowledged), B8 notification cascade (auditable fallback), classifier accuracy
(category 100% / priority 100% within-one-step).

## Demo-risky flags

1. **FM over-grant.** Facility Manager currently sees *all* in-org tickets/SC/payments,
   not B7's literal "assigned properties / operational budgets / managed vendors."
   Not a leak (same org), but broader than spec — needs an FM↔property assignment
   model that doesn't exist yet. **Decision needed:** accept for POC or scope the model.
2. **Property Owner & FM Ops see little/nothing.** No ownership mapping and no
   standing job assignments, so RLS returns little. BI shows an honest empty note.
   Same root cause as (1). Don't demo `owner@`/`ops@` cold.
3. **Finance sees all audit**, not only "all financial" — minor over-grant.
4. **Vendor has no direct link to its own scorecard** (reachable only via detail URL).
   Polish.
5. **WhatsApp outbound** unverified live since the earlier Meta account issue; Telegram
   round-trip and the cascade fallback are proven. Re-confirm on a working WA number.
6. **All data is synthetic** (no real client data at POC time) — expected; re-run the
   classifier harness on a real anonymised sample when available.

## Polish list → Week 3 (Days 15–21)

- **Day 15:** one-command truncate + reseed producing the full demo dataset.
- **Day 16:** confirm all Vercel env vars set in the dashboard (not just locally).
- **Day 17 (security):** defensive `request.json()` wrap in webhooks; webhook
  rate-limiting / signature verification.
- Vendor self-scorecard link (polish).
- FM/owner/ops scoping precision — schedule as Phase 1 (needs assignment/ownership
  models), or make an explicit POC scope decision.
- Carry-overs: `docs/UX_BACKLOG.md`; multi-tenancy product flows (onboarding UI,
  per-org channel routing) in `docs/RECONCILED_ROADMAP.md`.

**Gate:** no access violations found; module set complete; polish list above is
short and scheduled. Week 2 checkpoint **PASSED**.
