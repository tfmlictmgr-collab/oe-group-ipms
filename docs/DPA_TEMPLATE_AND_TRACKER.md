# Data Processing Agreements — model DPA and processor tracker

**Drafted:** 19 August 2026 · **Status: draft for legal review — nothing here
is executed.** Companion to `docs/NDPA_COMPLIANCE_PACK.md` §4, which lists
all thirteen processors as ⛔ unsigned.

> **What this document is.** A model Data Processing Agreement OE Group can
> offer a processor that has none of its own, plus an NDPA-specific addendum
> to attach on top of a processor's own standard DPA where one exists, plus a
> tracker of where each of the thirteen processors actually stands. **Drafting
> a DPA is not executing one** — every row in §3 still needs a real signature
> from the processor, which is a board/legal action (`GO_LIVE_CHECKLIST.md`),
> not something completed by writing this document.

---

## 1. Which path applies to which processor

Most of the thirteen processors are established SaaS companies that already
publish their own standard Data Processing Addendum — signing theirs (usually
via a dashboard acceptance, a trust-centre request, or a signature on their
paper) is faster and more defensible than asking them to sign OE Group's own
text. Two categories exist:

- **Has its own DPA (most likely):** Supabase, Vercel, Anthropic, Google
  (Gemini), Paystack, Resend, Upstash, Sentry. **Action:** locate and execute
  their standard DPA (§3 has the starting point for each), then attach the
  **NDPA addendum** (§2) as a rider — their DPA is written for GDPR and won't
  mention the Nigeria Data Protection Act or the NDPC on its own.
- **May not offer one (confirm, then use the model DPA if not):** 360dialog,
  Telegram, Flutterwave, Africa's Talking. `NDPA_COMPLIANCE_PACK.md` already
  flags Telegram specifically — Telegram Bot API has no known standard DPA
  process at all. **Action:** confirm with each; where none exists, present
  the **model DPA** (§4) for signature, or accept and document the residual
  risk if a processor cannot be brought to sign anything (a real possibility
  with Telegram, whose bot platform is not built for enterprise contracting).

---

## 2. NDPA addendum — attach to a processor's own GDPR-style DPA

A processor's own DPA is typically written for GDPR and is silent on Nigerian
law. This addendum closes that gap without renegotiating their whole document.

> **Addendum to the Data Processing Agreement between OE Group ("Controller")
> and [Processor] ("Processor")**
>
> 1. **Scope.** This addendum supplements the Processor's standard Data
>    Processing Agreement (the "DPA") wherever the DPA is silent on or
>    inconsistent with the Nigeria Data Protection Act 2023 ("NDPA"). Where
>    the DPA already provides equivalent or stronger protection, the DPA
>    governs.
> 2. **Breach notification.** Processor shall notify Controller of a personal
>    data breach **without undue delay and in any event within 24 hours** of
>    becoming aware of it, sufficient for Controller to meet its own 72-hour
>    notification obligation to the Nigeria Data Protection Commission (NDPC)
>    under NDPA s.40.
> 3. **Cross-border transfer.** Where Processor processes personal data
>    outside Nigeria, Processor confirms the transfer is made under one of:
>    (a) a jurisdiction the NDPC has recognised as adequate, (b) standard
>    contractual clauses materially equivalent to those recognised under
>    NDPA, or (c) another mechanism recognised by the NDPC — specify which,
>    per processor, in §3 below.
> 4. **Sub-processors.** Processor shall maintain and, on request, provide
>    Controller a current list of sub-processors handling Controller's data,
>    and shall flow down data-protection obligations equivalent to this
>    addendum to each.
> 5. **Assistance with data-subject rights.** Processor shall provide
>    reasonable assistance to Controller in responding to a data-subject
>    rights request within Controller's 30-day NDPA response window.
> 6. **Deletion or return on termination.** On termination, Processor shall,
>    at Controller's election, delete or return all personal data, and
>    certify deletion where requested, subject to any retention Processor is
>    independently required by law to keep.
> 7. **Audit.** Processor shall make available information reasonably
>    necessary to demonstrate compliance with this addendum, and permit
>    audits by Controller or an auditor Controller appoints, on reasonable
>    notice.

---

## 3. Processor tracker

| Processor | Personal data involved | Has own DPA? | Where to get it | NDPA addendum needed? | Status |
|---|---|---|---|---|---|
| Supabase | all of it (database, auth, storage) | Yes — published, GDPR-based | Supabase dashboard → Organization → Legal Documents, or supabase.com/legal/dpa | Yes (§2) | ⛔ not started |
| Vercel | all of it, in transit | Yes — published | vercel.com/legal/dpa | Yes (§2) | ⛔ not started |
| Anthropic | request/message text; extracted document text | Yes — available on request for business accounts | via Anthropic account team / trust.anthropic.com | Yes (§2) | ⛔ not started |
| Google (Gemini) | message text (classifier failover only) | Yes — Google Cloud DPA | cloud.google.com/terms/data-processing-addendum | Yes (§2) | ⛔ not started |
| 360dialog | phone numbers, message content | **Confirm** — likely yes as a Meta BSP, but direct-client tier (not Partner) may differ; check | 360dialog account/legal contact | Yes (§2) once confirmed | ⛔ not started, confirm first |
| Telegram | chat IDs, message content | **Unlikely** — Bot API has no known standard enterprise DPA process | Confirm via @BotSupport or Telegram's own privacy/legal contact; if none, use model DPA (§4) | Model DPA if no standard one exists | ⛔ not started, confirm first |
| Paystack | name, email, amount, bank details | Yes — Nigerian entity, DPA available on request | Paystack business/legal contact | Yes (§2), lighter weight since Paystack is itself NDPA-governed | ⛔ verification in progress (business KYC), DPA not yet requested |
| Flutterwave | as above, FX collections | Yes — likely, Nigerian entity | Flutterwave business/legal contact | Yes (§2) | ⛔ verification in progress (business KYC), DPA not yet requested; also gated on the in/out-of-scope decision in `GO_LIVE_CHECKLIST.md` |
| Resend | name, email, message content | Yes — published | resend.com/legal/dpa | Yes (§2) | ⛔ not started |
| Africa's Talking | phone numbers (SMS fallback) | Likely — Kenyan entity, confirm | Africa's Talking account/legal contact | Yes (§2) | ⛔ not started; only needed if SMS fallback is in scope for go-live |
| Upstash | user IDs (rate limiting) | Yes — published | upstash.com/trust | Yes (§2) | ⛔ not started |
| Sentry | may incidentally capture user IDs in error reports | Yes — published, GDPR-based | sentry.io/legal/dpa | Yes (§2) | ⛔ not started |

**All thirteen remain unsigned as of this draft.** This tracker turns
"⛔ unsigned" (the compliance pack's single line) into thirteen concrete next
actions, each with a named starting point — it does not itself close any of
them.

---

## 4. Model DPA — for a processor with no standard DPA of its own

Use only where §1/§3 confirms no standard DPA is offered. This is a starting
draft for legal counsel to finalise, not a document to send as-is.

> **DATA PROCESSING AGREEMENT**
>
> Between **OE Group** ("Controller") and **[Processor name]** ("Processor").
>
> **1. Subject matter and duration.** This Agreement governs Processor's
> processing of personal data on behalf of Controller in connection with
> **[service description]**, for the duration of the underlying service
> agreement between the parties.
>
> **2. Nature and purpose of processing.** [Describe: e.g. "receiving and
> relaying messages between Controller's platform and individuals who
> initiate contact via Processor's messaging service."]
>
> **3. Categories of data subjects.** Tenants, applicants, vendors,
> landlords, and staff of Controller and its client organisations.
>
> **4. Categories of personal data.** [Specify per processor — typically
> contact identifiers and message content; never special-category data per
> `NDPA_COMPLIANCE_PACK.md` §2, which is walled off from every third party.]
>
> **5. Processor's obligations.** Processor shall: (a) process personal data
> only on Controller's documented instructions; (b) ensure persons authorised
> to process the data are bound by confidentiality; (c) implement appropriate
> technical and organisational security measures; (d) engage sub-processors
> only with Controller's consent and under equivalent obligations; (e) assist
> Controller with data-subject rights requests and NDPA compliance; (f)
> notify Controller of a personal data breach within 24 hours of becoming
> aware of it; (g) delete or return all personal data on termination,
> certifying deletion on request; (h) make available information necessary
> to demonstrate compliance and permit reasonable audits.
>
> **6. Cross-border transfer.** [Specify the transfer basis — adequacy
> decision, standard contractual clauses, or explicit consent — per
> `NDPA_COMPLIANCE_PACK.md` §10.]
>
> **7. Liability.** [Standard mutual indemnity / liability cap clause — for
> legal counsel to draft.]
>
> **8. Governing law.** The laws of the Federal Republic of Nigeria.
>
> Signed for and on behalf of Controller: _______________ Date: _______
> Signed for and on behalf of Processor: _______________ Date: _______

---

## 5. What's still needed before any of this is real

1. Legal review of both the addendum (§2) and the model DPA (§4) — this
   document is a starting draft, not counsel-approved text.
2. Confirmation of 360dialog's and Africa's Talking's DPA availability (§3).
3. A decision on Telegram: pursue a signed agreement, or formally accept and
   document the residual risk if none can be obtained — silence is not a
   decision `NDPA_COMPLIANCE_PACK.md` §4 accepts.
4. Someone with signing authority to actually execute each — drafting closes
   none of the thirteen ⛔ rows on its own.
