# NDPA Compliance Pack — OE Group IWMS

**Prepared:** 8 August 2026 · Day 12 · **Status: draft for the board and for
legal review.**

Written against the **Nigeria Data Protection Act 2023**, with GDPR alignment
where international clients are in scope (`CLAUDE.md` A3).

> **What this document is.** Every claim below is grounded in code that was
> checked while writing it, and each is marked ✅ **enforced** (the system makes
> it true), 📄 **documented** (written down, relies on people), or ⛔ **open**
> (needs a decision or a signature). Nothing is asserted because it was
> intended.
>
> **What it is not.** It is not legal advice and it is not a signed compliance
> statement. A Nigerian data-protection practitioner should review it before
> the board relies on it.

---

## 1. Controller, processors, and the DPO

| | |
|---|---|
| **Data controller** | OE Group (TFML and OEA as brands; each client org's data is controlled by OE Group under its management agreement) |
| **Data Protection Officer** | ⛔ **Not designated.** NDPA requires a named person. Board action. |
| **Registration with the NDPC** | ⛔ Confirm whether OE Group meets the data-controller-of-major-importance threshold. Board/legal action. |

---

## 2. What personal data the system holds

| Category | Where | Who it is about |
|---|---|---|
| Identity & contact | `users` (name, email, phone, Telegram id) | staff, tenants, vendors, landlords |
| Tenancy application | `tenant_applications.form` — employment, address, next of kin, income | applicants |
| **Special category** | `tenant_applications.sensitive` — religion, marital status | applicants |
| Identity documents | `application-documents` bucket (private) | applicants |
| Property imagery | `work-order-media` bucket (private) — photographs taken **inside** client homes | tenants, incidentally |
| Financial | `payments`, `rent_charges`, `service_charges`, `ledger_*`, `payout_recipients` (bank details) | tenants, vendors, landlords |
| Behavioural | `tickets`, `ticket_messages`, `audit_log`, `user_notifications` | everyone |

### ✅ Special-category data is walled off

`tenant_applications.sensitive` is a **separate column from `form`**, and the
reviewer-facing function that returns an application **omits it** — the
migration carries the comment `-- note: 'sensitive' is NOT here`. Per decision
10 it is **never sent to a model**. Verified in `0062`.

---

## 3. Lawful basis (NDPA s.25)

| Processing | Basis |
|---|---|
| Tenancy application & KYC | **Consent** (captured explicitly) + steps prior to a contract |
| Lease administration, rent, service charges | **Contract** |
| Vendor management and payment | **Contract** |
| Maintenance requests & work orders | **Legitimate interest** — operating the property |
| Audit trail | **Legal obligation** + legitimate interest |
| Special category (religion, marital status) | **Explicit consent only.** Collected for tenancy suitability context; ⛔ the board should confirm it is genuinely necessary, since the cleanest NDPA position is not to collect it at all. |

### ✅ Consent is stored verbatim, per application

`tenant_applications.consent_statement` holds **the exact wording the applicant
saw**, alongside `consent_given_at`. Decision 10 requires this so that when the
copy changes, existing applicants keep the statement they actually agreed to —
a later edit cannot retroactively rewrite what someone consented to.

---

## 4. Processor register — DPAs required before real data flows

`CLAUDE.md` A3 requires a data-processing agreement with **every** processor.

| Processor | Purpose | Personal data | DPA |
|---|---|---|---|
| Supabase | database, auth, storage | all of it | ⛔ |
| Vercel | hosting | all in transit | ⛔ |
| Anthropic | request triage; document-check findings | message text; extracted document text | ⛔ **required** — see §6 |
| Google (Gemini) | classifier failover | message text | ⛔ |
| 360dialog | WhatsApp | phone numbers, message content | ⛔ |
| Telegram | optional vendor channel | chat ids, message content | ⛔ (confirm one is even offered) |
| Paystack | collections + transfers | name, email, amount, bank details | ⛔ |
| Flutterwave | FX collections | as above | ⛔ (only if FX is in scope) |
| Resend | email | name, email, message content | ⛔ |
| Africa's Talking | SMS fallback | phone numbers | ⛔ (only if enabled) |
| Upstash | rate limiting | user ids | ⛔ |
| Sentry | error tracking | may incidentally capture user ids | ⛔ |

⛔ **All thirteen are unsigned.** This is the single largest compliance gap and
it is a board/legal action, not a technical one.

---

## 5. Retention

| Data | Rule | Status |
|---|---|---|
| Rejected / withdrawn applications | **90 days**, then PII purged | ✅ **now enforced** — see below |
| Approved applications | tenancy + **6 years** | 📄 `purge_after` is deliberately not set on approval; the 6-year clock runs from tenancy end and **has no job yet** |
| Ledger, payments, remittances | retained — financial record | ✅ soft-delete only |
| Audit trail | retained, append-only | ✅ no UPDATE/DELETE policy exists |
| Work-order media | follows the ticket | 📄 no separate rule |

### ⚠️ The 90-day purge was specified, built, tested — and never ran

Found during this review, and it is the sharpest finding in the pack:

- Decision 3 of the OEA expansion locks the 90-day purge.
- `0082` sets `purge_after = now() + interval '90 days'` on every rejection.
- `0062` wrote `purge_expired_applications()`, which nulls the PII and keeps an
  anonymised stub proving a decision was made.
- `verify-application-review` asserts the date is set correctly.
- **And `vercel.json` carried two cron jobs, neither of them this one.** The
  function was called by nothing.

Every rejected applicant's documents, address, employment details and next of
kin would have been kept indefinitely, by a system whose own consent copy
promises otherwise. **Deletion that is scheduled but never executed is not a
retention policy; it is a record of one.**

**Fixed:** `/api/jobs/purge-applications` now runs daily at 03:00, authenticated
on `CRON_SECRET` like the other jobs, idempotent, and logging how many were due.
Proven end to end: name and email become `[purged]`, phone becomes null, `form`
and `sensitive` become `{}`, `purged_at` is stamped, and the anonymised stub
survives so the decision remains auditable.

⛔ **Still open:** the approved-application 6-year clock has no job. It is years
away for any real record, so it is not a go-live blocker — but it should be
built before the first tenancy ends, not after.

---

## 6. Automated processing (NDPA Art. 37)

The board's position, from decision 10, is implemented rather than promised:

- ✅ **Two-tier human review.** A scoped FM/PM recommends; an admin or finance
  approver decides. Enforced — the same person cannot do both
  (`verify-application-review`).
- ✅ **No automated decision, score, rank or recommendation.** AI performs
  **document verification only** — extraction, format and consistency checks,
  completeness, duplicates.
- ✅ **Findings, never conclusions.** Recorded against the evidence they came
  from (`application_document_findings`), and the reviewer must record their own
  reason.
- ✅ **Off by default.** Per-org B9 feature flag.
- ✅ **Special-category data is never sent to a model** (§2).
- 📄 **Bias audit on the extraction** — the classifier harness exists
  (`measure-classifier-accuracy`); a documented bias audit of document
  extraction specifically is outstanding.

**Why this matters:** the Art. 37 test is whether a decision is *solely*
automated with significant effect. Refusing someone housing is significant, and
a rubber-stamp does not cure it. Hence: findings not conclusions, a human reason
recorded, and the whole thing contestable.

---

## 7. Data-subject rights

| Right | Position |
|---|---|
| **Access** | 📄 Partly self-service — a tenant sees their requests, rent, statements and payment history; an applicant can resume their own application. A full subject-access export is ⛔ not built. |
| **Rectification** | ✅ A person can correct their own name (`update_my_profile`) and contact details (`update_my_notification_prefs`); everything else via their administrator. |
| **Erasure** | 📄 Automatic for rejected applications (§5). Otherwise ⛔ manual — and constrained: ledger and audit rows are retained by design, which is a lawful basis to refuse erasure of financial records but must be **explained**, not silently applied. |
| **Objection / withdrawal of consent** | ⛔ No self-service withdrawal. Manual. |
| **Portability** | ⛔ Not built. |

⛔ **Action:** publish a procedure naming who receives a rights request, the
response deadline, and how it is executed. NDPA expects a response inside 30
days.

---

## 8. Security measures (NDPA s.39)

Evidenced in `DAY12_SECURITY_PASS.md`:

- ✅ Encryption in transit (TLS) and at rest (Supabase-managed).
- ✅ Row-level security on **every** table; an anonymous caller reaches nothing.
- ✅ Role-based access enforced at four layers, verified across all ten roles.
- ✅ Append-only audit trail.
- ✅ Private storage for identity documents and property imagery.
- ✅ Secrets in environment variables; none in the repository.
- ✅ Rate limiting on intake and on remittance.
- ⛔ No external penetration test yet.

---

## 9. Breach procedure (NDPA s.40 — 72 hours)

⛔ **Not written.** Needs, at minimum: who declares a breach, how the audit trail
and `gateway_events` are used to scope it, who notifies the NDPC within 72
hours, when data subjects are told, and where it is recorded. **This should
exist before go-live** — a breach procedure written during a breach is not a
procedure.

---

## 10. Cross-border transfers

Supabase, Vercel, Anthropic, Sentry and Upstash process outside Nigeria. NDPA
restricts transfers to countries without adequate protection.

⛔ **Action:** confirm the hosting region for the production Supabase and Vercel
projects, and record the transfer basis (adequacy, standard contractual clauses,
or explicit consent) for each processor in §4.

---

## 11. Summary of what the board must action

| # | Action | Owner |
|---|---|---|
| 1 | Designate a DPO | Board |
| 2 | Sign 13 processor DPAs | Legal |
| 3 | Write the breach procedure | DPO + legal |
| 4 | Publish the privacy notice | Legal |
| 5 | Confirm cross-border transfer basis and hosting region | DPO |
| 6 | Publish the data-subject-rights procedure | DPO |
| 7 | Decide whether special-category data is necessary at all | Board |
| 8 | Commission an external penetration test | Board |
| 9 | Confirm NDPC registration requirement | Legal |

**Technical items closed during this review:** the 90-day retention purge now
runs. **Technical items still open:** the 6-year approved-application clock, a
subject-access export, and a documented bias audit of document extraction.
