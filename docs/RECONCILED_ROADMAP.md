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
- **Activate webhook auth in production** — set `WHATSAPP_APP_SECRET` and
  `TELEGRAM_WEBHOOK_SECRET` in Vercel (code is ready; default-skips in POC).
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
