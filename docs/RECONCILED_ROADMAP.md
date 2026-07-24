# Reconciled Delivery Plan — Board Milestones × Daily Build

**Status:** authoritative build plan (merge of two prior plans), July 2026.

Two planning documents existed and disagreed on order and on a few deliverables:

1. **The board milestone plan** — a 6-week, board-facing table with per-week
   verification and owners (the governance view).
2. **The 21-day daily workflow** — `docs/POC_DevWorkflow_v2_DualPathway.md`
   (the execution view, Pathway A).

This document reconciles them. The **board milestone plan governs *what* must be
provable each week**; the daily workflow governs *how* it gets built. Where the
daily build ran ahead of the weekly order, that is noted as a credit, not a
problem — but the weekly plan's explicit deliverables that were skipped are
tracked here as gaps with owners.

---

## Milestone × build-state matrix

| Wk | Board milestone | Board verification | Built via | Status |
|----|-----------------|--------------------|-----------|--------|
| 0 | Messaging accounts verified; sandbox creds; **anonymised historical request sample released** | Build Lead confirms readiness in writing | Days 1–3 (WhatsApp, Telegram, all creds) | ⚠️ Accounts/creds ✅ · **sample = GAP** |
| 1 | Environment + data structure + **dual-brand architecture established**; intake channel live | Test request received end-to-end | Days 1–6 (schema, RLS, `delivery_brand`/`parent_org_id` seams, brand theming, WhatsApp+Telegram intake) | ⚠️ Env/intake ✅ · dual-brand mechanism ✅ but **not instantiated** |
| 2 | Classification + **priority** triage; **accuracy measured against held-out sample** | Agreement rate reported against sample | Day 4 classifier + priority in acknowledgement | ⚠️ Triage ✅ · **accuracy measurement = GAP** |
| 3 | **Dispatch and assignment workflow** + notification to assigned party | Job routed and acknowledged | — (Day 8 built Vendor *Management*: registration + scoring, **not** job assignment) | ❌ **GAP — dispatch/assignment not built** |
| 4 | TFML + OEA branded portals operational, **verified data separation, no urls** | Cross-brand access test passed | Day 14 (access-matrix pass) is the home; RLS isolation already verified per-role | ⚠️ Mechanism ready · **instantiation + cross-brand test pending** |
| 5 | Invoice generation + **simulated** payment; rehearsal; environment frozen | Invoice issued, payment confirmed, env locked | Day 9 (SC invoicing) + Day 10 (gated sim payment) | ✅ Invoice + sim payment done · rehearsal/freeze = Days 16,18–21 |
| 6 (Slack) | Contingency; else reporting view + 2nd rehearsal; **board walkthrough** | Demonstration delivered | Day 12 (BI reporting) already built | ✅ Reporting ahead · walkthrough = Days 20–21 |

---

## Reconciliation notes

- **"no urls" (Wk4) is decisive:** brand separation is at the **org/data layer on
  one domain**, *not* DNS/domain routing. So DNS routing, JWT org-claims, and
  brand-segregating API middleware are **Phase 1 Production**, not POC. The POC
  proves isolation via database RLS + org theming.
- **CLAUDE.md B5 scope drift:** B5 originally scoped the POC as "WhatsApp triage +
  vendor schema" and pushed SC/remittance/audit/BI to Phase 1. The board plan and
  the daily build both include all six modules. B5 is superseded by this plan —
  the POC delivers all six modules (this is the stronger board story).

---

## Immediate course of action — make Weeks 0–2 board-provable

Ordered, because Wk2 depends on the Wk0 sample:

1. **Wk0 — anonymised historical request sample.** No real client data exists, so
   a **synthetic, clearly-labelled** sample of realistic Nigerian FM/property
   requests, each with an expected category + priority label. Doubles as the Wk2
   held-out test set. → `docs/sample-requests.json`
2. **Wk2 — classifier accuracy harness.** Run every sample through the *real*
   classifier and report the **agreement rate** (overall + per-category, category
   and priority separately). → `scripts/measure-classifier-accuracy.mjs`
3. **Wk1 — instantiate dual-brand.** Create TFML + OEA orgs with users so
   "dual-brand architecture established" is demonstrable (and front-loads the Wk4
   cross-brand test). Isolation proven by the existing RLS backstop.

## Tracked gaps beyond Weeks 0–2 (scheduled, not lost)

- **Wk3 dispatch/assignment workflow** — ✅ DONE. Assign to vendor/ops + acknowledge;
  RLS assignee visibility. In-app notification only; multi-channel is Day 13.
- **Wk4 cross-brand access test** — formal isolation test once orgs instantiated.
  (Orgs now instantiated + verified informally; formal repeatable test pending.)
- **FM/owner property scoping** — ✅ DONE (0008/0009). `property_stakeholders`
  model (manager/owner), tickets linked to properties, read policies rewritten so
  FM sees only managed-property data and owner only owned-property data; BI
  dashboards scoped accordingly. Verified for all roles in
  `scripts/verify-access-matrix.mjs`. Remaining minor over-grant: vendor list is
  still management-level (not per-property) — vendors aren't property-linked.
- UX production-readiness — see `docs/UX_BACKLOG.md`.
- PWA/offline + PDF export — CLAUDE.md B3 Phase-1 scope, not yet built.
- **Webhook rate-limiting** (Phase 1) — Upstash Redis sliding-window limiter on the
  intake webhooks. Signature verification (Day 17) is the POC mitigation; see
  `docs/SECURITY_REVIEW.md`.
- **Webhook auth in production** — ✅ DONE. `WHATSAPP_APP_SECRET` and
  `TELEGRAM_WEBHOOK_SECRET` are set in Vercel Production (verified 2026-07-24);
  the deployed code enforces whenever the secret is present, so inbound WhatsApp
  and Telegram (a B8 fallback channel) are authenticated — verified live on
  2026-07-24 (forged unsigned POSTs to both endpoints returned **403**). The
  hardening **merged into `main`** makes this **fail-closed** (missing secret →
  reject in prod, instead of silently skipping) as defence-in-depth. SMS
  (Africa's Talking) is still stubbed; secure its callbacks when it's wired in
  Phase 1. See the security-review tracker below (S1).
- **KPI/SLA-driven, dual-source vendor evaluation** (Module 2 upgrade) — tenant
  reviews the vendor on job completion + FM/PM evaluation, both driven by an
  admin-editable KPI/SLA checklist (computed scores, not free-typed), combined via
  the AURA weights. Full spec: `docs/PHASE1_VENDOR_EVALUATION.md`. ~1.5–2 weeks.
- **Role-appropriate personal reporting** (Module 6 extension — B7 already grants
  each role its own data; this is a nicer view of it):
  - *Tenant "Track my request"* — an ecommerce-style status timeline per request
    (Submitted → AI-triaged → Assigned → Acknowledged → In progress → Completed →
    Rate), the assigned vendor + its rating band, personal open/resolved summary,
    SC/payment history + next-due, notifications feed. **Buildable on existing
    timestamps** — highest-impact, lowest-cost addition; most relatable to a board.
  - *Vendor "My performance & pipeline"* — composite score trend + 5-dimension
    breakdown, job kanban (assigned→…→completed), payment status per invoice
    (incl. "blocked: below threshold"), rank as a **band/percentile only**.
  - **Guardrail:** each party sees its *own* data + a band/percentile — never
    competitors' names/scores, never vendor pay details to tenants.
  - POC-feasible now: tenant tracker, tenant SC/payment summary, vendor
    trend/pipeline/pay-status. Phase 1: tenant→vendor rating, vendor-visible
    reviews, SLA countdowns, earnings analytics.

### Multi-tenancy gaps — foundation built, product flows NOT (Phase 1)

The multi-tenant **foundation** is real and proven (every table carries `org_id`,
RLS scopes by org, TFML/OEA verified isolated). What is missing is the
**product surface** on top of it. These are **out of the 6-week POC scope** and
must be scheduled for Phase 1 — recorded here so they are not assumed done:

1. **Self-service onboarding / enrollment UI.** No in-app way for an org to enroll
   its own vendors, FMs, property managers, owners or tenants. Today users/vendors
   are created only by service-role seed scripts. Needs: public/invited signup,
   an admin "add member to my org" flow, role assignment UI, and vendor
   self-registration. The schema seams exist (`org_id`, `parent_org_id`,
   `delivery_brand`); the screens and invite flow do not.

2. **Per-org inbound channel routing.** One WhatsApp number, one Telegram bot, one
   credential set — and the webhook routes **hardcode `DEMO_ORG_ID`**, so every
   inbound message lands under the POC org regardless of brand. To have WhatsApp /
   Telegram / SMS uniquely service each org, need either separate numbers/bots per
   org or a mapping layer (inbound number/bot → org) that sets the ticket's
   `org_id` from the channel. Day 13 covers *outbound* delivery only, not inbound
   org routing. Ties to the same brand-isolation area as Wk4 ("no urls").

---

## OEA property-management expansion (Phase 1+) — locked scope

Source: `OUTLINE FOR SOFTWARE` + the three OEA tenant forms. Turns OEA from
service-charge administration toward full property/lettings management. Extends the
POC (does not overwrite). Full designs: `OEA_TENANT_ONBOARDING.md`; feature→phase
map in the chat-of-record. **Four scope decisions are locked (no ambiguity):**

1. **Rent = custodial.** OEA collects rent, deducts management/admin fees, remits to
   landlords through the **same B4 gated remittance + segregated client-funds ledger
   + daily reconciliation** as vendor payouts. Per-landlord `collection_mode =
   custodial | direct` flag; custodial is the core, the ledger is mandatory.
2. **Tenant-application review = two-tier, admin-configurable.** PM reviews/
   recommends (property-scoped); admin/finance approves. Individual → single
   approval, corporate → dual. Immutably audited.
3. **PII retention.** Rejected/withdrawn: purge PII after **90 days**. Approved:
   tenancy term **+ 6 years**, then purge/anonymise. Scheduled enforcement.
4. **TFML overlap via per-org feature flags (B9).** Shared for both brands:
   work-order media, inspections/inventory/audit, expense tracking, richer
   reporting. **OEA-only:** applications/KYC, leases, rent billing/roll, landlord
   dashboards, marketing. One codebase, per-org module registry.

### Phasing of the expansion
- **Phase 1 core:** tenant application & human-reviewed onboarding (both individual
  & corporate); lease administration (creation, unit allocation, renewal/demand
  notices); rent billing + rent roll/tenancy schedule; online rent payment
  (custodial); work-order photo/video; PM/landlord/tenant dashboards; net income /
  rental inflows / occupancy reporting; notices.
- **Phase 2:** OCR/AI form-extraction (assistive, human-verified); lease e-signing;
  bank-sync expense tracking (Mono/Okra); inspection checklists/inventory/audit;
  quarterly & rental-survey reports; predictive rental-trend analytics.
- **Phase 3:** one-click listing to social/web; leasing CRM; AI virtual touring
  (recommend third-party embed, e.g. Matterport, not build).
- **Advise/caution:** automated background checks are **not** in scope — screening is
  **human review of submitted forms** by design (avoids NDPA automated-decision +
  bias risk).

---

## LOCKED Phase 1 item — Interactive Analytics Dashboard (Module 6 upgrade, BOTH brands)

Upgrades the static BI dashboard into an **interactive, insight-driven analytics
console** for service improvement. Applies to **TFML and OEA** (operations-generic,
enabled via the B9 per-org feature registry). No ambiguity — this is committed.

### Filters (interactive, combinable)
- **Date range** (custom + presets), **vendor**, **classification/category**,
  **property**, **status**. Every filter is RLS-safe — a filtered view can never
  reveal data beyond the viewer's B7 matrix row.

### Metrics & insights
- **Completion rate (%)** by **vendor** and by **classification**; completed vs
  uncompleted counts *and* rate.
- **Best / worst performing vendor** (insight callout), vendor ranking with
  drill-down.
- **Average time-to-resolve** (and, once SLAs exist, SLA-adherence %).
- Open/closed, receivables, budget utilisation (existing) — now filterable.

### Time dimension
- **Weekly / monthly / quarterly / yearly** toggles with **trend lines** and
  **period-over-period comparison** (e.g. this quarter vs last).

### Enhanced UI feel (committed)
- Polished, modern, **interactive** — hover tooltips, click-through drill-downs,
  smooth responsive layout (mobile → desktop), brand-themed, validated dataviz
  palette (per the dataviz standard), light/dark aware. Export to **CSV/PDF**.
  Loading skeletons + empty states; accessible (WCAG AA).

### Data foundation (mostly exists)
- Tickets already carry status, category, `assigned_vendor_id`, and timestamps; the
  **immutable audit trail records every status transition with its time**, so
  completion timing is derivable. Add a `resolved_at`/`completed_at` column for
  direct, fast querying.

### Guardrails (baked in)
- **RLS preserved on every filtered/aggregated view** — org + property scope always
  applied server-side; filters can only narrow, never widen.
- **Resource/scale:** pre-computed / materialised aggregates (not per-request full
  scans) so it stays fast at 100+ properties; event-driven refresh.
- **Token optimisation:** any NL-query / narrative-summary AI is event-driven +
  cached, cheapest adequate model, never always-on.
- **Governance:** insights are descriptive analytics, not automated decisions.

---

## Pre-Phase-1 Security & Integrity Review — tracked calls (2026-07-24, PC2)

A code-grounded review of the POC baseline turned into decisions/calls. This is the
**synchronised source of truth** for both machines — every observed lag below has a
POC action *and* a Phase-1 home, so both builds get the fix. Code fixes live on
branch **`phase-1-hardening`** (commits `2e48f8b`, `2bf4b17`); migration
**`0010_money_integrity_hardening.sql`** is written but **not yet applied to any DB**.

| ID | Finding (plain) | POC / demo action | Phase-1 home | Status |
|----|-----------------|-------------------|--------------|--------|
| **S1** | Webhook auth *default-skipped* when a secret was unset | Secrets **are** set in prod (verified); code now **fail-closed** on branch → backport to `main` | Day 1 (keep secrets set; secure SMS callbacks) | ✅ prod safe · code backport pending |
| **S2** | `approval_threshold_amount` was **display-only** — any approver, any amount | App-layer enforce (admin required above the limit) → backport to `main` | Day 6 (full admin-configurable approval hierarchy) | ✅ on branch · hierarchy = Phase 1 |
| **S9** | `payments_update` RLS let a **direct API PATCH skip the gate** | Apply `0010` payment state-machine trigger (service-role-exempt) | Day 6 | ⏳ migration written |
| **S3** | `vendor_evaluations` **drive the KPI gate but were unaudited** (gate gameable) | Apply `0010` audit trigger | Day 4 / Day 11 | ⏳ migration written |
| **S4** | `service_charges` had **no audit** + were **hard-deletable**; no soft-delete | Apply `0010` (audit + `deleted_at` soft-delete) | Day 4 (ledger immutability) | ⏳ migration written |
| **S5** | FM sees **all vendors/payments/evaluations org-wide** (not property-scoped) | Leave (internal over-grant, org isolation holds) | Day 2 — extend property-scoping to the money side; **needs a vendor↔property model** (link table or derive via assigned tickets); re-run `verify-access-matrix.mjs` | 🔧 design call |
| **S6** | Next.js **14→16 bump is uncommitted, unpinned, untested** | **RESOLVED (PC1, 2026-07-24):** `main` is pinned at **`next@14.2.35`**, lockfile agrees, working tree clean — the proven POC baseline. The bump exists only as an uncommitted/stashed change in PC2's working copy; **drop it there**, don't commit it. | Day 0/1 gate — now clear | ✅ **resolved on `main`** |
| **S7** | Inbound **hardcodes `DEMO_ORG_ID`** (both brands collapse on intake) | Leave (POC is single-org) | Day 2 (channel→org routing) | ✅ already planned |
| **S8** | **No Gemini failover**; verify model id `claude-sonnet-4-6` | **VERIFIED (PC1, 2026-07-24):** live call to the Anthropic API with `claude-sonnet-4-6` returned **HTTP 200** — the id is valid and the classifier is not silently degrading. The **missing Gemini failover** remains real. | Day 12 (resilience) — failover only | ✅ model id verified · ⏳ failover pending |

**Applying these to the POC/demo too (per the "fix both builds" call):**
- **S1, S2 are code-only** (no schema change) → safe to merge to `main` and redeploy
  the demo; they improve the live POC with zero DB risk.
- **Migration `0010` (S9/S3/S4)** touches the **shared POC DB**. It is additive and
  **service-role-exempt** (seeds/webhooks unaffected), but it sits against Standing
  Rule #1 (*freeze the demo*). **CALL:** apply `0010` to the POC DB as a controlled
  one-off (recommended — low risk, gives the demo the same integrity guarantees), or
  defer to Phase-1 Day-1 once dev/prod are split. Whoever applies it runs
  `verify-access-matrix.mjs` + `verify-rls-rest.mjs` immediately after.
- **S6 is no longer a blocker.** Verified on PC1 (2026-07-24): `main` carries
  `next@14.2.35` in both `package.json` and `package-lock.json`, with a clean tree.
  Phase 1 can branch from `main` today. PC2 should discard its local bump.

**Live verification of the demo (PC1, 2026-07-24)** — evidence, not assertion:
- `oe-group-ipms.vercel.app/login` → **200**; landing → 307 (expected auth redirect).
- Forged unsigned `POST` to `/api/webhooks/whatsapp` → **403**; to
  `/api/webhooks/telegram` → **403**. Production webhook auth is **already
  enforcing** (secrets are set), so the fail-closed change on `phase-1-hardening`
  is defence-in-depth, not a fix for an open door.
- Demo DB: `_migrations` holds **0001–0009 only** — `0010` is applied nowhere.
  Seed data intact (3 orgs, 9 users across all 7 roles, 26 tickets, 5 vendors,
  3 payments, 30 service charges, 15 evaluations).
- **`0010` compatibility checked against the live schema before recommending it:**
  `current_user_role()` returns NULL (not an error) for the service role so the
  exemption is reachable; `log_audit()` reads `TG_ARGV[0]`, matching 0010's call
  form; `payments`/`service_charges`/`vendor_evaluations` all have NOT NULL
  `org_id` so `audit_log.org_id` cannot be violated by the new insert triggers;
  the trigger's state machine matches the app's real transitions exactly
  (`pending_evaluation`/`pending_approval` exist in the enum but are written by no
  code path); and `runPerformanceCheck` sets `performance_validated` and `status`
  in a single UPDATE, so the gate condition holds at trigger time. TRUNCATE
  bypasses row triggers, so `npm run seed` is unaffected.

**Cross-machine note (PC1 ↔ PC2):** this tracker lives on `main` so a `git pull`
syncs both machines. The code + migration for S1–S4/S9 live on `phase-1-hardening`
(pushed). Merge that branch (or cherry-pick the two code fixes) into the POC when
you accept the S6 decision, so the demo and Phase 1 stay in step.
