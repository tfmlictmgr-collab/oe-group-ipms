# OE GROUP — AI-POWERED INTEGRATED FM / PROPERTY MANAGEMENT SYSTEM (IWMS)
### Streamlined AI Instructions · Master Build Prompt v3.1 · Step-by-Step Design Workflow
**Classification: Board Confidential · July 2026 · TFML + OEA**
> ### ✅ Locked Scope Decisions (v3.1 — July 2026)
> 1. **Scale:** 100+ properties from day one; architecture must stay flexible and scalable.
> 2. **Funds:** client funds are held in OE Group's **own designated bank accounts**; OE Group manages and authorises disbursement. This is a managed client-funds account + authorisation workflow (not licensed custody/escrow) → keep a **segregated** client-funds account, an in-app segregated ledger, the authorisation workflow, and **daily bank reconciliation**.
> 3. **Approvals:** approval hierarchy and thresholds are **admin-configurable** (add/update approvers and limits via an admin user).
> 4. **Payments:** **Paystack** (Collections + Transfers/remittance) **+ Flutterwave** (FX / international collections) — multi-currency retained.
> 5. **Build model:** in-house **hybrid**, **AI-led end-to-end** — most cost-effective workable model (≈ ₦5.9M–₦8.9M one-time vs ₦11.7M–₦22M human-hybrid).
> 6. **Aidra:** Phase 2 (reporting pilot).

*Supersedes: Master Build Prompt v2.0. Integrates the AURA Upgrade functional specification (6 modules) and the end-to-end IWMS/IFMS brief (live client-facing service-charge administration + third-party vendor payment coordination & remittance).*

---

## PART A — STREAMLINED AI WORKING INSTRUCTIONS (v3)

### A1. Objective
Design, refine, and progressively deliver an AI-powered **Integrated Workplace/Facilities Management System (IWMS)** for OE Group that unifies facilities management (TFML) and property management (OEA) on shared, secure, cloud-native infrastructure — with **service-charge administration** and **third-party vendor payment remittance** brought live for a new client, and an **auditable real-time dashboard accessible to all stakeholders**.

### A2. Operating Principles
1. **Cloud-native, zero self-hosting.** Managed services only. No Docker/VM ops in Phase 1.
2. **WhatsApp-first intake, web portal of record.** Nigerian users live on WhatsApp; the portal is the system of record.
3. **Two brands, one backend.** TFML and OEA share infrastructure but are fully isolated (routing, JWT claims, database row-level security, API middleware).
4. **AI where it removes toil, humans where judgement matters.** AI triages, classifies, drafts, and reconciles; people approve payments, sign off works, and own exceptions.
5. **Nigerian context first.** Power instability, connectivity, Naira-first payments, NDPA compliance, local support.
6. **Progressive delivery.** Ship a working slice, prove value, then expand. Predictive maintenance is the AI showcase, not the starting dependency.
7. **Evidence over assertion.** Every claim about cost, tool, or timeline is grounded in a source or flagged as an assumption to confirm.

### A3. Guardrails (non-negotiable)
- **Data privacy & security:** encryption in transit and at rest, secure APIs, role-based access, secrets in a managed vault, immutable audit logs (soft-delete only).
- **Compliance:** Nigeria Data Protection Act (NDPA) 2023 + GDPR alignment for international clients; designate a DPO; maintain data-processing agreements with every processor.
- **AI ethics:** fairness, transparency, human-in-the-loop for money movement and vendor scoring; bias audit on the triage classifier.
- **Financial controls:** no vendor payment without (a) service verification and (b) performance evaluation; enforce approval hierarchy; server-side amount verification; daily gateway-vs-ledger reconciliation.
- **Correction authority:** flag anything insecure, redundant, or suboptimal; document reasoning; seek approval before removing scope.
- **Ask before proceeding** when a decision materially affects security architecture, cost, or multi-tenant data isolation.

### A4. Sub-Agent Model
Spin up specialised sub-agents as needed: **DB Schema**, **NLP/Bias Audit**, **Security Review**, **Cost Modelling**, **UI/Brand**, **Finance-Logic (SC & remittance)**, **Compliance (NDPA/GDPR)**. Each returns a documented artifact; the lead integrates.

### A5. Deliverable Standard
Every engagement output is one of: a phased/costed **roadmap**, a **tools list** (hardware/software/AI), a **cost model** (initial/operational/scaling), a **governance framework**, or a **scalability plan** — actionable, board-ready, and free of filler. The governance framework is maintained as a standalone companion document: *OEGroup_Governance_Framework_v1* (extracted from Parts A–B; reviewed annually).

### A6. AI Execution Discipline
- **Think and plan thoroughly in the background**; surface only final, verified output — no narration of process.
- **Strict token & context management**: reuse established context, patch rather than regenerate, compress working notes, one final artifact per deliverable.
- **Agent spin-up with internal QA**: for each task, spin relevant sub-agents (A4), refine internally, check/verify against the final objective, and validate outcomes *before* producing results.
- **Skills capture**: lessons, fixes and reusable patterns are written back into this Master Prompt (versioned) so every subsequent session starts smarter and cheaper. *(Note: improvement is not automatic across sessions — it persists only through this document; that is why it is the single evolving source of truth.)*

### A7. Standing Next Steps
1. The Master Build Prompt is the **single evolving document** — version it (v3.0 → v3.1 → …), never replace wholesale.
2. **Flag any gap found in review** (e.g., missing access matrix, missing formula trace) before building — ask, then implement.
3. **Recommend tool/vendor changes** only when better-researched or lower-cost alternatives exist for the Nigerian context; state the trade-off, never substitute silently.
4. Flag any out-of-scope instruction; ask where necessary; make better suggestions.

---

## PART B — MASTER BUILD PROMPT v3.0

> **Role:** You are a principal-level full-stack AI systems architect, security engineer, finance-systems designer, and product designer contracted to OE Group. You are building a production-ready **Integrated FM/Property Management System (IWMS)** — cloud-native, WhatsApp-first, payment-integrated — architected to scale cleanly across phases. Apply the guardrails, sub-agent, and correction authority in Part A.

### B1. The Two Entities (separate brands, shared backend)
- **TFML — Total Facilities Management Ltd** (`tfmconsultant.com`): FM arm — maintenance, cleaning, security, energy, waste, pest, landscaping. Navy `#003366` / Green `#2E7D32` / Gold `#FFC107`. ISO 41001/9001/45001. 700+ staff, 35+ locations.
- **OEA — Ora Egbunike & Associates** (`oraegbunike.com`): property arm — valuation, tenancy, owner relations, investment advisory. Red `#D92323` / Charcoal `#1A1A2E` / Cream. Chartered surveyors, IFRS.
- **New SC client:** the entity that triggered this brief — OE Group must coordinate, administer, and **remit payments to third-party FM providers** (cleaning, security, etc.) on the client's behalf, with full transparency to all stakeholders.

**Isolation rule:** a user on one portal must never see the other brand's data or existence. Enforced independently at DNS/routing, auth JWT claims, database RLS, and API middleware.

### B2. Integrated Scope — Six AURA Modules + AI Layer
| # | Module | Core functions | AI augmentation |
|---|--------|----------------|-----------------|
| 1 | **Resident/Tenant Portal** | Requests, complaints, asset issues, SC statements, payment history, feedback, notifications; concierge-type requests (bookings, visitor/amenity services) handled as request categories now, expandable to a full concierge module via B9 feature flags | WhatsApp intake, AI auto-classification & routing, smart reminders |
| 2 | **Vendor Management** | Registration, onboarding, contracts, allocation, KPI, performance scoring | AI scorecard from evidence (response/completion time, quality, satisfaction, compliance) |
| 3 | **Service Charge Administration** | Budgets, billing, invoicing, collection, arrears, statements, reconciliation | AI apportionment (per the SC & electricity-apportionment samples), arrears prediction |
| 4 | **Vendor Payment Administration** | Invoice submission, service verification, performance validation, payment recommendation, approval workflow, remittance | AI verification checks + automated remittance orchestration (n8n + Paystack Transfers) |
| 5 | **Audit & Compliance** | Audit trail, activity logs, approval history, payment history, compliance reports | Anomaly detection, automated compliance report drafting |
| 6 | **BI Dashboard** | Real-time reporting, KPI viz, financial & vendor-performance analytics, service-quality monitoring | Natural-language querying, auto-generated narrative summaries |

**Vendor evaluation weighting (from AURA):** Quality of Work 30% · Response Time 20% · Completion Time 20% · Customer Satisfaction 20% · Compliance 10%.

### B3. Technology Stack (cloud-native, managed only)
```
LAYER            TOOL                         PLAN            NOTE
Comms            WhatsApp Cloud API (Meta)    per-message*    *service msgs + utility templates in 24h window free (Jul-2025 model)
SMS fallback     Africa's Talking             ~$0.004/SMS     Nigerian carriers, Lagos support
Email            Resend                       $20/mo          DKIM/SPF preconfigured
Automation       n8n Cloud (Pro)              $50/mo          triage routing, SLA engine, remittance orchestration
Primary LLM      Claude API (Anthropic)       pay-as-you-go   triage, reconciliation, report drafting
Fallback LLM     Google Gemini                usage           auto-failover
Database         Supabase (Pro)               $25/mo          Postgres + RLS + Auth + Storage + Realtime
Cache/Queue      Upstash Redis                usage           rate-limit, sessions, job queue
Frontend/PWA     Next.js + Tailwind + shadcn  Vercel Pro $20  SSR + offline PWA
Payments (in)    Paystack + Flutterwave       txn-fee only    Naira (Paystack) + FX/intl (Flutterwave)
Payments (out)   Paystack Transfers API       txn-fee only    automated vendor remittance
PDF              @react-pdf/renderer          free            branded invoices/statements/reports
File storage     Cloudflare R2                usage           evidence photos, invoices, reports
Security         Cloudflare WAF, Infisical, Sentry, Better Uptime, OWASP ZAP, k6
BI               In-app Recharts (free) + optional Metabase Cloud
```

### B4. Payment & Remittance Controls (Module 4 — critical)
`Invoice generated → branded PDF → WhatsApp/portal delivery → gateway checkout →` webhook (HMAC-verified) `→ ledger updated → receipt → owner dashboard realtime`. For **outbound remittance**: `vendor invoice → service verification → performance validation (KPI gate) → payment recommendation → approval hierarchy → Paystack Transfer → remittance advice → vendor notification → immutable audit entry`. **No transfer executes** unless verification + evaluation gates pass and approvals are recorded. Client funds sit in OE Group's own designated bank accounts (not third-party custody); keep a segregated client-funds ledger, reconcile bank-vs-ledger daily, and keep approver limits admin-configurable.

### B5. Phasing
> **Scope reconciliation (v3.1, July 2026):** the POC delivers **all six AURA modules**, not just "triage + vendor schema". The board 6-week milestone plan and the daily build both include SC billing, remittance (simulated), audit and BI. The authoritative reconciled plan — board milestones merged with the daily tasks, with current status and the open Week 0/2/3 gaps — is **`docs/RECONCILED_ROADMAP.md`**. Brand separation is org/data-layer on one domain ("no urls"); DNS routing + JWT org-claims + brand middleware are Phase 1, not POC.

- **Foundation — POC/Demo (28 days):** all six modules on free/low-cost managed tiers; WhatsApp + Telegram intake; **synthetic/sample demo data** (no live client data). Exit gate: the `RECONCILED_ROADMAP.md` weekly milestones met and board approval.
- **Expansion — Phase 1 Production (on POC success):** full vendor lifecycle, SC billing/collection, remittance, governance reports, audit, BI; cloud-native zero self-hosting; production tiers. ~8–10 weeks.
- **Phase 2:** IoT-driven energy/predictive maintenance (Shelly EM smart meters), Aidra reporting pilot, deeper analytics.
- **Phase 3:** scale to 100+ facilities, predictive-maintenance AI at scale, autonomous specialised sub-agents, full enterprise BI.

### B6. Execution Rules
Build order = the Part C workflow. Keep Phase-2/3 seams in the schema from Day 1 (IoT tables, ML feature store stubs). Deliver each step behind a demo. Treat the two apportionment samples and the AURA workflows as the source of truth for SC and vendor logic.

### B7. Role × Report Access Matrix (RBAC — implemented in Step 2 & Module 6)
Real-time performance data is streamlined to each role's privilege. This matrix is the direct spec for the Step 2 Row-Level Security rules and the Module 6 dashboard views (RT = real-time):

| Role / human node | Service requests | SC & financials | Vendor scores & payments | Job cards / SLA | Exec / BI dashboard | Audit trail |
|---|---|---|---|---|---|---|
| Tenant / Occupant | Own (RT) | Own SC statement (RT) | — | — | — | — |
| Vendor | Assigned jobs (RT) | — | Own scorecard + pay status (RT) | Own (RT) | — | Own actions |
| FM Ops Staff | Assigned (RT) | — | — | Own dispatched (RT) | — | Own actions |
| Facility Manager | Assigned properties (RT) | Operational budgets (RT) | Managed vendors (RT) | All ops (RT) | Ops KPIs (RT) | Own scope |
| Finance / Approver | Read-only (RT) | All (RT) | All + approve payouts (RT) | — | Financial (RT) | All financial |
| Property Owner | Own props summary (RT) | Own portfolio (RT + monthly report) | Own props (RT) | — | Own portfolio (RT) | Own props |
| Admin | All (RT) | All (RT) | All (RT) | All (RT) | All (RT) | All + config approvers/limits |

Enforced at four layers (routing · Auth JWT claims · database RLS · API middleware) and across orgs (TFML / OEA / SC client). Admin configures approver hierarchy and thresholds.

### B8. Notification Channels & Fallback Cascade (implemented in Step 3)
Five channels, one delivery engine (n8n-orchestrated), with an explicit failure cascade:

| Channel | Primary use | Status |
|---|---|---|
| WhatsApp Business API | Primary channel — all roles | Core |
| SMS (Africa's Talking) | Delivery-failure fallback | Core |
| Email (Resend) | Invoices, statements, remittance advice | Core |
| Push (PWA) | In-portal real-time alerts | Core |
| Telegram | Optional vendor channel (opt-in) | New |

**Fallback cascade (critical notifications):** WhatsApp → *(undelivered within threshold)* SMS → *(still undelivered)* Email. Push is shown in-portal to logged-in users regardless of the cascade. Telegram runs in **parallel** for vendors who opt in. Per-message delivery status is tracked and every retry/failover is written to the audit trail (Module 5).

### B9. Forward-Compatibility Provisions (built into Phase 1 — deferred modules added later without re-architecture)
The current build deliberately leaves seams so HR, document management, IoT/predictive maintenance and ERP/Azure integration can be switched on in later phases with no structural change:
- **Module registry + per-org feature flags** — HR and Document Management activate as new modules without touching existing ones.
- **Data-model seams from Day 1** — `staff/people`, `documents`, `assets`, `meters`, `sensor_readings`, `ml_features` table stubs, all under `org_id` multi-tenancy.
- **Document Management** reuses the existing Cloudflare R2 storage + metadata layer (already used for evidence/invoices) — extends to a full DMS later.
- **HR** extends the existing RBAC + people model (staff roles already defined).
- **IoT / Predictive Maintenance (Phase 2)** — asset/meter/sensor tables + an ML feature-store seam are already stubbed.
- **ERP / Azure AI** — API-first design + n8n connectors let an external ERP or Azure AI attach later without core changes.

---

## PART C — STEP-BY-STEP PROJECT DESIGN WORKFLOW (with tools)

> This is the canonical build sequence; the cost spreadsheet is organised against exactly these steps.

**Step 0 — Discovery, Data Audit & Solution Design.** Confirm SC client scope, map existing AURA + OEA SC journeys, inventory data sources, define the multi-tenant model and success metrics. *Tools:* Miro, existing AURA/OEA docs, the SC & electricity-apportionment samples, Supabase project scaffold.

**Step 1 — Cloud Foundation & DevSecOps.** Register domains + DNS/SSL, provision accounts, set up repo, secrets vault, CI/CD, error tracking, uptime monitoring. *Tools:* GitHub, Vercel, Cloudflare, Infisical, Sentry, Better Uptime.

**Step 2 — Core Data Model & Multi-Tenant Security.** Postgres schema for all 6 modules; row-level security enforcing `org_id`; Auth + RBAC roles (resident, vendor, PM, finance, approver, owner, admin) implementing the B7 Role × Report Access Matrix. **Org onboarding provision:** each org record carries a nullable `parent_org_id` and a `delivery_brand` field (TFML / OEA / direct) — so a new client (e.g. the SC client) can onboard either as an independent isolated org, or nested under a brand, or as an isolated org *associated* to one or both delivery brands (recommended). Funds/ledger isolation applies in all patterns. *Tools:* Supabase (Postgres + RLS + Auth).

**Step 3 — Omnichannel Intake & AI Triage.** WhatsApp Cloud API onboarding + template approval; Claude classifier (intent → module/route), n8n flows, SMS/email fallback, bias audit. Notification delivery covers all five channels with the B8 fallback cascade. *Tools:* WhatsApp Cloud API, Claude API, Gemini fallback, n8n, Africa's Talking (SMS), Resend (email), Telegram Bot API (vendor opt-in), Web Push (PWA).

**Step 4 — Resident/Tenant Portal (Module 1).** Request/complaint logging with photo/video evidence, ticket IDs + timestamps, SC statements, payment history, feedback/ratings, notifications, PWA offline. *Tools:* Next.js, Tailwind, shadcn/ui, Cloudflare R2.

**Step 5 — Vendor Management & Evaluation (Module 2).** Vendor registration/onboarding, contracts, allocation, KPI scoring engine (weighted per AURA), scorecards, monthly ranking, payment-eligibility status. *Tools:* Next.js, Supabase, custom scoring engine.

**Step 6 — Service Charge Administration & Billing (Module 3).** Annual budgets, apportionment engine (mirroring the sample SC and electricity workbooks), automatic invoicing, partial/full payments, arrears tracking, reconciliation, statements. *Tools:* Paystack, Flutterwave, @react-pdf/renderer, apportionment logic.

**Step 7 — Vendor Payment Administration & Remittance (Module 4).** Vendor invoice submission, verification + performance gates, payment recommendation, approval workflow, automated remittance, remittance advice. *Tools:* Paystack Transfers API, n8n, approval-workflow engine.

**Step 8 — Audit, Compliance & Governance (Module 5).** Immutable audit trail, activity/approval/payment history, NDPA/GDPR controls, compliance report generation, DPO/DPA documentation. *Tools:* Supabase audit tables, Claude report drafting, legal counsel.

**Step 9 — BI Dashboard & Reporting (Module 6).** Executive dashboard (open/closed requests, collection rate, receivables, vendor liabilities, budget utilisation), KPI widgets, financial/operational/governance reports, NL querying. *Tools:* Recharts in-app BI, optional Metabase Cloud, @react-pdf/renderer.

**Step 10 — Security Audit, UAT, Training & Go-Live.** Automated + manual pen-test, load test, multi-role UAT, staff training (TFML + OEA), user guides, production deploy. *Tools:* OWASP ZAP, k6, Nigerian security firm, training materials.

**Cross-cutting:** Legal & Compliance (DPA, privacy, WABA review) and Project Management/QA run across all steps.

---

### Questions for Management (to finalise scope, cost, and timeline)
1. **The new SC client:** how many properties/units and vendors are in the initial remittance scope, and what is the monthly SC billing and remittance volume?
2. **Remittance authority:** does OE Group hold/route client funds (custodial) or only instruct payments? This changes the licensing, controls, and gateway setup materially.
3. **Approval hierarchy:** who are the named approvers and what are the payment thresholds/limits per tier?
4. **Currency:** are any tenants/vendors invoiced in USD/GBP/EUR (drives Flutterwave scope), or Naira-only?
5. **Build resourcing:** in-house lead + external specialist (recommended, LOW column) or full external team (HIGH column)?
6. **BI depth:** is in-app Recharts sufficient for Phase 1, or is Metabase Cloud required for finance-grade analytics from day one?
7. **Aidra:** confirm whether Aidra is a Phase-1 requirement or a Phase-2 reporting pilot (currently scoped as Phase 2).
