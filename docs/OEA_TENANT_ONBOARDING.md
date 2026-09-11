# OEA Tenant Application & Onboarding (Phase 1 design)

Source: three OEA forms — *New Tenants Acquaintance Form* (individual),
*Tenant's Guarantor/Referee Form* (individual), *Tenant KYC — Shopping Mall*
(corporate). This is the **front door to lettings**: a human-reviewed application
that, on approval, hands off to lease creation and the rest of the pipeline.

## Flow (the "design flow")
```
Prospective tenant (individual OR corporate)
  → receives the right application form
  → fills ELECTRONICALLY in-app  OR  downloads → fills → uploads the completed file
  → submits with required attachments (IDs, CAC, TIN, passport, guarantor, etc.)
  → enters the review queue
  → human reviewer(s) evaluate → request-info / approve / reject  (fully audited)
  → on APPROVAL → onboarding kicks in:
        create lease → allocate unit → provision tenant account (invite)
        → rent billing + notices begin
```
**No automated approval/rejection** — decisions are human, by design. Any AI
(e.g. reading fields off an uploaded PDF) is decision-*support* only, human-verified.

## Two application types (one table, a discriminator)
A single `tenant_applications` record with `type = individual | corporate`, so one
review queue serves both. Type-specific fields live in a JSONB payload (forms will
evolve — JSONB avoids schema churn) alongside indexed core columns.

**Individual** captures: personal (name, state/LGA, addresses, sex, DOB, religion*,
phones, email, socials), employment (employer, position, tenure, business/CAC if
self-employed), residence history (former address, reason for vacating, years,
former landlord/surveyor), intended use + occupants + pets, family (marital status,
spouse, next-of-kin), plus a **guarantor + two referees**.

**Corporate** captures: business (trading + registered name, CAC, TIN, addresses,
structure, category, nature, web/social), authorised contact (name, position,
contact, ID, DOB), trading history (years, branches, franchise, current
landlord/PM), proposed tenancy (unit/shop, size sqm, floor preference, intended
use, lease term, move-in, fit-out, signage), financial (bank reference, guarantor),
**two trade references**, and attachments (CAC, ID, TIN/tax clearance, passport,
company profile).

`*` religion / marital status are **special-category personal data** — optional,
flagged, and access-restricted (see guardrails).

## Data model (new entities — all `org_id` + property-scoped, RLS-enforced)
- `tenant_applications` — id, org_id, type, status
  (`draft|submitted|under_review|info_requested|approved|rejected|withdrawn`),
  applicant contact, property_id / preferred unit, form JSONB, consent flags,
  submitted_at, decided_by, decided_at, decision_notes.
- `application_attachments` — id, application_id, org_id, kind
  (`national_id|work_id|cac|tin|passport|company_profile|guarantor_id|other`),
  storage ref (Cloudflare R2, per-org prefix), content_type, size, uploaded_at.
- `application_reviews` — id, application_id, reviewer_id, decision, notes,
  created_at (immutable via the existing audit triggers).
- Guarantors / referees / trade references — sub-rows or JSONB on the application.
- **On approval** → create `lease` (+ unit allocation) and provision the tenant
  `user` (invite), reusing the onboarding + notification machinery.

## Dual submission path
- **Electronic:** in-app multi-step form (individual vs corporate variant), inline
  validation, **save-as-draft**, submit. Best data quality.
- **Upload:** download a blank/branded template, complete offline, upload the file
  + attachments. The uploaded file is the record of truth; a reviewer captures the
  key fields (Phase 2: optional OCR/AI pre-fill, always human-verified).

## Human review workflow
- Submitted applications land in a **review queue** (roles: PM/reviewer, admin).
- Reviewer sees structured data + attachments; can **request more info**, **approve**,
  or **reject with notes**.
- **Admin-configurable approval hierarchy** (mirrors the payment-approver pattern).
- Every action is written to the immutable audit trail.
- Approval triggers the onboarding handoff above.

## Guardrails applied (per the standing requirements)
- **NDPA / data protection — the heaviest PII in the system.** Explicit **consent**
  captured at submission; purpose limitation ("tenancy screening only" — already on
  the forms); strict RLS so only assigned reviewers + admin see an application;
  encryption at rest (Supabase + R2); a **retention policy** that auto-purges
  rejected/withdrawn applicant PII after a defined window; a DPA. Special-category
  fields (religion, marital status) optional and separately gated.
- **Security hardening:** uploads validated (allow-listed content-types, size caps),
  private R2 with signed URLs (no public access), per-org key prefixes; virus/type
  screening before a reviewer opens a file.
- **Bias mitigation / governance:** no automated decisioning; human-in-the-loop,
  explainable, auditable. AI extraction is assistive and verified.
- **Token / resource optimisation:** any AI (OCR/summaries) is event-driven and
  cached, cheapest adequate model; never always-on.
- **Access speed / scalability:** JSONB + indexed core columns; paginated review
  queue; media served via CDN (R2). Scales to 100+ properties.
- **Robustness / flexibility:** JSONB form payload absorbs form changes without
  migrations; one table + discriminator keeps a single review pipeline.

## Phasing
- **Phase 1 (core):** electronic form (both types) + upload path + attachment
  storage + consent + human review/approval workflow + audit + onboarding handoff to
  lease creation. This is the extracted core component.
- **Phase 2:** OCR/AI-assisted field extraction from uploaded PDFs; application-funnel
  analytics; optional e-signing of the declaration; optional external verification
  hooks (only if OEA later contracts providers).

## Locked decisions (July 2026 — authoritative, no ambiguity)

1. **Rent custody = CUSTODIAL (default).** OEA collects rent into OE Group's
   segregated client-funds account, deducts management + admin fees, and remits the
   balance to landlords through the **same gated remittance + segregated ledger +
   daily bank-vs-ledger reconciliation** as vendor payments (CLAUDE.md B4). A
   per-landlord `collection_mode = custodial | direct` flag supports landlords who
   collect directly (OEA then bills fees only) — but the **core build is custodial
   and the segregated funds ledger is mandatory**. Rent therefore reuses Module 4's
   approval-gated remittance, not a side path.

2. **Reviewer hierarchy = two-tier, admin-configurable.** A **Property Manager**
   (`facility_manager` role, property-scoped via `property_stakeholders`) reviews and
   recommends; an **Approver** (`admin` or `finance_approver`) gives final approval.
   Defaults: **individual applications → single approval; corporate/commercial →
   dual (recommend → approve)**. Approver assignment + the single/dual threshold are
   admin-configurable (mirrors `payment_settings`). Reviewers see only applications
   for properties they manage; every action is immutably audited.

3. **PII retention = enforced defaults.** **Rejected/withdrawn applications: PII
   auto-purged after 90 days** (an anonymised audit stub remains, proving a decision
   was made). **Approved applications: retained for the tenancy term + 6 years**
   after termination (Nigerian contract limitation period), then purged/anonymised.
   Special-category fields (religion, marital status) are optional and separately
   access-gated. A scheduled job enforces the purges; windows are admin-configurable
   but ship at these defaults.

4. **TFML overlap = per-org feature flags (B9).** Enabled for **both** brands
   (shared operations): work-order photo/video, inspection checklists/inventory/audit,
   expense tracking, richer reporting/dashboards (vendor management already shared).
   **OEA-only** (lettings): tenant application/KYC/onboarding, lease administration,
   rent billing/roll, landlord dashboards, marketing/leasing. TFML keeps
   facilities-ops with **no** tenant/lease/rent modules. One codebase, toggled by the
   per-org module registry.


---

## Built, and what changed in building it (30 July 2026)

**Required documents are configuration, not code.** `application_document_requirements`
holds them per org and per application type, and
`submit_tenant_application()` enforces them. The list in `lib/application-form.ts`
seeded it and no longer decides anything — one rule, one place.

**The completeness gate lives inside the transition.** It used to sit in the server
action, reading `application_attachments` through the applicant's own anon session
— which has no SELECT policy, so it returned zero rows *without erroring* and every
uploaded document read as missing. Submission was impossible for every applicant.
The RPC is also granted to `anon`, so a check outside it could be posted past. Both
answered by asking the question where the answer is visible and cannot be routed
around.

**Save-and-resume is real.** `startApplication` emails the link, the public page
accepts `?resume=<token>` and rehydrates through `resume_application()`, and the
page re-checks the draft's `org_id` against the org in the URL so a token cannot be
replayed through another organisation's page. `/tenancy/*` sends
`Referrer-Policy: no-referrer` and `Cache-Control: no-store`.

**Two columns are unreadable to `authenticated`:** `sensitive` (special-category —
RLS is row-level and cannot withhold a column) and `resume_token_hash` (the
resume/save/submit functions take that hash as their argument, so reading it is
equivalent to holding the applicant's link). Column privileges cannot be carved out
of a table-level grant, so the grant was replaced with an explicit column list.

### Amendment to locked decision 2 — AI verification (board, 29 July 2026)

Screening stays **human and two-tier**. Automated **document verification** is now
permitted as decision *support* — extraction, format and consistency checks,
completeness, duplicates — and may never decide, score, rank or recommend. Findings
are tied to the evidence they came from; the reviewer must record their own reason;
special-category data never reaches a model. See `CLAUDE.md` v3.3 decision 10.

### Still open

- Per-property application window (`auto` / `open` / `closed`), which gives an
  application its `property_id` and makes property-scoped PM review possible — the
  Day 8 blocker.
- A verified Resend sending domain for `oraegbunike.com`, or the resume email will
  not reach an OEA applicant.
