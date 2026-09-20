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
| **Data Protection Officer** | ✅ **Designated: Ebube Ikechwu** (2026-08-19, board). NDPC registration of the DPO and publication of contact details are still open — see §11. |
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
| Vendor due diligence | `vendor-documents` bucket (private) — CAC certificates, tax clearance, insurance | vendors, and the named directors in them |
| Invoices & completion evidence | `invoice-attachments` bucket (private) | vendors, tenants incidentally |
| Proof of payment | `payment-proofs` bucket (private) — teller slips and transfer receipts | tenants, and whoever's name is on the slip |
| Proof of bank details & payout | `payout-evidence` bucket (private) — a payee's own bank letter or statement | vendors, landlords, ops staff |
| Brand marks | `org-logos` bucket — **public by design**, painted on the sign-in page before anyone authenticates | no personal data |
| Financial | `payments`, `rent_charges`, `service_charges`, `ledger_*`, `payout_recipients` (bank details) | tenants, vendors, landlords |
| Behavioural | `tickets`, `ticket_messages`, `audit_log`, `user_notifications` | everyone |

⚠️ **This inventory listed two buckets until 20 Sept 2026.** Four holding
personal data — vendor KYC, invoices, payment proof and bank evidence — were
built after it was written (`0140`, `0164`, `0281`, `0289`) and never added. All
seven, with their `public` flag, size limit and MIME allowlist read out of their
creating migration, are tabulated in `GO_LIVE_CHECKLIST.md` §1.

⚠️ **The full bank account number is never stored** (decision 17, `0289`). A
payee uploads a document showing it, the payment officer reads it off that
document to make the transfer, and the system retains only the bank, the account
name and the last four digits. The document itself lives in `payout-evidence`
and is therefore subject to the same retention clock as every other record here.

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
| Approved applications | tenancy + **6 years** | ✅ **now enforced** — `0299`, 20 Sept 2026. See below |
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

### ✅ The approved-application 6-year clock, and the renewal trap in it

**Closed 20 Sept 2026 (`0299`).** This row read "has no job yet" since the Day
12 review. It was the last open row in the table above.

**It is closed by stamping a date, not by adding a second deletion path.**
`purge_expired_applications()` fires on `purge_after < now()` and nothing else.
The 90-day rule has always worked because `0082` sets that date on rejection;
the 6-year rule never worked because nothing set it on approval. So the missing
piece was never the deletion — it was the date. `0299` computes and sets it,
and the one proven deletion path does the rest.

**The clock cannot start at approval**, which is why this is a nightly
reconciliation rather than something the approval writes. It runs from the end
of the **tenancy**, which is unknown at approval and changes every time the
lease is renewed. The job therefore re-derives the answer for every approved
application on every run, and **withdraws** a stamp if a renewal has reopened
the tenancy since. A stamp that is wrong has six years in which to be
corrected; a purge that is wrong has none.

⚠️ **The trap, stated because it is the whole difficulty.** A renewal does not
carry `application_id` forward. So the obvious query — "the end date of the
lease this application produced" — returns the end of the **first** lease, and
would set a purge clock on a tenant who is still living there under their
fourth renewal. The applicant whose data this rule protects would be purged
while still a tenant. `0299` therefore walks `renewed_from_lease_id` forward
recursively and treats the tenancy as ended only when no lease anywhere in that
chain is still `draft` or `active`. This is the same mistake `0181` found in
the admin fee, where it had money attached rather than personal data.

**Approved applications that produced no lease** — an offer never accepted, or
a lease recorded on paper — have no tenancy and so no clock. They are counted
and reported on every run rather than left behind, because an approved
application quietly holding PII with no retention date is the same shape of gap
as the one this whole section exists to record.

Proven against PostgreSQL 16 before shipping, across eight cases: no lease, a
live tenancy, a single ended tenancy, the renewal trap, a fully-ended chain
(stamped from the **last** end, not the first), withdrawal after a late
renewal, soft-deleted leases in both directions, and a rejected application's
own 90-day clock left untouched. Held by `verify-retention-clock`.

⚠️ **What is still true:** for any real record this fires years from now. The
value of building it today is that the renewal rule is understood today. It
should be re-read — not merely assumed — the first time a real tenancy ends.

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
- ✅ Rate limiting on intake and on remittance — and **fail-closed on the money
  path**: if the limiter was meant to be running and is not, the payment webhook
  answers 503 and every remittance route refuses rather than proceeding
  unlimited. General intake stays fail-open deliberately, because a tenant who
  cannot raise a ticket during a Redis outage is an inconvenience where an
  unlimited remittance endpoint is an incident.
- ✅ **Backup and recoverability** — Supabase Pro **daily backups**, 7-day
  retention, **stated RPO ~24 hours**, plus `npm run backup` for a verified
  copy taken at a moment of the operator's choosing. Point-in-Time Recovery was
  **considered and declined** on a recorded basis: a day of ledger entries is
  reconstructible from gateway records and the bank statement, and PITR covers
  Postgres only — it would protect no identity document or payment proof. Full
  reasoning, the restore procedure and the quarterly drill:
  `BACKUP_AND_RESTORE.md`. ⚠️ The stated RPO is only honest while a day's
  transactions remain re-keyable by one person; that is written down as a
  review trigger, not an assumption.
- ⛔ No external penetration test yet.
- ⛔ **Storage backup is unconfirmed.** Every line above about backups concerns
  **Postgres**. Whether Supabase's daily backup includes Storage objects — the
  identity documents, work-order photographs, vendor KYC, payment proofs and
  payout evidence — is **not documented and has not been confirmed**. It must be
  answered with Supabase before cutover. If the answer is no, the most sensitive
  material this system holds has no backup, which is a larger gap than the one
  PITR would have closed. Raised 20 Sept 2026.

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

✅ **Answered 2026-09-20 — see `CROSS_BORDER_TRANSFER_BASIS.md`.** Production
Supabase is `eu-west-1` and Vercel is `dub1`, both Ireland. The basis for every
row in §4 is **contractual clauses under s.41**, because GAID 2025 repealed the
NDPR whitelist and the NDPC has issued no adequacy decision for any country —
so hosting in the EU supplies no basis on its own.

⚠️ The sentence above this one says five processors work outside Nigeria. That
count is wrong; it is closer to eleven. Paystack and Flutterwave are the only
plausible exceptions and only if their hosting is Nigerian, which is one of the
open questions in that document.

📌 It also means the transfer basis and the thirteen unsigned DPAs (§11 row 2)
are **one piece of work**: a DPA without transfer clauses does not discharge
s.41. Still a working document pending DPO and Legal review.

---

## 11. Summary of what the board must action

| # | Action | Owner |
|---|---|---|
| 1 | ~~Designate a DPO~~ — **Ebube Ikechwu**, 2026-08-19 | Board ✅ |
| 2 | Sign 13 processor DPAs — drafts prepared, see `DPA_TEMPLATE_AND_TRACKER.md` | Legal |
| 3 | ~~Write the breach procedure~~ — drafted 2026-09-20, `BREACH_PROCEDURE.md`; **needs contacts + review** | DPO + legal 🔄 |
| 4 | Publish the privacy notice | Legal |
| 5 | ~~Confirm cross-border transfer basis and hosting region~~ — drafted 2026-09-20, `CROSS_BORDER_TRANSFER_BASIS.md`; **awaiting DPO review** | DPO 🔄 |
| 6 | ~~Write the data-subject-rights procedure~~ — drafted 2026-09-20, `DATA_SUBJECT_RIGHTS_PROCEDURE.md`; **publishing still owed** | DPO 🔄 |
| 7 | Decide whether special-category data is necessary at all | Board |
| 8 | Commission an external penetration test | Board |
| 9 | Confirm NDPC registration requirement | Legal |

**Technical items closed during this review:** the 90-day retention purge now
runs. **Technical items still open:** the 6-year approved-application clock, a
subject-access export, and a documented bias audit of document extraction.
