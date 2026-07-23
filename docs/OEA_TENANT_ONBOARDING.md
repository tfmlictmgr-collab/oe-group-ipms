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

## Open items (need answers before the downstream build)
1. **Rent custody model** (custodial-remit-to-landlord vs landlord-direct) — drives
   the funds ledger the onboarding hands off to. *Still unanswered.*
2. **Reviewer roles + approval hierarchy** for applications (who approves, thresholds?).
3. **Retention window** for rejected/withdrawn applicant PII (compliance decision).
4. **Which parts apply to TFML** (facilities tenants/work-orders) vs OEA-only.
