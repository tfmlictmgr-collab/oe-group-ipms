# Data-subject rights procedure — OE Group IPMS

**Status:** working document, drafted 2026-09-20. Approved by Joseph Emmanuel
(ICT) as the working procedure pending DPO and Legal review.
**Owner:** DPO — **Ebube Ikechwu**. **Closes:** `GO_LIVE_BUILD_PLAN.md` 1.4.

This operationalises the promises already made publicly in
`PRIVACY_NOTICE.md` §6. **Where the two disagree, the notice wins and this
document is wrong** — a published promise cannot be narrowed by an internal
procedure.

---

## 1. The clock

**30 days** from receipt, for every request. That is what the notice tells
people and what the Act requires.

- Acknowledge **within 3 working days**. A person who hears nothing assumes
  they are being ignored, and that is how a request becomes a complaint.
- If a request is genuinely complex, tell them **before day 30**, say why, and
  give a date. Silence past day 30 is the failure, not the extra time.

---

## 2. How a request arrives

Any route counts — email to the DPO, a message to support, WhatsApp, a letter,
or a tenant telling an FM in person. **A request does not have to say "data
subject access request" or cite the Act.** "Can you send me everything you hold
about me" is a valid access request and the clock has started.

Whoever receives it: forward to the DPO **the same day** and tell the person
you have done so.

---

## 3. Verify who you are talking to

Before releasing anything, confirm the requester is who they claim.

- **Signed-in account holder** — the account itself is the verification, if the
  request comes from the address on the account.
- **Anyone else, or a different address** — ask for one piece of information
  only they would hold (a tenancy reference, a recent payment amount).

⚠️ **Do not over-verify.** Demanding ID for a routine access request is itself
a recognised obstruction tactic. And ❌ **never create an account for someone
in order to verify them** — that manufactures the record you were asked about.

---

## 4. The rights, and how each is actually done

### 4.1 Access — "what do you hold about me?"

Most of it they can already see, and pointing them there is a complete answer
for those parts:

| They ask about | Where it already is |
|---|---|
| Their requests and messages | My Requests |
| Rent, charges, payment history | My Rent |
| Their tenancy, statements | Tenancy statement |
| Their profile | Settings → Profile |
| A vendor's own company, jobs, invoices | My Company / My Work |

For anything beyond that, the DPO assembles it. ⚠️ **`records.export` is
deliberately off for every role in every organisation** (`0223`, `0239`) and is
operator-gated — that is an internal bulk-export control and **not** the route
for a personal request. Assemble the individual's own data; do not switch a
bulk capability on to answer one person.

Provide it in a commonly-used, readable form. A PDF or spreadsheet is fine.

### 4.2 Correction

Most is self-service in Settings → Profile. For the rest — a name on a tenancy,
a corrected phone number — an administrator makes the change.

📌 The correction is recorded in `audit_log` automatically, with who made it.
That is the proof the request was honoured, and it is why corrections are never
made directly in the database.

### 4.3 Erasure — **and its limits, stated honestly**

Some data **will not** be deleted, and the notice already says so. Repeat the
reason rather than hiding behind "we are unable to":

| Data | What happens | Why |
|---|---|---|
| Rejected/withdrawn tenancy application | **Auto-purged after 90 days** (`0082`, `purge-applications`). A decision record is kept without personal details. | The process stays auditable without keeping the person |
| Financial records — payments, rent, remittances | **Retained permanently** | A settled payment cannot be un-made, for the same reason a bank statement cannot be un-issued |
| `audit_log` | **Cannot be deleted** — append-only by trigger | It is the record of who did what. A trail that can be erased on request is not a trail |
| A user account | **Deactivated, not deleted** | `audit_log_actor_id_fkey` holds the account the trail names. Deactivation removes all access — see `verify-deactivation` |
| Everything else | Deleted | |

When refusing in part, always say: **what is being kept, why, for how long, and
that they may still ask what is held.**

### 4.4 Portability

Their own data, in a machine-readable form, where processing rests on consent
or a contract. In practice: the same assembly as §4.1, delivered as CSV or JSON.

### 4.5 Objection, and withdrawing consent

- **Marketing or optional channels** (WhatsApp, Telegram, SMS) — stop, and turn
  the consent record off. `consent` is a record, not a checkbox (`0148`), so
  this is a real state change and is auditable.
- **Processing necessary to the tenancy** — cannot simply be stopped. Explain
  that the tenancy itself is the basis, and what ending it would mean.

⚠️ **Consent is not the basis for the core system**, and should never be
described to a tenant as though it were. See `CROSS_BORDER_TRANSFER_BASIS.md`
§5 for why.

---

## 5. Refusing, properly

You may refuse a request that is manifestly unfounded or excessive, or where an
exemption applies. If you do, say **within 30 days**:

1. That you are refusing, and which part.
2. The specific reason.
3. That they may complain to the **NDPC**, and how.

A refusal without a route to challenge it is what turns a disagreement into a
regulatory complaint.

---

## 6. The register

Kept by the DPO. One row per request, never deleted — this is the evidence that
the 30-day promise is met in practice.

| # | Received | Who (ref, not name) | Right | Verified | Acknowledged | Fulfilled | Partial refusal + reason | Days |
|---|---|---|---|---|---|---|---|---|
| | | | | | | | | |

📌 Review quarterly. If a right is never exercised, check whether the notice is
actually reachable — an unused rights process usually means an unfindable one,
not a satisfied user base.

---

## 7. Templates

**Acknowledgement (within 3 working days)**

> Dear [name], we received your request on [date] and are handling it. We will
> respond by **[date + 30 days]**. If we need anything further to confirm your
> identity we will contact you. — [DPO], Data Protection Officer

**Fulfilment**

> Dear [name], attached is the personal data we hold about you as of [date].
> [Where relevant: some records are retained and cannot be deleted — see below,
> with the reason and the period.] If anything is inaccurate, tell us and we
> will correct it. — [DPO]

**Partial refusal**

> Dear [name], we have [done X]. We are not able to [Y], because [specific
> reason — e.g. payment records form a permanent financial record]. We will
> keep that data for [period]. You may ask at any time what we hold. If you are
> unhappy with this decision you may complain to the Nigeria Data Protection
> Commission at [contact]. — [DPO]

---

## 8. Contacts

| Role | Name | Contact |
|---|---|---|
| DPO | Ebube Ikechwu | **[to be completed before publishing]** |
| NDPC complaints | | **[to be confirmed by Legal]** |

⚠️ These must be filled in **and match `PRIVACY_NOTICE.md` §6 exactly** before
either document is published. A notice that points at a contact this procedure
does not use is how a request gets lost between two inboxes.
