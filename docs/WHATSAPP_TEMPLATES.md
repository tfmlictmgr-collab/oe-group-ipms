# WhatsApp message templates — copy for 360dialog submission

**Date:** 2026-08-10 · **By:** PC2 · **Status:** drafted, **not yet submitted**.

These are the templates that must exist in the 360dialog Hub before any
business-initiated WhatsApp message can be sent at all. Background and the
finding that prompted them: `CHAT_DEEP_LINKS.md` §4.

> **Submit each one twice.** TFML and OEA are separate 360dialog businesses with
> separate API keys (`WHATSAPP_360DIALOG_MIGRATION.md`), so approval for one
> grants nothing to the other. The copy below is brand-neutral precisely so the
> same text can go in twice without editing — the brand identity is already
> carried by the sending number's verified business name, which is what WhatsApp
> shows at the top of the chat.

---

## 0. Rules the copy below is already written to satisfy

Getting these wrong means rejection, and a rejected template is a day lost.

- **Category: `UTILITY`** for every template here. They are all triggered by
  something the recipient did or is party to. Do not submit any of them as
  `MARKETING` — that category carries different consent rules and is refusable
  by the user in a way that would silently drop transactional notices.
- **Name:** lowercase letters, digits and underscores only.
- **Variables** are positional — `{{1}}`, `{{2}}` — and fill in order.
- **A body may not begin or end with a variable**, and two variables may not sit
  adjacent. Every template below starts and ends with fixed text.
- **Variable VALUES may not contain newlines, tabs, or runs of 5+ spaces.** A
  single offending value fails the whole send. Property names and vendor names
  come from user-entered data, so `sendWhatsAppTemplate` callers should flatten
  whitespace before passing them.
- **Keep values short.** A variable carrying a 200-character property
  description makes an unreadable message and risks truncation.

### ⚠️ Opt-in is a prerequisite, not a formality

WhatsApp requires the business to hold opt-in before sending a template, and
NDPA requires a lawful basis for the processing regardless
(`NDPA_COMPLIANCE_PACK.md` §3). For tenants and vendors the basis is contract —
these are notices about their own tenancy or their own invoice, not marketing —
but **the opt-in itself still has to be captured and recorded**, and it is not
today. That is a gap to close alongside submission, not after: onboarding needs
to state that WhatsApp will be used for service notices and record that the
person agreed, the same way `tenant_applications.consent_statement` records
consent verbatim.

---

## 1. `job_assigned` — a vendor or ops person has been dispatched

Replaces the free-text send at `app/dashboard/tickets/[id]/actions.ts`
(`cascadeToUserIds`, "A job has been assigned to you…").

- **Name:** `job_assigned`
- **Category:** UTILITY · **Language:** `en`

**Body**
```
Hello {{1}}, a new job has been assigned to you: {{2}}, reference {{3}}. Please open the portal to acknowledge it and get started.
```

| Var | Value | Source |
|---|---|---|
| `{{1}}` | recipient's first name | `users.full_name`, first word |
| `{{2}}` | short job summary | `tickets.summary`, whitespace-flattened, truncate ~60 chars |
| `{{3}}` | job reference | `shortRef(ticket.id)` |

**Note:** the acknowledgement deadline is deliberately not in the copy. It
varies by SLA and urgency, and a template cannot carry conditional text — a
wrong deadline in a message a vendor is measured against is worse than none.

---

## 2. `payment_approved` — a vendor's payment cleared approval

Replaces the free-text send at `app/dashboard/payments/[id]/actions.ts`.

- **Name:** `payment_approved`
- **Category:** UTILITY · **Language:** `en`

**Body**
```
Hello {{1}}, your payment of {{2}} has been approved and is queued for remittance. You will receive confirmation once it has been sent.
```

| Var | Value | Source |
|---|---|---|
| `{{1}}` | vendor contact name | `vendors.name` |
| `{{2}}` | amount | `formatNaira(payment.amount)` |

**⚠️ Say "approved and queued", never "paid".** Approval and remittance are
separate steps with separate authorisers by design — finance disburses, the
approver does not (`verify-oversight-roles`). A vendor told "paid" at approval
time will chase a payment that has not left yet, and the audit trail will
disagree with the message they were sent.

---

## 3. `service_charge_ready` — a statement is available

Replaces the free-text send at `app/dashboard/sc/[id]/actions.ts`.

- **Name:** `service_charge_ready`
- **Category:** UTILITY · **Language:** `en`

**Body**
```
Hello {{1}}, your {{2}} service charge statement for {{3}} is ready. The amount due is {{4}}. You can view the full breakdown in the portal.
```

| Var | Value | Source |
|---|---|---|
| `{{1}}` | occupant's first name | `users.full_name`, first word |
| `{{2}}` | period | `budget.period` |
| `{{3}}` | property name | `property.name`, whitespace-flattened |
| `{{4}}` | amount | `formatNaira(share.amount)` |

**Note:** `{{3}}` currently falls back to the string `"your property"` when the
property row is missing. That reads correctly in the existing free-text
sentence, and still reads correctly here — keep the fallback when porting.

---

## 4. `application_decision` — an applicant has an outcome

Not currently a cascade call site; drafted because it is the notice most likely
to be added next and the one with the sharpest consequences.

- **Name:** `application_decision`
- **Category:** UTILITY · **Language:** `en`

**Body**
```
Hello {{1}}, a decision has been made on your application, reference {{2}}. Please sign in to the portal to see the outcome and any next steps.
```

| Var | Value | Source |
|---|---|---|
| `{{1}}` | applicant's first name | `tenant_applications.form`, first name |
| `{{2}}` | application reference | short reference |

**⚠️ The outcome itself is deliberately not in the message.** Three reasons, and
all three matter:

1. **A rejection should not arrive on a lock screen**, read by whoever is
   holding the phone.
2. **A template variable cannot carry the reason**, and NDPA Art. 37 requires
   the decision be contestable with a recorded human reason
   (`NDPA_COMPLIANCE_PACK.md` §6) — a bare "unsuccessful" over WhatsApp is the
   rubber-stamp shape that provision exists to prevent.
3. **A rejected application is purged after 90 days**; the portal shows the
   anonymised state correctly, a WhatsApp message sitting in someone's history
   forever does not.

---

## 5. `payment_request` — a payment has been requested

Sent by `lib/payment-request-notice.ts`, from
`app/dashboard/ledger/collections/actions.ts`.

- **Name:** `payment_request`
- **Category:** UTILITY · **Language:** `en`

**Body**
```
Hello {{1}}, a {{2}} payment for {{3}} is now due. The amount is {{4}} and the payment reference is {{5}}. We have emailed you a secure link to pay. Please do not share it with anyone.
```

| Var | Value | Source |
|---|---|---|
| `{{1}}` | payer's first name | `users.full_name`, first word |
| `{{2}}` | what it is for | "service charge", "rent", "deposit", "payment" |
| `{{3}}` | property / unit | `service_charges.property_or_unit`, flattened |
| `{{4}}` | amount | `formatMoney(amount, currency)` |
| `{{5}}` | reference | `payment_intents.gateway_reference` |

**⚠️ The link is deliberately NOT in the body.** Two reasons, and the second
is the one that matters:

1. Meta prefers a dynamic **URL button** to a raw link in body text, and a
   template carrying an unexpected URL is a common rejection.
2. A WhatsApp message containing a payment link is the exact shape of the
   scam Nigerian tenants are most often targeted with. Telling them the link is
   in their **email** — a channel they already associate with us, and which this
   code sends first and always — makes the WhatsApp message a nudge that cannot
   itself be spoofed into a payment page. "Please do not share it" is in the
   body for the same reason.

**When submitting:** add a URL button (`Pay now`, dynamic suffix) if the
organisation would rather the link be tappable. `sendWhatsAppTemplate` does not
pass button parameters today, so that is a code change as well as a submission
change — not a copy tweak.

**Until it is approved:** the cascade attempts WhatsApp, fails, and falls
through to SMS, which carries the link as plain text. Email is sent regardless
and independently. So the payer is reached either way; approval only upgrades
which channel gets there first.

---

## 6. What stays free text, and why

Do **not** convert these. `sendWhatsApp` / `sendReply` remain correct for them:

- **Every reply inside a conversation** — the webhook handlers at
  `app/api/webhooks/{whatsapp,telegram}/route.ts`. The person just messaged in,
  so the 24-hour window is open by definition, and a template here would make a
  natural conversation robotic.
- **Acknowledgement replies** (`buildAcknowledgement`) — same reason: they are
  the immediate answer to an inbound message.

The rule to hold onto: **template when we speak first, text when we answer.**

---

## 7. Submission checklist

- [ ] Submit all four to **TFML**'s 360dialog Hub · category UTILITY, language `en`
- [ ] Submit all four to **OEA**'s 360dialog Hub · same
- [ ] Record the approved template names — they must match
      `sendWhatsAppTemplate`'s `name` argument exactly; a typo fails identically
      to a missing template
- [ ] Capture and record WhatsApp opt-in at onboarding (§0) before the first
      template send
- [ ] Port the four call sites from `sendReply` to `sendWhatsAppTemplate`
- [ ] Flatten whitespace on every user-derived variable at the call site
- [ ] Verify one send per brand against a real handset before relying on it

Approval typically lands within minutes to a day. A rejection usually names the
rule broken; §0 covers the ones that catch people out.
