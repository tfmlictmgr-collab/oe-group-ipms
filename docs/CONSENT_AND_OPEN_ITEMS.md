# Consent, and a conclusive pass over the open security items

**Date:** 2026-08-10 · **By:** PC2 · **Branch:** `phase-1`
**Migrations 0146–0148 are written and NOT applied.** `tsc --noEmit` and
`next lint` clean.

This closes the consent gap flagged in `WHATSAPP_TEMPLATES.md` §0, and then
goes through every remaining flagged item and states its actual status —
measured where measurable, rather than inferred.

---

## 1. Consent — built, not documented-as-intended

### The gap

`users.notify_whatsapp` is a **routing preference**: a boolean saying "send here
if you have something." Two separate obligations need something stronger:

- **WhatsApp's platform rules** require opt-in before a business-initiated
  template. Sending without it risks the WABA — both brands' inbound channel.
- **NDPA s.25** requires a demonstrable lawful basis. A boolean demonstrates
  nothing: no date, no wording, no history. It cannot distinguish consent from a
  default, and it cannot show what was permitted on the day something was sent.

This is the same thing 0062 already refused for tenancy applications: *"Recorded
as WHEN and TO WHAT, not a boolean — 'they ticked a box' is not a record of what
they agreed to."*

### What was built — `0148`

`channel_consents`, **append-only**. A withdrawal is a NEW ROW, never an edit or
a delete of the grant, for the same reason `audit_log` has no UPDATE or DELETE
policy: the question a regulator asks is not *"do they consent now"* but *"what
were you entitled to send on the day you sent it."* An update-in-place design
answers the first and destroys the evidence for the second.

Each row carries the **verbatim wording the person saw**, copied rather than
referenced — so a later edit to the copy cannot rewrite what someone agreed to.

| Piece | Where |
|---|---|
| Table + RLS + audit trigger | `0148` |
| `record_my_channel_consent` / `withdraw_my_channel_consent` | `0148`, definer, self only |
| `has_channel_consent` | `0148` — **not granted to `authenticated`** |
| The send gate | `lib/channel-consent.ts` → `lib/cascade.ts` |
| The wording | `lib/consent-statements.ts` |
| Capture + withdrawal UI | Settings → Profile → *How we reach you* |
| Proof | `scripts/verify-channel-consent.mjs` |

### Five decisions worth defending

**Writes go through definer functions, not an INSERT policy.** The functions
stamp `org_id`, `recorded_by` and `recorded_via` from the **session**. An INSERT
policy would let a caller assert all three — including writing a
`self_service` grant on someone else's behalf. That is precisely the forgery
this record exists to make impossible.

**`has_channel_consent` is not callable by a signed-in user.** It answers a
question about an arbitrary `user_id`. Granting it to `authenticated` would let
anyone probe whether anyone else is contactable on WhatsApp. The send path runs
as the service role and needs no such grant. (0114 exists because this class of
thing was once assumed rather than enforced.)

**The gate fails CLOSED — unlike the rest of the notification path.**
`lib/rate-limit.ts` fails open on purpose ("a limiter outage must not take
intake down"). This does the opposite. A limiter failing open risks load; a
consent check failing open is an unlawful disclosure and a policy breach against
the number both brands depend on. **The cascade falls through to SMS then email,
so failing closed costs the CHANNEL, never the NOTICE.**

**Consent is identifier-bound.** Consent recorded against one number does not
carry to another. Numbers get recycled; a template to a reassigned number
discloses the previous holder's business to a stranger.

**Withdrawing does not disable email.** Email is the B8 cascade's last resort
and the only channel guaranteed to carry what someone is contractually owed — a
statement, an invoice, a decision. Withdrawal is recorded and stops the channel;
it cannot leave a person unable to receive what their tenancy entitles them to.
The lawful basis for those notices is **contract**, not consent, and that basis
does not evaporate when a channel preference is withdrawn.

**This also closes NDPA_COMPLIANCE_PACK.md §7's "⛔ No self-service
withdrawal. Manual."** Withdrawal is now one click, in the same place as
granting — a consent that is hard to retract is not freely given.

### Where the gate applies, and where it must not

The discriminator is `CascadeTarget.whatsappSender`, which the type already
documents as *"supplied when replying to an inbound message… omitted for
proactive sends."* That makes it the honest signal for "did they speak first,"
rather than a second flag that could disagree with it.

- **Reply** (`whatsappSender` set) → **no gate.** They messaged us, on the
  number they chose, about something they raised. Requiring recorded consent to
  answer someone's own question would be absurd and worse for them: silence
  instead of a reply.
- **Business-initiated** → **gated**, and needs `recipientUserId`.

A recipient with no portal account — a vendor reached only through
`vendors.contact_phone` — has no consent on file and no way to give it, so
WhatsApp is **skipped** and the cascade falls through to email. That is the
correct outcome, not a bug.

### ⚠️ One bug caught during the build, recorded because it was mine

`lib/channel-consent.ts` imports `supabaseAdmin`, and the settings screen is a
**client component**. Importing the wording from that module pulled a
service-role module toward the browser bundle — violating the explicit rule in
`lib/supabase/admin.ts`: *"never import this into client components."*

No key would have leaked (Next strips non-`NEXT_PUBLIC_` env vars from client
bundles). Fixed properly anyway by splitting the strings into
`lib/consent-statements.ts`, which imports nothing server-side. The rule is not
"avoid leaks you can prove"; a service-role module has no business in code
shipped to a browser.

---

## 2. Open items — mostly superseded by PC1, and that is recorded honestly

> ⚠️ **Read this before the subsections.** This section was written against a
> local `phase-1` that was **two commits behind** `origin/phase-1`. PC1 had
> already pushed `753f50d` ("Close all six Day 12 follow-ups") and `0f4de32`.
> Most of what follows was therefore work done twice, and two of my edits —
> `scripts/verify-cross-org-dispatch.mjs` and `security/README.md` — were
> **reverted in favour of PC1's**, which are better informed. The subsections
> below are kept, corrected in place, because the *convergences* are worth
> something and the *corrections* are worth more than quietly deleting them.
>
> **The process lesson, since it cost real work:** `git fetch` at the START of a
> session, not before the push. The two-machine note in the project memory says
> exactly this, and I ran it last.

### ⚠️ Corrections to what this document originally claimed

| I wrote | Actually |
|---|---|
| "The CSP is **not set anywhere in this repo** … configured at the Vercel project level" | **Wrong.** PC1 set it in `next.config.mjs` (`753f50d`). It looked absent only because my checkout predated their commit. |
| The Paystack-isn't-a-script finding, presented as new | **Independently reached by PC1 first**, and documented more precisely in their `next.config.mjs` header: CSP "governs subresources, frames and form posts; it does not restrict navigating away." |
| My `verify-cross-org-dispatch` fix (unassign + `status: "open"`) | **Superseded.** PC1 checked the application layer and found there is *no bare-unassign path in the product at all* — so my version tested a transition the product never performs. Theirs asserts **re-dispatch to a different assignee**, which is what the app actually does. |
| My `security/README.md` status rewrite | **Superseded** by PC1's, which also records that only PC2 has Docker and so only PC2 can run ZAP. |
| HSTS `preload` "recorded but missing" | PC1 reached the same place and made it a **deliberate** omission with a reason (preload is hard to reverse; submit only if OE Group chooses to). |

### 2. Open items — measured, not assumed

### ✅ HSTS on the real domains — CLOSED (`DAY12_FOLLOWUPS` §4)

Measured just now:

```
tfmlportal.com/reset-password  →  Strict-Transport-Security: max-age=63072000; includeSubDomains
oeaportal.com/reset-password   →  Strict-Transport-Security: max-age=63072000; includeSubDomains
```

Present, consistent, two years, subdomains included, on both aliases. The
inconsistency ZAP reported was a `.vercel.app` cache artefact, as suspected.

**One discrepancy worth recording:** `DAY12_FOLLOWUPS` §4 recorded the header as
including `preload`. The real domains do **not** send it. That is not a
vulnerability — `preload` only matters if the domain is submitted to
hstspreload.org, which is a deliberate and hard-to-reverse step — but the
follow-up doc and reality disagreed, and now they don't.

### ✅ CSP — PC1 shipped it; my analysis independently agreed

PC1 set `Content-Security-Policy-Report-Only` in `next.config.mjs` (`753f50d`),
and reached the Paystack conclusion first and more precisely: CSP *"governs
subresources, frames and form posts; it does not restrict navigating away."*
Checkout is `window.location.href = checkoutUrl` to Paystack's hosted page, so
nothing Paystack serves is ever loaded into this origin and **no `script-src`
entry is needed** — correcting the assumption recorded when the CSP was first
deferred.

I reached the same finding independently from the deployed headers and the
source. Recorded only because two people converging on it from different
directions is worth more than either alone: **the premise for deferring the CSP
was wrong, and both of us verified it against the actual code.**

Remaining before promoting to enforcing is unchanged and is PC1's stated plan:
UAT against it with a clean console, then flip.

### 🟡 CORS wildcard — half-measured (`DAY12_FOLLOWUPS` §3)

`Access-Control-Allow-Origin: *` **confirmed present** on the public
`/reset-password` on both real domains. The open question — whether it reaches
**authenticated** routes — still needs a session cookie, so it is not closeable
from here. It needs someone signed in to check `/dashboard` and
`/dashboard/payments`. Architecturally it should not (Vercel applies it to
static responses only), but that remains inference.

### ✅ `verify-cross-org-dispatch` — closed by PC1, my version dropped

See the corrections table. **One thing from my version PC1 may want to take:**
the converse assertion — that clearing the assignee *without* standing the
status down is still refused. Nothing currently asserts 0117's guard directly,
so if it were ever dropped the suite would stay green on the hole it closed.
Offered as a suggestion, not re-applied over their work.

### ✅ `security/README.md`, k6 rate-limit, Preview rate limiting — closed by PC1

All three are in `753f50d`. I had left the k6 script alone deliberately; PC1
rewrote it. Their `DAY12_CLOSEOUT.md` is the authority on all six follow-ups —
read that, not this.

---

## 3. Still board/legal only — no code closes these

Unchanged by anything here, and each remains a genuine go-live gate:
designate a DPO · sign the 13 processor DPAs · write the 72-hour breach
procedure · publish the privacy notice and the subject-rights procedure ·
confirm cross-border transfer basis and hosting region · decide whether
special-category data is collected at all · commission the external pen test ·
confirm the NDPC registration threshold.

**One is now partly technical and worth re-reading:** the pack's §7 recorded
erasure and objection as manual. Self-service **withdrawal** now exists (§1).
Self-service **portability** and a full **subject-access export** still do not —
though `my_channel_consents()` is the first piece of one.

---

## 4. PC1 — what to review and action

Ordered by what breaks if it is missed.

1. **⚠️ APPLY `0146`, `0147`, `0148` BEFORE OR WITH THE DEPLOY — they are
   pushed but NOT applied, and the code assumes them.**
   `app/dashboard/settings/profile/page.tsx` calls `my_channel_consents()` and
   the save path calls `record_my_channel_consent`. Until the migrations land,
   the profile page still renders (the RPC error is swallowed and the list
   reads empty) but **saving a channel change will fail** for anyone toggling
   WhatsApp/Telegram/SMS. Apply deliberately: dev and prod still share one
   Supabase project.
2. **Review the consent design in §1** — particularly the three choices that
   are load-bearing and would be easy to "simplify" into holes: definer-only
   writes, `has_channel_consent` withheld from `authenticated`, and the gate
   failing CLOSED.
3. **Run `node scripts/verify-channel-consent.mjs`** once the migrations are
   applied. It joins `npm run verify` automatically. **I did not run it** —
   it writes and deletes rows, and I was not going to do that against a
   database shared with production without asking.
4. **Decide on `ChatWithUs` for the public `/apply/[orgId]` page**
   (`CHAT_DEEP_LINKS.md`). It needs `vendor_application_org` extended to return
   the two public handles — defensible, but it widens an RPC written narrow on
   purpose, so it is a decision rather than a task.
5. **Submit the four WhatsApp templates** (`WHATSAPP_TEMPLATES.md`) — twice,
   once per brand. **But capture consent first:** nobody has granted anything
   yet, so every business-initiated WhatsApp send currently skips to email.
   That is the gate working correctly, and it is also the state that must
   change before the templates are worth anything.
6. **Consider the converse assertion** noted in §2 for
   `verify-cross-org-dispatch`.
7. **`DAY12_CLOSEOUT.md` outranks §2 of this document.** Where they disagree,
   yours is newer and better informed.
