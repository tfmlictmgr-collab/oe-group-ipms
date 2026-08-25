# Build Journal

Append-only. One entry per milestone: what shipped, what was **verified** (not
assumed), and any decision worth remembering. Newest last.

Conventions: 🟢 shipped · 🔎 verified · ⚖️ decision · ⚠️ defect found & fixed.

---

## 2026-07-24 · Phase 1 Day 1 — environment split
🟢 `phase-1` branch; dev Supabase (`uszwigxdvjlwcwkjsjmc`, eu-west-2) migrated +
seeded; Upstash rate-limiting on both intake webhooks; Sentry across
server/edge/client; isolated `oe-group-ipms-dev` Vercel project; UptimeRobot.

🔎 Seeding dev left the demo DB unchanged (demo 26 tickets on its own host, dev
22 on another). Limiter: 5 allowed then 6th blocked, independent per sender,
fail-open when unconfigured. Sentry test event delivered; no-DSN path sends
nothing. Deployed bundle references the **dev** Supabase; demo untouched.

⚖️ Two **separate Vercel projects**, not Preview-scoping — the demo project's env
vars are set for all environments, so a phase-1 preview there would have
inherited the demo database.

⚖️ Rate limiting **fails open**, webhook auth **fails closed**. Protection must
not take intake down; authentication must not be skippable.

---

## 2026-07-24 · Phase 1 Day 2 — brand isolation (from a prior session)
🟢 Per-org inbound channel routing (kills hardcoded `DEMO_ORG_ID`), JWT org
claims + brand middleware, S5 money-side property scoping.

⚠️ Found a **duplicate `0012` migration number** while resuming; renamed the
theming migration to `0013` and re-pointed the ledger row.

---

## 2026-07-24 · UI overhaul + per-org branding
🟢 Design system (semantic tokens, light/dark, elevation, focus rings); component
library (Button, Card, Badge, Input, Table, DropdownMenu, Sheet, Avatar…) and
patterns (PageHeader, StatCard, EmptyState, StatusBadge); SaaS app shell with
sidebar + mobile drawer + theme toggle + user menu; **every screen restyled**;
per-org branding — colours, monogram, **logo upload**, portal name, tagline,
support contacts, all admin-editable with no code.

🔎 Brand var resolves to TFML navy `#003366`; no horizontal overflow at 375px on
any screen; charts theme-aware (dark bars `#63a4ef`, grid `#2a2f3d`); logo
storage rules — admin can upload to own org, **cannot** to another org, non-admin
cannot at all, public read works; dev serves the new UI while the demo still
serves the old.

⚠️ **`<Button asChild>` crashed `/dashboard` with a 500** — `@radix-ui/react-slot`
calls `createContext`, which cannot run in a Server Component. Marked it
`"use client"`.

⚠️ **Theming silently never saved.** The audit trigger on `orgs` violated
`audit_log.org_id NOT NULL` because that table has no `org_id` (its identity is
`id`), and the audit fires in the same transaction, so every branding update
rolled back. Fixed in `0014`.

⚖️ **No per-org login headline.** Login is pre-auth and both brands share one
domain ("no urls"), so there is no way to know whose branding to show — the
control would have been dead. Column kept for when per-domain routing lands.

---

## 2026-07-25 · Asset register (Phase 1 core)
**Why now:** a careful check found asset management was *not* in Phase 1 at all —
`CLAUDE.md` B9 promised an `assets` stub "from Day 1" that was never built, B2
lets tenants raise "asset issues" against assets that didn't exist, and the
roadmap had **zero** mentions of "asset". Assets are a hub (tickets, work orders,
Phase-2 meters/sensors point at them), so building it now avoids backfilling
every relationship later.

🟢 `0016` assets — org → property → (optional) unit hierarchy; identity,
make/model/serial, lifecycle, condition, criticality, commercials, responsibility;
enums not free text; per-org case-insensitive unique tag; property-scoped RLS
(FM/PM write only their properties); integrity trigger so a unit must belong to
the asset's property; hard delete blocked; every write audited; `tickets.asset_id`.

🟢 `0017` archive/restore RPC. 🟢 `0018` insurance + statutory compliance columns
(indexed for expiry alerting), `asset_certificates` child table, and
**admin-definable custom fields** (`asset_field_definitions` + `custom_fields`
JSONB).

🟢 CSV template (per-org, includes custom fields), bulk import with row-level
validation preview, single-entry form, list with search/filter/expiry state,
detail page, nav entry.

🔎 Access: 14 checks — FM creates on managed properties but not unmanaged;
tenant/vendor blocked; reads property-scoped and cross-org isolated; mismatched
unit rejected; archive/restore/audit all correct. Import logic: 25 checks against
a deliberately messy file. **End-to-end against the dev DB:** 2 valid rows written,
3 blocked (unmanaged property, duplicate tag, typo'd enum), rejected rows
provably absent, `"1,250,000"` stored as `1250000`, audit entries present.

⚠️ **Soft-delete was impossible.** PostgreSQL applies SELECT policies to the NEW
row when an UPDATE carries `RETURNING` (PostgREST always adds it), so setting
`deleted_at` made the row invisible and the update was rejected outright — the
guardrail made the feature unusable. Replaced with explicit permission-checked
`archive_asset` / `restore_asset` / `archived_assets()`.

⚠️ **Import previewed rows the write would refuse.** Properties are readable
org-wide but assets are writable only on staked properties, so the picker offered
"Victoria Court" to an FM who doesn't manage it. Added `writableProperties()` and
routed every picker and lookup through it.

⚖️ **Hybrid extensibility:** core fields stay typed columns (indexed, validated,
importable); client-specific fields are admin-defined and stored in JSONB — so
fields can be **appended with no code and no migration**, and they appear in the
CSV template automatically.

⚖️ **Only 3 of 44 fields are required** (property, tag, name). Compliance and
insurance are optional so a quick register stays valid.

⚖️ **FM/PM is one role, two labels.** `facility_manager` renders as "Facilities
Manager" for TFML and "Properties Manager" for OEA. Permissions are identical;
splitting the role would double every RLS policy for no security gain.

📌 Carried to Day 3: FM/PM **attaché** assignment (staff or vendor) is defined
during onboarding — `property_stakeholders` already models it.

---

## 2026-07-25 · Phase 2 tagging seam corrected — barcodes, not just QR
🟢 `0019` `asset_identifiers` (qr · barcode_1d · rfid · nfc · oem_serial · legacy)
replaces the single `assets.qr_code` column, plus `find_asset_by_identifier()`
for symbology-agnostic scan lookup. Dropped `qr_code` (nothing written to it yet).

⚖️ **An asset carries several identifiers at once** — the OEM barcode on the
rating plate, a legacy tag from a previous system, your own printed label,
sometimes RFID. One column could hold exactly one and would have forced
re-labelling of already-tagged equipment. Barcodes are still widespread in FM
(cheap 1D scanners, existing labels), so QR-only was wrong.

🔎 Same asset resolved from a QR payload, a Code 128 barcode and an OEM serial;
an unknown value matched nothing. Uniqueness is per-org, since two orgs may
legitimately hold the same OEM barcode.

---

## 2026-07-25 · Phase 1 Day 3 — self-service onboarding
Closes the "no in-app way for an org to enroll its own people" gap: until now
users existed only because a service-role seed script created them.

🟢 `0020` invitations (hashed token, expiry, single-use, revocable) +
`invitation_preview()` / `accept_invitation()`; vendor `approval_status`.
🟢 Public `/invite/[token]` accept flow; `/dashboard/people` for issuing
invitations, revoking them, approving vendors and assigning unit occupancy;
People nav entry for admin + FM/PM.

⚖️ **The raw token is never stored** — only its SHA-256 hash, so a database read
cannot be replayed as an invitation (password-reset pattern).
⚖️ **The role is fixed at issue time** and applied by a SECURITY DEFINER function,
so nobody can self-assign elevated access during sign-up. An FM/PM cannot mint
an administrator.
⚖️ **Email is optional.** Resend is not configured, so invitations return a
one-time link the inviter can share over any channel; the moment
`RESEND_API_KEY` is set the same action also emails, and the link stays as a
fallback. Shipping link-only beats blocking on a key.

🔎 14 checks: hash-not-token storage; preview leaks nothing for a bad token;
FM cannot invite an admin; a tenant cannot invite at all; a forwarded link is
refused for a different email; the accepted user gets exactly the invited role,
org and attaché assignment; single-use enforced; **a newly-onboarded FM reads
only their attached property**; acceptance audited. Verified in-browser: the FM's
role list correctly omits Administrator, and an invalid token reveals neither
email nor org.

⚠️ **A regression the suite caught — and it was the test, not the product.**
`verify-access-matrix` sampled "the first user with role facility_manager". The
invitation test left an accepted invitee behind, that invitee had no properties,
and the script picked it — reporting 5 scoping failures while the REST-based
check still passed. Two fixes: the script now targets the **seeded principals by
email** (a real org has many users per role, and a newly-invited FM without
assignments legitimately sees nothing — the old assumption was simply wrong),
and the invitation test now strips scope and demotes its leftover instead of
pretending to delete it.

⚖️ **An accepted invitee cannot be deleted, and shouldn't be.**
`audit_log.actor_id` references them; the FK refusal is the immutable audit
trail working as designed. Tests neutralise rather than erase.

📌 Still open for Day 3+: vendor **self**-registration is currently
invitation-based (admin/FM issues the link) — a public application form remains
to be built; Resend key needed for automatic emails.

---

## 2026-07-25 · Vendor self-registration (closing the Day-3 gap before Day 4)
**Why before the ledger:** "who may become a payable vendor" is a money-path
question. Settling it now means the gate is already airtight when Day 4 makes
remittance real — auditing it afterwards would mean auditing a live money path.

🟢 `0021` `vendor_applications` — the first unauthenticated write in the system.
Public `/apply/[orgId]` form, `/apply/confirm/[token]` email confirmation,
admin review queue on `/dashboard/people`, and an admin-controlled open/close
switch with a shareable link.

**Controls, in order of cost so abuse is dropped early:**
per-IP rate limit (5 / 10 min) → honeypot + submission-timing → Turnstile (when
configured) → per-email rate limit (3 / 24 h) → field validation and length caps
→ INSERT under RLS.

⚖️ **Applications never touch `vendors`.** An applicant cannot exist as an
assignable or payable entity until a human approves; approval is an RPC that
*creates* the vendor, so "approved" and "exists as a vendor" cannot drift apart.
⚖️ **Opt-in per org, default closed** — a leaked link is inert until an admin
opens it, and closing it makes every old link inert again.
⚖️ **anon may INSERT but never SELECT** — the endpoint cannot enumerate
applicants, vendors or orgs. An unknown org and a closed org return the same
message.
⚖️ **Turnstile fails OPEN, deliberately** — unlike webhook auth. It is bot
resistance, not authorisation; the authorisation gate is human approval, which
cannot be bypassed. Failing closed would take the channel offline for a missing
optional key, when the worst case is a spam row in a queue someone must approve
anyway. Rate limiting and honeypot/timing run regardless.
⚖️ **Email verification degrades, not blocks.** Without Resend the application is
still queued and flagged "Email unverified" in the queue, so a reviewer knows to
confirm by other means; the key upgrades it automatically.

🔎 16 checks: closed org rejects; open org accepts; anon reads nothing back;
applicant cannot self-approve via `status`; applying creates no vendor;
duplicates refused while pending; a tenant and another org's admin both blocked
from deciding; email confirmation single-use and silent on failure; approval
creates exactly one approved vendor and links the application; double-approval
refused; all audited.

⚠️ **Nobody could submit at all.** The 0021 INSERT policy gated on
`exists (select 1 from orgs …)`, but a WITH CHECK subquery runs as the *caller*
and `orgs` RLS hides every row from anon — so the EXISTS was always false and
every public submission was rejected, including from orgs that had opened
applications. Fixed in `0022` with a SECURITY DEFINER predicate that answers one
boolean and reveals nothing else. **A policy that reads another RLS-protected
table must not assume the caller can see it.**

📌 Remaining input gaps (not build gaps): `RESEND_API_KEY` + `RESEND_FROM` for
invitation and verification emails; `TURNSTILE_SECRET_KEY` +
`NEXT_PUBLIC_TURNSTILE_SITE_KEY` for bot resistance. Both are read at runtime —
adding them needs no code change.

---

## 2026-07-25 · Email sending domain + reply routing
⚠️ **The master brief had the wrong TFML domain.** `CLAUDE.md` B1 and the Day 0/2
workplan carried `tfmconsultant.com`, which DNS shows **does not exist** (no A,
no MX). The real domain is `tfmlconsultant.com`. Corrected at source, so Day 2's
DNS/brand routing targets the right domain. `oraegbunike.com` was already right.

⚠️ **Nearly broke TFML's live business email.** Their root SPF already chains to
~9–10 DNS lookups (`+a`, `+mx`, `include:websitewelcome.com` → 4 nested,
`include:_spf.google.com`) against an RFC limit of 10, and ends `-all` with DMARC
`p=reject`. Adding Resend to the root would have tipped it into SPF PermError —
which under `-all` + `p=reject` means existing staff mail gets **rejected**, not
spam-foldered.

⚖️ **Send from a subdomain** (`notify.tfmlconsultant.com`): root SPF untouched,
lookup limit sidestepped, sending reputation isolated from business mail. DMARC
has no `sp=` tag so the subdomain still inherits `p=reject`, and relaxed
alignment (`adkim=r`/`aspf=r`) means DKIM `d=notify.…` and the SES return-path
both align — strict protection retained *and* mail delivers.
🔎 Verified live: SPF, MX and the full DKIM key resolve on the subdomain with no
cPanel name-append typo; root MX/SPF byte-for-byte unchanged.

⚖️ **No `no-reply`.** Almost everything this system sends is client-facing and
money-adjacent — SC invoices, remittance advice to landlords, renewal notices.
A dead reply address silently loses genuine disputes and reads as evasive.
Instead: `From` on the sending subdomain (reputation), `Reply-To` on a real
monitored inbox (relationship). No extra DNS — it's a header.

🟢 `lib/email.ts` — one outbound path, category-routed Reply-To
(account/finance/operations/it), so the policy is decided once rather than
re-derived per call site. `0023` adds per-org `finance_email` + `it_email`
alongside `support_email`; all three are admin-editable in Settings, so TFML and
OEA control their own inboxes with no deploy. Invitations and vendor-application
verification now route through it.

🔎 Routing verified without sending mail: TFML resolves account→info@,
finance→accounts@, it→admin@projects…; an unset category falls back to support;
an org with nothing set omits the header rather than sending a broken one; and
finance never silently falls through to the IT inbox.

📌 The `notify.` MX + cPanel catch-all forwarder is **deliberately deferred** —
Reply-To covers virtually every client, and all three inboxes have working MX.
Revisit **before Day 5**, when remittance advice starts going to landlords and a
bounced reply becomes costly.

---

## 2026-07-26 · Sender identity is per-brand, not "OE Group"
⚠️ **I had the From header wrong.** I proposed a single `RESEND_FROM` of
`OE Group <…>`. Per B1, OE Group is the holding entity and is **not
client-facing** — a TFML tenant receiving mail from "OE Group" doesn't recognise
the sender (reads as phishing) and it leaks the group structure the isolation
rule says they should never see.

The correction runs deeper than a label: each brand sends from **its own verified
subdomain** (`notify.tfmlconsultant.com` vs `notify.oraegbunike.com`), so one env
var cannot express the sender at all.

🟢 `0024` adds per-org `email_from_name` + `email_from_address`, admin-editable in
Settings beside the reply routes. `RESEND_FROM` survives only as a last-resort
fallback for orgs with no sender configured; if that is unset too, `sendEmail`
**declines to send** rather than delivering under the wrong brand.
Display names are quoted, so a comma in a brand name cannot split the header
into two addresses.

🔎 Verified: TFML sends as `"TFML Nigeria" <no-reply@notify.tfmlconsultant.com>`,
OEA as `"Ora Egbunike & Associates" <no-reply@notify.oraegbunike.com>`, the two
identities are distinct, neither exposes the holding entity, and a punctuated
brand name stays inside its quotes.

---

## 2026-07-26 · Email copy is brand-specific too
⚠️ **Half-fixed brand leak.** The From header was corrected to "TFML Nigeria",
but the subject and body still read "the OE Group portal" — the same B1
violation, just in the copy rather than the header. The role also rendered as
raw database text (`fm ops staff`) instead of the brand-aware label.

🟢 `sendEmail` now accepts subject/text as functions of a `MailContext`
carrying `brandName` (the org's sender name, falling back to its own name), so
any copy that names the organisation resolves per brand at send time. Roles
render through `roleLabel(role, brand)` — TFML "Operations Staff",
OEA "Property Operations Staff". Added "Invited by <name>" as a trust signal,
since the most common reply to an invitation is "is this genuine?".

⚖️ **No LLM in outbound mail.** Templates are static strings; nothing is
generated at send time, so email costs zero Anthropic tokens. Claude is used
only for inbound triage classification. Worth stating because it means copy
quality is free — there is no reason to keep it terse.

🔎 Live end-to-end on the dev deployment: Resend accepted both sends
("Emailed to …"), From resolved to `TFML Nigeria <no-reply@notify.tfmlconsultant.com>`,
and no "OE Group" string remains anywhere in outbound copy.

---

## 2026-07-26 · Notification centre, channel preferences, People sub-navigation
🟢 `0025` `user_notifications` — a per-recipient inbox, distinct from the 0007
`notifications` table which is a per-channel DELIVERY LOG ("did it go out?").
This one answers "what does this person still need to deal with?", so it is
addressed to a user, carries read state, and is readable only by that user.
Bell in the top bar with unread count, live INSERT subscription, mark-one/all
read, deep links.

🟢 `0025`/`0026` channel preferences — per-user email/WhatsApp/SMS/Telegram
opt-in, **captured during enrolment** on the accept-invite screen and editable
later in Settings.

🟢 People split into **Members · Invitations · Vendor Applications · Unit
Occupancy**, with pending counts on the tabs. Members gains search and
activate/deactivate.

⚖️ **Scoping by recipient, not by role.** A notification row is either yours or
invisible — there is no role logic to get wrong, and it cannot drift as roles
change.
⚖️ **Preferences are RPCs, not an RLS policy.** RLS is ROW-level: a policy
allowing `id = auth.uid()` to UPDATE `users` would let anyone edit *any column
of their own row*, including `role`. That is straight privilege escalation. The
RPCs expose exactly the columns each caller may touch.
⚖️ **A channel can't be enabled without an identifier** — no phone, no
WhatsApp/SMS. Preferences can never claim a route that fails at send time.
⚖️ **Deactivate, never delete.** Anyone who has acted is referenced by
`audit_log.actor_id`; deleting them would put holes in the audit trail. An admin
also cannot deactivate themselves — the classic way to lock an org out.
⚖️ **Notification links must be relative**, so a notification can never redirect
someone off-site.

🔎 21 checks: recipient-only reads (cross-user AND cross-org); a user cannot
fabricate a notification for themselves or anyone else; marking read cannot
reassign a row; `notify_role` reaches exactly the active roster with no
cross-org leakage; absolute URLs rejected; a tenant can set their own channels
but the role is untouched and direct self-promotion is blocked; deactivation is
admin-only and never self-inflicted; a deactivated member receives nothing.
Verified live: bell reads "Notifications, 2 unread", sub-nav renders all four
tabs, and the leftover test invitees no longer appear in Members.

⚠️ Cleared the 5 test-invitee rows from the Members list by deactivating them —
they were visible in the client's UI, left by an earlier verification run.

---

## 2026-07-26 · Analytics sequencing confirmed (Day 10)
📌 Client asked why the BI charts are still static and when the locked
interactive analytics console arrives. It is **Day 10**, spec'd as requested
(filters by date range / vendor / classification / property / status;
completion rate by vendor and by classification; best/worst performer; average
time-to-resolve; weekly/monthly/quarterly/yearly toggles with period-over-period;
CSV/PDF export).

⚖️ **Held at Day 10 rather than pulled forward.** Days 4–6 create the financial
data the console must report on — collection rate, receivables, budget
utilisation, vendor liabilities, remittance flow. Building the filter engine,
aggregation layer and exports before the ledger exists would mean building them
twice. The operational half of the data (requests, vendors, assets, timestamps)
is already in place and waiting. Trade-off surfaced explicitly to the client,
who chose to keep the order.

---

## 2026-07-26 · Phase 1 Day 4 — client-funds ledger + reconciliation
🟢 `0027` double-entry ledger; `0028` org-configurable bank account + opening
balance; `0029`/`0030` statement import, conservative auto-matching and
reconciliation; ledger UI (Balances · Journal · Reconciliation).

⚖️ **Four invariants enforced by the DATABASE**, not application code: entries
must balance, the ledger is append-only, client funds cannot go negative, and a
counterparty cannot be overpaid. The last is the segregation guarantee, and it
is why accounts are per-landlord/per-vendor rather than pooled.
⚖️ **Balances are a view, never stored.** A stored total can drift from its
postings, and a ledger whose balance disagrees with its own history is worse
than no ledger.
⚖️ **Statement lines stay separate from postings.** The statement is third-party
evidence; the ledger is our record. Merging them would let an import rewrite the
books and leave nothing independent to reconcile against.
⚖️ **Dedupe on the bank's reference, not date+amount+description.** Two real
₦500 charges on one day are normal; dropping the second would understate the
account. Un-referenced repeats are a warning, and a person decides.
⚖️ **Auto-match only when exactly one entry fits.** A wrong match is worse than
none — it makes the books look reconciled when they are not.
⚖️ **Every reconciliation run is kept**, balanced or not. One only saved on
success is one nobody can audit.
⚖️ **Last four digits only** for bank accounts. The app never initiates
transfers from stored details, so the full number is risk with no benefit.

🔎 The workplan's Day-4 gate verbatim: a clean statement reconciles to ZERO
variance, then an unrecorded ₦75,000 debit is introduced and correctly flagged,
the line reported unmatched, both runs retained. 39 checks across ledger +
reconciliation. All twelve suites green.

⚠️ **Two functions in `0029` were broken despite the migration applying
cleanly** — `min(uuid)` does not exist in Postgres, and a CASE returning text
was inserted into an enum column. Both surfaced only when called with real data.
**A migration that applies says nothing about whether its functions run.**

⚠️ **`accept_invitation` had TWO live definitions.** `CREATE OR REPLACE
FUNCTION` only replaces an identical signature — 0026's extra parameters created
an overload alongside 0020's original, and every argument after the first two
has a default, so a two-argument call was ambiguous and Postgres refused it. The
app always passed all seven, so it kept working and the fault was invisible
there. Dropped the stale version in `0031`. **When changing a function's
signature, DROP the old one explicitly.**

⚠️ Two test defects fixed while verifying: immutability was asserted on error
presence (RLS filters the row before the trigger fires, so the call is a silent
no-op — only a STATE assertion proves it), and the insufficient-funds case was
masked by the overpayment rule firing first.

📌 Placeholders until the client supplies them: bank name/last-4, opening
balance and its allocation, and the management/admin fee percentages — all
default to zero or blank so nothing is ever deducted or assumed by accident.

## 2026-07-27 · Phase 1 Day 5 — collections, checkout, receipts

Money coming in, end to end: raise a request against an invoice → checkout →
signed webhook → server-to-server verification → ledger posting → branded PDF
receipt. Gateway adapters for Paystack (Naira) and Flutterwave (FX), plus a
simulated adapter for environments with no keys.

⚖️ **`verifySignature` and `verifyTransaction` are separate calls, and both are
required.** A signature proves WHO sent the message. It says nothing about
whether the contents are true. Only a server-to-server lookup proves WHAT was
paid, so the amount that reaches the ledger always comes from that lookup —
never from the request body, under any adapter.
⚖️ **The amount is fixed server-side from our own invoice** before the gateway
is contacted. Nothing the payer sends can change what is charged.
⚖️ **Posting is idempotent by construction**: `ledger_entry_id` on the intent IS
the "already posted" flag, set under a row lock, so there is no separate boolean
to drift. Three concurrent deliveries produce one entry.
⚖️ **A webhook always answers 200 once the signature is valid.** A non-2xx makes
gateways retry, and retrying a message we already understood adds load without
changing the outcome. The stored event carries the real result.
⚖️ **An unconfigured gateway refuses with 403, not 500.** A 500 makes gateways
retry indefinitely and hints at internal state to whoever is probing.
⚖️ **Receipts are generated on demand, never stored**, so a receipt can never
disagree with the ledger it was drawn from — and are served through the caller's
own session, so RLS decides who may see one. A hidden receipt and a
non-existent one answer identically.
⚖️ **The simulated gateway is not a stub that returns success.** It writes the
charge to its own record (`simulated_charges`, 0034) and its `verifyTransaction`
reads it back — the same shape as asking Paystack. A stub returning `success`
would have quietly broken the one rule the design exists to enforce.

🔎 The end-to-end suite posts a webhook whose payload claims **₦999,999,999**
against a ₦400,000 invoice where ₦250,000 was actually presented. The ledger
takes ₦250,000, flags the shortfall, leaves the invoice open, and the receipt
never carries the forged figure. 17 checks over real HTTP against a running
server; `verify-checkout-e2e.mjs`.

⚠️ **A live run debited the wrong bank account.** `record_collection` resolved
the debit side with `... where purpose = 'client_funds' and active limit 1` —
no ORDER BY, so the planner chose, and it chose a leftover test account. An org
may legitimately hold several client-funds LEDGER accounts (one per configured
bank account) while holding exactly one active client-funds BANK account, and
reconciliation compares the statement against `bank_accounts.ledger_account_id`.
A collection posted anywhere else is money that exists in the books but can
never be matched to the bank — a permanent variance on a system whose whole
purpose is daily agreement. Fixed in `0035` with `collection_bank_account()`,
which reads the bank account reconciliation actually uses. **`LIMIT 1` without
`ORDER BY` is not a choice; it is a coin toss with the planner.**

⚠️ The collections suite had been passing throughout, because it picked the
account to watch the same arbitrary way. **A test that re-derives what the
system should do, instead of asking the system what it did, verifies nothing.**
Both now resolve through the same function.

📌 Live test-card run on the dev deployment is the remaining Day-5 step; the
Paystack test webhook URL is saved and the adapter is live, not simulated.

## 2026-07-27 · The same `LIMIT 1` bug, in a third place — and it hit live config

⚠️ An admin configured the client-funds bank account for all three orgs. Two
linked correctly. The third was wired to **"Client funds (recon test)"** — a fake
account left behind by `verify-reconciliation.mjs`, because
`saveBankAccount` resolved the ledger counterpart with `.limit(1)` and no
ordering, exactly as `record_collection` had.

That link is not cosmetic: `bank_accounts.ledger_account_id` is both what
reconciliation compares the statement against **and** where the opening balance
is posted. A wrong link silently misdirects both, and the org would have
reconciled a real bank statement against a test account forever.

⚖️ **One resolver, `canonical_ledger_account(org, purpose)` (0036).** Three
independent `LIMIT 1`s meant three chances to disagree about which account holds
the client's money. Deterministic ordering: numeric chart codes first, then code,
then age.

⚖️ **The stray account was deactivated, not deleted.** It carries two test
postings that net to zero; removing them would edit the ledger, which the whole
design forbids. Deactivating puts it out of reach of every resolver while
leaving it auditable.

⚠️ **The test script printed "(cleaned up)" while cleaning nothing** — six
deletes, no error checks, no assertion. It now checks each delete and then reads
back to confirm the rows are gone; two consecutive runs leave nothing behind.
**A test that litters the database it verifies eventually verifies the litter** —
this debris caused a real collection to be debited to a test account, then
caused a real configuration to point at one.

🔎 All three orgs now resolve to `1000 Client funds (bank)`, each linked to its
own Providus account. Ledger, reconciliation, collections and checkout suites
green after the repair.

## 2026-07-27 · The demo failed, and the failure message was invisible

⚠️ **Paystack refused the checkout: "Invalid Email Address Passed".** The seeded
demo tenants were on `@oegroup.test`, and `.test` is reserved by RFC 2606 —
guaranteed undeliverable, so gateways reject it outright. Fine for Supabase auth,
useless for anything that must actually receive mail. Demo tenants moved to the
brands' real domains; staff logins stay on `.test` since they only authenticate.

⚖️ **The address is now checked before the gateway is called**
(`lib/email-address.ts`), because the fix is administrative — edit the person's
record — and the message should say that rather than surfacing a gateway error
mid-checkout. `DEMO_PAYER_EMAIL` routes the test receipts to a real inbox.

⚠️ **The far worse defect: the user never saw that message.** Next.js replaces
the message of any error thrown in a Server Action with an opaque digest in
production builds. The screen said *"An error occurred… the specific message is
omitted in production builds"*, while the real reason sat in the Vercel log with
`digest: '843142770'`. Every carefully-worded message in the collections
actions — "that invoice is already paid", "only finance can request a payment" —
had been unreachable in the only environment that matters.

⚖️ **Expected failures are RETURNED, not thrown.** Collections actions now use a
discriminated result (`{ ok: false, message, hint }`); only unexpected faults
throw, and the client shows a generic message for those. Error text that
identifies what to change is pinned until dismissed — a four-second toast cannot
be acted on.

⚠️ **This is systemic: 95 `throw new Error` sites across 11 server-action files**,
covering people, assets, banking, invitations and the payment gate. All show the
same wall. Collections is converted as the reference implementation; the rest is
tracked separately. **Error handling that is only exercised in development is
not error handling** — it looked correct locally in every test I ran, because
`next dev` shows the real message.

## 2026-07-27 · Every server action now tells the user what went wrong

Converted all 13 `"use server"` modules — 28 actions, 95 throw sites — from
throwing user-facing messages to returning them.

⚖️ **`ActionResult<T>` and two helpers.** `fail(message, hint?)` on the server;
`runAction()` on the client, which re-throws so the ~20 existing
`catch (e) { toast(e.message) }` blocks keep working while finally showing the
real reason. Messages are not masked on the client — only across the Server
Action boundary — so re-throwing there is safe.
⚖️ **`failFromDb` translates Postgres, once.** "new row violates row-level
security policy" is not a sentence to put in front of a facilities manager; it
now reads "You do not have permission to assign that occupant."
⚖️ **Two files still throw, deliberately.** `buildImportContext` is awaited
during a server render for a state middleware already prevents, and
`app/pay/[reference]` is dev-only. Masking is correct for both — they are bugs,
not user errors, and the audit records them as exceptions by name.
⚖️ **Messages that name a fix are pinned until dismissed.** A four-second toast
saying which approval step is missing cannot be acted on.

⚠️ The audit found a file I had missed entirely — `app/apply/[orgId]`, the
public vendor application. It already returned results, in its own `{ok, error}`
shape, as did collections in a third shape. Three shapes for one idea is how the
next one gets missed; all now share the type.

🔎 `verify-action-errors.mjs` — a STATIC audit, and honest about it: it proves
failures are returned, not that a toast renders. It checks no action throws
outside the two documented exceptions, that every action module uses the shared
result type, and that no client discards a result (accepting either
`runAction()` or an explicit `.ok` check). All 12 suites green afterwards,
including the checkout end-to-end.

📌 **The reason this needed a check rather than a review**: `next dev` shows the
real message, so the fault is invisible in the only environment where it is ever
noticed. It survived every local test of every one of these screens.

## 2026-07-27 · A read-only observer role — and a credential it exposed

🟢 New `viewer` role (0037/0038) for showing progress to someone OUTSIDE the
organisation. Every existing role was wrong for it: `finance_approver` is the
only one that sees org-wide, and it sees the entire client-funds ledger and bank
configuration.

⚖️ **Deny by default, then add back.** Every existing SELECT policy names the
roles it admits, so a new role starts able to read almost nothing. That is the
right footing — the migration lists what it grants and, explicitly, what it
withholds and why.
⚖️ **Withheld columns go through DEFINER views, not application filtering.** RLS
is row-level, and column-level GRANTs are per database role — every signed-in
user shares `authenticated`, so a grant hiding ticket free text from a viewer
hides it from finance too. `ticket_overview` and `vendor_overview` omit the
columns entirely and the viewer gets no policy on the base tables, which makes
the omission real rather than cosmetic. Because a definer view bypasses RLS, its
WHERE clause IS the boundary and must test the ROLE as well as the org —
otherwise a tenant reads every ticket in the org through it. Tested directly.
⚖️ **One honest page beats four that half-work.** A viewer gets a purpose-built
Programme Overview rather than degraded versions of the operational screens: the
requests list would be empty and the analytics page would render a financial
dashboard of ₦0, which reads as a broken build rather than withheld access.

⚠️ **The verification found a live credential leak that predates this work.**
`channel_routes_select` was `using (org_id = current_user_org_id())` with no role
test, so **any signed-in user — including a tenant — could read
`channel_routes.external_id`**. For Telegram that column IS the per-bot secret
token, which is simultaneously the authentication and the routing key for the
inbound webhook. Holding it lets someone forge service requests into a chosen
org, attributed to any sender.

⚖️ **Fixed by removal, not restriction (0039).** `resolveOrgForChannel` runs
under the service role inside the webhook handler, and no UI reads the table —
so the policy granted access nothing needed, which is the strongest kind of
permission to delete. RLS stays on with zero policies.

🔎 `verify-viewer-access.mjs` — 40+ assertions, all against a live viewer
session: reads structure; returns nothing from twelve money tables, the audit
log, invitations or applications; cannot reach `tickets.message_text` or
`vendors.contact_email` directly; cannot insert into eight tables, cannot update
or delete a property it CAN read, cannot escalate its own role, cannot see
another org; and a tenant gets zero rows through the new views. Channel routing,
access matrix and JWT-claims suites still green after the fix.

📌 **This role is defined more by absences than permissions, and an absence is
the easiest thing in a schema to lose by accident** — which is exactly why every
denial is asserted against the database rather than inferred from reading the
policies.

## 2026-07-27 · Permissions become operator-governed (scheduled, Day 6.5)

⚠️ **"Read-only Observer" was invisible in the invite dropdown.** The roles
offered came from a private `ROLE_CHOICES` array in `InviteDialog.tsx`; the
server validated against a separate `INVITABLE_ROLES` array in the action.
Adding the role to one did nothing for the other. Now one exported list.
**Two lists that must agree will eventually disagree** — and the failure is
silent, because each half is individually correct.

⚖️ **Role privileges become an admin-toggled permission matrix — Day 6.5**,
after remittance rather than before it. The permission system must know which
capabilities are non-delegable, and that list is not final until the B4 approval
gate is complete; building it first means guessing, then reworking.

⚖️ **The editor lives only on the OE Group operator portal.** Brand admins see
the matrix read-only — transparency without control. This needs a **platform
operator org**, a concept the model does not have: `orgs.is_platform_operator`,
explicit rather than inferred from `delivery_brand = 'direct'`, because that
field describes who delivers the service, not who governs the platform, and a
future direct-delivery client would otherwise inherit operator rights silently.

⚖️ **Editing another org's permissions is the ONE deliberate crossing of the
org-isolation boundary.** Routed through a single audited `SECURITY DEFINER`
function that verifies operator status, writes to exactly one target org, and
records both orgs — never through a cross-org RLS policy. A policy would leave
the boundary permanently weakened; a function leaves it intact with one guarded
door.

⚖️ **Some switches must not exist.** Payment approval and its threshold
escalation, remittance execution, ledger read/write, bank configuration, audit
visibility, admin invitation, permission editing itself, and channel-route
credentials stay hardwired. These are the controls an auditor checks — a toggle
granting `ledger.read` to Tenant exposes every client's money, and one granting
`payment.approve` to whoever raises the invoice destroys segregation of duties.
Shown as locked with the reason, not hidden: an admin should see the boundary.

⚖️ **Default to the most restrictive workable state.** Seeded from B7, and OFF
wherever B7 is silent. A new org starts locked down and is opened deliberately,
rather than starting open and being closed from memory.

⚖️ **B7 stays the approved baseline.** Deviation is badged with a per-capability
diff and a one-click reset, so the running system cannot silently drift from the
board-approved matrix.

📌 Recorded in `CLAUDE.md` as locked scope decision 7 (**v3.1 → v3.2**) and
specified in `PHASE1_WORKPLAN.md` Day 6.5, with its gate: *a toggle changes what
the DATABASE returns; locked permissions cannot be moved by UI or direct API
call; a brand admin cannot reach the editor.*

## 2026-07-27 · Invitations could not be accepted — three faults, one symptom

⚠️ **The screen said "Something went wrong. Please try again." That was mine.**
`describeError` returned the generic fallback for anything that was not an
`ActionError`. But only errors crossing the SERVER ACTION boundary are masked by
Next — an error thrown in the browser keeps its message, and here that message
was the whole answer. The real text, *"Your account was created but needs email
confirmation…"*, was thrown away by the very helper written to stop messages
being thrown away. **The rule is not "trust ActionError"; it is "suppress what
Next has masked"** — now detected by the `digest` property, everything else is
shown.

⚠️ **The underlying fault: enrolment was built on `supabase.auth.signUp`.** With
email confirmation enabled — the Supabase default — that returns a user but NO
session, so acceptance failed at the last step and left a half-made account
behind. The retry then hit "already registered", sign-in refused an unconfirmed
address, and the invitee was permanently stuck. One real person was in that
state.

⚖️ **The confirmation round trip was never earning anything.** The invitation
link was EMAILED to that address, so possession of it already proves control of
the mailbox. Asking again establishes no new fact and adds a step that can fail.
The login is now created server-side, already confirmed, and the invitee signs
straight in.
⚖️ **But an invitation must never set a password on a LIVE account** — that is
account takeover with extra steps. A confirmed, previously-used account is left
untouched and the invitee is asked to use their own password. An unconfirmed,
never-used shell is completed, which is what unsticks anyone the old flow
stranded. Both cases are asserted.

⚠️ **A third fault, found while fixing the second:** the new code asked "does
this address already have a login?" via the admin SDK's paginated `listUsers`,
then searched the page. Past the page size the account is simply not found, so
the code would create one and the invitee would be told their address is already
registered. TFML alone has 700+ staff. Replaced with `auth_account_state()`
(0043) — an exact, service-role-only lookup returning three booleans and nothing
else.

⚠️ **Two test defects, both the familiar kind.** `verify-invitations` created its
accounts with the admin API, which confirms the email as a side effect — so it
exercised a path the browser never took, which is exactly why this survived.
**A test that stages its fixtures differently from the real path is not testing
the real path.** And the new script compared emails case-sensitively while
Supabase lower-cases them on write, so a check silently failed AND its cleanup
never matched — twelve probe accounts had accumulated.

⚖️ **Cleanup now retires rather than deletes what it cannot remove.** A probe
that redeemed an invitation is referenced by `audit_log.actor_id`, and the audit
trail raises on DELETE for the service role too (0005). 0025 had already noted
the consequence. Deleting it would mean weakening the audit design to suit a
test — so the fixture is deactivated and labelled, exactly as a real departing
member is, and the script reports "N removed, M retired" instead of claiming a
clean sweep.

🔎 `verify-invite-acceptance.mjs` — 17 checks: a fresh invitee gets in first
time; a stranded shell is repaired; a live account's password survives an
invitation aimed at it; revoked, expired and forged links provision nothing.

## 2026-07-27 · Review of the day's work, and email delivery told the truth

🔎 Ran the code-reviewer agent over the day's commits. Three findings were real
defects in code written **today**, two of them repeats of mistakes this build had
already made and documented.

⚠️ **A cross-tenant leak in the very functions written to fix a different bug.**
`canonical_ledger_account()` and `collection_bank_account()` (0035/0036) are
`SECURITY DEFINER` — they bypass RLS by design — take a `p_org_id`, are granted
to `authenticated`, and **never checked that org belonged to the caller**. Any
signed-in user could ask for another org's client-funds ledger account id. Only
a UUID escapes, so the blast radius is small; the lapse is not. Hours earlier,
writing the viewer views, the rule had been stated explicitly: *a definer object
bypasses RLS, so its body is the entire security boundary*. It was then
reintroduced in a function instead of a view. **Knowing a rule and applying it
are separate acts.** Fixed in 0044 (service role exempt, as elsewhere).

⚠️ **Invoice regeneration could double-bill.** `generateInvoices` deleted the
budget's existing `service_charges` and discarded the delete's error.
`payment_intents.service_charge_id` has no ON DELETE clause, so once a payment
has been requested the delete FAILS — and the code carried on to insert a second
invoice for the same unit and period, beside one that may already be paid. Now
refused, with the reason and the alternative.

⚠️ **"One live request per invoice" was a comment, not a guarantee.** A read
then an insert is not atomic; two staff, or one double-click, produced two
payable checkout links for one invoice. 0045 adds the partial unique index, and
losing the race now returns the other person's link rather than an error.

⚠️ **An invitation could take over a real account.** The gate protecting
existing logins was `is_confirmed && has_signed_in`, but `createUser` and every
seed script pass `email_confirm: true` — so a colleague enrolled but not yet
logged in looked exactly like a stranded shell, and whoever held an invitation
for that address could overwrite its password. The reliable discriminator is the
**profile**: `accept_invitation` creates the `users` row, so an auth account with
one belongs to somebody. Gating on `is_confirmed` alone would have blocked the
genuine recovery path, since this flow confirms on creation.

⚖️ **"Emailed to <address>" was a claim the system could not support.** Resend
returning 2xx means ACCEPTED FOR DELIVERY. A message can be accepted and then
bounce, and the provider's message id — the only handle that could ever tell us
which — was being discarded. Now: `email_deliveries` (0040) records every send,
a signed Resend webhook records what became of it, and the invitations list shows
`delivered` / `bounced` / `sent — not yet confirmed` instead of asserting
success. The copy no longer says emailed; it says sent, and always offers the
link.

📌 The reviewer's own instructions (`.claude/agents/code-reviewer.md`) now carry
the defect patterns this build keeps producing — `LIMIT 1` without `ORDER BY`,
definer objects trusting their arguments, RLS policies with no role test,
PL/pgSQL that only fails when called, read-then-insert as a uniqueness claim,
discarded error returns, duplicated lists, and thrown Server Action errors — so
each review starts from what has actually gone wrong here rather than from first
principles.

## 2026-07-27 · Phase 1 Day 6 (2/2) — remittance actually moves money

🟢 The remittance domain built in part 1 had no caller. "Execute Remittance"
flipped a status and touched nothing else, so a vendor payment could read
**remitted with zero ledger effect** — the kind of thing discovered at
reconciliation, months later. Now wired end to end.

⚖️ **Post only on a CONFIRMED success.** Paystack may answer `pending`: accepted,
outcome unknown. Posting then would record money as having left on a transfer
that can still fail. A `pending` transfer stays `sending` and is settled by the
`transfer.success` webhook, resolved by OUR reference.
⚖️ **A transport failure is `unknown`, not `failed`.** If the instruction may or
may not have reached the gateway, guessing either way is worse than admitting
it: `failed` invites a retry that could pay twice, `sent` records money that may
still be in the account. It is held for a person, and cannot be re-claimed.
⚖️ **If the money left but the ledger write failed, never report failure.** That
message would invite a retry, and a second transfer is unrecoverable. The user
is told it was sent, told not to retry, and given the reference.
⚖️ **The account number is not stored.** It goes to the gateway; what comes back
is a recipient code, and that code is the only thing money can be sent to. The
gateway is the system of record for where money goes, so a compromise here
yields no payable details. Only the last four digits are kept.
⚖️ **The bank's name enquiry wins over the form.** What gets stored is the
account's real holder, and a mismatch is surfaced rather than accepted — a
trading name legitimately differs from a registered one, so a person decides.
⚖️ **Replacing bank details supersedes rather than edits.** Rewriting a
recipient that past remittances point at would silently restate where money went.
⚖️ **Flutterwave refuses payouts outright.** B3 scopes it to FX collections. A
fake success on an unimplemented payout path is exactly how money appears to
have moved when it has not.

🔎 `verify-remittance`: the gate refuses unverified, unscored and unapproved
payments; 3 concurrent claims produce exactly 1 winner; re-confirming returns
the same entry and moves nothing; a sent remittance cannot be restated or walked
back; fees land in fee income and the landlord receives the net; an unrecognised
₦5,000,000 liability is refused by the overpayment guard; `unknown` stays
unknown. Seven money suites green.

⚠️ **Three test defects, all the same shape: a test that does not own its
state.** The remittance suite ran against an unfunded service-charge account and
read the overpayment guard's *correct* refusal as a broken gate. It identified a
ledger entry as `made.entries[0]` — an index into a shared cleanup array, which
became the wrong entry the moment a fixture pushed something ahead of it. And
the ledger suite asserted absolute org-wide totals, so residue from any other
suite — or a real payment — failed a correct system. All three now assert
DELTAS against a captured baseline and verify their own cleanup.

📌 **The live Paystack test payment is in the books.** TFML: ₦285,000 invoiced,
₦287,000 received, flagged as a mismatch, posted to the client-funds ledger.
Day 5 is proven against the real gateway, not just the simulator.

## 2026-07-27 · Closing the code review

🟢 All open review findings fixed: `0048` (one resolver in remittance posting,
atomic opening balance, ordered auth lookup), `0049` (the collection credit side
and vendor-payable recognition through the same resolver), a stuck-remittance
recovery path, `simulatePayment` converted to `ActionResult`, and the viewer
suite extended to the tables the review noted were granted but never probed.

⚖️ **A transfer that leaves the bank but fails to post now has a way back.**
Previously that state lived in a `console.error`: the money had gone, the ledger
disagreed with the bank, and the only recovery was the gateway re-delivering a
webhook — which never comes if the cause is persistent. Client Funds now shows
those remittances first, above the position itself, because while one is
outstanding **the position below it is wrong**. The action completes the
POSTING and never re-instructs the gateway; re-sending is the one thing that
must never happen, so it is not offered.

⚠️ **Following the review literally introduced a regression, and the suite caught
it in one run.** Switching `record_remittance_sent` to `canonical_ledger_account`
was correct — but the COLLECTION side had never been converted, so rent was
credited to the oldest account while the payout settled against the standard
one, and the overpayment guard refused a legitimate remittance. `0048` predicted
exactly this in its own comment and then caused it. **A resolver used in half
the places is worse than no resolver at all** — the two halves now disagree
where before they were consistently wrong together.

⚖️ **Opening balances post in one function.** Entry-then-postings from the
application meant a failure between them left an entry with no postings —
invisible to the balancing trigger, which fires on postings. Every other money
path was already a single function; this one had been missed.

⚠️ More `REC-%` recon-test debris found, this time a landlord payable account —
the same family cleaned earlier. Retired rather than deleted; it carries
postings. **Test litter in a shared database keeps presenting as product bugs.**

## 2026-07-27 · Day 6.5 — the permission matrix

🟢 Role privileges are now data an operator toggles, not role names compiled into
policies. `capabilities` catalogue + `role_permissions` per org (0050), policies
rewritten to ask `has_permission()` (0051), seeded from B7.

⚖️ **Locked capabilities are listed but never read by a policy.** Payments,
ledger, bank configuration, audit, permission editing, admin invitation and
channel credentials stay hardwired. They appear in the catalogue so the UI can
show them as locked *with the reason* — an administrator should see that the
boundary exists rather than wonder why a switch is missing.

⚖️ **Org isolation and identity are not capabilities.** `org_id = current_user_org_id()`
survives untouched in every policy, and a tenant reading their own request or a
vendor their own job is identity, not privilege. The suite turns EVERY toggle off
and proves both still hold.

⚖️ **Editing another org's matrix is a FUNCTION, not a cross-org policy.** A
policy would leave the isolation boundary permanently weakened for every query;
a `SECURITY DEFINER` function leaves it intact with one guarded door that records
who went through it, naming both organisations.

⚠️ **The seed granted more than B7 does** — `tickets.read_all` to the FM, where
B7 says "assigned properties". Caught by `verify-access-matrix` on the first run
after the switch. **Moving to a matrix is only safe if the seed reproduces the
PREVIOUS effective access exactly**; anything else re-grants access under cover
of a refactor, and nobody reviews a seed as carefully as a policy. Corrected in
0053 by deriving each default from the policy it replaced rather than from a
reading of the matrix.

⚠️ **A `FOR ALL` policy grants SELECT.** Revoking `vendors.read` left the FM
still seeing every vendor: the read policy correctly denied, but `vendors_write`
was `FOR ALL`, and permissive policies OR together. Invisible before today
because the two role lists were identical — the moment they became independently
toggleable, one silently overrode the other. **A permission screen that can be
wrong about the database is worse than none, because it is believed.** Split into
explicit INSERT/UPDATE/DELETE in 0055.

⚠️ **`set_role_permission` wrote to a `metadata` column that does not exist.**
The audit insert is inside the same transaction as the permission write, so every
call rolled back — the toggle did nothing while reporting success. The migration
applied cleanly, because PL/pgSQL bodies are not checked until executed. Fourth
occurrence of that trap in this build. Then the SAME mistake appeared in the
verification script, which selected `metadata` and read the resulting ERROR as
"nothing was audited" while 22 rows sat in the table. **A test that does not
check its own query's error reports the wrong fault.**

⚖️ The audit write stays inside the transaction. A permission change that
succeeded while its audit record failed is worse than one that failed cleanly.

⚖️ **Permission checks are hoisted** — `(select has_permission('x'))` rather than
a bare call, so the planner evaluates each once per statement instead of once per
row. These policies sit in front of every read, and B5 puts 100+ properties on
this system from day one.

🔎 `verify-permissions.mjs` — 24 assertions: a toggle changes what the DATABASE
returns (revoke → zero rows, restore → exactly what was there), a revoked write
is refused, four locked capabilities refuse to move, an invented capability is
refused, a brand admin can read but not edit their own matrix and cannot see
another's, a tenant cannot edit at all, isolation and identity survive every
toggle off, and the trail names both organisations.

## 2026-07-27 · Day 6.75 — properties and units become manageable

⚠️ **Found by asking, not by testing: there was no way to enrol a property.**
Every property in the system came from a seed script. Nothing in the application
inserted into `properties` or `units` — only read them — though the write
policies had been there since `0001`. It was not deferred; it was **missed**, and
it was in neither the workplan nor the reconciled roadmap.

The build sequenced by module — tickets, assets, vendors, service charges,
ledger, collections, remittance — and treated the portfolio as fixtures the whole
way through. **A dependency that is always already there in the test data is a
dependency nobody notices is missing.**

🟢 `0056` plus a full CRUD surface: property list and detail, units with
occupancy, bulk unit import with a validating preview, and the attaché
assignment as toggles.

⚖️ **Two constraints exist purely to protect the apportionment.** A unit label is
unique within its property — a second "Flat 2" makes every invoice for it
ambiguous and doubles that property's share. And an apportionment factor must be
positive: a zero-weighted unit pays nothing while still consuming, and the
shortfall is redistributed across its neighbours **without anyone being told**.
Both are enforced in the database, not the form.

⚖️ **The import is all-or-nothing.** A partly imported block is worse than a
refused one, because a budget apportions across whatever exists — so a silently
missing unit inflates every other unit's share. The preview shows each row's
resulting **percentage**, not just its factor: an apportionment mistake is
invisible as a number and obvious as a share.

⚖️ **Retiring refuses while obligations remain**, and names what is in the way —
a property with live units, a unit with an occupant or an unpaid charge. Hard
deletes are blocked outright: a deleted property orphans its assets, budgets,
invoices and the ledger entries derived from them.

🔎 `verify-properties.mjs` — 17 checks. The one worth keeping: attaching an FM to
a property makes it visible to them and detaching removes it again, asserted
against live sessions. **The attaché assignment is the access, not a label.**
Access-matrix, permissions, asset, viewer, collections, remittance and ledger
suites all still green after the policy rewrite.

## 2026-07-28 · Code review of the property register — two live faults

⚠️ **`block_hard_delete()` is SHARED, and 0056 redefined it.** 0010 declared it
with `if auth.uid() is not null then raise` — a soft-delete rule for people, with
the service role deliberately exempt so seeds and verification scripts can clean
up. 0056 re-declared the same name with an unconditional raise in order to attach
it to properties and units. `create or replace` does not add a second function:
it replaced the one 0010's `service_charges` trigger and 0016's `assets` trigger
already pointed at. Confirmed live — a service-role delete of an asset came back
*"Records here are retired, never deleted"*.

⚖️ **A shared trigger function is an interface.** Redefining one to suit a new
caller changes every existing caller, and nothing in the new migration says so.
Restored in `0057`, and `verify-properties` now asserts it from the properties
suite — because the damage was invisible from the feature that caused it.

⚠️ **A unit could be attached to ANOTHER ORGANISATION'S property.** `units_write`
checks `org_id = current_user_org_id()`, and the row's own org_id was always
correct — but `property_id` was never checked against it. Confirmed live: the POC
org placed a unit on TFML's "Adeola Odeku Complex". Beyond the isolation breach
it was a denial of service on the neighbour, since `units_property_label_uidx`
is keyed on (property_id, label) with no org component.

⚖️ **Fixed relationally, not in a policy.** A composite foreign key on
`(property_id, org_id) → properties(id, org_id)` makes the invariant structural:
it cannot be forgotten by the next policy author, and it holds for the service
role too, which an RLS check never would. `assets` had the same gap unexploited
and got the same constraint.

⚖️ **Occupancy and pricing are different powers.** `units_write` admits EITHER
`properties.write` or `units.assign_occupant`, and the general save rewrote label
and apportionment factor every time — so a role granted only occupancy could
restate what every unit in a property pays. Now a separate `assignUnitOccupant`
that touches one column. The general save also no longer writes `property_id` on
an update: doing so let a unit be re-parented, silently shrinking the original
property's apportionment base.

⚠️ **Row numbers in both importers pointed at the wrong line.** `parseCsv` strips
blank and `#` rows, so a loop index is an index into the FILTERED array, not the
user's file — off by one for the shipped template alone. Added `parseCsvLines`,
which carries the source line, and switched both importers. **An importer that
says "row 4 is wrong" about row 6 is worse than one that says nothing.**

⚠️ `unitImportContext` returned `ok()` on a failed read, so a short members query
made every valid occupant email report as unknown — and made the caller's
`if (!ctxResult.ok)` unreachable. **A validation context built from a partial
read validates nothing.**

⚖️ The portfolio list counted units in JavaScript over an unbounded fetch, which
past PostgREST's 1000-row cap would have **understated** occupancy rather than
failing. Now a `property_summary` view with `security_invoker`, so the caller's
RLS still decides what is counted.

📌 Of twelve findings, ten were real and fixed. Two were not: the
`auth.uid() is not null` service-role exemption is the established pattern here
and is safe because these functions are granted to `authenticated` and
`service_role` but never `anon`; and the retire functions' org check is
belt-and-braces behind that same grant.

## 2026-07-28 · Second review pass — the fix that was worse than the bug

⚠️ **`property_summary` multiplied every count.** 0058 left-joined BOTH `units`
AND `assets` to `properties` in one grouped query — a cartesian product per
property. Measured live before the fix: Lekki Gardens Estate reported **30 units
where there are 6**, with the apportionment factor five times too large; Ikoyi
Heights reported 8 where there are 4.

⚖️ The JavaScript it replaced was **correct**. It carried a scaling risk — silent
truncation past PostgREST's 1000-row cap — and I traded that for a value that was
wrong at any size. **Fixing a scaling risk by introducing a correctness bug is
not a fix.** Scalar subqueries now, so no table can multiply another.

⚖️ **A fan-out hides in small data.** It was invisible for six of eight
properties, because it only appears once a property has two of the *second*
thing. The regression test therefore asserts specifically against properties
that have units AND 2+ assets, rather than against whatever happens to be there.

⚠️ **The occupancy/pricing split only covered UPDATE.** `units_insert` still
admitted `units.assign_occupant`, so a role granted only occupancy could CREATE
units with any apportionment factor and dilute every existing unit's share.
Creating a unit is portfolio management; occupancy changes one column on a unit
that already exists. Split properly in `0059`.

⚠️ **Two functions named `assignUnitOccupant`.** The older one, on the People
page, wrote `occupant_user_id` with no role check — so the "an occupant must be
a tenant" rule was never an invariant and the two screens disagreed about what
was legal. One implementation now, with the caller importing it directly: a
`"use server"` file cannot re-export, which the build caught and `tsc` did not.

⚠️ **0057 would have aborted on a fresh environment.** It deleted mismatched
rows before adding the composite FK — but a unit that has ever been invoiced is
referenced by `service_charges`, so the delete fails and rolls back the whole
migration, including the `block_hard_delete()` restoration above it. Now it
REPAIRS instead: the property is authoritative about which org a row belongs to.

⚠️ `parseCsvLines` counted RECORDS, not physical lines — so a quoted field
containing a newline reintroduced exactly the drift the helper existed to
remove. It now tracks real line numbers through quoted newlines. The bank
statement importer was the third one still on the old arithmetic.

⚠️ `assignUnitOccupant` had no `.select()`, so an UPDATE matching zero rows —
missing capability, retired unit — returned success and the UI silently snapped
back on refresh. **A write that cannot fail is not the same as a write that
succeeded.**

📌 Eight findings this pass, all eight real. The most serious was mine, and it
was introduced *while fixing* the previous review.

## 2026-07-29 · Baseline audit from PC2 — the threshold was not a control

PC2 shared a read-only build audit (`docs/BUILD_AUDIT_BASELINE.md`) against
`0cc4d32`, plus `REVIEW.md` setting re-review convergence rules. Five findings,
all checked against the current tree rather than taken on trust.

⚠️ **S-1 — the approval threshold was enforced only in the server action.**
Every other stage of the B4 gate is re-checked in the database and therefore
holds against a direct API call; the amount threshold was the exception.
Confirmed exploitable before fixing: a finance approver PATCHed a **₦5,000,000**
payment — five times the org's ₦1,000,000 limit — straight to `approved` with
their own JWT, and the same role may then remit it.

⚖️ That is the segregation-of-duties control on the LARGEST disbursements,
defeated by one hand-crafted call. Now in `enforce_payment_transition()` (0060),
with a null threshold falling back to the same ₦1,000,000 the application
assumes — **"not configured" must never read as "no limit"**, and the two layers
must not disagree about what is unlimited.

⚠️ **E-1 — the executive dashboard aggregated whole tables in JavaScript.** Past
PostgREST's 1000-row cap it truncated silently, so collection rate, outstanding
and vendor liabilities **undercounted rather than errored**. An executive reading
a collection rate cannot tell a truncated figure from a true one. Moved into
`security_invoker` views (0061) — deliberately several small ones, not one
joined view, having just been bitten by exactly that fan-out in
`property_summary`. Cross-checked against the raw sums it replaced.

⚖️ **E-2 — a stated limit is honest; a silent one is not.** The request list was
unbounded and hit the same ceiling, dropping older requests with nothing on
screen to say so. Now 200 with the true total shown beside it.

📌 **S-2 had already been fixed** by `0057`'s composite foreign key, before the
audit reached us — the audit was against an older HEAD. Recorded rather than
re-fixed, which is what `REVIEW.md` asks for.

⚖️ **D-1 became a test rather than a runbook note.** The read-leak fix depends on
`0055` being applied; an environment stopped at `0054` reintroduces it silently.
`scripts/verify-deployment-safety.mjs` now asserts the invariants **no single
migration owns** — no `FOR ALL` on matrix-governed tables, RLS on every
org-scoped table, the threshold present in the trigger, the composite org FKs,
`block_hard_delete()`'s service-role exemption, no fan-out in the aggregate
views, and no client policy on `channel_routes`. **A deployment note asks
someone to remember; a check does not.**

## 2026-07-29 · Day 7 — tenant application and KYC intake

🟢 Public, brand-aware application at `/tenancy/<org>`, individual and corporate,
mobile-first, save-and-resume without an account, document upload, NDPA consent
captured verbatim. `0062`–`0063`.

⚖️ **Special-category data lives in a different column, not a filtered field.**
Religion and marital status are on OEA's paper form; under NDPA they need a
stricter basis than "the form has a box". RLS is row-level and cannot withhold a
column, so the separation is physical: `sensitive` is its own column and
`application_overview` — what every reviewer reads — does not select it. Optional
on the form, and labelled as optional where it is asked.

⚖️ **Consent is stored verbatim, not as a boolean.** "They ticked a box" is not a
record of what someone agreed to. Changing the wording later must not
retroactively alter what a past applicant consented to.

⚖️ **Retention purges the person and keeps the decision.** A rejected applicant's
PII is nulled at 90 days and the row remains as an anonymised stub. Deleting it
outright would destroy the evidence that a decision was properly taken, which is
the opposite of what retention law asks for.

⚖️ **The module gate is independent of the window.** TFML runs facilities and has
no tenancies; with `tenant_applications_open` forced true it still refuses,
because `org_has_module(org, 'lettings')` is a separate condition. This is the
B9 registry the brief promised — HR and DMS join it without new machinery.

⚠️ **An applicant may write but must never read — and that broke the insert.**
The RLS policy was right and raw SQL worked, but `.insert().select()` through
PostgREST failed: **a RETURNING clause is evaluated against the SELECT policy**,
and there deliberately is none. The same shape bit the asset soft-delete earlier
in this build. Rather than add a read policy and lose the property that stops the
table being enumerated, every applicant write now goes through a `SECURITY
DEFINER` function that re-checks the same gate (`0063`), and the anon INSERT
policies were dropped so there is exactly ONE way in — asserted by the suite.

⚠️ `/apply` was already the VENDOR application, so tenancy moved to `/tenancy`.
Worth it beyond the routing conflict: "apply" is ambiguous between supplying
services and renting a home, and the person reading the link is a stranger.

⚠️ Two test defects, both the familiar kind: a check compared `undefined` to
`undefined` and passed while the step under test had actually failed; and a
precondition was assumed rather than set, so a previous crashed run's leftover
state reported as a product failure. **A test that asserts a precondition it did
not establish is testing the last run, not this one.**

📌 R2 is not configured, so documents use a PRIVATE Supabase Storage bucket with
signed upload URLs and per-org path prefixes. The brief allows either ("Cloudflare
R2 (or confirm Supabase Storage)"); flagged rather than substituted silently.

⚠️ **The switch had no switch.** The application window was a column only the
public page read and only the verification script wrote — so opening OEA's
intake meant someone with database access doing it by hand. It looked finished
because every layer worked; nobody could operate it. Added the toggle and public
link under People, mirroring vendor applications, with the module gate
re-checked in the action so a facilities org cannot set a flag that reads "open"
while the public page refuses every application. **A control an operator cannot
reach is not a feature, it is a support ticket.**

⚠️ **And the test was closing it.** The suite set the window closed on cleanup
rather than restoring what it found, so a routine verification run silently took
the live application link offline — which is precisely what happened here, and
looked like a caching bug for a while. It now records the state on entry and puts
it back. **A test may borrow the product's state; it may not decide it.**

⚠️ The public tenancy page was also cached, so even once the window was open the
link kept reading "Applications are closed". Its content depends entirely on live
org state, so it is now `force-dynamic`. The person who notices a stale render
here is a prospective tenant who quietly gives up — a correctness question rather
than a performance one, and one nobody would ever report.

---

## WhatsApp requests that reached nobody

Messages arrived, routed to the right brand, and were answered on the right
number — and did not appear on the requests dashboard.

⚠️ **An optional foreign key used as a security scope silently denies every row
that has not got one yet.** The webhook wrote `sender_id` and `property_id` both
NULL — it has a phone number, not a user, and no property. The select policy
grants a non-`read_all` reader on `property_id in (select
current_user_property_ids())`, and NULL never matches an IN list. So only admin
and finance could see any of them. Measured on live data before the fix: all 13
of TFML's chat requests and all 10 of OEA's had no property, and both brands
happen to have only admin/finance accounts — which is the only reason it looked
like it worked. This is the same shape that hides tenant applications from a
Property Manager (recorded under Day 8).

Two populations, so two fixes. A sender we KNOW resolves to the user and the
property of the unit they occupy, which finally makes B7's "Tenant: own requests"
mean something for someone who wrote in on WhatsApp. Resolution is org-scoped and
refuses ambiguity: two people sharing a number is not a licence to guess which of
them is writing, so an ambiguous match resolves to no match. A sender we do NOT
know stays unresolved and is reached through a new `tickets.triage_unassigned`
capability whose clause can only ever admit rows where `property_id is null` —
it cannot widen access to a request that belongs to a property.

⚠️ **And I made the same mistake I had just written up.** The capability was
granted with a one-off INSERT while `seed_b7_permissions()` — the single
definition of what an org starts with and what a reset returns it to — knew
nothing about it. The grant survived until the next reset, which happened within
the hour: two of my own measurements disagreed, one said a Facility Manager could
see unassigned requests and the other said `granted=false`. Every org created
afterwards would have started without it too. **A rule applied in one place and
not in the source of that rule is worse than no rule, because it looks applied.**

Correcting it settled the default. B7's Facility Manager row reads "Assigned
properties (RT)", an unassigned request is in no assigned property, and locked
decision 7 says silence means OFF. So the capability is named explicitly in the
baseline as `false` — a decision on the record rather than one that fell through
to a default — and an operator turns it on per org. The suite now proves the
toggle moves it AND that a reset puts it back.

📌 Tooling: the Bash tool's sandbox blocks outbound network on this machine while
PowerShell does not, which made a working connection look like an outage for some
time. Network-dependent work runs through PowerShell here.

---

## A regional hierarchy above the property register

The board asked for REGION → PROJECT → LOCATION → SITE above the properties that
already exist, and for decentralised regional administration beneath it.

**One table, not five.** `current_user_property_ids()` is referenced 42 times
across 13 migrations — the property is the security anchor for tickets, assets,
service-charge budgets, tenant applications and the attaché assignment. Five
nested tables would have meant rewriting all of it. A single `org_nodes` table
with a materialised path hangs *above* properties, so the tree is a dimension over
them rather than a replacement, and nothing downstream changed.

Scoping was added by **extending that one resolver**, not by adding a second.
`property_stakeholders` gained a nullable `node_id`, and an assignment is now to a
property OR a node — enforced by a check constraint, because encoding "assigned to
a region" as an *absent* property id would have repeated this week's NULL-as-meaning
mistake for the third time. A manager assigned to a project now reaches properties
added to it afterwards, with no re-assignment; that is the whole point.

### Two trigger mistakes, in sequence, both mine

⚠️ **`UPDATE OF column` fires on the columns NAMED IN THE STATEMENT, not the
columns whose values changed.** The subtree cascade was attached as `after update
of path`, but re-parenting is `update … set parent_id = …`, which never names
`path`. The BEFORE trigger recomputed the moved row's own path correctly and the
cascade to its descendants never ran at all. Not cosmetic: every place-scoped read
matches on the path prefix, so the suite measured a manager assigned to the NEW
parent reaching zero properties while the OLD parent still reached the moved
subtree.

⚠️ **And the fix for it was worse.** I added `WHEN (pg_trigger_depth() = 1)` as a
recursion guard. **For an AFTER trigger the WHEN condition is evaluated
immediately after the row change — inside the main statement, before any trigger
function runs — and it decides whether the event is even queued.** Nothing is
nested inside a trigger at that moment, so depth is 0, the condition is never
true, and the trigger was never queued. The symptom was identical to the original
bug, which is exactly why it was worth instrumenting instead of reasoning: a
`raise notice` as the first line of the function printed nothing, while the audit
trigger on the same table fired normally.

**A WHEN clause runs in a different context from the function body it gates.** Row
values are visible to both; execution state such as trigger depth is not.
Recursion guards belong in the body.

📌 Both were caught by the verification suite on its first run, before anything was
pushed — the re-parenting check existed because moving a node is precisely where a
materialised path stops telling the truth.

---

## Day 7 could never have been submitted

PC2's build audit reported the tenancy submission path blocked end to end. Verified
by running it before touching anything: three `record_application_attachment` calls
returned true, the service role saw three rows, and **the applicant's own session
saw zero**. Every uploaded document read as missing, and the flow answered "Still to
upload: Government-issued ID, Passport photograph, Guarantor's ID" seconds after all
three had uploaded.

⚠️ **A query with no matching RLS policy returns zero rows without erroring.** The
check read `application_attachments` through the applicant's anon session, where
there is deliberately no SELECT policy. Nothing failed loudly; the answer was just
always "nothing there".

⚠️ **Third appearance of one shape: a write-only role cannot read its own row
back.** `0063` fixed exactly this for `tenant_applications` and did not carry the
lesson two tables across to `application_attachments`.

And following it up turned over a second defect the audit had not named:
`submit_tenant_application` is granted to `anon`, so the document check living in
the server action **could simply be posted past**. A completeness rule enforced
beside a transition rather than inside it is not a rule. Moving it into the
function answers both halves at once — a definer function can see the attachments,
and nothing can route around it.

The required list moved into `application_document_requirements` rather than being
duplicated in SQL beside the constant in `lib/application-form.ts`, because two
sources of truth for one rule is the failure this journal keeps recording. It is now
per-org, per-type operator configuration — which also answers the outstanding Day 7
question about which documents are mandatory.

### A token hash worth more than it looks

The audit also found `sensitive` readable through the base table despite
`application_overview` existing to withhold it — correct, because **RLS is
row-level and cannot withhold a column.** Following that up: `resume_application()`,
`save_application_draft()` and `submit_tenant_application()` all take the token
**hash** as their argument, so anyone able to read `resume_token_hash` from the base
table could resume, edit and submit another person's application. Larger than
reading a religion field, same cause, same fix.

📌 **Column privileges cannot be carved out of a table-level grant.** Table-level
SELECT implies every column, and revoking one afterwards does nothing — the grant
has to be replaced with an explicit column list. `application_overview` is a plain
view and reads the base table with its owner's rights, so reviewers kept exactly
the access they had, minus two columns they were never meant to have.

---

## Oversight that authorises but cannot disburse

The board added two roles on 29 July: `executive` — the MD of TFML and the
Managing Partner of OEA, one enum value with a brand-aware label as `facility_manager`
already has — and `regional_manager` for decentralised regional administration.

The governance split the board confirmed: an executive **sees everything finance
sees and co-holds payment approval, including above the threshold, and cannot
execute a remittance.** Nor can they add a bank account, post to the ledger, or
raise the threshold they approve against. Approving against a limit you can lift
yourself is not an approval, and oversight plus disbursement in one pair of hands
removes the separation of duties that makes the audit trail worth anything. All
four are asserted against the live database.

Eighteen SELECT policies gated money and audit visibility by naming roles
directly — locked capabilities have no `role_permissions` rows, so the matrix
never sees them. Rather than retype eighteen predicates into a migration, they
were read from `pg_policies` and rewritten mechanically into `oversight_roles()`:
one definition of who has oversight instead of the same array in eighteen places.
Every extra clause — `actor_id = auth.uid()`, the vendor's own rows, the FM's
scoped vendors — survived byte-identical because it was never retyped.

### I broke the payment gate, and the suite caught it

⚠️ Adding `executive` to `enforce_payment_transition()` meant rewriting it — from
a partial read. Three blocks above the part I had looked at went missing: the
service-role exemption, the no-status-change short circuit, and **the legal
transition state machine**. Without the third, a caller could forge
`service_verified_at` and `performance_validated` and jump straight from
`pending_verification` to `approved`, skipping verification and recommendation
entirely. `verify-payment-gate` reported it on the next run: "finance: forge both
gate flags + approve → ALLOWED".

**`create or replace` on a function is a full rewrite: whatever you do not
restate, you delete.** The journal already records the mirror image of this —
redefining a *shared* function and changing behaviour for callers I had not
considered. This is the same error from the other side: redefining a function from
a partial view and dropping rules I had not seen. Read the whole definition from
the catalogue, not from the migration that happened to introduce the part you were
looking for.

📌 And a second lesson inside the first: when the gate genuinely broke, the suite's
own forge attempt **succeeded**, which moved the only seeded `pending_verification`
payment to `approved` — so the next run found no fixture and reported "run npm run
seed first" instead of "the gate is bypassable". A test that borrows a precondition
it did not establish will eventually report the wrong failure. It now creates its
own probe payment and removes it.

---

## Closing out the audits

Both audit documents re-checked against current code rather than against memory.
Baseline S-1, S-2, E-2 and D-1 were already closed; D7-D1, D7-S1 and D7-S2 were
fixed earlier in the same session. Two findings were genuinely still open.

### D7-E1 — the last figure counted in JavaScript

`0061` moved ticket counts, money totals and vendor scores into the database and
left the budget-utilisation panel behind. It selected every `service_charges` row
carrying a `budget_id` and summed them in the page, under a comment stating it was
"bounded by the number of BUDGETS … not by invoices, so it does not carry the
truncation risk the totals above did."

⚠️ **Being wrong in a comment is worse than being wrong in code.** The query
returned one row per INVOICE. The next reader checks the comment, sees the risk
explicitly dismissed, and moves on. Past PostgREST's 1000-row cap the panel would
have under-reported budget utilisation with nothing on the page to say so — a
finance figure quietly too low, which is worse than one that fails.

Now `bi_budget_utilisation`, `security_invoker`, with the per-budget totals as
scalar subqueries rather than a join — the `property_summary` fan-out that
reported 30 units where six existed is not a mistake worth making twice. Verified
against a hand count of the underlying charges, and that a tenant sees none of it.

### D7-D2 — a link that was promised and never sent

The form told every applicant they could "return using the link we emailed you —
for 30 days". No email was sent, and the page had no way to accept such a link:
the resume token existed only as a prop in the client component. Closing the tab
lost the application, leaving half-filled personal data in the table until it
expired.

Wired properly rather than by correcting the copy: `startApplication` now emails
the link, the page accepts `?resume=<token>` and rehydrates through the existing
`resume_application()` definer function, and the hash/token/link rules live in one
module because they are now used in three places.

Two things the token being in a URL required: the page re-checks `draft.org_id`
against the org in the address, so a valid token cannot be replayed through
another organisation's page; and the `/tenancy/*` route sends
`Referrer-Policy: no-referrer` and `Cache-Control: no-store`, because a query
string reaches Referer headers and a draft application should not sit in a shared
cache.

---

## Intake that can hold a conversation

The board asked for an interactive classifier — a person should be able to correct
a priority the AI got wrong. The gap underneath the request was larger than the
request.

⚠️ **Every inbound message created a new ticket.** There was no conversation state
and nowhere for a follow-up to go, so "it's worse now" opened a second ticket and
`/start` opened one of its own. Worse, the acknowledgement already ended with *"If
the category or priority looks wrong, reply and we'll correct it"* — and replying
opened a third. **A promise the system did not keep**, the same shape as the resume
link that was never emailed. Two of those in one week is a pattern worth naming:
copy that describes behaviour is a specification, and it was being written ahead of
the behaviour.

Three things were needed, and none of them was a cleverer prompt: somewhere for a
follow-up to go (`ticket_messages`), memory of what this sender last said
(`chat_conversations`, expiring), and a guarded way to act on a correction (two
definer RPCs). The router picks one of five intents and cannot act on anything —
every intent is carried out by an RPC that re-checks the sender owns the ticket.

**The guards, not the routing, are what make it safe:**
- only the number that raised a ticket may re-prioritise it
- a reporter cannot overrule a priority an operator has set — their request is
  recorded on the thread instead, so nothing is lost silently
- a self-declared escalation sets `requires_human_review`, so it informs the
  queue rather than driving dispatch on its own
- `urgency_source` distinguishes the AI's assessment from the reporter's, so the
  dashboard shows a self-declared urgency for what it is
- nothing crosses an org boundary, and a closed ticket cannot be reopened by
  replying to it

📌 **The fallback direction matters.** When routing is uncertain or the model call
fails, the message is treated as a NEW REQUEST. A duplicate ticket is visible and
closeable; a message merged into the wrong thread, or dropped, is neither.

Numbered quick replies (1–4) are honoured without a model call — cheaper, faster,
and what someone on a poor connection will actually send.

Verified twice: `verify-conversational-triage` (24 checks) proves the guards
against the database; `verify-triage-conversation-e2e` sends four real messages
through the deployed webhook and the live model, and confirms that a correction and
a status question add no tickets while a genuinely different problem gets its own.

---

## Intake opens per property, and the Day 8 blocker closes with it

The board asked for the application window to follow occupancy. Deriving it with
**no override** would have been the wrong answer even though it is what was asked:
a landlord legitimately wants a waiting list on a full building, and legitimately
wants a property closed while its units sit empty — refurbishment, a dispute, a
handover. So three states rather than a computed boolean — `auto` (open while a
unit is vacant), `open`, `closed` — with the org flag kept as a master switch, and
every override recorded against the person who made it. **Automation should inform
the decision, not remove it.**

The vacancy count sits beside each row on the operator screen, so whoever
overrides it is looking at the same fact the automation used.

### The part that mattered more

Applications carried `property_id = null`, and both the RLS policy and
`application_overview` scope a reviewer without `applications.review_all` to
`property_id in (select current_user_property_ids())` — which NULL never
satisfies. Property-scoped review, **the entire premise of Day 8**, returned
nothing.

An applicant now arrives through a *property's* link, so `property_id` is a fact
about how they applied rather than something they typed. That distinction is the
whole reason this is safe: which link someone used is sound to scope access to
their identity documents by; a free-text "unit preference" they asserted is not.

The old 7-argument `start_tenant_application` was **dropped**, not left beside the
new one. Leaving it would have preserved a way in that produces exactly the
property-less applications this change exists to end, and "one way in" is the rule
`0063` established for this table.

⚠️ **My own suite passed for the wrong reason first.** Check G attached
`finance.oea@oegroup.test` to the property and confirmed it could read the
application — but `finance_approver` *holds* `applications.review_all`, so it
would have seen every application in the org whether scoping worked or not. It now
creates a `facility_manager`, asserts that role does **not** hold `review_all`,
confirms it sees nothing before the assignment, and only then attaches it. A test
that passes for the wrong reason is worse than no test, because it is believed.

📌 Three other suites broke on the dropped signature, which is the correct
consequence: the compiler cannot see an RPC signature, so the suites are what
catch it. Each now creates its own accepting property rather than depending on the
occupancy of demo data.

---

## The cache that was invisible at every layer I looked at

After the per-property window shipped, the public page reported "Applications are
closed" while the identical query, run directly against the same database seconds
earlier, returned an accepting property. Correct code, freshly deployed, and the
response headers said `x-vercel-cache: MISS`, `age: 0`,
`Cache-Control: private, no-cache, no-store`.

I worked through: a stale deployment, a pinned production alias, the wrong Supabase
project, a dropped RPC, a stray background process flipping the flag. All wrong,
and each took a round trip. What settled it was giving up on inference and having
the deployed page log what it actually saw — which said `master: false` at the same
moment a direct read said `true`.

⚠️ **Next.js patches the global `fetch`, and supabase-js uses `fetch`.** Server-side
reads were being served from Next's DATA cache. That cache is invisible at the CDN
layer, so the response can truthfully say `no-store` and `MISS` while the *data*
inside it is hours old. Both stale reads — the org row and the RPC result — pointed
at the same earlier moment, when the window genuinely had been closed.

📌 **`export const dynamic = "force-dynamic"` does not cover this.** It makes the
ROUTE dynamic, which governs when the page re-renders, not whether the fetches
inside it come from the data cache. Earlier in this build I "fixed" exactly this
symptom by adding `force-dynamic`, and it appeared to work — it did not, it just
re-rendered stale data at a different moment.

Fixed once, centrally: `supabaseAdmin` now passes `cache: "no-store"` on every
request. **A database client must never hand back stale data**; anything that
genuinely wants caching can ask for it at the call site. Proven by closing the
property and reloading (closed immediately), then reopening (open immediately).

📌 And a smaller lesson that cost several rounds: I read `tenant_applications_open`
as `true` while my own verification suites were mid-run, flipping it on and
restoring it. **State read during a test run is not the resting state.**

---

## Audit 0729b — a regional manager who was not regional

⚠️ `0072b` seeded `regional_manager` with `applications.review_all`, three lines
below its own header stating the role has *"Nothing financial, no org-wide read."*
The capability is defined as reading **every** tenant application in the
organisation. **The comment and the code disagreed in the same file, and the
comment was the one that was right.** I wrote both.

Two consequences, the second worse: a manager for one region read every
applicant's identity documents in the brand, and — because
`application_document_requirements` is write-gated on the same capability — could
rewrite what documents *every* property in the org demands.

📌 **Why it survived a verification suite.** `verify-oversight-roles` asserted the
role held no *financial* capability and no `tickets.read_all`. It never asserted
it held no org-wide read of applications. **A guard you did not think to assert is
a guard you do not have.** The replacement asserts the whole shape: it lists all
sixteen organisation-wide capabilities and requires the role to hold none of them,
so the next one added cannot slip through the same gap.

The role loses nothing real. Applications carry `property_id` since `0076`, so a
regional manager reaches their own region's applications through the node subtree.
Scoping does the work the over-grant was doing, correctly.

### A comment that claimed a protection the view did not have

`stakeholder_assignments` was commented *"Definer-free: it reads through the
caller's own policies"* and had no `security_invoker`. It happened to be safe
because its `WHERE` clause repeats the same test — a coincidence one edit away
from being wrong. `property_application_windows` had the same omission and was
**not** safe: a tenant or vendor could read occupancy and vacancy for every
property in the org.

**An inaccurate comment about access control is worse than none**, because the
next person reads it, believes the boundary is handled, and relaxes the clause
that was actually holding.

### A link that outlives the window it was made in

The closed-intake gate ran before the resume branch, so a valid 30-day link
returned "Applications are closed" the moment the last property filled up —
contradicting the email sent minutes earlier. Reordered: **closing intake stops
NEW applications; it must not strand one already in progress.** Someone half way
through a form whose property has since filled still gets to finish, and the suite
proves a new application is still refused at the same moment.

Also from the same review: the 1–4 quick-reply map existed twice (reorder one and
"can wait" becomes critical — the INVITABLE_ROLES shape again), `openThread`
treated a database error as "no open thread" so a transient failure silently
opened a duplicate, and a greeting filed a notification against a ticket id that
was null.

---

## A regional manager who could not invite anyone

Asking one question the code had never been asked — *can a regional manager
actually invite someone?* — turned over three faults at once.

⚠️ **The capability was decorative.** `people.invite` was true for
`regional_manager` in the matrix since `0072b`, while `invitations_insert`
admitted only `admin` and `facility_manager`. The matrix said yes and the table
said no, for a fortnight, with nothing failing loudly.

⚠️ **A facility manager could mint an executive.** The escalation guard read
`(current_user_role() = 'admin' or role <> 'admin')` — it named the one
privileged role that existed the day it was written. `executive` was added later
and walked straight through it: an FM could create the MD who co-approves payments
above the threshold. **A guard that names one role protects against the roles that
existed when it was written.** Replaced with a rank, so a new role needs a number
rather than every guard needing a new exception.

**And an invitation could not carry a region**, so a regional manager could not be
given their region in the same act that created them — two steps, and the second
is the one that gets forgotten.

### Then the fix broke something the old rule allowed

📌 `role_rank(role) < role_rank(current_user_role())` is correct for escalation and
also made `admin → admin` impossible. An organisation with one administrator had
no way to appoint a second. Caught by the suite's own check that an administrator
could issue everything below them.

That is a lockout, and lockouts are exactly the pressure that makes an operator
build a standing super-admin — the thing this system deliberately does not have.
An org that cannot appoint its own second administrator will ask someone with
database access to do it, and that becomes the norm. So: below your own rank,
**plus** an administrator may appoint a peer. Held strict for `executive`, which
is an office rather than a pool — an executive minting executives would let
above-threshold approval be widened from inside.

### Eighteen places that named the FM and not the regional manager

The board's position is that a regional manager supersedes the FM/PM across the
board. The matrix said so; eleven policies, five functions and one view still named
`facility_manager` alone, because they were written before the role existed —
including `payments_update`, `payments_select` and the vendor-application
decisions.

Rewritten mechanically from `pg_policies` and `pg_get_functiondef` rather than
retyped, behind one `fm_roles()` definition. Retyping eighteen predicates by hand
is how the payment state machine went missing in `0072b`; the same discipline that
caught it applies to avoiding it.

---

## What OE Group may do inside a brand

The board asked whether the operator should be able to add and remove
administrators — a super-admin. The answer built here is **no standing power to
grant, yes to two narrower things**, because the audit trail depends on it: if OE
Group could quietly add an administrator to OEA, then "OEA's finance approver
approved this payment" stops being a claim anyone can rely on.

The asymmetry across all three functions: **the operator may take privilege away
and may never grant it to a person.**

- **Provisioning** creates a new org and an *invitation* for its first
  administrator — never an account. The operator opens a door and does not walk
  through it.
- **Suspend-only** freezes a compromised account. It cannot approve a payment,
  read a tenant's documents, or put a friendly name on a roster. Un-suspending is
  limited to suspensions the operator itself applied; anything else is the brand's
  to reverse.
- **Break-glass** issues a 24-hour administrator invitation when an org has locked
  itself out — recorded in *both* audit logs, in an `operator_actions` table the
  target org can read, and announced to every administrator and executive still
  standing. Silent operator access is what auditors object to; operator access as
  such is not.

Plus **last-admin protection**, because the lockout break-glass exists to cure
should mostly never happen.

### Three runtime faults, all the same species

⚠️ `0079` applied cleanly and every function raised on first call. **A PL/pgSQL
body is not checked against the schema until it executes** — the trap `0029`,
`0032`, `0033` and `0054` already recorded. A migration applying is not evidence
that anything in it works.

⚠️ And one was a repeat with my name on it: I wrote `metadata` into `audit_log`
by copying the pattern from `0050` — the migration `0054` exists specifically to
fix, and whose header says so in its first three lines. **A migration file records
what was intended once; the catalogue records what is true now.** Second time in
two days: `0072b` dropped the payment state machine the same way.

### A fixture that could not be removed

📌 The suite provisioned real orgs, and **a provisioned org can never be deleted**
— it has audit rows immediately, `audit_log` is append-only by design, and its
foreign key holds the org in place. That is correct behaviour: you cannot erase
the record that an organisation did something.

The consequence was not tidiness. Three leftover OEA-branded orgs meant
`orgs.find(o => o.delivery_brand === "OEA")` — which most suites use — began
resolving to one of *them*, and two unrelated suites failed with what read as
product faults ("OEA does not have lettings"). **`delivery_brand` is not a unique
key and was being used as one.**

Fixed three ways: `orgs` gained the soft delete every other entity already had, so
a retired org can exist without being picked; every suite now filters
`deleted_at is null`; and the provisioning check runs inside a transaction that
rolls back. **A fixture you cannot remove is not a fixture.**

---

## Audit 0729c — the fix that re-opened the boundary

Both HIGH findings were introduced by `0078c/d`, the work written to *close* the
regional-manager over-grant. Verified against the live catalogue before touching
anything, and one was worse than reported.

⚠️ **S1 — I scoped the field I had just added, and not the three beside it.**
`0078c`'s own header explains why `node_id` needed a check: an invitation IS the
grant, so handing out a region you do not hold plants a manager where you have no
authority. Every word applies equally to `property_ids`, `unit_id` and
`vendor_id`, which have been on `invitations` since `0020` and which
`accept_invitation` applies unconditionally. None was checked.

The consequence is precise: assigning an existing user to a property needs
`hierarchy.write`, which only an administrator holds. *Inviting* one reaches the
identical `property_stakeholders` row needing only `people.invite`. A regional
manager for the North could plant a facility manager on a Southern property
without ever holding the capability that governs exactly that.

**I reasoned about the field I was adding rather than the statement I was
writing.** A policy governs an INSERT, and an INSERT carries every column.

📌 And the suite could not have caught it — `tryInvite` only ever set `node_id`.
**A test that exercises the field you were thinking about confirms the thought,
not the boundary.** It now takes any scope column, and checks a foreign property,
a mixed array, and a tenant's unit.

⚠️ **S2 — a definer function with no caller check, and worse than reported.**
`apply_invitation_node` had no check on who was calling, which invitation they
meant, or whether it had been accepted. The audit said it was granted to
`authenticated`; the live privilege check found it reachable by **anon** too,
despite the `revoke ... from public` sitting beside its grant.

It was also never called, so the node-on-invite feature has never worked: an
invitation carrying a region silently dropped it. Dropped the function rather
than gating it, and moved the work inside `accept_invitation`, which already
applies the other three attachments under a token the caller had to hold. **A
second entry point to the same effect is a second thing to get right.**

---

## Day 8 — two-tier human review, and only human review

Locked decisions 2 and 10: a PM/FM recommends, an approver decides independently,
and nothing decides itself. Individual applications need one approver; corporate
need two, and they must be two different people. The maker-checker separation is
the same one already enforced on money — the recommender may never also approve.

The full decision trail lives in `application_decisions` (mirroring
`ticket_messages`): every recommend, request-info, approve and reject is one row,
who did it, and a reason of at least ten characters — enforced twice, once as a
friendly `raise exception` and once as the table's own CHECK, because a caller
should get a message before it gets a constraint violation.

**Unit assignment moved into review, deliberately.** The public form only
captures a property — most prospects do not know a unit number — so a reviewer
assigns the specific vacant unit while reviewing, and the completing approval
requires one. You cannot finish a tenancy decision without knowing which unit it
is for.

**The completing approval issues a real invitation**, through the same
`accept_invitation` hardened in audit 0729c — so an approved applicant becomes a
tenant occupying exactly the unit assigned, by the identical path every other
person in this system is onboarded, rather than a second bespoke mechanism.

### Three defects the suite found before anything shipped

⚠️ **A CASE expression of string literals does not auto-cast to an enum inside an
INSERT.** `(case when p_approve then 'recommend_approve' else 'recommend_reject'
end)` resolves to `text`; only a bare literal gets Postgres's implicit enum cast.
Every recommendation failed on the suite's first run, which meant nothing
downstream of a recommendation could be exercised either — one silent type
mismatch masqueraded as four failing checks.

⚠️ **The invite token cannot be generated inside the function that creates the
invitation.** My first draft called `gen_random_bytes`/`digest` inside Postgres —
but only the caller can ever hold the raw token to email it, so a function that
generates its own hash is a function nobody can send the link for. Fixed by
taking `p_invite_token_hash` as a parameter, generated in TypeScript the same way
`inviteMember` already does with `lib/invitation.ts`, and returning the
invitation id only when an approval actually completes the application.

⚠️ **An applicant asked to fix a document could not upload one.**
`record_application_attachment` matched only `status = 'draft'`; an info request
reopens an application through `status = 'info_requested'` on a fresh token —
exactly the state an applicant is in for the single most likely reason a
reviewer sends one back. It would have surfaced as a silent failure on someone's
phone, not a message anyone could act on. Widened the same way
`submit_tenant_application` already was for the same status.

35 checks: property scoping on both recommend and unit-assignment; a reason under
ten characters refused; the recommender refused when trying to approve OR reject
their own recommendation; approval refused with no unit; individual approval
completing immediately and corporate requiring two distinct approvers (the same
one twice is refused); the resulting invitation accepted and the unit correctly
occupied, then no longer assignable; rejection setting a 90-day purge date while
approval sets none; an info request minting a fresh token, the applicant
resubmitting with new documents, and the stale recommendation clearing rather
than carrying forward; the queue reporting approval progress without a join,
scoped to the caller's own reach.

Schema and functions committed; the review queue and detail UI follow.

---

## Audit 0729d — org retirement had no door of its own

`0080` added `orgs.deleted_at` to close a fixture-cleanup problem and rode it on
`orgs_admin_update` — the pre-existing policy that grants a brand's own admin
UPDATE on every column of their own org row, written for theming. Two faults from
one omission, found and confirmed live before touching anything:

⚠️ **The wrong actor could do it.** Any brand admin could set or clear their own
org's `deleted_at` by a direct PATCH — no reason, no operator involvement, none of
the double-audit-log / `operator_actions` / `notify_role` machinery every other
operator crossing in `0079` gets. The only trace was a generic `org.updated` row
indistinguishable from a theme-colour change.

⚠️ **The right actor could not.** `orgs_admin_update` requires
`id = current_user_org_id()`, so an *operator* admin — whose own org is the
operator's, not the target's — could never retire another org through it at all.
Org retirement was reachable only via direct database access for its intended
purpose, while reachable by the wrong actor through the ordinary app path.

Fixed the way every other operator crossing already is: `retire_org()` /
`unretire_org()`, operator-only, reasoned, recorded on both sides, announcing to
the target org's remaining admins and executives.

### Two more of my own mistakes, in sequence, both caught by the suite

⚠️ My first attempt used a trigger keyed on `auth.uid() is not null`. **`SECURITY
DEFINER` changes which ROLE Postgres checks privileges as — it does not touch
`auth.uid()`**, which reflects the calling session's JWT regardless. The trigger
fired inside `retire_org` too and blocked its own write, raising the exact message
meant for a direct PATCH.

⚠️ The second attempt replaced it with `REVOKE UPDATE (deleted_at) ... FROM
authenticated`. Confirmed live with `has_column_privilege` that it did nothing:
**a column-level REVOKE cannot override a table-level GRANT**, and `authenticated`
held Supabase's default blanket table `UPDATE` on `orgs`. The direct-PATCH test
still succeeded. Fixed with the pattern already used for
`tenant_applications.sensitive` — revoke the table-level grant entirely, then
grant `UPDATE` on an explicit column allowlist. Every real write path in the app
was traced by hand afterward against that allowlist rather than assumed correct.

While rebuilding the allowlist, `is_platform_operator` — the single flag that
grants the one deliberate crossing of org isolation in this system — turned out to
have **no protection at all**, closed in the same migration rather than filed
separately for the same root cause.

📌 And the suite's own first draft was structurally wrong in a way worth naming:
its writes went through PostgREST while its assertions read from an unrelated
`pg.Client` transaction that had witnessed none of them — borrowed from the
provisioning test, where a rollback is necessary because provisioning is
irreversible. Retirement is fully reversible through `unretire_org`; it needed
plain calls and real cleanup, the same shape as every other section in that file,
not the one section's pattern applied where it didn't fit.

Also closed: `0729d-L1`, a vendor_id scoping case the 0729c-S1 fix implemented
correctly but never exercised.

---

## Day 8 UI — the queue, and the decision in front of the evidence

The tenancy page stops reporting a number and starts listing people: applicant,
property, type, and mid-review the live approval progress and standing
recommendation, oldest first, each opening a detail page.

That page puts the whole application in one column — applicant, documents, every
non-sensitive form section, and the review history — with the decision panel
underneath it rather than beside it. A reviewer reads before deciding because
that is the order the page is in. `application_overview` never selects
`sensitive`, so special-category data does not reach a reviewer's screen at all.

**Every disabled state mirrors a rule the database will enforce anyway.**
Approve is greyed while a required document is outstanding; the approve/reject
pair is replaced by a sentence when the viewer is the recommender; the reason box
refuses under ten characters before any call is made. None of that is the
boundary — `0082` re-checks all of it — it is the difference between a button
that fails and a button that explains.

**Attachments open through a signed URL minted on click**, valid five minutes. A
link sitting in the page for the length of a review is a link that outlives the
review.

🔎 Verified in the browser against a real applicant's live submission, not a
fixture: the queue rendered both waiting applications with their properties; the
detail page rendered all seven form sections, three uploaded documents and the
applicant's contact details; a recommendation fired the real RPC, moved the
application to `under_review`, and came back as `0 of 1 approval · recommended
approve` with the reason stored verbatim under the reviewer's name — and the
same reviewer was then correctly refused the approval, told in words why a
second, independent person must make it.

⚖️ Unchanged and worth restating: nothing on this page scores, ranks or
recommends an outcome on its own. The recommendation shown is a person's, with
that person's name on it.

---

## Day 8.75 — the regional structure, made visible

`0066` built the board's REGION → PROJECT → LOCATION → SITE. `0067` extended the
one resolver so a manager assigned to a node reaches everything beneath it.
`0078c` and `0081` carried a node through an invitation and applied it on
acceptance. Twenty-four checks proved all of it.

**And not one line of it had a screen.** No way to create a region, file a
property under a site, or assign a regional manager to one — every property in
the system was unfiled, and the structure the board asked for on 29 July existed
only for people with database access. The security model was complete and the
feature did not exist.

Shipped the tree screen (create, rename, retire, assign managers at any level),
a cascading picker shared by the property form and the invite dialog, and the
property list's own place column.

⚖️ **A regional manager is scoped to a node, not a property list** — so their
picker stops wherever they administer rather than forcing a depth the assignment
does not need. A property's picker does the opposite: only a complete
Region→Site chain produces a value, because `0066`'s trigger refuses anything
filed above a site and a half-made selection should not submit as one either.
One component, two shapes, because the two questions genuinely differ.

⚖️ `retire_org_node` refuses while a live child or property depends on the node.
Retiring a project whose location is still live would not touch that location's
own `deleted_at`, but every read starts from the tree and filters
`deleted_at is null` — so the location would vanish from the top down while
still existing. The same silent-orphan shape `retire_property` already guards.

---

## Day 8.8 — every organisation gets a front door, without publishing the list

The ask: replace the single anonymous login box with a home screen of
organisation icons, each opening that org's own sign-in.

⚠️ **Half of that ask is a B1 violation, and B1 is not a style rule.** *"A user
on one portal must never see the other brand's data OR EXISTENCE."* A public
grid publishes the entire client list — both brands, the service-charge client,
and every landlord org onboarded later — to anyone who loads the page,
competitors included. The single login box is the reason that list is not public
today.

So the ask was split at the line where it stops being safe. **A link someone was
handed is not an enumeration; a directory is.** Every org gets `/o/<slug>` with
its own branding, resolved by a function that takes a slug and returns at most
one row and cannot be made to list — wildcards and quotes match literally, and
an unknown slug answers exactly as a retired org does. The grid lives behind the
operator sign-in, gated inside the query rather than in front of it, so a brand
administrator receives an empty set rather than a refusal: **a refusal confirms
there is something worth refusing.**

⚖️ The default is this way round because the two directions are not
symmetrical. Making the grid public later is a one-line change. Un-publishing a
client list that has been indexed is not a change at all.

⚠️ **The slug backfill keyed on `delivery_brand` and collided on first run.**
There are two OEA orgs — the live one and a retired test fixture — and both
claimed `oea`. `delivery_brand` says which brand *delivers the work*; it has
never said which organisation this *is*, and nothing ever made it unique. The
name identifies an org, so the name is what the slug derives from. The
uniqueness index was also scoped to live orgs in the same fix: a retired
organisation holding an address hostage forever would mean a name could never be
reissued.

📌 Worth keeping: the enumeration checks in the suite are the ones that matter,
and they are cheap — passing `%`, `_`, `*` and `' or '1'='1` as slugs and
asserting zero rows. The lookup was never going to be a `LIKE`, but the test
costs four lines and would catch the day someone "improves" it into one.

---

## Day 8.5 — AI may verify documents; it may never screen

Locked decision 10, built as schema rather than as policy. There is **no score
column and no recommendation column** on `application_document_findings` — not
nullable, not unused, absent. A column that exists gets populated eventually,
and a number attached to an applicant becomes a ranking whatever it is called.
`attachment_id` is NOT NULL, so a finding is always an observation about a
specific document; a finding about "the applicant" is exactly the thing decision
10 forbids. Severity is `info | attention` and a third value is where an
observation becomes a conclusion.

⚖️ **Findings outside the permitted kinds and severities are dropped, not
coerced.** A model returning `"severity":"reject"` must not have that quietly
rounded to `attention` — the finding would then read as an observation while
carrying a verdict. Dropping loses information; coercing launders a conclusion.

⚖️ Special-category data is not a *parameter* of any function in the
verification module. Not "we remember not to pass it" — there is nowhere to put
it. Duplicate detection compares hashes computed locally and the finding names
no other applicant: a fraud control that reveals whose other application it was
is a privacy breach wearing a fraud control's clothes.

⚠️ **The composite foreign keys did not say what I assumed they said.** One
proves the application is in this org, the other proves the attachment is in
this org, and neither says the two belong to *each other* — a finding on
application A could cite application B's identity document. Found by the suite,
closed by a trigger in `0086b`. Both rows being in the same organisation was
never the property that mattered.

⚠️ **And the suite's own first draft printed ALL CHECKS PASSED while four of its
seven sections had silently SKIPPED.** It reached for whatever application
happened to be in the database and gave up when the one it found had no
attachment. A suite that reports success for checks it never executed is worse
than no suite, because it is trusted. It builds its own fixtures now.

---

## The region order was backwards, and my fixtures were in the user's dropdown

Two faults found from one screenshot of a live property form.

⚠️ **17 test fixtures were in a production dropdown.** `PROBE-Region2-*` where
Nigeria's regions should have been, in the org the team actually works in. Two
distinct causes, and fixing either alone would have left it happening:

1. Cleanup deleted in **reverse creation order**, which stops respecting the
   tree the moment anything is re-parented — the suite re-parents a node under a
   region created after it, so the parent was deleted first and the foreign key
   refused. The errors were never checked.
2. **Cleanup did not run at all when the suite threw.** A failed assertion
   leaving a variable undefined kills the script before its cleanup block. This
   is the fault that did the damage, and no amount of care *inside* that block
   addresses it — the block never executes.

Fixed with deepest-path-first deletion, an asserted result, and a **start-of-run
sweep**: a crashed run is repaired by the next one rather than accumulating
until someone sees it in production. The sweep immediately cleared 3 stragglers
on its first run, which is the proof it was needed.

⚖️ **REGION → LOCATION → PROJECT → SITE**, amending the 29 July board order,
which put PROJECT above LOCATION. The board's own description of the structure
is geographic — Kano, Sokoto and Abuja in the North; Port Harcourt, Enugu and
Yenagoa in the East — and under the minuted order you cannot record "Kano" until
you have invented a project to put it in. **A project happens in a place; a
place does not happen in a project.** "Kano Housing Scheme" is a project in
Kano; Kano is not inside a scheme. `0066` anticipated this exactly, writing the
ordering as an explicit function *"rather than relying on the enum's declaration
order"* — this is that considered change. Existing nodes were re-levelled, never
deleted, because a node's id is in the path of everything beneath it.

⚠️ **And the picker was a dead end.** Reported from the live screen: *"the other
fields cannot be selected even after picking the set default regions."* A
manager adding the first property in a new city picked a Region, found Location
empty and disabled, and had no route forward except abandoning the form. The
levels now offer inline creation for anyone holding `hierarchy.write`, each
select says what it is waiting for rather than showing a bare dash, and 25
Nigerian cities are seeded across the three regions — for every live org,
including the POC org that `0066` skipped as "a demo fixture" and which turned
out to be the one in daily use.

---

## Day 8.9 — the surfaces a client actually sees

A display type scale, a brand-tinted hero wash, and short entrance motion,
applied to the three public entry points: the operator launcher, the per-org
sign-in, and the tenancy application.

⚖️ **Large type needs its own tracking and leading.** Tailwind's defaults are
tuned for body copy; at 40px the same spacing reads loose and unfinished. The
`display-*` classes use a fluid `clamp()` so a heading is 48px on a laptop and
24px on a phone without a breakpoint, and tighten letter-spacing as size grows.

⚖️ **Motion honours `prefers-reduced-motion`.** It is decoration on these
screens and carries no meaning — nothing is communicated only by movement — so
switching it off costs the user nothing, which is exactly the test for whether
it may be switched off.

⚖️ **The tenancy page's reassurances became three promises instead of one grey
paragraph.** Read by a person, used only for this application, deleted after 90
days. A wall of small muted text is not read, and each of those sentences is
load-bearing for somebody about to upload their identity document.

### The same leak, in a different table

⚠️ A property named **`PROBEREV-A-BPYT0` was on the public tenancy page**,
offered to prospective tenants as somewhere they could live, alongside Banana
Island Residences.

`verify-application-review`'s cleanup block is correct and thorough. It had
never run. An earlier failure threw first, and everything below it — including
every line that deletes a fixture — was simply never reached.

📌 This is the identical fault that put `PROBE-Region2-*` in a live Region
dropdown two days ago, and I fixed it there without asking where else it
applied. **End-of-run cleanup cannot repair end-of-run cleanup.** The repair has
to happen at the start of the next run, which is the only moment guaranteed to
be reached, and it now does for hierarchy nodes, properties and applications
alike. 26 stray properties were cleared on the first sweep; all six real
properties and every live application were untouched.

---

## Day 8.9 — the surfaces a client actually sees

⚠️ **A B1 violation had been sitting in static copy the whole time.** The
sign-in footer was hardcoded `© OE Group · TFML & Ora Egbunike & Associates`
and rendered on *every* door — so a TFML employee signing in at their own
branded address read the other brand's name. That is precisely what B1 forbids:
"must never see the other brand's data **or existence**." It sat three lines
below a comment asserting that this component "never learns that any other
organisation exists."

⚖️ The lesson is where it was, not what it was. Org isolation is enforced at
four layers and every one of them held. The leak was in a string a designer
would call copy and a reviewer would skim — **the one place in the system where
nothing is enforced.** Policies and RLS cannot protect a hardcoded sentence.
Worth grepping the rest of the client-facing copy for the same shape.

🟢 Public links carry a readable handle: `/tenancy/oea` rather than
`/tenancy/98638544-8e25-44ab-9a20-7f1aac3a1534`. Ids still resolve, permanently
— links already sent are in inboxes and on printed sheets, and breaking them to
tidy a URL would strand applicants who did nothing wrong.

⚠️ **Every input was 14px.** Mobile Safari zooms whenever a focused input is
below 16px, so on a phone each tap jerked the layout and the applicant pinched
back out before finding the next field. On a fourteen-section tenancy form that
is not cosmetic — it is the reason someone abandons it halfway. The whole
product inherited this, because it lives in the shared `Input`.

⚠️ **And two bugs in the autofill map, found by checking it against the real
field keys rather than reading it back.** The third-party opt-out said
`previous_landlord` where the schema says `former_landlord`, and missed
`current_landlord` entirely — so both landlords' phone fields fell through to
the `type === "tel"` fallback and offered to fill the *applicant's* number into
a reference. **A silently wrong phone number on a reference is worse than a
blank one**: nobody notices, and a reviewer rings a stranger to check a tenancy.

📌 The check that caught it was five lines — enumerate every key in
`application-form.ts`, run the function over each, assert no third-party field
gets anything but `off`. Reading the regex back would never have found it,
because the regex looks right. It only looks wrong beside the data.

---

## Day 9 — leases, rent, and the landlord's share

⚖️ **Rent in Nigeria is paid annually, in advance** — one or two years up front
is ordinary, and monthly residential rent is the exception. Almost every
off-the-shelf PM system assumes a monthly cycle, and adopting that assumption
would have modelled this market wrongly at the root. `annual` is the default
frequency and the lease form defaults to it, rather than making a letting agent
correct the same field on every tenancy they type.

🟢 Locked decision 14 built: an org-wide default management fee with a
per-landlord override, and the applicable rate **snapshotted onto every charge**
when it is raised. Proven by moving the org rate to 25% and confirming an
existing charge does not budge — the decision exists precisely so a rate change
cannot rewrite a past landlord statement, so that is asserted, not assumed.

⚖️ `raise_rent_charge` is the only write path into `rent_charges`, and there is
no INSERT policy for `authenticated` at all. An administrator able to hand-write
a charge could claim any fee on it, and the landlord statement would faithfully
repeat the figure.

⚖️ A unit cannot be let twice over the same days — a GiST exclusion constraint
rather than a report someone reads later, because a double-let is two families
holding keys to one flat. The suite also proves back-to-back terms still work,
or no unit could ever be re-let.

⚠️ **A suite assertion passed on zero rows.** "None of these rows belong to
anyone else" is trivially true when the caller can see nothing — and the tenant
could see nothing, because `rent_roll` is `security_invoker` and joins
`properties`, which tenants have had no read on since `0056`. The check reported
PASS while the feature was broken.

📌 **This is the second time this shape has hidden a defect in this build.** A
negative assertion is not a test until it also proves the positive: assert rows
exist, THEN assert none are foreign. Fixed with `my_tenancies()`, the
denormalised definer-scoped shape `0003` had already established for tenants —
widening `properties_select` to admit occupants would have granted every tenant
a read on the property register to answer "show me my flat".

⚠️ **And the probe-account sweep was reporting work it had not done.** It counted
successful deletes and discarded the errors, so every account with any history
was skipped silently — 72 probe users were still sitting in the tenant picker
after it claimed to have cleaned up. They cannot be deleted at all:
`audit_log.actor_id` references `users` and the audit trail is append-only, so
an actor can never be erased. Deactivation is the correct answer and the one the
product already uses for a departing member; 66 are now gone from every picker
with their audit history intact.

📌 **Counting successes while discarding errors is how a cleanup reports work it
did not do.** Same fault as the fixture orgs that could not be removed — and
both times the database was right to refuse.

---

## Rent reaches the ledger, and notices reach tenants once

⚠️ **The fee was computed everywhere except where the money is.**
`record_collection` credited the whole receipt to `landlord_payable` for any
rent intent, so a ₦12,000,000 payment made the landlord a creditor for
₦12,000,000 — the ₦1,200,000 management fee included. The rent roll displayed
the correct net all along. The **ledger**, which is what a landlord is actually
paid from, did not.

⚠️ **And three different places claimed to know the fee:**
`payment_settings.management_fee_percent` (0027, used by
`create_landlord_remittance`), `orgs.management_fee_pct` + `landlord_terms`
(decision 14), and the snapshot frozen onto each `rent_charges` row. I created
the third of those in Day 9 without reconciling the first. CLAUDE.md warns that
two mechanisms answering one question is how the ledger-account resolver ended
up applied in half the places it was needed — this was three, and they could
disagree about what a landlord is owed.

⚖️ The snapshot is now authoritative for rent. The fee is taken **once**, at
collection, and `create_rent_remittance` pays out a balance that is already net.
Remitting through the older path would have deducted the fee a second time and
shorted the landlord twice over.

⚖️ Notice idempotency lives in the **database, not the schedule**. A
`(lease, threshold)` row is claimed *before* the email is attempted, so a
retrying scheduler, a manual re-run and two racing deploys all send nothing
extra. Write-then-send is deliberate: a crash between the two leaves `delivered`
false and a row explaining it, which an operator can act on. Silently mailing
someone three times is recoverable by nobody.

⚠️ **Two bugs of the same kind, one migration apart.** I wrote
`'partially_paid'` and `'processing'` (0092c), then `user_id` and `'pending'` on
`remittances` (0092d) — all four plausible, none real. I was writing from memory
instead of reading the DDL.

📌 The first broke **every** collection, not just rent, because the status update
runs on all paths. And Postgres could not warn me: a plpgsql body is not
resolved until it executes, so the migration applied cleanly and the failure sat
waiting for the first payment. **A function body is not type-checked until it
runs — the suite is the only thing standing between that and production.**
Reading the table definition takes ten seconds; guessing cost two rounds.

⚠️ The per-landlord rate field saved on **blur**, with nothing on screen saying
the value would be kept — so someone typing a rate and closing the tab lost it
silently. Replaced with an explicit Save that appears only when there is
something to save. Blur-to-save is a reasonable pattern for a filter; it is the
wrong one for money.

---

## Fixing what was broken: runners, fixtures, and one real defect

Asked to fix everything outstanding, the first job was finding out what was
actually broken rather than trusting my own list. Running all fifty suites
surfaced five problems, and only one of them was where I expected.

⚠️ **Three "broken" suites were fine — I ran them wrongly.**
`verify-asset-import`, `verify-asset-import-e2e` and `verify-reconciliation`
import `.ts` modules whose own imports carry no file extension, which bare
`node` cannot resolve. Their headers say `npx tsx`. Nothing at the point of use
did, so a full sweep with `node` reported three healthy suites as broken.

📌 **A false failure is worse than a missing test**, because it teaches whoever
sees it to discount failures. Fixed with `npm run verify` — one command, one
runner, all fifty-one, per-suite timeouts so a hang reports as a failure instead
of looking like patience.

⚠️ **A real product defect was hiding behind a fixture failure.**
`propertiesByName` is a `Map` keyed on property name, and two properties can
share one — the demo portfolio had two "Lekki Gardens Estate". `new Map()` keeps
the last pair and discards the earlier silently, so a CSV row naming that
property imported assets into whichever happened to come last in an unrelated
query.

⚖️ That is worse than a rejection: nobody sees it, and the assets end up on the
wrong building. An ambiguous name is now refused and names itself. The
collision is only visible in the raw pairs, *before* the Map collapses them,
which is where the check now lives.

⚠️ **Fixtures that could not observe what they asserted.** The org-scoped logins
were created with no property assignments at all, so the manager managed
nothing. `verify-asset-access` failed with "create on managed property refused"
— the policy was correct and the fixture was empty — and `verify-access-matrix`
reported seven scoping failures for a manager with nothing to scope.

📌 Attaching them to **everything** was equally useless. "FM sees 15 payments,
admin sees 15" is then the correct answer, and scoping becomes unobservable. **A
boundary can only be tested where something sits on the far side of it.** The
manager now holds a proper subset, and which property is withheld is *chosen*:
one carrying vendors, so the money boundary has an exclusion to prove — but
holding the fewest assets, so the importer's duplicate-tag fixture stays within
reach. Two suites wanted opposite things from one property; that rule satisfies
both.

⚖️ **Two places still claimed to know the management fee.** `payment_settings`
(read by the older landlord remittance path) and `orgs.management_fee_pct`
(decision 14). An administrator could set 10% on one screen and 7% on the other
and be right both times. `orgs` is now the single source, mirrored into the
legacy column by trigger, and both settings screens read and write the one
number.

⚠️ **And a correction to my own account.** I recorded that the probe sweep had
gone rogue and deactivated eleven real demo accounts, and could not reproduce
it. That was wrong: those eleven were retired **deliberately**, by a separate
script, when the org-scoped credentials replaced the flat pool. I had restored
them on a misdiagnosis; they are retired again, and nothing references them.

📌 The guard I added on the strength of that misdiagnosis stays — not because a
bug was found, but because the blast radius of a wrong pattern there is every
login in the system. What genuinely needed fixing was the reporting: **a cleanup
that prints only a count cannot tell you whether it touched the right rows.** It
now names every address it sweeps.

---

## "TFML Nigeria" retired

⚖️ The portal was named **TFML Nigeria Portal** and sent email as **TFML
Nigeria**. That collides with an unrelated business with no connection to Total
Facilities Management Limited, so it is retired in favour of **TFML Portal**,
sending as **TFML**.

Changed in the two places a client actually sees — `orgs.portal_name` and
`orgs.email_from_name` — and in the code comments, the settings placeholder and
the test fixtures that carried it as an example, so a re-seed or a copied
snippet cannot quietly reintroduce it.

⚠️ `verify-email-routing` asserted the literal string
`"TFML Nigeria" <no-reply@notify.tfmlconsultant.com>`, so a legitimate brand
rename broke a security test. Same fault as the deploy gate that matched error
prose: it now asserts what the From header must be TRUE of — that TFML sends
from its own domain, that neither brand exposes the holding entity, that the two
are distinct — rather than what it happens to say today.

📌 And the requirement itself is now enforced rather than remembered: the suite
fails if any sender identity contains "Nigeria". A naming decision that lives
only in someone's memory is one re-seed away from being undone.

⚠️ Earlier entries in this journal still say "TFML Nigeria". They are left
alone. This is an append-only record of what was true when it was written, and
editing it to match the present would destroy the only account of why the change
happened.

---

## Day 10 — the console, and the fact nobody wrote down

⚠️ **The two headline questions were not slow to answer. They were
unanswerable.** "Average time-to-resolve" and "which vendor completes fastest
this quarter" both need the moment a request was finished, and `tickets`
recorded a status and never a timestamp. A ticket had been `resolved` since some
unknown point, and `created_at` minus nothing is not a duration.

📌 Second time this build has wanted a fact nobody wrote down, and the fix is the
same shape as `payments`: stamp the transition **in a trigger**, so it cannot be
forgotten by a caller who sets the status directly. Set once — a reopened and
reclosed ticket keeps its **original** resolution time, because a reopen is a
fact a report should show, not a faster fix.

⚖️ **And it does not backfill.** Every ticket already sitting at `resolved` has
no honest resolution time. `created_at`, `now()`, or any interpolation would
manufacture durations that look real, get averaged, and end up in a board report
as fact. They stay NULL, every aggregate excludes them explicitly, and the
console says so on screen: *"4 completed requests were closed before this system
began recording resolution times."* An average that means "of what we measured"
is worth more than one that means "of everything, some of which we invented".

⚖️ **The prompt asked for materialised aggregates. It gets live SQL instead.** A
materialised view is computed once, as its owner, and cannot vary by caller — it
would hand every reader the same numbers and quietly undo the scoping this build
spends 42 policy clauses maintaining. Every function here is plain SQL over
`tickets`; **none is `SECURITY DEFINER`**, so an FM/PM sees 17 where an
administrator sees 41, through the identical function, and the function does not
know that rule exists. Speed is worth having. It is not worth buying with the
one property that makes the figures safe to show.

⚠️ **A partial period is not a decline.** Period-over-period first shipped
comparing the newest bucket with the one before it. On 3 August that meant a
three-day-old month against a full July: **−81.3% requests raised, −100%
completed**, both arithmetically correct, both describing the calendar, both in
red on an executive's screen. The comparison now drops the period still in
progress, and the trend marks it *"so far"*. Same class of error as an unmeasured
vendor ranking fastest — a number that is technically true and completely
misleading.

⚠️ **Two averages, two populations.** The console pools per-period figures into a
headline by weighting each average by how many tickets it covered. First-response
and resolution are averaged over **different** sets — a ticket can be
acknowledged and still open — so `0101` returns a count for each. Weighting the
response average by the resolution count would have produced a plausible number,
in a headline tile, wrong by however much acknowledgement outpaces completion.

⚖️ **Three fixtures with no subject.** `executive` and `regional_manager` reached
no BI at all, contrary to B7 v3.3. **No ticket in any org carried an
`assigned_vendor_id`**, so every vendor panel was correctly and uselessly empty.
And no `vendor@` login was attached to a vendor record, so a contractor signed in
to a completely empty application — `verify-bi-scoping` had been printing zeros
across all six tables for the vendor role, indistinguishable from a policy that
denies everything. The policies were right in all three cases. Nothing was on the
other side of them to see.

📌 This is now the third distinct table — nodes, properties, and contractors — to
leak a probe fixture into a live screen. `Perm probe 1785232896727` was sitting
in the analytics console's contractor filter, offered to an administrator as a
real contractor to report on. The cause is new, though: `verify-permissions`
inserts a vendor it **expects to be refused**, so it has no cleanup — and the one
run where that expectation failed left the row nothing would ever delete. **A
fixture whose cleanup is conditional on the assertion passing has no cleanup on
exactly the runs that need it.** Swept at the start of the run, and the insert
now captures its id so a wrong success cleans up after itself.

⚠️ **`vendors.deleted_at` does not exist.** The vendor picker filtered on it, the
query errored, and the error surfaced as an **empty dropdown** — which reads as
"this organisation has no contractors", not as a bug. Fourth time a plausible
column name has been written from memory rather than checked. The picker now logs
its own failure instead of silently emptying itself.

⚖️ **Seeding synthetic timings, deliberately and loudly.** `0099` refuses to
backfill because the moment was never recorded and any value would be a guess
presented as fact. `seed-dispatch-demo.mjs` writes exactly such timings — and the
distinction is *where*, not *whether*: CLAUDE.md B5 defines the POC as synthetic
sample data with no live client data, so there is no real history to
misrepresent. It refuses to run without `--yes`, refuses any org outside a demo
allowlist, and prints that its timings are fabricated. Without it the day's
visible deliverable — "which vendor completes fastest?" — cannot be demonstrated
at all.

---

## Audit 0804 — the race, the gate that could never open, and a settings screen nobody could save

⚠️ **`create_rent_remittance` could pay a landlord twice.** It aggregated the
unremitted charges, inserted a remittance for the total, then marked them
remitted — with no row lock and an unconditional closing UPDATE. Under READ
COMMITTED two overlapping calls both read the same charges as unremitted and both
insert a full-amount payout. A double-click was enough.

📌 What makes it a slip rather than a design choice is that both neighbours in
the same path already do it right: `record_collection` takes `for update` before
posting, and `claim_remittance_for_sending` takes `for update` and gates on
`status = 'queued'` — the exact claim-before-you-send discipline the aggregation
step skipped. The fix takes the lock in a subquery ordered by id (two callers
queue in the same sequence and cannot deadlock), re-checks `remitted_at is null`
in the write, and aborts if it did not claim every row it counted.

🔎 **The suite was made to fail first.** The pre-fix function was restored
temporarily and `verify-remittance-race` reported *"THE SAME RENT WAS REMITTED
TWICE"*, then the fix was reapplied and it passed. Worth doing because one of its
own assertions is a false comfort: "the second call blocked" passes on the BROKEN
code too — B sailed through the unlocked SELECT, inserted its remittance, and
only then blocked on the UPDATE. It blocked; it blocked too late. That check is
now labelled as diagnosis, and the outcome is what decides the suite.

⚖️ **The gate it checked could never open, and it was the wrong gate.**
`has_permission('remittance.execute')` denies everyone permanently —
`remittance.execute` is in no catalogue, no matrix, no seed. That masked the race
by making the function `service_role`-only in practice.

The audit filed it as "needs seeding". It is not being seeded. Locked decision 7
names remittance execution among the controls that are hardwired and **never
appear as toggles**, and `capabilities` already carries `payment.remit` —
*"Execute a transfer to a vendor or landlord"* — as locked, for this exact act. A
grantable `remittance.execute` row would make a non-delegable control delegable
and give one act two names that can disagree. So the function joins its four
siblings instead: `authenticated` revoked, `service_role` only, authorisation in
the calling action — which is what `executeRemittance()` already says in as many
words. The feature is unblocked for a UI; the toggle is not created.

⚖️ **An index that claimed a guarantee it did not provide.**
`rent_charges_remittance_uidx` was `unique (id) where remitted_at is not null` —
`id` is the primary key, so it enforced nothing a plain PK did not, while the
column comment beside it announced "the guard against paying the same month
twice". That combination is worse than no index: a reader auditing the double-pay
concludes it is closed and stops looking. Dropped, replaced with a partial index
that is actually useful for the lookup, and the comment now names the lock.

⚠️ **Settings → Lettings could not be saved by any administrator, since Day 9.**
0083c replaced `orgs`'s table-level UPDATE grant with a column allowlist, and
**Postgres does not extend such a grant to columns added later**. All four
lettings columns arrived unwritable; every admin got "permission denied for table
orgs".

📌 It was invisible because **every suite that touches those columns writes as
`service_role`**, which bypasses column grants entirely. A suite that only ever
uses the service key is testing the database, not the application's access to it.
`verify-lettings-grants` signs in as a real administrator, asserts in both
directions, and fails if any `orgs` column is neither on the allowlist nor on the
deliberately-excluded list — so the next column added has to be classified rather
than silently unwritable.

⚠️ **And that new suite destroyed the OEA organisation on its first run.** To
learn the column names it read `orgs.select("*").limit(1)` — an arbitrary row,
which Postgres returned as the POC's — and then echoed those values onto the
signed-in admin's org. `oeaportal.com` served "OE Group — Foundation POC" with no
OEA branding and no sender identity until it was restored.

📌 Two things saved it, and both are worth naming. The append-only `audit_log`
held the full `before_state`, so the org was restored from what it actually was
rather than from what someone remembered. And `verify-email-routing` failed
loudly on the next run — "OEA sender is null" — because it asserts a brand sends
as itself rather than asserting a string. The lesson for the suite: **a script
that writes must read the row it is going to write.** Learning a schema from one
row and applying it to another is the same error as trusting `delivery_brand` to
identify an org — a lookup that returns *a* row where the code assumes *the* row.

⚖️ **Which is the third instance of that error.** 0085 found it for slugs; the
360dialog migration found it attaching a live WhatsApp key to a retired probe
fixture; `register-telegram-bot.mjs` still had it, and worse — `.maybeSingle()`
with the error discarded, so on two matches it printed *"No organisation with
delivery_brand X"*, announcing that none exists at the moment several do.
`'direct'` is the sharp case and it is live today: the POC, the SC client and the
platform operator all carry it. `scripts/lib/org-lookup.mjs` now refuses and
lists candidates for both registration scripts, and accepts a slug — the only
identifier an org actually has.

📌 Two smaller ones closed in the same pass: the wrong-host dashboard redirect
now **signs the session out** rather than only moving the browser (its sign-in
sibling always did, and two checks disagreeing is how one of them later gets
relaxed); and the two cron routes compare their bearer token with a constant-time
`secretMatches()` instead of `===` — the pattern `lib/webhook-security.ts` was
written to avoid, reintroduced two files from its own reasoning.

---

## Flutterwave, made real — and what "made real" actually required

⚠️ **The gap was never the missing API key.** `FlutterwaveAdapter` has existed
since B3's payment gateway build, complete and correct — but the double-entry
ledger underneath it was **currency-blind**. `ledger_accounts` had no currency
column; exactly one active `client_funds` bank account was permitted per org,
full stop; `canonical_ledger_account()`/`collection_bank_account()` resolved
"the" account for a purpose with `limit 1` and no notion of currency; and
`client_funds_position` — its own comment calls it "the single most important
number in the system" — summed `funds_held`/`funds_owed` across the whole org
with no currency grouping. A USD collection posted through that code as it
stood would either be structurally impossible (no second client-funds account
could exist) or, worse, land in the Naira accounts and silently misstate the
one figure this entire ledger exists to keep honest. "Wire up Flutterwave"
without fixing this first was building a button that corrupts the books the
first time someone clicks it in anger.

📌 What did **not** need to change is worth naming, because it's what made the
fix tractable: `assert_funds_available()` — the trigger enforcing "cannot go
negative" / "cannot overpay a counterparty" — already checks balance **per
account row**, not per purpose aggregated across accounts. A USD `client_funds`
row and an NGN `client_funds` row were already two independent balances as far
as that invariant is concerned. Only the *resolvers* (which account is "the"
one for a purpose) and the *display aggregates* (which sum across accounts)
needed to learn about currency — `0103_flutterwave_multicurrency_collections.sql`.

Every existing call site keeps working unchanged: both resolvers gained a
`p_currency` parameter defaulting to `'NGN'`, so a caller that has never heard
of multi-currency — every remittance, rent, service-charge and fee-income
lookup in the codebase — gets exactly the Naira account it always got.

⚠️ **Two migration mechanics worth remembering.** `create or replace function
foo(a, b default X)` does **not** replace an existing `foo(a)` — Postgres
identifies a function by name *and parameter types*, so `(uuid)` and
`(uuid, text)` coexist as separate overloads, and a 1-argument caller becomes
**ambiguous** ("Could not choose the best candidate function between..."),
confirmed live the moment the migration first ran. The old signatures had to be
dropped explicitly first. And `create or replace view` refuses to change an
existing output column's position or name — a new column must be appended at
the end of the select list, never inserted where it would naturally read.

⚠️ **A script that writes must read the row it is about to write, encore.**
`verify-lettings-grants` — from the previous session, unrelated to this work —
had already taught this lesson once (it overwrote OEA's org row with an
arbitrary one). This session found a second, independent instance of the
adjacent mistake: my own `verify-fx-collections` suite's cleanup deleted
`ledger_entries` **before** `payment_intents`, and `payment_intents.ledger_entry_id`
has no cascade delete rule — so the delete was silently refused (the error was
never checked) and an orphaned entry, "Collection — other (GBP) · ₦0.00" with
no postings under it, surfaced in the live Journal UI. Same root cause as the
probe-node/probe-property/probe-vendor leaks this build has hit before:
**cleanup order must follow the foreign keys, and a delete's error must be
checked** — a silent no-op is indistinguishable from success until someone
reads the screen it left dirty.

📌 **The browser-testing detour, recorded because it wasted real time.** Debugging
"the currency-add button does nothing" turned out to be nothing — the Browser
pane's `screenshot`/`read_page` calls were serving stale cached output for
several minutes (confirmed when `location.href` read live via `javascript_exec`
showed the login had actually succeeded and navigated to `/dashboard`, while
`screenshot` kept showing the login form). Restarting the dev server cleared it.
Lesson for next time: when a UI interaction seems to silently do nothing, check
`location.href` via `javascript_exec` before concluding the interaction failed —
it reads live DOM state, where `screenshot`/`read_page` in this session did not.

⚠️ **The regression the full suite run caught.** `client_funds_position` moved
from one row per org to one row per (org, currency) — correct and necessary,
but `verify-ledger`, `verify-collections` and `verify-remittance` all queried it
with `.single()`/`.maybeSingle()` and no currency filter, because until this
session no org had ever held more than one. The instant a real USD account
existed (added live, through the browser, to prove the feature), all three
suites started throwing "multiple (or no) rows returned". Fixed by scoping each
to `.eq("currency", "NGN")` — they test the Naira ledger specifically, so they
now ask for Naira specifically, same fix already applied to the three app pages
that had the identical assumption (Ledger Balances, Reconciliation, and the
simulated-checkout/receipt currency symbol).

Two further formatting bugs were caught only because the feature was actually
exercised end-to-end in the browser, not just verified at the database layer:
the simulated checkout page (`/pay/[reference]`) and the reconciliation screen
both hardcoded `formatNaira()` regardless of the underlying intent's or bank
account's own currency — a USD payment showed "₦1,250.50" on the page a real
payer would see. `lib/currency.ts` gained `formatMoney(amount, currency)`
(₦/$/£/€, falling back to the ISO code for anything else — never guessing a
symbol for a currency this build doesn't actually issue checkout links in).

New: `scripts/verify-fx-collections.mjs` (21 checks) — enabling a currency
provisions exactly `client_funds`+`suspense`, idempotently; a second account in
the same currency is refused while a different currency is not; the resolvers
never cross currencies; `record_collection` posts a foreign receipt into only
that currency's accounts while the NGN segregation position is provably
untouched; `client_funds_position` reports per currency; an opening-balance
allocation cannot cross currencies; and `gatewayMode()` reads a Flutterwave
key's own prefix correctly.

**Still open, deliberately:** no Flutterwave account/key exists yet — that is
the one remaining external dependency, tracked in `GO_LIVE_CHECKLIST.md`. Once
a key is set, the feature is live with no further code change — an admin adds
the foreign-currency account under Settings → Banking, exactly as demonstrated.

## Day 11 — a vendor's score comes from a checklist and a clock

The old vendor evaluation was a free-typed form: five numbers 0–100, typed by
whoever remembered to fill it in, no evidence behind any of them. B2's own
weighting table (Quality 30 · Response 20 · Completion 20 · Satisfaction 20 ·
Compliance 10) was decorative — nothing in the schema enforced it, and nothing
stopped a Quality score of 100 with no ticket, no vendor, and no work behind
it. That is the gap Day 11 closes.

**Two dimensions are never asked for a human answer.** Response Time and
Completion Time are computed straight from the ticket's own timestamps against
an admin-set SLA target (`evaluation_criteria`, `measure = 'sla_timer'`) —
`100 * (2 - actual_hours / target_hours)`, clamped to 0–100, so hitting the
target scores 100, missing it by double scores 0, and nobody types a number
for either. Quality and Compliance stay human judgement (the FM/PM answers a
short checklist — met/partial/not-met, yes/no, or a rating — against
admin-authored criteria), and Satisfaction is the tenant's own rating,
collected separately.

⚠️ **Dual-source, not one form filled in twice.** `vendor_evaluations` gained
`ticket_id` and `source` (`'fm_pm' | 'tenant'`), unique on the pair — two
immutable rows per job, written once each, never updated in place, matching
the table's pre-existing no-UPDATE-policy design rather than fighting it. The
composite score exists only once both rows do; a ticket with only the FM/PM
half submitted shows `awaiting_tenant = true` and no score, never an estimate.
`submit_vendor_evaluation(ticket_id, source, responses)` is the **only** write
path — a direct insert is refused (`scripts/verify-vendor-evaluation.mjs`
section F proves it) — and it re-checks standing itself (ticket is done, has a
vendor, the caller is the sender for `tenant` or holds evaluation rights for
`fm_pm`, nobody evaluates their own job) rather than trusting the UI to have
asked correctly.

📌 **Criteria are effective-dated, the same philosophy decision 14 already
applies to money.** Editing a criterion's wording or weight doesn't rewrite
past scores — it retires the old row (`superseded_by` points at the new one)
and inserts a replacement. `submit_vendor_evaluation` resolves the criterion
in force **at the ticket's `resolved_at`**, so a job scored last month keeps
last month's rubric even if an admin reweights the checklist today. A fallback
was needed for the org's very first evaluations ever: a ticket resolved before
any criterion existed (or before the rubric was seeded at all) fell through
the date filter and stayed permanently unscored — fixed by falling back to the
**earliest** version on record when no version satisfies the date check.

The rubric itself lives at Settings → Evaluation Rubric (admin-only, gated the
same way the fee/notice settings are): grouped by dimension, weight badges,
a misweighting warning if a dimension's points don't sum to 100, inline edit
and retire, and a "set up the recommended rubric" one-click seed
(`ensure_default_evaluation_criteria`) matching B2's weights exactly.

The old free-typed "Submit new evaluation" card on the vendor page is gone.
In its place: a tenant sees "Rate this job" on `/dashboard/my-requests` the
moment their ticket resolves (`my_requests()` gained `awaiting_review`,
resolved via a `tickets_prompt_review()` trigger that fires **after** the
existing lifecycle trigger, in its own `AFTER UPDATE` trigger — so a
notification fault can never block the status transition it's reacting to);
an FM/PM sees "Evaluate the vendor" on the ticket's own page once it's
resolved and unscored. The vendor's page merges legacy free-typed rows (kept,
dated, clearly historical) with the new dual-source rows into one table, and
now lists outstanding jobs — completed but not yet evaluated — instead of
inviting a free-form re-score of something already scored.

⚠️ **The one deliberate spec deviation.** `docs/PHASE1_VENDOR_EVALUATION.md`
proposes a new `completed` ticket status as the trigger for "now evaluable."
Built against the already-shipped and already-verified `resolved`/`closed`
terminal states instead — a new status would have touched the analytics
console, `my-work`, and `my-requests` simultaneously for no behavioural gain,
the same reasoning Day 10 used to justify its own materialized-view deviation
in `GO_LIVE_CHECKLIST.md`.

⚠️ **A property-less test ticket exposed the triage-visibility boundary
working exactly as designed, not a bug.** Browser-verifying the FM/PM half
against a hand-inserted ticket with `property_id = null` returned a genuine
404 for the facility-manager login — not a stale-cache artefact this time.
`role_permissions` showed `tickets.triage_unassigned` correctly `granted =
false` for `facility_manager` in this org: per the 29 Jul board decision
(`0064`, section F of `verify-chat-request-visibility.mjs`), only
admin/executive/regional_manager may see an unfiled request — a
property-scoped FM's access starts at a property, and an unfiled ticket has
none yet. The fix was the test fixture, not the product: giving the ticket a
real `property_id` the FM was actually scoped to made it visible immediately.
Worth naming as a real-world implication: a ticket a tenant raises through a
channel that never resolves a property (or a portal request left unfiled)
cannot reach an FM/PM's "Evaluate the vendor" prompt until someone with triage
rights files it against a property first — evaluation inherits the same
scoping the ticket itself already had.

Verified live in the browser end to end, both roles, not just at the RPC
layer: tenant submits a star rating + yes/no → live point preview → "Submitted.
Thank you." FM/PM opens the same ticket → checklist → live preview (200/200
on a perfect job) → "Submitted." → the vendor's scorecard immediately showed
the composite (96.5, matching the AURA weights against the actual response
values) in its evaluation history. Fixture ticket and its evaluation rows
deleted afterward, in FK order, so no test artefact was left in the shared
demo data.

New: `scripts/verify-vendor-evaluation.mjs` (26 checks, sections A–J) — no
free-typed scores are possible; composite appears only once both sources
exist; no duplicate submission per source; a not-done or vendor-less ticket
refuses; standing is enforced server-side (wrong tenant, vendor self-eval);
the direct-insert path is gone; effective-dating leaves a past response
untouched by a later criterion edit; the earliest-criterion fallback scores a
ticket older than the rubric itself; and a tenant's `awaiting_review` flag
works without any read access to `vendor_evaluations` directly.

**Deferred out of Day 11, scope size:** work-order photo/video evidence
uploads, and the full production UX pass (mobile drawer navigation, WCAG AA
audit, loading skeletons, confirmation dialogs on money-moving actions) named
alongside vendor evaluation in `PHASE1_WORKPLAN.md`'s Day 11 scope. Tracked
there as still open.

## The PC2 production-alias incident, and what it changed here

Shared by PC2, recorded in full in `docs/INCIDENT_2026-08-05_PROD_ALIAS.md`: a
stale `.vercel/project.json` link plus `vercel deploy --prod=false --force`
not behaving as documented briefly aliased Phase-1 code onto the frozen POC's
production URL (~5–8 min, caught and rolled back). This machine's own link was
checked against it and was already correct
(`prj_apZGqo3YPBnMyDZBRXifrl6eC2e4` = `oe-group-ipms-dev`) — no relink needed
— but the standing lesson travels regardless: **confirm the linked project
before any raw `vercel deploy`/`rollback`, every time, on every machine.** It's
why the deploy later in this entry used the explicit `--prod` flag rather than
`--prod=false`.

## WhatsApp/Telegram intake: the prompt file that never shipped, and the reply that never stopped

Two customer-facing screenshots — a real WhatsApp user complaining "How can
you classify a simple Hi as a request?" and the same "Hello, you have X
open…" reply timestamped six times across a single day — turned out to be one
symptom of two separate, real, live defects. Neither was found by guessing;
both were confirmed against the deployed function's own behaviour before
anything was changed.

⚠️ **Every genuinely new WhatsApp/Telegram ticket was silently failing to be
created.** `lib/triage.ts` loads its classification prompt from
`docs/AURA_Triage_Classification_Prompt.md` via `readFileSync(process.cwd() +
...)` at request time — a pattern Next's serverless file tracer (`@vercel/nft`)
does not reliably catch, because the path is assembled at runtime rather than
statically imported, so nothing tells the bundler "this file is needed here."
Confirmed two ways rather than one: a probe run locally against the exact same
shared DB created a ticket cleanly (ruling out the classification/insert logic
itself), then the SAME probe against the deployed URL returned 200 OK with
zero ticket created. Pulling the deployed function's own logs (`vercel logs`,
CLI already authenticated) settled it outright:
`Error: Could not find a fenced system prompt block in
/var/task/docs/AURA_Triage_Classification_Prompt.md` — the file simply never
shipped in the function bundle. Worse than a clean failure: that call sat
**outside** `classifyMessage`'s own try/catch, so instead of the designed
degrade-to-human-review fallback (the one the model-unreachable case already
had), it threw straight out through `classifyAndCreateTicket` and
`handleInboundMessage` to the webhook route's outer catch, which logs and
swallows everything, returning 200 regardless. A dropped request looked
identical to a successfully handled one from the outside.

Two fixes, not one, deliberately: `next.config.mjs` gained
`experimental.outputFileTracingIncludes` naming the file explicitly for both
webhook routes — the root-cause fix — and `loadSystemPrompt()` moved **inside**
`classifyMessage`'s try block, so any future failure to produce a
classification, for any reason, degrades to `FALLBACK_CLASSIFICATION` with
`requires_human_review: true` instead of crashing intake. The second is worth
its own line: a root-cause fix closes the one bug found; a resilience fix
closes the whole class it belongs to.

📌 **The classifier model id was re-checked and is fine.** `claude-sonnet-4-6`
returns 200 on a live call — a model released after this build's own knowledge
cutoff, not a typo. `PHASE1_WORKPLAN.md`'s S8 line ("classifier model id:
VERIFIED") was correct as far as it went and is now updated to say what was
actually wrong.

⚠️ **No idempotency on inbound chat webhooks — the second, independent bug.**
The payments webhook has deduplicated on the gateway's own event id since day
one (`gateway_events`, 0032 — "a retry after a timeout is normal traffic").
Nothing equivalent existed for WhatsApp or Telegram, and both providers
redeliver a webhook on any slow or non-2xx response, on a backoff that can run
to hours. Every redelivery of the same message was reprocessed as if new and
re-sent whatever reply had already gone out — exactly what the screenshot
showed, six identical pleasantry replies to one "Hi" across a single day, at
gaps (00:00 → 06:14 → 18:38 → 19:06 → 19:32) that match a provider retry
schedule far better than any bug in the reply logic itself. Fixed the same way
0032 fixed it for money: new migration `0105` adds `chat_webhook_events`, a
unique index on `(channel, event_id)` — WhatsApp's `wamid`, Telegram's
`update_id`, which covers a tapped inline button the same way it covers a
message — insert-first, and a duplicate-key conflict means "already handled,"
short-circuited before any of the expensive classify+write+reply path runs.

Verified locally first, then confirmed **in production, against the real
symptom**: the same message delivered three times to the live deployed
webhook produced exactly one ticket. `verify-triage-conversation-e2e` (new
request / priority correction / follow-up status question / genuinely
different problem opening its own ticket) passes fully against
`oe-group-ipms-dev.vercel.app` — the same suite that, run before the fix,
failed with "expected 1 ticket, found 0" against that exact URL. The
classifier's own routing logic needed no change at all; every symptom traced
back to the crash and the missing dedup around it, not to the model
misunderstanding anything.

⚠️ **`verify-channel-routing`'s own fixture broke, correctly.** It posted every
WhatsApp message in the suite under one hardcoded `id: "wamid.test"`, and every
Telegram update under `update_id: 1` / `2` — fine when nothing deduplicated,
wrong the moment something did. The new dedup rejected every call after the
first as an "already handled" redelivery, which is the fix working exactly as
designed, not a regression. Fixed to mint a unique id per call, the same way
the suite already minted a unique phone number per call via its own `stamp`.

**Deployed via an explicit `vercel deploy --prod`** rather than waiting on
Git-integration behaviour that, on inspection, wasn't reliably mapping this
push to a Production build — aliases (`oe-group-ipms-dev.vercel.app`,
`tfmlportal.com`, `oeaportal.com`) confirmed repointed, and the live page
content checked, not just its status code, per the incident lesson above.

**Still open, flagged, not actioned without explicit account access:** the
incident doc's other suggestion — scoping the frozen POC project
(`oe-group-ipms`)'s Git integration to `main` only, via an Ignored Build Step,
so it stops building every `phase-1` push as Preview noise. That's a
dashboard/account setting on a project this session has no API token for;
recommended to whoever holds Vercel dashboard access, not attempted here.

## Day 11, the rest: evidence on the job, and text you can actually read

### Work-order photos and video

A vendor says the job is done; an FM/PM scores the quality of it; a payment
gate turns on that score (B4). Until now none of that could be accompanied by
the one thing that actually shows the work. Tenants had the mirror-image gap:
"the leak is under the sink" is a sentence where a photograph is unambiguous.

📌 **The whole design rests on one decision: visibility FOLLOWS the ticket, it
is not re-derived.** The obvious implementation copies `tickets_select`'s
clauses — sender, assignee, vendor, `has_permission`, property scoping, the
unfiled-triage clause — onto the new table. That is exactly what the locked
scope decisions forbid ("a second scoping mechanism alongside the first is
forbidden"), and the reason is concrete: `tickets_select` has been amended in
0006, 0008, 0051, 0052 and 0064, and a copy would have needed all five
applied twice, correctly, forever. Instead the policy asks the only question
that matters — *can you see the ticket this belongs to?* — as an `exists`
over `tickets`. Postgres evaluates that subquery as the caller, so
`tickets_select` applies to it in full: every clause, every future amendment,
automatically. That assumption was **verified before any UI was written**, not
assumed: a throwaway probe confirmed the owning tenant sees the attachment and
an unrelated tenant sees neither ticket nor attachment.

⚠️ **A test that passes for the wrong reason is worth nothing, and this suite
caught itself doing it.** Section A originally asserted "the FM/PM sees as
much evidence as ticket" against an *unfiled* ticket — and passed at 0 : 0,
because a property-scoped FM cannot see a ticket with no property at all (the
0064 boundary this session had already run into once). Both numbers being zero
proves nothing about inheritance. Rewritten to file the ticket against a
property the FM genuinely holds — resolved from *their own* read rather than
hardcoded — and to require 1 : 1 positively, plus 0 : 0 negatively for the
same person on the same run. That pair is the actual claim.

Evidence is **append-only** (no UPDATE policy at all, same reasoning as the
ledger and the audit log), attributable (`uploaded_by` not null, and a row
cannot claim someone else uploaded it), and **fixed once the job is judged**:
the uploader may remove their own mistake while the ticket is open, but after
it resolves the file may already have been weighed in a vendor evaluation or a
payment verification, so it belongs to the record rather than to whoever
happened to upload it.

📌 **The index row is the real gate; storage RLS only proves the org prefix.**
So when the index insert is refused, the already-uploaded object is deleted —
otherwise a refused attachment leaves a file in the bucket with nothing
pointing at it and nothing to ever clean it up. Deletion runs the other way
round (row first, then object): the row's policy is the narrower of the two, so
a refusal there stops everything with the file intact, whereas removing the
object first would destroy evidence on a refused row-delete and leave a row
still claiming it exists.

Bucket is **private** (a work-order photo routinely shows the inside of
somebody's home) and capped at **25 MB** by the bucket itself, not merely by
the browser — enough for a phone photo or a short clip, and a deliberate
refusal of the 4K minute-long video that would never finish uploading on the
mobile connections A2.5 targets. Uploads run **sequentially** for the same
reason. The mobile button carries `capture="environment"`, so a technician
standing in front of the work photographs it directly instead of going via the
gallery app.

Verified in the browser end to end, not only at the RPC layer: a real PNG
generated in-page, handed to the file input exactly as a picker would, uploaded
→ indexed → thumbnail rendered from a signed URL at the right dimensions →
removed, with **both** the row and the stored object confirmed gone
afterwards. New: `scripts/verify-work-order-media.mjs` (20 checks).

### WCAG AA — measured, not asserted

The previous entry's UX pass deliberately said accessibility had only been
*spot-checked* and that a real audit was its own deliverable. This is that
audit, and it found genuine failures.

⚠️ **The badges were failing, some of them badly.** Contrast measured on
computed styles as actually rendered — not on the token values in the
stylesheet — put "Resolved" at **3.71:1**, "Closed"/"Low" at **4.31:1**, and
"High"/"In Progress" at **2.06:1**, against the **4.5:1** WCAG AA requires of
12px text. Amber on cream was effectively decorative rather than legible. The
cause was a category error in the design system: `--success`, `--warning`,
`--info`, `--destructive` are *fill* colours, meant to pair with a white
`-foreground` on a solid chip, but the tint badges paint the hue at 12–15% and
then use **the same hue as the text**. Fixed by giving the tinted variants
their own darker (in dark mode, lighter) `-on-tint` foreground; every solid
variant keeps its existing fill, so nothing that already passed moved.
`--muted-foreground` failed too, in both themes, and was corrected in both.

⚠️ **Two measurement bugs of my own, caught before either could be reported as
a finding.** First, the contrast script read `rgba(235,152,10,0.15)` — a
*translucent* background — as though it were opaque, so foreground and
background computed identical and it reported a ratio of **1.00**, a critical
finding that did not exist. Fixed by compositing every translucent layer up
the ancestor chain before comparing. Second, and worse: the first post-fix
"0 failures, both themes" result was measured **on the login page**, because
the session had silently expired — 0 failures over 0 badges. Re-measured
signed in, on a page carrying 54 badges, in each theme via a genuine reload
(toggling the `.dark` class mid-script did not recompute reliably and produced
a nonsense number in the other direction). *A clean result is only as good as
the evidence that the thing being measured was actually on screen.*

Structural criteria checked alongside contrast — image alternatives, accessible
names on every control, programmatic labels on every input, heading order,
page title, `html lang` — across the dashboard, the ledger and a form page:
clean, with one exception found **in the code written minutes earlier**. The
new media component's file inputs are `sr-only`, which hides them visually
while leaving them in the tab order, and neither carried a name: a screen
reader would announce "file upload button" and nothing else. Both given
`aria-label`s, and the identical pre-existing gap in `LogoUpload` fixed with
them.

## Audit 0805 — the leak the design's own header warned about, one layer down

PC2's `build-auditor` + `/code-review` pass on the 0805 window (Flutterwave,
work-order media, dual-source evaluation, chat dedup, Day 11 UX) came back
with two HIGHs. Both real, both fixed the same day, both proven closed with a
test that fails against the pre-fix state and passes against the fix — not
asserted from reading the diff.

⚠️ **H1 — the exact leak 0106's own header comment warns about, but one layer
down.** The migration states the design principle in its first twenty lines:
"Visibility FOLLOWS THE TICKET. It is not re-derived," and the TABLE policy
(`ticket_attachments_select`) implements that correctly, via an `exists` over
`tickets` that Postgres evaluates as the caller — so `tickets_select` applies
in full, automatically, forever. The STORAGE policy for the same bucket never
got the same treatment. It re-derived a materially broader rule — org
membership alone — which meant any authenticated member of the org could sign
a URL for, or list, any OTHER ticket's photos directly through Supabase
Storage, entirely outside the table policy that was built to prevent exactly
that. `getMediaUrl()` compounded it: it took a caller-supplied storage path
with no DB check at all, reasoning that "the row they got the path from was
itself gated by the ticket" — true only if a path could never be obtained any
other way, which the org-only storage policy did not guarantee.

Both fixed by asking the storage layer the same one question the table layer
already asks: does an `ticket_attachments` row exist at this exact path? That
single `exists` inherits `ticket_attachments_select`, which inherits
`tickets_select` — the same "one resolver, extended" principle 0106 used for
the table, applied one layer down rather than reinvented. `getMediaUrl()` now
resolves by attachment **id**, looks the row up under RLS first, and signs
only the path that row itself carries — belt-and-suspenders with the storage
fix, not a substitute for it.

**Proven, not asserted.** The pre-fix policy was reapplied via a direct `pg`
connection (the `verify-remittance-race` pattern), the new suite section run
against it, and it failed all three assertions exactly as the audit
described: an unrelated tenant signed the object, listed the folder, and an
orphaned object with no index row was signable by anyone including its own
uploader. The fix was restored and the same section passes clean. This is the
same discipline S1's remittance-lock fix used in the previous audit — a test
is only worth trusting once it has been watched to fail.

📌 **A second, related gap found while fixing the first, not in the audit
itself.** The storage DELETE policy used Storage's own automatic
`owner = auth.uid()` attribution, with no check that the job was still open —
so the underlying object could be deleted by its uploader even after the
ticket resolved, even though the table's own delete policy already refuses by
then (the evidence may already have been weighed in a vendor evaluation or a
payment). A row that cannot be deleted but whose file CAN be is a worse
failure than a stray file: it is a stale reference that claims evidence
exists when it does not. Fixed by factoring "uploaded_by = caller AND ticket
still open" into one `ticket_attachment_deletable()` function, called from
both the table's delete policy and the storage delete policy — a nested
`SELECT` inside an RLS policy always applies the referenced table's SELECT
policy, never its DELETE policy, so the storage policy could not simply
borrow the table's own rule by querying through it; one function, called from
both, is the only way to avoid the same predicate drifting apart in two
places.

⚠️ **H2 — a generated column written for a model 0104 replaced, still being
read by the two things it was supposed to feed.** `vendor_evaluations.
composite_score` is `generated always as (...) stored`, unchanged since 0001,
written for one row with all five dimensions filled in at once. 0104's
dual-source design instead writes two half-populated rows per ticket, and the
generated column COALESCEs whichever half a given row doesn't carry to zero —
so an FM/PM row with a perfect 100 on all four of its own dimensions
generates `composite_score = 80`, and a tenant row with perfect satisfaction
generates 20. `vendor_evaluation_tickets` (0104) already computes the correct
combined figure, populated only once both halves exist, and the vendor's own
scorecard page already reads it correctly. The payment gate itself
(`runPerformanceCheck`) and the executive BI figure (`bi_vendor_scores`) did
not — both averaged the raw column directly, meaning a vendor with only
new-style evaluations could have genuinely excellent work auto-rejected by a
KPI gate reading data the new schema never intended it to read.

Fixed by repointing both at `vendor_evaluation_tickets`. Proven with the
audit's own worked numbers, not a different example: a new suite writes a
genuinely perfect job's two real rows, confirms they generate exactly the 20
and 80 the audit predicted, confirms the OLD query's real function
(`averageComposite()`, imported, not reimplemented) produces 50 from those
rows, and confirms the NEW query produces 100. A still-pending half of a pair
contributes nothing to the average — `averageComposite([100, null]) === 100`,
not a number dragged toward the missing half's implicit zero.

New: `scripts/verify-vendor-score-consumers.mjs` (10 checks) — the H2 fix,
proven with the audit's exact numbers. `scripts/verify-work-order-media.mjs`
gained sections I and J (H1's storage-layer fix, proven both ways) and now
also sweeps stray storage objects at start-of-run, not just stray rows — the
same "a run that dies before its own cleanup leaves debris a later run can't
see" lesson, found again because writing a storage-layer test needed real
objects in the bucket for the first time.

**Not yet actioned:** M1 (Telegram's `update_id` dedup key isn't scoped per
org — two different orgs' bots can collide on the same small sequential
integer, silently dropping a real message as a false "already handled"), M2
(the new favicon route turns `orgs.logo_url` — writable by any admin with no
DB-level format check — into a public, unauthenticated redirect surface), and
L1 (`retire_evaluation_criterion` fires no audit trigger). Recorded in
`BUILD_AUDIT_0805.md`'s PC1-response table so they are not mistaken for
closed; out of scope for this pass, which was scoped to the two HIGHs.
*(All three closed the next day — see below.)*

## Silence is not a request: what fixing M1/M2/L1 actually turned up

The brief was the three remaining audit findings. What the investigation
found first was a live production defect none of them described — reported by
the user as "a blank message duplicating to the other org", which is a
description of something far more serious than what was actually happening,
and worth writing down for exactly that reason.

⚠️ **Check the frightening interpretation before fixing the mundane one.**
The symptom — the same blank message appearing in both TFML and OEA — reads
as a cross-org leak, which would be a B1 violation and the most serious class
of defect this system can have. It wasn't. The two tickets came from two
genuinely different `wamid`s five minutes apart, each correctly routed to its
own org: one real person messaging both brands' numbers and hitting the same
bug twice. **B1 held.** That was established by pulling the actual
`chat_webhook_events` rows and comparing message ids, before touching any
code — because "probably not a leak" is not something to assume about the one
invariant the whole multi-tenant design rests on.

⚠️ **The real defect: `classifyMessage("")` doesn't fail, it guesses.** Any
WhatsApp message carrying no text — a sticker, a voice note, a bare photo, a
location pin — arrived with `messageText: ""` and was classified and inserted
exactly like prose. The classifier duly returned `category: "general"`,
`requires_human_review: true`, and a ticket was created that says nothing
about what is wrong or where. Unactionable for staff; and the sender is never
told why nothing happened. Three such tickets were sitting in production.
Reproduced deterministically (a sticker payload → a content-less row) before
changing anything, so the fix was aimed at a confirmed cause rather than a
plausible one.

Fixed at the shared layer (`handle-inbound.ts`) rather than in either
webhook, so both channels answer identically: an empty message now gets a
specific, media-aware reply — "I can see you've attached something, but I'll
need a few words describing what it's about" — and creates no ticket. The
two channels had *different* wrong behaviours here (WhatsApp created the
blank ticket; Telegram silently dropped the message and said nothing at all),
which is exactly the drift the file's own header warns about: two copies of a
routing rule is two chances for one to go wrong. Now there is one answer.

📌 **The classifier wasn't classifying first contacts at all.** A greeting was
recognised only by exact match against a six-item list (`hi`, `hello`, `hey`,
`/start`, `/help`, `/menu`). Everything else with no open thread fell straight
through to "new request" — **with no model call whatsoever**. "Good
afternoon", "you there?", "test", a stray "?" all became tickets. The
five-way router prompt that already existed assumes an open thread and asks
which of five things a reply is doing; none of that applies to a first
message, which is why it was never called for one.

So a first contact now gets its own narrow classification pass asking the one
question that does apply: is this describing something, or is it noise.
Deliberately biased toward *request* on any ambiguity — the asymmetry matters
and is stated in the prompt itself: a slightly premature ticket is cheap and
closeable, whereas telling someone with a real problem that they've sent
small talk is not. The new suite asserts both directions, because a
"greeting detector" that also suppresses real requests would be a worse bug
than the one it replaced.

The three audit findings themselves were straightforward by comparison:
M1 folded `org_id` into the dedup key (it was already on the table, already
populated — just not part of the uniqueness constraint); M2 added the
`CHECK` constraint `logo_url` never had, after verifying both live production
values already matched the shape; L1 let the existing audit trigger fire on
`update` as well as `insert`, which also closed a slightly wider gap than the
finding described — `edit_evaluation_criterion()`'s supersede-the-old-row
UPDATE was equally unaudited.

New: `scripts/verify-intake-intelligence.mjs` (13 checks) — a sticker and a
voice note create no ticket while a captioned photo still does; two orgs can
share a Telegram `update_id` while a true redelivery is still caught; an
external URL and a `javascript:` scheme are both refused for `logo_url` while
a real one still saves; retiring a criterion is audited; and a
non-hardcoded greeting raises nothing while a real problem still raises
exactly one ticket.

**Left for OE Group:** the three blank tickets already in production are real
inbound records from real numbers — `open`, unassigned, no work against them.
Deliberately not deleted. They are meaningless but they are also real
people's messages, and clearing a production queue is the queue owner's call,
not a cleanup script's.

---

## 2026-08-06 · ⚠️ The demo database was migrated 117 versions forward by accident

Shared by PC2, recorded in full in `docs/INCIDENT_2026-08-06_DEMO_DB_MIGRATED.md`:
`.env.local` on PC2 had `SUPABASE_DB_*` and `NEXT_PUBLIC_SUPABASE_URL` pointing
at **two different Supabase projects**, and nothing had ever compared them. A
routine `npm run migrate` therefore applied `0011`–`0109` to the **frozen POC
demo** database — which had sat at `0010` since 24 July — while the dev database
the app actually serves received nothing.

Demo data is intact and the demo still serves its login page; dev was untouched
and remains at `0108`. **Not hand-reversed, deliberately:** migrations here are
forward-only and additive, so unwinding 117 of them produces a third state
nobody has tested. The clean reversal is a point-in-time restore — an owner
action, flagged in §4 of the incident doc along with applying `0109` to dev
(PC2 has no working DB credentials for it, which is the bug itself).

⚖️ **The runner now refuses to migrate when the two halves of the environment
name different projects** (`scripts/migrate.mjs`), before it opens a connection.
Both failure directions were previously silent: migrating the wrong database
looks exactly like a successful catch-up, and a fix you just wrote appears
applied when it is not.

📌 Found while fixing audit 0805-C1 — the `sc_budgets` duplicate-period race.
That fix (`0109` + the action's own 23505 path + a 13-check suite) is written and
correct; it is simply not applied to dev yet.

## The tenant could not pay their own rent — and anyone could stop them

PC2's `GAP_2026-08-06` was accurate in every particular, including the detail
that gives it away: `my_tenancies()` — a function written specifically for
"the tenant's own view" — was referenced exactly once in the whole `app/`
tree, **in a comment**. Day 9 built the entire accounting side of rent
(demands on schedule, the fee split, the landlord's share reaching the
segregated ledger, all verified) and no way for the person who owes the money
to see it or pay it. The ledger was fully wired to receive a payment nobody
could make.

Built along PC2's own suggested lines — reuse the proven collection path
rather than add a second one. `/dashboard/my-rent`, a `my_rent_charges()`
companion to `my_tenancies()`, and a server action that passes **no amount**:
the RPC computes the outstanding balance from the demand itself, the same
rule `raisePaymentRequest` already follows for service charges.

⚠️ **The defect underneath it.** `create_rent_payment_intent` (0092) is
`SECURITY DEFINER`, granted to `authenticated`, and checked only that the
demand belonged to the caller's **organisation** — never that the caller was
the tenant on the lease. So any account in the org could open a payment link
against anyone else's rent.

The interesting part is not the payment. Paying a stranger's rent is a
strange attack; the money would land correctly. It is the function's **own
one-live-intent guard**, three lines further down — *"a payment link is
already open for this rent demand"* — which exists to stop a tenant paying
twice. Opening an intent on somebody else's demand turns that protection into
a weapon: **the real tenant is locked out of paying their own rent**, from
any account in the org, with nothing in the app to explain why. A guard
against double payment, repurposed as a denial of the obligation itself.

Worth stating as a general shape, because it will recur: **a uniqueness
guard is also a claim, and whoever can create the claim can deny it to
everyone else.** The guard was right; who was allowed to trip it was not.

Fixed in `0110` — the demand's own tenant, an oversight role, or an FM/PM
scoped to the property; service-role callers (the scheduled job, no session)
unaffected. Reproduced against the pre-fix function via a direct `pg`
connection and re-verified after restoring it (`verify-tenant-rent-payment`
section G), the same discipline the remittance-race and storage-RLS fixes
used: a test is worth trusting once it has been watched to fail.

⚠️ **A migration file that lies, and nearly propagated.** `0092`'s file still
reads `status in ('pending','processing')`. `processing` is not a value of
`payment_intent_status`; `0092c` replaced the function to say `status =
'pending'` and **the original file was never corrected**. Rewriting the
function from the migration file — which is the obvious way to write `0110` —
reintroduces a guard that throws `invalid input value for enum` instead of
guarding anything. It failed on the first migrate, which is the good outcome;
the bad one was available, because my own new `my_rent_charges()` had copied
the same stale predicate and would have silently matched nothing. `0110` was
written from the **live** `pg_proc.prosrc` and says so. **When a function has
been replaced by a later migration, the file that first created it is no
longer a description of anything.**

📌 **FK cleanup, one link longer than expected.** Clearing a browser fixture
that had actually been *paid* took: `gateway_events` → `payment_intents` →
`ledger_postings` → `ledger_entries` → `rent_charges` → `leases` → `units` →
`properties`. Two traps. `payment_intents.rent_charge_id` is `ON DELETE SET
NULL`, so deleting the charge first does not block — it silently orphans the
intent, which then blocks the ledger entry with no visible connection back to
what caused it. And `payment_intents` also references `unit_id`, so that same
orphan blocks the unit and the property several steps later. The suite's own
cleanup now walks the full chain, with the reasoning written down rather than
the order alone.

Verified end to end in the browser, not only at the RPC layer: a tenant
signed in, saw ₦2,400,000 outstanding on their own flat, paid it, and the
ledger balanced to zero — ₦2,160,000 held for the landlord, ₦240,000
recognised as fee income at the 10% snapshotted on the demand.

New: `scripts/verify-tenant-rent-payment.mjs` (13 checks).

## A reference nobody could search by

Every acknowledgement a reporter receives names their request by `shortRef()`
— the first eight hex characters of the id, uppercased ("C1AF0AF7"). It is
the string a tenant quotes when they ring up. The requests list filtered on
summary, message text, property and category, and **not** on that, and did
not display it on the row either: the one identifier both sides of a
conversation actually share was the one thing the dashboard could neither
find nor show.

Two halves to the fix, and the second matters more than it looks.

📌 **Show it.** A list that cannot be matched by eye against a WhatsApp
message is a list you have to search blind. The reference now sits at the
front of each row's metadata line.

⚠️ **Search the table, not the page.** The requests list loads the 200 most
recent tickets and narrows them in the browser. A reference older than that
window matches nothing locally — and the screen would then say *"No matching
requests"*, which does not read as "not in this page", it reads as **"no such
request"**. To someone holding a real reference from a months-old thread that
is a confident wrong answer, and the kind that ends with a person being told
their request was never logged. So when the query looks like a reference and
the loaded page has nothing, `find_tickets_by_reference()` (`0111`) asks the
database, which searches everything. The result is shown separately, labelled
"found outside the most recent N", so the status counts keep describing
exactly what they describe.

⚠️ **A reference is a prefix, and a short one — so the lookup had to be
proved, not assumed.** Four hex characters is 65,536 possibilities: trivially
enumerable by anyone who wants to. A lookup taking a prefix is therefore only
safe if RLS scopes its answer exactly as the list does. `find_tickets_by_
reference` is deliberately **SECURITY INVOKER** (the default, and the whole
point) rather than definer, so `tickets_select` applies in full — it makes an
existing row *findable*, never a new one *visible*. The suite leads with that
rather than with correctness: an unrelated tenant quoting a valid reference
gets nothing, **and** cannot see the ticket by the ordinary route either, so
the two answers agree and the lookup is provably not a second, looser door.
Below four characters it returns nothing at all, ordinary words return
nothing, and it is bounded at 20 rows — a stray keystroke is not a query for
the whole table.

Verified in the browser across every spelling a person actually uses:
lowercase, `#`-prefixed, padded with spaces, a four-character prefix, and a
pasted full UUID with its dashes — all find the same request, and ordinary
text search still behaves as before.

New: `scripts/verify-ticket-reference-search.mjs` (15 checks).

## Record correction — `0112` landed inside an unrelated commit

`0112_operator_org_host_routing.sql`, with `app/page.tsx` and `lib/org-host.ts`,
was committed in `d32b4b9` — whose message is entirely about the demo-database
decision and does not mention it. The cause was mine: `git add -A` without
re-reading `git status` first, sweeping in work that was in the tree but not
part of what I was committing.

Recorded here rather than fixed by rewriting history, because `phase-1` is
shared with PC2 and a force-push to relabel one commit costs more than the
mislabelling does.

**What the change actually is**, since the commit message will not tell anyone:
`app/page.tsx` redirects a resolved host straight to `/o/<slug>`, which is right
for every client org and wrong for the platform operator. `/login` is
deliberately anonymous and names no organisation (B1 — it "reveals nothing about
who is on the platform"); `/o/<slug>` is a client org's own front door and locks
sign-in to that org. Routing the operator's own domain through `/o/oe-group`
would silently trade the anonymous door for the client-facing one. `0112` adds
`is_platform_operator` to `org_branding_by_host` — one column, no new function,
no change to how a hostname is bound or resolved — and root checks it first.

⚠️ **The more useful lesson is what the mislabelling hid.** The commit contained
real code, but the last production deploy had been cut from the commit *before*
it. So the dev database was serving a function returning a column the deployed
app did not consume. Additive, so nothing broke — and that is exactly why it
could have sat there indefinitely. It surfaced only because the labelling was
questioned and the state got checked properly. **A schema change and the code
that reads it are one unit; deploying is part of landing it, not a separate
errand.** Deployed and verified after this was noticed: both brand portals still
resolve to their own `/o/<slug>` doors, which is the behaviour the operator
exception must not disturb.

## The failover, the memory, and the hole they found

Asked for a Gemini failover with better intelligence and memory. All three
landed. The third thing was not asked for and matters more than the other two.

**Failover** — `lib/llm.ts`, provider adapters shaped like the payment
gateways already in this codebase. Gemini rather than GPT because B3 locks it,
and A7.3 forbids substituting a vendor silently; swapping is one adapter and
one env var, but that is a decision to take, not to assume. Built on `fetch`,
no second AI SDK in a bundle that runs on every inbound webhook.

📌 **The design point worth keeping.** Failover triggers on *did we get a
USABLE answer*, not *did the HTTP call succeed*. `parseClassification` used to
return `FALLBACK_CLASSIFICATION` when the text would not parse — which is
indistinguishable from a real classification of a vague message, so an
overloaded model answering with prose was accepted as an answer and the
fallback was never consulted. It now returns null, and null means "ask the
next provider".

**Memory** — `0113`. `conversation_context` handed the router
`tickets.message_text`: the line that OPENED the ticket. Meanwhile
`ticket_messages` had held the actual exchange since 0075. So the model was
asked "is this a follow-up?" while shown only the first thing the person ever
said, with every turn since invisible. `conversation_transcript` supplies the
recent turns, labelled by speaker — without labels our own automated
acknowledgement reads as something the tenant said.

📌 Both are tested with **injected failing providers**, so the shipped
failover logic itself is exercised with no outage and no Gemini key. Section F
is a control: it removes the fallback and asserts the result changes. A green
failover test that stays green when failover is deleted is worth nothing.

---

⚠️ **And then the suite found that almost nothing was actually protected.**

A section asserting `conversation_transcript` was unreachable from a client
session failed. It was reachable. So were **101 of 103 SECURITY DEFINER
functions**.

Every migration in this build uses:

    revoke all on function f(...) from public;
    grant execute on function f(...) to service_role;

`PUBLIC` is the pseudo-role meaning "everyone by default". Supabase ships
`ALTER DEFAULT PRIVILEGES ... GRANT EXECUTE ON FUNCTIONS TO anon,
authenticated, service_role`, which writes **explicit** grants to those named
roles at creation. Revoking from PUBLIC does not touch an explicit grant to
`anon`. **The revoke ran, succeeded, and removed nothing that mattered** — for
the whole build, in a codebase whose own comments repeatedly assert these
functions are service-role-only.

Proven, not inferred, with the anon key that ships in every page bundle:

- `append_reporter_message` — an anonymous caller **wrote a message into a
  ticket**, attributed to the reporter. Confirmed by doing it and reading the
  row back.
- `record_collection` — reached its body. It contains **no auth check of any
  kind**, correctly: it was service-role-only, so it never needed one. An
  anonymous caller could post a collection to the client-funds ledger,
  marking an invoice paid with no money received.
- `retire_org` — reached its body. Its guard is `if v_caller is not null and
  not caller_is_operator_admin()`, and an anonymous caller has no
  `auth.uid()`, so the check is skipped entirely.

Not everything was open: `set_role_permission` tests `current_user_role() is
distinct from 'admin'`, true for anon, so it refuses. **The blast radius is
exactly "functions whose only gate was the grant"** — which is most of the
money path, because a function that is genuinely service-role-only has no
reason to check a caller it can never have.

⚠️ **Two distinct causes, and the guard found the second.** `0114` revoked the
explicit `anon`/`authenticated` grants — 81 statements, each derived from the
grantees its own migration declared, so the public application and invitation
flows stay anonymous by design rather than by luck. The new guard then
immediately failed on two functions still reachable, for the opposite reason:
`has_permission` and `accept_invitation` carried `=X/postgres` in their ACL —
an empty grantee is PUBLIC. Their migrations never revoked from public at all;
`accept_invitation`'s revoke in 0020 names the **two-argument** signature that
0026 replaced with a seven-argument one. **A revoke naming a signature that no
longer exists protects nothing, and nothing warns you.** Fixed in `0115`.

📌 Checked before revoking `has_permission`, because RLS policies call it: if
anon could not execute it, every anon query on a table whose policy calls it
would ERROR instead of returning nothing — breaking the public tenancy and
vendor application flows in a way that surfaces only when a real applicant
tries. No anon-facing policy calls it; those gate on `org_accepts_*`, granted
to anon deliberately and untouched.

**The standing lesson.** Intent expressed in SQL is not the same as effect in
the database, and only the database can be asked which is true. Every comment
in every migration said "service_role only"; the code said it; the reviews
believed it; it was false everywhere. `scripts/verify-function-grants.mjs` now
compares live grants against the intent parsed out of the migrations
themselves, so the two can never silently disagree again.

Full suite after the lockdown: **65 of 65** — nothing legitimate was revoked.

New: `scripts/verify-classifier-failover.mjs` (17), `verify-function-grants.mjs` (22).

## The key was set, and the failover still would not have worked

`GEMINI_API_KEY` went onto Vercel and was redeployed — the right sequence, and
the step people usually miss. So the failover was live. Except the adapter had
never made a real call: every test to that point used injected stubs, which
proved the failover *logic* thoroughly and the Gemini *integration* not at all.
The REST shape, the model name and the response parsing were all still
guesses.

⚠️ **The first real call came back `429`.**

    GenerateRequestsPerDayPerProjectPerModel-FreeTier

Not a bad key — a `models` listing with the same key returned 200 and all 42
models, `gemini-2.0-flash` among them. The free tier's **daily** quota was
already exhausted, on a key minutes old. So: key present, key valid, model
correct, failover code correct — and no failover. It would have been
discovered during the outage it exists for, and the symptom would have been
indistinguishable from never having built it.

📌 **This is why the health surface checks REACHABILITY, not configuration.**
The obvious version of `/dashboard/settings/ai` reports "fallback: configured
✓" off the presence of an env var. That would have been accurate, reassuring
and worthless. It now sends a real one-word prompt to each provider and
reports what came back — and the very first run said, correctly:

    Claude (Anthropic) — primary — Answered normally.
    Gemini (Google) — fallback — Key accepted but the provider refused:
    quota or rate limit reached.

A quota refusal is singled out from other errors deliberately, because it is
the one failure that looks like success from every other angle.

📌 **And a live probe still cannot answer the other half.** A provider can be
reachable *now* and have been failing all day. So the page also reads
`tickets.classified_by` (0113) for the last seven days and shows what actually
carried the load — with a warning when any request fell to the fallback, or to
neither. The probe is the present tense; the column is the past one, and
neither substitutes for the other.

Costed deliberately: the probe is a **button**, not something every page render
pays for. Admin-only, and gated in the server action rather than only the
page, because a server action is a public endpoint that here spends money and
reports infrastructure state.

**Left with the user, not resolved here:** the free tier is not a production
failover. Either enable billing on the Google Cloud project so the quota is
real, or accept that the fallback is best-effort and the failover is a
degradation-reducer rather than a guarantee. Both are defensible; the one
thing that is not is believing it works because a key is set.

## A vendor you could invite but never create

Reported: a vendor onboarded under TFML never appeared in the vendor list, and
could not be picked when dispatching a request. Both true, plus a third the
report could not see — their own My Work page was empty too.

⚠️ **The invitation machinery was not the bug**, which is worth recording
because it is the obvious suspect and an hour could be lost there.
`invitations.vendor_id` exists, `InviteDialog` renders a vendor picker for the
vendor role, and `accept_invitation` already links the accepted user to the
chosen company. I initially concluded otherwise off a grep for
`insert into vendors` — the function does an **UPDATE**, so the grep said
"never touches vendors" and it was wrong. Reading the function caught it.
**A negative grep is not evidence; it is one phrasing failing to match.**

The actual cause was upstream and simpler: **nothing in the application could
create a vendor company.** `app/dashboard/vendors/` had a list and a detail
page and no `new/`. Rows only ever arrived through the public self-service
application flow (`approve_vendor_application`, 0021) or a seed script. TFML
and OEA had **zero** vendors between them — so the invite dialog's picker was
empty, the invitation went out with `vendor_id = null`, and the accepted user
landed with a role scoped to a company that did not exist.

📌 **One missing row, three symptoms, because three surfaces read the same
table**: the vendor list, the dispatch dropdown, and My Work (by `user_id`).
That is why it presented as "invisible AND unassignable AND blank" rather than
one clean failure — and why the new suite asserts all three from one fixture
instead of trusting that they agree.

**Built:** `/dashboard/vendors/new`, gated to admin/FM with RLS
(`vendors_insert`, capability `vendors.write`) as the real boundary.

📌 Created as `approval_status = 'pending'`, deliberately **not** approved. The
public path sets 'approved' because a human has just reviewed the application
in front of them; an administrator typing a company name has done no such
review, and starting it approved would launder an unreviewed vendor into a
payable one — the exact thing `verify-vendor-applications` exists to prevent
from the other direction.

📌 The form offers to attach an **existing unattached vendor login**, and only
renders that when there is one. This is the rescue path for anyone already
stranded — otherwise fixing them is a separate errand nobody knows to run. It
found both TFML orphans on first load, including the reported person.

**Guarded:** `0116` adds a CHECK that a vendor invitation must name a company.
`NOT VALID`, deliberately — two such invitations already exist, and rewriting
live invitation history to satisfy a rule written afterwards edits the record
of what happened. New rows are checked; the two are grandfathered and left
exactly as they occurred.

New: `scripts/verify-vendor-onboarding.mjs` (11 checks), including one that
asserts an administrator holds `vendors.write` in **every** org — the original
failure was org-shaped, and a suite that only ever tests the seeded demo org
would not have seen it.

## A job assigned to nobody

Reported: a job dispatched to Philip's vendor (eDOWM, TFML) did not appear in
his portal and produced no notification.

📌 **The read path was never at fault**, and establishing that first saved
chasing RLS. Impersonating him through `set local request.jwt.claims`, he
resolves his vendor and sees the ticket correctly — the instant
`assigned_vendor_id` is actually set. Every symptom came from that one field
never being written.

⚠️ **The ticket said `status = 'assigned'` with both assignee columns null,
and `assigned_at` null too.** `assignTicket` always stamps `assigned_at`, so
it had never run. The status had been moved by the **Status dropdown**, which
offered 'assigned' as a free choice — setting the word and nobody behind it.
Not a one-off mis-click either: two more tickets on the POC org were sitting
in the same state.

**Three defects, one report.**

1. **A meaningless state was reachable.** `assigned` / `acknowledged` /
   `in_progress` with nobody assigned. `0117` refuses it with a BEFORE trigger
   — separate from `tickets_stamp_lifecycle` on purpose, so the trigger that
   stamps never gains a reason to reject and the trigger that rejects never
   gains a reason to rewrite. The manual status list no longer offers
   'assigned' at all: dispatching is what assigns, and a dropdown that can
   silently un-hold a job is a trap.
2. **A vendor was never notified.** `assignTicket` read
   `if (opsUserId) notify_user(...)` — dispatching to a vendor told nobody,
   while the toast said "The assignee has been notified." A vendor is a
   *company*; the person to tell is the login attached to it, so the fix
   resolves `vendors.user_id` and notifies that. A vendor with no attached
   login still gets nothing, which is now a visible consequence of an
   unattached company rather than a silent hole.
3. **The dispatch could fail silently.** `.update().eq()` with no `.select()`
   returns no error and zero rows when RLS declines, so a refused dispatch
   reported success. Same class as the FK-cleanup no-ops earlier in this build.

⚠️ **Existing rows deliberately not rewritten.** Three tickets are in the bad
state. Guessing an assignee would put a name against work that person may
never have been told about — worse than an honest gap. The trigger fires on
UPDATE, so each refuses its next status change until dispatched properly,
surfacing it to a human exactly when one is already looking.
`verify-role-workflows` reports the count so they can be found deliberately.

📌 **And a fixture bug in my own new suite, caught before it was reported as a
product bug.** Section B first picked *any* vendor with a login — and got one
whose login is **deactivated**. `notify_user` correctly declines those, so the
section failed for a right reason and read as "vendors are never notified."
The suite now requires an ACTIVE login. Same shape as the 0:0 inheritance test
in `verify-work-order-media`: **a fixture that does not satisfy the
precondition tests nothing, and will happily tell you something alarming.**

New: `scripts/verify-role-workflows.mjs` (24 checks) — deliberately a
*seam* suite rather than another per-feature one. The per-feature suites test
their own feature deeply on the seeded demo org; this walks every live
organisation and checks the joins between features: that a working status
implies a holder, that being assigned actually tells someone, that a tenant
reads no ledger and a vendor reads no other vendor's jobs. The reported bug
lived precisely in that gap.

## Two journeys, audited against the documented sequence

The user journey deck is not in this repo, so the sequences came from the
user directly. That distinction matters more than it sounds: **B7 is an
ACCESS matrix, not a journey.** It says what a role may read and write. It
would never have told me a vendor needs to *decline* work, or that an FM's
day starts with managing properties. Inferring a journey from permissions
would have produced something plausible and wrong in exactly the places that
matter.

### Vendor — three of five steps had nothing behind them (0118)

Accept existed. Decline did not exist **at all** — a contractor given a job
they could not take had no way to say so, and it sat assigned to someone who
was never coming. Mark-complete was *permitted by RLS* and never offered by
the UI, so the capability existed and was unreachable. Submitting an invoice
was refused outright: `payments_insert` admits only
admin/facility_manager/regional_manager, so a vendor could **see** their
payments and never raise one.

📌 Built as SECURITY DEFINER functions rather than by widening
`payments_insert` to vendors. Widening it would also hand them
`service_verified_at`, `performance_validated` and `approved_by` — **which
are the B4 gate itself.** A vendor states a claim; verification and the
performance check turn it into money, and both belong to somebody else. The
suite asserts the negative directly: a vendor attempting to self-approve gets
zero rows.

### FM/PM — a failure only this role could hit (0119)

Adding a property failed in **every organisation**. The insert was never the
problem: evaluated as the FM, both halves of `properties_insert` are true,
and an insert with no `RETURNING` succeeds. It is the `RETURNING` that was
refused — **Postgres applies SELECT policies to a RETURNING clause**, an FM
holds no `properties.read_all` (B7 scopes them to assigned properties), and a
property created a microsecond ago has no stakeholder row. They could not
read back what they had just made, so the statement failed. The app does
exactly `.insert(row).select("id").single()`.

⚠️ **An admin would never have found this.** `read_all` makes their read
independent of the assignment, so the whole failure is invisible from the
seat most testing is done from. The general lesson: *a permission that is
broader for the tester than for the user hides the user's bug entirely.*

The fix is not to widen the read policy or drop the `RETURNING` — it is that
**the person who files a property manages it**. Attaching the creator is the
missing half of the create, not a workaround for it.

### And the latitude asked for: raising work proactively (0120)

Every route into `tickets` assumed a REPORTER — the chat webhooks carry a
sender, and `/dashboard/new` files the signed-in person's own unit under their
own name. Planned maintenance, an inspection finding, anything spotted on a
walk-round had nowhere to go. Two consequences follow from "there is no
tenant here", and both are deliberate:

* `sender_id` stays **NULL**, not the FM's own id. They are not the person
  the work is for, and putting them there would make every planned job look
  like a complaint they raised about themselves — and would wrongly arm the
  tenant satisfaction prompt (0104) on resolve, asking a nonexistent tenant to
  rate the work.
* `property_id` is **required**. Inbound chat may arrive unfiled and be
  triaged later; staff-raised work with no place is work nobody can pick up.

📌 **Two test-methodology bugs of my own, caught before either was reported
as a product bug.** The round-trip check used a CTE — and a row created inside
a CTE is not visible to a SELECT in the *same* statement, because both read
the snapshot taken at statement start. It reported "created but unreadable to
its creator" on every org: an artefact that read *exactly* like the bug it was
written to catch. And an FM's payment write is scoped to vendors they manage,
so zero rows on an out-of-scope vendor is **correct** — the first version read
that right refusal as a failure. Both fixed by establishing the precondition
before asserting on it, the same lesson as the 0:0 inheritance test and the
deactivated-vendor notification test.

New: `verify-vendor-journey.mjs` (21), `verify-fm-journey.mjs` (13 per org,
every org).

**Still open, flagged not fixed:** `assets.scope` does not exist, though
locked decision 8 specifies `unit | property | site` explicitly — precisely to
stop a nullable `unit_id` being used to mean "shared". The table carries
`property_id` and a nullable `unit_id`: the exact pattern the decision
forbids. Implementing it is a schema change over every existing asset row, and
the decision says how a NEW asset states scope but not how to classify ones
already recorded. That classification is the owner's call, not a guess.

## Asset assemblies, mobility, and what "maintained" actually means

`docs/ASSET_CLASSIFICATION_AND_SCOPE.md` (PC2) separates two things this
codebase had already got right and which are easy to conflate: **taxonomy**
(what an asset is) and **access scope** (who may touch it). Part 1 of that doc
is confirmation, not instruction — the existing enums and the two-tier RLS are
correct and are untouched here. Part 2 is the work.

Its three load-bearing claims were re-checked rather than taken on trust,
because two of them decide the design:

* `meters` / `sensor_readings` / `ml_features` genuinely do not exist — so the
  usage-metered strategy really is a Phase-2 seam (B9), not a regression.
* `audit_asset_write` genuinely exists as `AFTER INSERT OR UPDATE` — which is
  precisely why 2b needs no new machinery: relocating a movable asset is
  already audited as an ordinary `property_id` change.

**2a — assemblies.** Every asset was a flat row, so a chiller plant made of a
chiller, its AHUs and ducting could not say those belong together, and "total
spend on the HVAC plant" could only ever mean "on one unit of it".
`parent_asset_id` with a trigger enforcing same-org **and same-property**: a
component on another property is not a component, it is a different asset that
happens to be the same model, and letting the two merge would make a
property's register lie about what is on site.

📌 **The cycle guard is where this kind of change goes wrong, so the suite
tests three depths, not one.** Direct self-parenting is the obvious case.
A→B→A is the one people remember. The one that actually bites is re-parenting
an ANCESTOR under its own descendant — it looks like an ordinary edit and
leaves a register that cannot be walked. All three refused, and a fourth check
confirms the refusals left the existing chain byte-for-byte intact, because a
guard that rejects *and* corrupts is worse than no guard.

**2b — fixed vs movable.** Deliberately **advisory**, not enforced: it states
intent and gates the UI, and the database still permits relocating a `fixed`
asset. A hard constraint would mean a lift miscategorised on import could
never be corrected — and the suite asserts the permissiveness explicitly,
because the obvious test ("a fixed asset cannot move") would have encoded
exactly the wrong rule.

**2c — maintenance strategy.** `last_serviced_at`/`next_service_due` were bare
dates: a quarterly-serviced chiller and a fix-on-failure door closer were
indistinguishable until someone read the dates and inferred it. Now
`reactive` (default) / `calendar` (with a required interval — a strategy with
no period is a label, and the constraint says so) / `usage`. **`usage` stays
valid in the check constraint and absent from the UI**: the column never needs
widening when the meter tables land, and nothing can compute it until they do.
The suite asserts both halves — that the database accepts it, and that Phase 2
is still genuinely Phase 2.

📌 **The UI came almost free, and that is the payoff of an earlier decision.**
The asset form renders from `ASSET_FIELDS` in `lib/asset-schema.ts` — one list
shared with the CSV import template, so the two cannot drift. Adding mobility
and maintenance there put them on the form *and* in the bulk-import template
in one edit, and `verify-asset-import` passed untouched. Only
`parent_asset_id` needed hand-wiring, because it is a relation rather than a
scalar. The detail page gained a "Part of" breadcrumb and a Components list —
where an asset sits in its assembly changes how you read everything else about
it, so it sits above the detail rather than below.

New: `scripts/verify-asset-classification.mjs` (17 checks). All four asset
suites pass, including the importer.

---

## The tenant/resident journey — reporting, being answered, and paying

**Migrations 0122–0126 · 7 Aug 2026**

Sixth role walked end to end, from the user-journey deck: *report an issue → AI
triage (category + priority + interaction) → ticket + acknowledgement → track
requests → pay the service charge → view statements and payment history → track
the timeline → appraise the vendor.* Four of those steps already worked. Three
did not, and one of them was quietly wrong about money.

### The portal was the least intelligent channel

WhatsApp and Telegram classify every inbound message — model, failover,
recorded provider, conversational follow-up (0075, 0113). The **portal**, which
A2 calls the system of record, did none of it. `NewRequestForm` was a
client-side `supabase.from("tickets").insert()` with **category and severity
taken from two dropdowns the reporter filled in themselves**. It showed no
reference back, and told nobody.

So a gas leak reported on the web carried whatever urgency the reporter picked
from a select box, and then sat in the table waiting to be noticed.

Moved to a server action: the classifier runs where the API key is, the row
records `classified_by`, and staff are notified. The category *can* still be
set by the reporter — they know whether this is a billing question better than
a model reading one sentence. **The urgency deliberately cannot.** "How bad is
this" is the judgement the classifier exists to make consistently across
reporters, and a self-assessed severity is the field people lean on to jump the
queue. They correct it *afterwards*, against a stated baseline, recorded as the
reporter's own — which is what 0124's `set_my_ticket_urgency` is for.

### A tenant could not pay a service charge at all

Module 3 built budgets, apportionment, invoicing, the ledger posting and daily
reconciliation. `payment_intents_insert` admits admin/finance/FM and nobody
else, so the person being billed had a number and no button — exactly the gap
0110 closed for rent, closed the same way and for the same reason.

📌 **And underneath it, a live regression.** `record_collection` used to end
with `update service_charges set status = 'paid'` — present in 0032, 0033, 0035
and 0049. The 0092 rewrite (adding the rent fee split) dropped that line, and
0103 rewrote from 0092. Confirmed against `pg_proc.prosrc` rather than the
files: **the deployed function contained no reference to `service_charges` at
all.** A service-charge payment posted to the ledger correctly, marked the
*intent* paid, and left the *invoice* reading `invoiced` for ever. The money was
right; the record of what it settled was not, and arrears over-reported by
exactly the amount collected.

Restored — and no longer a flat `'paid'`. The original was already wrong for a
short payment: ₦300k received against a ₦482k invoice, and the invoice read
settled. Derived from `amount_paid` now, as rent has been since 0090.

### Two locks on the same door

Section E of the new suite then caught a defect in the fix. `0123` removed
0045's index blocking a second intent on a `part_paid` invoice — a spent
checkout is not a live link, and blocking on it made the balance uncollectable.
That fixed nothing on its own: both intent functions built the gateway
reference deterministically **from the charge**, so the second attempt
collided on `payment_intents_org_ref_uidx` instead.

⚠️ **Not confined to the new path.** `create_rent_payment_intent` has carried
the same shape since 0092, and there it is worse — no unique index covers
`rent_charge_id`, so the function's own guard passes and the tenant is shown a
raw duplicate-key error for "pay the rest of your rent". Both fixed in 0125:
the reference is unique per **attempt**, and the charge stays recoverable from
the intent's own FK column, which is where that link belongs.

### A notification could cross an organisation

Found before leaning on `notify_role` to tell the FM a request had arrived —
worth asking what it actually permits.

⚠️ Both notification functions are `SECURITY DEFINER`, granted to
`authenticated`, and **neither checked the caller against the organisation it
wrote into**. `notify_role` took the target org as an *argument*.
`notify_user` derived it from the *recipient* — which reads like a safety
check and is the opposite of one: it made the function work for any recipient
in the database.

Proven live, then rolled back: a **TFML tenant wrote a notification titled
"Urgent: verify your bank details" into an OEA administrator's inbox**, and a
second directly at a named OEA user.

The smaller problem is the data. B1 says a user on one portal must never see
the other brand's data *or existence* — a notification arriving from outside
proves the other org exists, names a reachable person inside it, and does so in
the one surface a user is trained to trust. `p_link` was already constrained to
a relative path, which is precisely why the gap mattered: **the address was
guarded, the sender never was.**

Fixed with 0110's shape — derive the boundary from the session, skip it when
there is none, so the scheduled jobs (which legitimately write across orgs) are
untouched. Returns a no-op rather than raising, matching the
deactivated-recipient case: a refusal would confirm the recipient exists.

### Two regressions the guards caught, not review

Both mine, both from this session's own work:

- **The reporter's correction lost its audit entry.** 0124 factored the shared
  rule down into `apply_reporter_urgency` so the portal and chat could use one
  copy — and the move dropped the `audit_log` insert. `verify-conversational-triage`
  said so. A priority is how work is ordered and how an SLA is measured; the
  trail has to say who moved it and from what. **A refactor that keeps the
  behaviour and loses the record has not kept the behaviour.**
- **Four new functions were anonymous-callable.** The trap 0114/0115 were
  written for, arriving on schedule: the project's `ALTER DEFAULT PRIVILEGES`
  grants EXECUTE to `anon` on every new function, and `revoke all ... from
  public` — which 0123 and 0124 both dutifully wrote — does not touch an
  explicit per-role grant. The sharp one was
  `create_service_charge_payment_intent`, whose standing check is skipped when
  `auth.uid()` is null (that is how the jobs are trusted), so an anonymous
  caller who learned an invoice id could have opened a checkout and locked the
  real payer out.

New: `scripts/verify-tenant-journey.mjs` — every step, every org, plus the
cross-org notification matrix. Adjacent suites re-run green: collections,
rent-money, tenant-rent-payment, notifications, function-grants,
conversational-triage. `verify-checkout-e2e` fails at section H on both this
tree and the pre-change tree — Node cannot import `lib/pdf/receipt.tsx` from a
plain `.mjs`; a harness limitation, not a regression, and A–G pass.

---

## The finance lead — approving in bulk, paying owners, and reporting

**Migrations 0127–0131 · 7 Aug 2026**

Seventh role walked end to end: *reconcile the ledger (match payments to
tickets) → batch-approve payouts → remit to owners → generate reports (P&L and
statements) → tax & compliance (future) → multi-entity consolidation.*

Tax & compliance filing is explicitly a later build and is **not** started here.

### A batch must not become a shortcut

Two things a bulk approval must not turn into, and they pull in opposite
directions.

It must not skip the gate. `enforce_payment_transition` (0073) is a
`FOR EACH ROW` trigger, so it fires per row even on a multi-row UPDATE — which
is exactly why `approve_payments` is **SECURITY INVOKER**. It runs as the
caller, RLS applies, the trigger applies, and the batch is N single approvals
rather than a privileged path that happens to do N things.

And it must not be all-or-nothing. A single `update ... where id = any($1)` is
one statement: if the seventeenth invoice sits above the caller's threshold,
the statement raises and none of the twenty are approved. So each row gets its
own exception block and its own answer. **A week's invoices will routinely
contain one that needs the MD, and the honest result is "eighteen approved, two
left as they were" — not a failed action with nothing done.**

### Three places the application was stricter than the board

A pattern, not three coincidences. Each time, the database implemented a board
decision and an application layer that had copied the rule never caught up.

📌 **`approvePayment` refused executives above the threshold.** Decision 9 gave
the MD of TFML and the Managing Partner of OEA approval "including above the
threshold"; 0073 put `('admin','executive')` in the trigger; the TypeScript
still read `approver?.role !== "admin"`. Proven against the live trigger before
changing anything — an executive approving ₦5,000,000 against a ₦1,000,000
threshold is **allowed** by the database. So an MD was told to "ask an
administrator" for a payment the system would have accepted from them. The
check now *asks* (`my_approval_limit()`) instead of re-deriving.

📌 **The ledger layout refused executives entirely.** `oversight_roles()` grants
them ledger, bank-account and balance reads — a live check reads 135 entries as
the POC executive — and the nav lists Client Funds for them. Only the page said
"Finance access required". The policy said oversight, the menu said oversight,
one line said no.

📌 **The payment/ticket link existed and nothing used it.** `payments.ticket_id`
(0118) is populated on **0 of 18 rows**, because the vendor's own invoice route
checks it properly and the finance route — a direct insert from a form — had no
job field at all. Almost every real invoice arrives on paper, so almost every
payment was untraceable to the work it bought. That is not a display gap: B4
verifies delivery *against something*, and if nothing names what, the
verification is a checkbox. The rule now lives in a trigger below both routes,
and the payments screen names what is missing rather than leaving it unnoticed.

### The owner could not be paid

`create_rent_remittance` has existed since 0092b, was hardened against a
double-payout race in 0102, and is exercised by two suites — and was **called by
nothing outside `scripts/`**. Rent was demanded, collected, split and credited
to the segregated ledger, with no way for anyone to pay the landlord. The same
shape as the tenant's rent screen before 0110.

⚠️ Steps 3–5 of the transfer (claim → send → post) were **extracted** to
`lib/remittance-run.ts` rather than written a second time. Two copies of a
transfer path is how one of them ends up without the `unknown` branch — the one
that stops a double send after a gateway timeout. Both remittance suites pass
unchanged against the extraction.

The payout run is deliberately **one property at a time**, which is the opposite
of the choice made for approvals one screen away. An approval can be
reconsidered; a transfer cannot. Bulk belongs where a mistake is recoverable.

### Consolidation is the operator's, and nobody else's

A consolidated position is one figure built from several orgs' books — precisely
what B1 keeps apart. So it sits behind `caller_is_operator_admin()`, on the
operator portal beside the org directory, never as a tab on a brand's finance
page.

The gate is **inside the query**, so a brand administrator gets an empty set
rather than a refusal — decision 12's reasoning, because a refusal confirms
there is something worth refusing, and here that something is the existence of
the other organisations. Confirmed in the browser as well as the suite: the POC
finance approver loads `/orgs/consolidated` and reads "Nothing to consolidate".

Deliberately **not** written to `operator_actions`: that table records
interventions with a stated reason, and its own comment says it exists so
crossings can be listed "without filtering a million rows". An audit row per
page load would drown the signal it was built to preserve.

⚠️ And a limit stated rather than papered over: **no org has a `parent_org_id`.**
All five are flat. So consolidation today groups by delivery brand, which is
OE Group's actual shape, and does not pretend to a hierarchy nobody configured.

### Two suite flaws worth more than the features

Both found by running it, not by reading it:

- The first version **skipped a whole org when it had no vendor**. OEA has no
  vendor and OEA holds the only lease — so the single most important rule in
  the payout path ("a landlord is paid what was received, never what was
  billed") was never once exercised, on any org, while the suite printed ALL
  CHECKS PASSED. It now builds its own lease, unit and rent charge. **A check
  that quietly opts out when the data is thin is not a check.**
- A refusal assertion matched only its happy-path regex, so an unrelated
  failure (a missing temp-table grant) printed "!!! AN EXECUTIVE REMITTED A
  PAYMENT" — a screaming false alarm about a plumbing fault. Now tri-state:
  allowed, refused for *this* reason, or failed for another reason and
  therefore proving nothing.

New: `scripts/verify-finance-journey.mjs`. Adjacent suites green: payment-gate,
remittance, remittance-race, ledger, access-matrix, oversight-roles,
function-grants. Clean production build. `verify-reconciliation` fails on this
tree **and on HEAD** — Node cannot resolve a `.ts` import from a `.mjs` script,
the same harness limit as `verify-checkout-e2e`.

---

## All ten roles — the menu stops keeping its own copy of the rules

**Migration 0132 · 7 Aug 2026**

Read `docs/OE_Group_Phase1_Progress.UPDATED.pptx` for the remaining journeys.
The deck draws **seven** lanes; `user_role` has **ten** values. The three with
no lane — `executive`, `regional_manager`, `fm_ops_staff` — turned out to be
exactly the three that had drifted.

### The fourth instance of one defect

📌 Four times in two days an **application array of role names** has been found
disagreeing with the database it was supposed to describe:

1. the executive locked out of the ledger `oversight_roles()` grants them;
2. the executive refused an above-threshold approval decision 9 gives them;
3. the **regional manager** holding *fifteen* capabilities — `properties.write`,
   `assets.write`, `tickets.assign`, `people.invite`, `vendors.write`,
   `leases.write`, `units.assign_occupant` among them — and named in **none** of
   the navigation's arrays, so the product offered them no Properties, no
   Assets, no Vendors, no Leases and no People;
4. `fm_ops_staff`, who can be dispatched a job and *can* read it (verified live
   across every org), with no page to see it on.

Fixing a fourth instance one array at a time would have guaranteed a fifth. So
**the menu now asks the matrix** (`my_capabilities()`, 0132). Decision 7 made
privileges an operator-toggled matrix precisely so role names would stop being
hardcoded — and the menu had kept its own copy anyway. A capability the operator
grants now appears in that user's navigation without a deployment.

⚠️ What deliberately does **not** come from the matrix: the non-delegable
controls decision 7 names — payment approval, remittance, ledger, bank
configuration, audit visibility, admin invitation, permission editing. They have
no capability row, so they *cannot* be returned, and the app still checks them by
role. `non_delegable_controls` lists them so that distinction is legible rather
than remembered, and the suite asserts none of them has become a toggle.

### One correction caught before it shipped

Deriving purely from capabilities would have **removed** Properties and Assets
from the property owner, who holds neither capability and reaches both tables by
being a *stakeholder* on the property. A regression introduced by a cleanup is
the worst kind, so `role === "property_owner"` stays as an explicit clause with
the reason written next to it.

### Two roles given somewhere to be

- **`/dashboard/my-jobs`** — ops staff. `assignTicket` offers them, RLS lets them
  read what they are given, `notify_user` tells them it arrived — and the
  notification link was the only route to it. Same gap the vendor had before
  `/dashboard/my-work`.
- **`/dashboard/portfolio`** — the landlord. `landlord_statement()` was written
  in 0130 and wired to nothing: a report about the owner's money that the owner
  could not open, committed in the same turn that was closing exactly this kind
  of gap elsewhere. Worse, Statements branches on staff-vs-not, so an owner was
  shown the **tenant** view — service charges billed *to* them. An owner is not
  billed; they are paid.

### The test that had to be rewritten

`verify-role-surface` first held one expected menu per role and failed on
`finance_approver` reaching Lettings. **The test was wrong, not the product** —
finance is tier two of the OEA application review, so `applications.review_all`
puts them there legitimately.

The deeper flaw that exposed: a fixed grid *cannot* be right. The matrix is
operator-governed and per-org — the POC finance approver holds 8 capabilities,
OEA's holds 10, deliberately. A test asserting one exact menu would either fail
on legitimate configuration or force every org to be identical, which is the
opposite of what decision 7 built. It now asserts **REQUIRED** and **FORBIDDEN**
per role and leaves everything between them to the operator.

### The deck

`docs/OE_Group_Phase1_Progress.UPDATED.v2.pptx` — four new lanes (H Executive,
I Regional Manager, J FM Ops Staff, K Viewer), so all ten roles are drawn.
Written to a **new file**: the original was open in PowerPoint, and an in-place
write would have left a corrupt deck where a working one was.

Three existing lanes corrected, and one of them **downwards**: Lane E claims
*"Approve major spend"* as built. No owner can approve a payment —
`enforce_payment_transition` admits finance, admin and executive only, and B7's
owner row has no approval cell. Marked *"future · needs a board decision"*,
because a deck overstating what a board can check is the one error that matters.

New: `scripts/verify-role-surface.mjs`. Access suites green: access-matrix,
permissions, role-hierarchy, oversight-roles, viewer-access, role-workflows,
finance-journey. Clean production build.

> **Correction (same day).** Two entries above — and the commit messages that
> carried them — state that `verify-reconciliation` and `verify-checkout-e2e`
> fail because "Node cannot resolve a `.ts` import from a `.mjs` script". That
> is wrong. Both scripts say `Usage: npx tsx …` in their own header; they were
> being run with bare `node`. Under `tsx` all four affected suites pass
> (`asset-import`, `asset-import-e2e`, `reconciliation`, `checkout-e2e` — the
> last needs the dev server up, which is what its "fetch failed" actually
> meant). **No harness limitation exists.** Recorded here rather than edited
> away, because "those two always fail" is exactly the belief that stops someone
> running them.

---

## The vendor could see the work and not touch it — and four open items closed

**Migrations 0133–0134 · 7 Aug 2026**

### The reported defect

A live screenshot from `tfmlportal.com/dashboard/my-work`: a contractor with one
assigned job, and no way to accept, decline or complete it.

📌 The controls existed. `VendorJobActions` — accept, decline, mark complete —
has sat on `/dashboard/tickets/[id]` since 0118, wired to gated server actions
that check the job is actually theirs. But a vendor has **no Requests entry in
the navigation**, and "Current jobs" on their own page rendered each job as
plain text in a five-column table: no link, no buttons. So the contractor's home
screen listed work it gave them no way to act on, and the only route to the
controls was a URL they had to already know.

Fixed by putting the actions where the vendor already is. Cards rather than
table rows, deliberately: a contractor reads this on a phone between jobs, and a
five-column table with a button in it is a desktop shape. The actions are the
**same server actions, imported** — one write path, a second surface on it.

Verified live: Accept moved the job `Assigned → Acknowledged`, the button left,
and the follow-on line appeared.

### 84 leaked fixture accounts, 11 of them operator admins

Flagged last turn as "11 stray accounts"; the dry run found **84** — including
eleven live administrators on the platform operator org, the most privileged
account type in the system. The guarded sweep in `seed-org-logins.mjs` already
covered every one and had simply never been run. All 84 gone; the operator org
now holds exactly one admin.

### A regression of my own, caught by a standing suite

`verify-operator-governance` failed with **"NOBODY AT THE ORG WAS TOLD"**.

0122 stopped a signed-in caller writing notifications into another organisation —
a real B1 breach, proven live. That fix was right and stays. What it *also*
stopped was the one crossing the board sanctions: `operator_break_glass_invite`
ends by telling the target org's administrators that OE Group has just issued an
emergency admin invitation into their organisation. The caller there is a
signed-in operator admin, so `auth.uid()` is set and the org check silently
returned 0.

⚠️ The consequence is precisely backwards. `operator_actions`' own comment says
the crossing must be "visible to the organisation it was done TO — silent
operator access is the thing auditors object to". A boundary that silences that
announcement **made operator access silent**, which is the one outcome decision 7
exists to prevent. Fixed by naming the exception (`caller_is_operator_admin()`)
rather than widening the rule.

### Decision 8's last unbuilt clause

> "Assets state their scope. `assets.scope` ∈ `unit | property | site`. 'Shared'
> is a stated fact, never an absent `unit_id`."

The hierarchy half shipped in 0121; this column never did. So `unit_id is null`
still meant three different things at once — building-wide plant, site-wide
plant, and *a row nobody finished filling in* — and no query could separate
shared plant from incomplete data.

Built with the consistency trigger that makes the column mean something (a
unit-scoped asset must name its unit; a shared one cannot be pinned to one), and
`assets_serving_unit()`, which is the query the column exists for: a unit's own
assets **plus** the shared plant above it. `unit_id IN (...)` structurally cannot
answer that, which is how shared plant disappears from per-unit reports.

⚠️ Scope is **derived, not defaulted**, in both the form action and the import
validator. The database default is `property`, so a row naming a unit and saying
nothing about scope would have been refused by the new trigger — the user
meeting a raw constraint error for a field they were never asked about. Existing
spreadsheets, which have a Unit column and have never heard of scope, import
unchanged. `site` is the one value never inferred: nothing in a spreadsheet
distinguishes it from `property`, and inferring it would put an asset outside
the property it is on.

### Two suites that were never broken

Recorded above — twice — as failing on "a Node ESM harness limit". They were
being run with bare `node`; both headers say `Usage: npx tsx`. Under `tsx`,
`asset-import`, `asset-import-e2e`, `reconciliation` and `checkout-e2e` all pass.
Corrected in place above rather than quietly edited, because "those two always
fail" is exactly the belief that stops someone running them.

### Left open, deliberately

**Owner sign-off on major spend** (deck lane E4). Standard property-management
practice is that the *management agreement* sets a repair threshold above which
the landlord consents **before work is commissioned** — not consent to release a
payment. Building it as payment approval would contradict decision 9's
separation and B7's owner row, which is why the deck now reads "future · needs a
board decision" rather than being quietly implemented. Building it as work-order
consent needs a cost estimate on the ticket, which is new product surface and
new board scope. **That shape is the board's to approve, not mine to assume.**

---

## A 404 that was never a missing page

**7 Aug 2026 · no migration**

Reported from production: filling in the asset register and being redirected to
the new asset gave **"This page could not be found"** — for a row that existed,
that the user could read, and that RLS was perfectly happy to return.

### The cause

`PGRST201`. `assets` carries **two** foreign keys to `properties` —
`assets_property_id_fkey` and the composite `assets_property_same_org_fk`
(0057) — so the unqualified embed `properties(name, address)` is ambiguous and
PostgREST refuses to guess. Naming the constraint resolves it.

The asset **list** was broken identically, as were **People → Invitations** and
**People → Occupancy**, which embed `properties(name)` through `units` — the
same double-FK shape. Four pages, one cause, and the register had been
unreachable for as long as that constraint has existed.

### Why it survived so long, which matters more

📌 **The page threw the error away.** `const { data: asset } = await …` keeps the
data half and discards the `error` half, so a malformed query arrived as `null`
and became `notFound()`. **The product said "this page does not exist" when it
meant "this query is wrong"** — sending anyone investigating to hunt for a
missing route. The page now throws on a query error and reserves 404 for a
genuinely absent asset.

📌 **No suite touched it.** Every asset suite queries the table directly, because
that is what testing RLS requires. None asked for the *shape the page asks for*,
so the join could break without a single check going red.

### The guard, and the flaw in the guard

`scripts/verify-embeds.mjs` extracts every `.from(…).select(…)` embed from
`app/` and `lib/` and runs it against the real schema — 14 distinct embeds
today.

⚠️ Its first version used `{ head: true, count: "exact" }`, reasoning that a HEAD
request resolves the join without returning rows. It does — but **a HEAD
response carries no body**, so PostgREST's error document never arrives and
supabase-js returns an error with an empty `message` and no `code`. All four
genuinely broken embeds fell through to the "unclassified" branch, printed as
harmless NOTEs, and **the suite reported ALL CHECKS PASSED while looking
straight at them.** A `limit(1)` keeps the response cheap and the error document
intact. Caught only because I already knew the answer and the suite disagreed —
which is the whole argument for confirming a new check can actually fail.

A schema-level break is now a red suite rather than a customer's 404.

---

## The notification told the truth; the page it pointed at did not

**Migration 0135 · 8 Aug 2026**

Reported from production: the welcome notification says *"Your account is ready.
You can change how we reach you in Settings"* — and a tenant opening Settings
was told **"Administrator access required"**.

### The preferences were never missing

`update_my_notification_prefs`, the channel picker, phone and Telegram fields,
the WhatsApp/SMS/email/Telegram toggles — all built, all working, all reachable
by every role. What was wrong is that **`/dashboard/settings` IS the branding
page**, which is administrator-only. So every non-admin followed a sentence the
product had just written them, arrived at a refusal, and reasonably concluded
Settings held nothing for them. Their preferences were one unlabelled tab away.

📌 **A refusal is right when the user chose the page; it is wrong when the
product chose it for them.** The section index now redirects a non-admin to
their own settings. `AdminOnly` stays on every admin sub-route, for anyone who
types one directly.

### The gap the report uncovered on the way

**A person could not correct their own name.** `users` carries a SELECT policy
and *no UPDATE policy at all* — deliberately, because the row holds `role` and
`org_id`, the two columns every RLS policy in the system reads, and a
self-service UPDATE on it is one careless `with check` away from letting someone
promote themselves. So self-writes go through narrow definer functions, and
exactly one existed.

`update_my_profile` (0135) is the second, and touches `full_name` and nothing
else:

- **not `role` or `org_id`** — a function that could reach them would be a
  privilege-escalation path wearing a friendly name;
- **not `email`** — that is an authentication identity, not a display field.
  Changing it without re-verification would let someone redirect their own
  password reset.

Both are shown read-only on the page with the reason stated, because "why can't
I edit this?" is the next question and a greyed-out box does not answer it.

### What each role now has

Everyone: **My Profile** (name, plus their email/role/organisation for
reference) and **My Notifications** (channels, phone, Telegram). Administrators
keep the seven organisation tabs behind them. Nothing else moved — the
organisation-configuration tabs are org config, and decision 7 keeps bank
configuration and the payment gate non-delegable regardless of how welcoming a
settings page looks.

The profile page also states what the notification screen implies: *"Currently
by email — no phone number on file, so WhatsApp and SMS cannot be used."* A
channel that silently cannot fire is worse than one that says why.

`verify-role-surface` gained section D: every role in every org renames itself,
**and its role and org are unchanged afterwards** — 36 combinations, plus a
check that a tenant cannot rebrand the organisation. Verified live as a TFML
tenant: Settings lands on My Profile, and the channel picker is fully editable.

---

## A refusal that says why, reaches the vendor, and can be undone

**Migrations 0136–0137 · 8 Aug 2026**

Four questions asked of the live build. One had an answer; three did not.

### Who does what (the one that was already true)

From `enforce_payment_transition` and `payments_update`, asserted now rather
than described:

| Step | Who |
|---|---|
| Submit invoice | the vendor themselves, or finance/admin keying in a paper one |
| **Service verification** | the FM/PM or regional manager **scoped to that vendor** — plus admin/finance/executive |
| **Performance check** | triggered by a person, **decided by the number**: the vendor's composite AURA score against the org's `min_performance_score` |
| **Approve** | finance, admin or executive — and above the threshold, admin or executive only (decision 9) |
| **Remit** | finance or admin **only**. Never an executive — oversight authorises, finance disburses |

### The three that did not

📌 **A rejection recorded no reason.** `payments` had no such column. An invoice
could be refused and nothing, anywhere, said why.

📌 **Nobody was told.** Approval notifies the vendor through the B8 cascade;
refusal notified no one. The invoice simply went quiet.

📌 **`rejected` was terminal.** The state machine listed no transition out of
it. An invoice refused in error — a mis-click, or a performance score low only
because the tenant's half of an evaluation had not landed yet — could never be
corrected, for work that had genuinely been done. The screen said *"Blocked —
vendor failed the performance gate. No remittance possible."* and offered
nothing.

Worse, that was the **only** rejection the product could produce: there was no
manual reject at all. A verifier looking at work that plainly had not been done
had no button for it, and the honest options were to leave the invoice sitting
or to run a performance check they knew would fail.

### What now exists

`reject_payment` takes a mandatory reason (≥10 characters), records who and
when, and notifies the vendor with it. The reason requirement is **in the
trigger too**, so a direct UPDATE cannot produce a silent dead end either.

`reopen_payment` is the appeal outcome: `rejected → pending_verification`,
finance or admin only, **with `service_verified_at` and `performance_validated`
cleared**. A reopened invoice that kept its old verification would walk straight
to approval carrying a judgement made before the reason for refusal was known.

⚠️ The appeal is deliberately **not** a new subsystem. Correcting and re-issuing
a refused invoice is the standard commercial path and already worked — both
`submit_vendor_invoice` and `payments_work_order_valid` treat a rejected invoice
as not blocking a fresh one. Nothing told the vendor that, which was the real
defect. Reopening covers only what resubmission cannot: a refusal that should
never have happened.

### Surfaced at the touchpoints

- **Vendor** — each invoice now says *who holds it*: "with your facility
  manager, to confirm the work", "cleared the gate — with finance to approve",
  "not approved — see the reason, then resubmit". A contractor reading
  "recommended" cannot tell whether that is good news or a queue.
- **FM/PM** — a first-gate queue on Payments: *"N invoices awaiting service
  verification — nothing moves until someone confirms the work was delivered.
  This is the first gate, and it is yours."* Previously a raised invoice landed
  in the same undifferentiated list as everything else.
- **Payment detail** — Reject, with a reason box, at every live stage; and
  Reopen for finance/admin on a rejected one.

### The suite found a defect in my own function

On its first clean run, a vendor attempting to reopen was told **"only a
rejected invoice can be reopened (this one is rejected)"** — self-contradictory,
and useless to whoever reads it.

Cause: these functions are SECURITY INVOKER by design, so `payments_update`
decides who may act — and **a zero-row UPDATE under RLS is ambiguous**. It means
either "wrong status" or "not your invoice", and both were reported as the
first. 0137 distinguishes them. Nothing is disclosed by doing so: the row was
already readable to the caller under the same policies.

Three fixture faults were also mine, each caught by disbelieving a green line:
`$3` used as three different types in one statement (nine phantom product
failures); node-pg returning only the last result of a multi-statement query;
and section B run against the POC's **deactivated** vendor login, where
`notify_user` declines by design — the same trap that caught
`verify-role-workflows` earlier in this build.

New: `scripts/verify-invoice-appeal.mjs`. Money suites green: payment-gate,
remittance, vendor-journey, finance-journey, role-surface, embeds. Clean build.

---

## Day 12 — security pass, NDPA pack, UAT script

**8 August 2026 · no migration**

The final roadmap stage. Three deliverables, one real finding, and one false
alarm I nearly published.

### The finding: retention was specified, built, tested — and never ran

📌 Decision 3 of the OEA expansion locks **90-day purge** of rejected and
withdrawn applications. `0082` sets `purge_after` on every rejection. `0062`
wrote `purge_expired_applications()`, which nulls the PII and keeps an
anonymised stub proving a decision was made. `verify-application-review` asserts
the date is correct.

**And `vercel.json` carried two cron jobs, neither of them this one.** The
function was called by nothing — the same shape as `create_rent_remittance`
earlier in this build, and with a worse consequence: every rejected applicant's
identity documents, address, employment details and next of kin would have been
retained indefinitely, by a system whose own consent copy promises otherwise.

**Deletion that is scheduled but never executed is not a retention policy; it is
a record of one.**

Fixed: `/api/jobs/purge-applications`, daily at 03:00, authenticated on
`CRON_SECRET` like its siblings, idempotent, and logging how many were due —
recorded *before* the purge, because afterwards there is nothing left to count
and "0 purged" cannot be distinguished from "did nothing". Proven end to end:
name and email become `[purged]`, phone null, `form` and `sensitive` `{}`,
`purged_at` stamped, stub retained.

### The false alarm I nearly published

`verify-security-posture` first read the **grant** tables and reported:

> ANON CAN WRITE *(68 tables)* · ANON MAY EXECUTE 237 UNEXPECTED FUNCTIONS ·
> audit_log is mutable by anon · **3 CHECKS FAILED — do not go live**

⚠️ **Every one of those was wrong.** The grant layer is the wrong thing to
measure on Supabase: `ALTER DEFAULT PRIVILEGES … GRANT ALL ON TABLES TO anon,
authenticated` is the platform's standard posture, and **RLS sits on top of it**.
Of the 237 functions, 24 were triggers, 194 were `SECURITY INVOKER`, and all 22
definer functions were public surfaces or internally gated —
`operator_provision_org`, the worst-looking, opens with
`if not caller_is_operator_admin() then raise`.

Publishing a "do not go live" verdict built on that would have been worse than
publishing nothing. The check now does what an attacker would: holds the anon
key and tries. 17 tables, a delete and an update against the audit trail, an
insert, and the provisioning function — all refused or empty.

### Deliverables

- **`DAY12_SECURITY_PASS.md`** — verdict, the database boundary (30 checks), the
  application boundary (the standing suites), dependencies, secrets, and an
  explicit section on **what this pass does not cover**, because a security
  report implying more coverage than it has is itself a risk.
- **`NDPA_COMPLIANCE_PACK.md`** — every claim marked ✅ enforced / 📄 documented /
  ⛔ open, grounded in code checked while writing. Thirteen unsigned processor
  DPAs are the largest gap; the breach procedure does not exist and should
  before go-live.
- **`UAT_SCRIPT.md`** — all ten roles plus the operator, with the **"must
  refuse"** rows called out as mattering equally: every one of them was a real
  defect at some point in this build.

### Dependencies — a deferral, argued not waved through

`next@14.2.35` carries 21 advisories and the fix is a **major** bump to 16.x.
Applicability was assessed rather than assumed: the Image Optimizer advisories
name self-hosted deployments (this is Vercel, with no `remotePatterns`
configured at all); the i18n middleware bypass needs Pages Router **and** i18n
(this is App Router, no i18n); the custom-server SSRF needs a custom server;
the CSP-nonce XSS needs nonces. What genuinely applies is the Server Components
DoS class and RSC cache poisoning — availability and cache-correctness, not
disclosure.

**Recommendation: schedule Next 16 as the first post-go-live item, with its own
regression cycle.** Two major versions days before cutover trades largely
non-applicable advisories for a large untested regression surface across a
system that moves client money. Every non-breaking fix was applied.

### Still open, and honestly so

The approved-application **6-year** clock has no job (years away, not a
blocker). No subject-access export. No documented bias audit of document
extraction. No external penetration test or load test — both need production
plus, for the pen test, a third party and written authorisation.

---

## Account recovery — and a repo that disagreed with its database

**Migration 0139 · 8 Aug 2026**

Pulled PC2's notification work (`d33aac6` — chat-channel notification parity,
the dispatch cascade, and a notification that cannot outlive its ticket), then
found something else on this machine.

### An applied migration that was never committed

`0139_forgot_password_and_mfa_backup_codes.sql` was **applied to the shared dev
database and untracked in git**, along with `app/reset-password/`,
`app/dashboard/settings/security/`, `lib/mfa.ts` and edits to the sign-in panel
and settings nav.

📌 That state is worse than either half alone: the database has tables the repo
does not know about, so the next clone builds an app that does not match the
schema it will connect to, and nobody finds out until something reads a column
that "does not exist" in code that never mentions it.

### Reviewed before shipping, because it is authentication

Password reset touches the one thing this system cannot get wrong, so it was
read rather than trusted. It holds up:

- 32-byte token, **SHA-256 at rest** — a database read cannot be replayed as a
  working link (same shape as invitations, 0020);
- one-hour expiry, single-use, **and every sibling token for that account
  invalidated** on use, so three requested links do not leave two live;
- marked used **only after** the password change succeeds — a failed update
  leaves the link usable rather than burning it silently;
- anti-enumeration throughout, **including on the rate-limit path**: a
  refusal that said "too many attempts" would itself confirm the address had
  been tried;
- rate limited per-IP *and* per-email, because mail-bombing one address from
  many sources is what a per-IP limit alone misses;
- built on this app's own branded Resend path, not Supabase's built-in mailer,
  which is unconfigured here and would silently not deliver.

⚠️ **One real gap, fixed:** it did not revoke existing sessions. Supabase's
`updateUserById` changes the credential and leaves live refresh tokens alone —
so an attacker who already had a session kept it, and "I think someone got into
my account, I've changed my password" is exactly the case this flow exists to
answer. **Changing the lock while the intruder still holds a key is not a
reset.** Now `admin.signOut(user, "global")`, best-effort and deliberately
non-fatal: the password has already changed by that point, and failing the
action would tell the user their reset did not work when it did.

### A process note on myself

Three separate reads during this investigation were wrong — "lib/mfa.ts
MISSING", "no security settings page", "the MFA half is not wired" — all taken
while a `git stash pop` was still restoring files. I reported two of them to the
user before catching it. **A file listing taken mid-restore is not evidence**,
and the fix was to stop inferring and run `git ls-files --others` once, cleanly.

`_tmp-verify-reset-mfa.mjs` was promoted to `verify-account-recovery.mjs`: it
proved the feature end to end (including signing in with the new password and
restoring the seeded one) but as a scratch file it would not have survived.

---

## The notification 404, the second time — and the inbox it should have been

**Migration 0145 · 8 Aug 2026**

Pulled PC2's window first: the 0806 audit (which found two gaps in code from
this machine — see below), the cross-org cascade leak, `0143`'s parent-relocation
guard, `0144`'s cross-org assignment guard, and the demo-project denylist. All
applied here; `.env.local` checked for the drift PC2 found on theirs — **clean,
both halves on the Phase-1 dev project.**

### Why 0138 did not close it

`0138` deletes a notification when its subject is deleted, keyed on
`entity_type` + `entity_id`. Checked against live data: **zero orphans by that
key.** Its triggers work exactly as written.

📌 But `notify_user`/`notify_role` take those two columns as trailing **optional**
arguments, and several callers — `0118`'s work-order notifications among them —
build a link as `'/dashboard/tickets/' || p_ticket_id` and stop. **84 rows
carried a UUID in the link and a NULL `entity_id`; 66 of those links were dead**,
across four roles and two organisations.

**A fix that keys on a field the writer is not required to populate is a fix for
the cases that happened to populate it.**

Editing those three call sites would not have held — the next `notify_role(...)`
with a link and no entity reference reintroduces it silently. So the derivation
moved **into** the notify functions: a link carrying an id now yields its own
`entity_type`/`entity_id`. Every existing caller is covered without being
touched; every future one without being told. Backfilled, then 0138's own
cleanup finally had a key to match on. **66 → 0.**

### The half no cascade could ever have fixed

Reading every notification **as its actual owner** across every org and role
turned up 9 more that still would not open — and these are a different problem
entirely. The subject **exists**; the reader cannot see it.

`notify_role` broadcasts to every holder of a role in the organisation, while
RLS scopes each of them to a subset — an FM/PM is property-scoped on tickets and
vendor-scoped on payments. So an FM assigned to two properties is told about a
ticket on a third. **That is the real root of the reported 404, and it was never
a dangling reference at all.**

Closed at the surface: `my_notifications()` computes `target_live` as the
**caller** (SECURITY INVOKER, precisely so RLS applies), and both the inbox and
the bell render a dead link as plain text rather than a link. Wording is *"not
available to you"*, not *"no longer available"* — for most of these the record
is alive and well, it simply is not theirs, and telling someone an existing
record was deleted is a different lie from the 404, not a fix for it.

⚠️ **Outstanding follow-up, quantified rather than tolerated:** narrowing the
broadcast at the notify site so people are not told about work outside their
scope. The suite reports the count as a NOTE — a design consequence should not
turn the build red, but it should not go unmeasured either.

### The inbox

`My Notifications` was a settings form. It is now the inbox: **Needs you** and
**Already dealt with**, last 30 days, plus anything still unread whatever its
age — an untreated notification does not stop mattering because it got old.

Retention is enforced in two places, deliberately not duplicates:
`my_notifications()` **hides** old read rows so the list shows what still needs
a person; `/api/jobs/purge-notifications` (03:15 daily) **deletes** them so the
table stays bounded. Hiding alone leaves rows forever; deleting alone makes the
inbox depend on a job having run.

Channel preferences moved to a **collapsible** section on My Profile — expanded
automatically when nothing is configured, since a person with no channel on is
exactly who needs to see it.

New: `scripts/verify-notification-links.mjs`, which checks the **shape** (every
id-bearing link declares its subject) and not merely the symptom, because the
shape is what stops the next caller reintroducing it.

---

## Pen-test and load-test setup

**8 Aug 2026 · no migration · configured, not yet run**

Prepared per `DAY12_SECURITY_PASS.md` §6, which listed the external pen test and
load test as the two things that pass did **not** cover.

### The constraint that shaped all of it

Most applications take an active scan casually. This one cannot, for two reasons
invisible from outside:

📌 **Next.js Server Actions are POSTs to the page's own URL**, identified only by
a `Next-Action` header. An active scanner replays captured requests with mutated
parameters — so a captured *"Send payout"* or *"Approve payment"* carries a real
finance session, and the replay satisfies the B4 gate **exactly as the original
did**. `/api/webhooks/payments/*` accepts signed gateway callbacks a replay
would turn into a collection that never happened, and `/api/jobs/*` includes the
job that purges personal data.

So `automation-full.yaml` excludes money, job, webhook and account-recovery
routes, and `scripts/pentest-preflight.mjs` refuses to clear a target where
those exclusions would not be enough: a **live** gateway key, the frozen POC
project, or a database that has ever actually **sent a remittance**.

Proven by running it: the dev target is **cleared for baseline** and **refused
for full** — *"1 remittance(s) have actually been SENT from this database — it
is not a scan target"*. The gate fires before Docker is even checked.

⚠️ **The trade, stated in the runbook rather than buried:** the active scan
therefore says *nothing* about the payment gate. That is deliberate — the gate
is tested far more precisely by `verify-payment-gate`, `verify-remittance`,
`verify-remittance-race`, `verify-invoice-appeal` and `verify-role-surface`,
which exercise it as real users with real roles and assert the refusals. A
scanner guessing parameters is both a worse test of that surface and a dangerous
one.

### Choices worth recording

- **Active scan runs as a LOW-PRIVILEGE user.** Scanning as an administrator
  answers *"can an admin do admin things?"* while doing maximum damage. The
  question worth asking is whether a tenant can reach what they must not.
- **The spike test inverts the usual pass condition.** Under a burst the correct
  behaviour is not "serve everything" but "shed predictably and keep the sign-in
  page alive" — a system that tries to serve a 20× stampede in full falls over
  instead of degrading. So `spike.js` asserts **zero 5xx** and treats 429s as
  success, while `journey.js` treats any 429 as a misconfiguration.
- **`rate-limit.js` fails if nothing is refused.** `lib/rate-limit.ts` fails
  *open* everywhere except remittance, which means a misconfigured limiter — or
  a missing Upstash credential on the new production project — looks exactly
  like a healthy system until someone abuses it. This is the check that tells
  them apart, which is why it belongs against production after cutover.
- **k6 is read-only.** Every request is a GET. A load test that fired Server
  Actions would create thousands of tickets, invoices and notifications in
  whatever database it was pointed at. `journey.js` doubles as an
  anonymous-access assertion: `/dashboard`, `/dashboard/payments`,
  `/dashboard/ledger` and `/orgs` must never answer 200 without a session.
- **No nuclei, sqlmap or Burp**, deliberately. Each additional tool is another
  set of payloads that could reach a Server Action, for ground ZAP plus the
  suites already cover on this stack.
- **The pre-flight is invoked inside the runner, not chained with `&&` in
  package.json.** `&&` and `$npm_config_target` behave differently in PowerShell
  and bash, and a safety gate that silently does not run on one machine is worse
  than no gate. Both runners work identically from either.

Handover-ready: `security/README.md` carries install steps, the ordered
sequence, which step is safe against what, expected false positives not to
chase, and a rules-of-engagement table to complete before the external test.

**Discoverability follow-up (same day).** Asked whether PC2 could actually find
`security/README.md`. Checked rather than assumed, and the honest answer was
**no**: the only reference anywhere was one line at position 4755 of this
journal — a file nobody navigates by.

Worse, the check surfaced that the repository's **root `README.md` was still the
unmodified `create-next-app` boilerplate** after an entire Phase-1 build. Anyone
cloning this — a new developer, an auditor, the second machine — opened it and
learned how to scaffold a Next.js app.

📌 **Handover material that is not linked from where people start is not
handover material.** Writing the runbook was the smaller half of the job.

Fixed at the four entry points that actually get opened: a real root `README.md`
(a "you are… / read this" table, the commands, the layout, and the note that the
database is the boundary); `HANDOFF.md`'s document index — which also had the
role count stale at **9** when there are ten; `DAY12_SECURITY_PASS.md` §6, where
"no external pen test" now says the tooling is *unrun rather than unbuilt*; and
the `GO_LIVE_CHECKLIST.md` line that already named ZAP and k6 without saying how
to run them, now carrying the active scan's window — after cutover, before the
first client.

## A remittance names the account the money left

Client Funds gained a print function, and answering a second question about it —
"what is the *Settings* → Client Funds tab actually for?" — turned up something
neither question was about.

`remittances` had no `bank_account_id`. Money going out was tied to a bank
account only by inference: `record_remittance_sent` re-derived "the" client-funds
account at posting time via `collection_bank_account(org)`, while reconciliation
compares a statement against `bank_accounts.ledger_account_id`. The two agreed
because `bank_accounts_one_client_funds_per_currency_uidx` permits exactly one
active client-funds account per currency — so the correctness of every payout
reconciliation rested on a uniqueness index nobody would think to re-read before
relaxing it. A second Naira account (a new bank, a migration between banks) and
payouts would post to whichever row `limit 1` returned, matched against a
statement they never appeared on. No error; the books would simply be about a
different account than the money.

📌 **An invariant defended only by an index that someone may relax is not
defended.** The index is a fine rule; resting a money trail on it without saying
so is not.

Two defects fell out of the same inference, both fixed in `0146`:

- `collection_bank_account(r.org_id)` was called with **no currency**, so it
  defaulted to NGN — as did the `canonical_ledger_account` calls beside it for
  the liability and the fee. 0103 gave every money-**in** path its own currency
  and never reached this one. Nothing has mis-posted: `payments` carries no
  currency and Paystack Transfers is Naira, so every remittance in existence is
  NGN. It would have mis-posted the first time one was not.
- A remittance could be created for an org with **no configured client-funds
  account at all**, failing only at posting time — after the transfer had been
  handed to the gateway.

The fix stops inferring. `remittances.bank_account_id` is stamped at creation,
`not null`, backfilled across every historical row, and posting uses *that*
account rather than re-deriving one. `client_funds_bank_account()` **raises on
ambiguity instead of ordering its way out of it** — the same shape as
`auto_match_statement_lines`: exactly one candidate, or a person decides. Relax
the index tomorrow and you get a refusal naming the choice, not a silent
mis-post.

The rule is a **BEFORE INSERT trigger, not three edits**. There are three insert
paths today (`create_vendor_remittance`, `create_rent_remittance`, and the older
`create_landlord_remittance`) and the next one would have been the fourth place
to remember. It also refuses another org's account, an *operating* account —
client money leaves the segregated one — a currency mismatch, and any attempt to
re-point a payout that has already posted.

`verify-remittance-account.mjs` holds it: 12 checks, including that the account
named is the ledger account the posting lands on and the one reconciliation
compares against. One check was wrong before the code was: it hardcoded USD as
"a currency with no account", and the fixture org has a USD account (0103), so
correct behaviour read as a failure. The test now picks a currency the org
genuinely holds none of.

---

## Two ways out, one gate — the approval chain (0149–0153)

The board asked for a tiered, multi-stage approval chain on outbound payments.
Reading the code first turned the shape of the request inside out twice.

### The threshold governed itself (0149)

Decision 16 broke the disbursement concentration in August: an admin who
approves a payment can no longer release it. It left the other half standing.
`payment_settings.approval_threshold_amount` was writable by any administrator,
and `enforce_payment_transition` reads that number to decide whether a payment
needs executive sign-off. So an admin meeting a ₦5,000,000 payment could raise
the threshold to ₦10,000,000, then approve it alone — three legal steps, no
refusal anywhere, and an audit trail that only reports the fact afterwards.

📌 **A control that only produces evidence after the money has gone is a
report, not a control.**

0072b had already written the principle — *"approving against a threshold you
can raise yourself is not an approval"* — to justify keeping the threshold away
from the MD. It was never applied to the administrator, who is the role the
escalation escalates *to*.

The obvious fix is a role above `admin`, and the reference artifacts proposed
exactly that. `0078d` refused to add one on purpose: *"the thing this system
deliberately does not have"*, because an org that cannot appoint its own second
administrator eventually asks someone with database access to do it. Decision 7
had already put governance of this kind on the operator portal. So the threshold
went where the rest of the governance lives, through one audited definer
function — and the guard is **column-level**, because the fee columns in the
same table are a commercial term the brand negotiates (decision 14), not a
control an auditor checks.

### One payable had a gate; the other had nothing (0151/0152)

Two paths move money. `create_vendor_remittance` ran the full B4 gate. Landlord
payouts ran `assert_may_disburse` and **nothing else** — no approver, no
threshold, no second pair of hands. One finance approver, acting alone, could
release a landlord's entire collected rent for a property. It is custodial
client money and it had strictly weaker controls than a vendor's invoice for a
light fitting.

📌 **That asymmetry was nobody's decision. It is what happens when a second
payout path is added beside the first and the gate is not carried over.** Task 2
as briefed said "all outbound payments" and expected the answer to be "only
vendor remittance exists"; the honest answer was that a second one existed and
had been unguarded since 0092b.

Four adaptations away from the reference implementation, each because the live
schema said so:

- **Naira, not kobo.** Every money column here is `numeric(14,2)`.
- **The stages are hardwired.** Decision 7 lists payment approval among the
  controls that "never appear as toggles"; a per-org table of stages is exactly
  such a toggle. The *amounts* are configurable, and only by the operator.
- **The ladder lives in `payment_settings`.** Tier 2's ceiling **is** the
  existing `approval_threshold_amount` — they were always the same number. A
  separate `approval_thresholds` table would have been a second resolver for one
  question, which decision 8 forbids in as many words.
- **The trigger overwrites the amount, the role and the tier** from the
  authoritative records. Refusing a wrong amount still trusts the caller to send
  one; there is now no value a caller can send that changes which tier applies.

`admin` resolves to tier 2 and `executive` to tier 3, which is decisions 16 and
9 stated as code rather than as prose.

### What the tests caught that review did not

- A `RAISE` that built its message with `||` on an unknown-type literal failed
  with *"malformed array literal"* — and the admin's write **was** refused, by
  that bug, one line before the authority check. A green test proving nothing.
- `operator_actions_action_check` was rebuilt from 0079's four values, silently
  dropping three added by 0083/0089. Same trap 0136 documents for function
  bodies: **the newest migration that touched a thing is the definition.**
- An RLS-filtered `UPDATE` returns success with zero rows, not an error. A check
  written against the error read "finance raised the approval limit" when
  finance had changed nothing. **A refused write and a write that hit nothing
  look identical from the client; only the data tells them apart.**
- `users_approval_tier_check` and `accept_invitation` were each correct alone:
  the constraint requires a tier for `payment_approver`, and the insert did not
  carry one. A `payment_approver` invitation could be issued, emailed and
  clicked, and would fail at the moment someone tried to accept it (0153).

### Sequencing that would have shipped broken

The landlord payout button created and sent in one press. With a chain between
those acts, every payout would have failed at the send step with "0 of 3
approval stages" — the control technically enforced and the feature unusable.
Split into `raiseLandlordPayout` and `sendApprovedPayout`. `sendCreatedRemittance`
also flattened every claim error into "already being sent", which would have
told someone their payout was in flight when it had been refused for want of an
approval — **a worse lie than an unhelpful error.**

`verify-approval-chain.mjs`: 49 checks, including all six band boundaries, the
forged-amount case, amount-tampering after approval, and the landlord gap.

## The suite that passed while the feature was unreachable (0155–0158)

`verify-approval-chain` passed 49 of 49 while the two roles it was written for
could not read a single payment. `payments_select` and `remittances_select` gate
on `oversight_roles()`; 0151 added `payment_audit_approver` and
`payment_approver` and never touched either policy. The Approvals queue would
have been empty for exactly the people it exists for, and `approve_payments()`
answered "not awaiting approval, or not yours to approve" for every id.

📌 **A suite that exercises a control with a key that ignores permissions cannot
tell you the permissions are missing.** Every insert in that suite goes through
the service role, which bypasses RLS by design. It proved the rules hold; it
could not prove the roles can reach the rows those rules govern. `0157` adds a
narrow `payment_chain_roles()` rather than widening `oversight_roles()` — that
function also governs ledger and audit visibility, and an approver has no
business in either.

Found by `verify-finance-journey`, not by review, and only because that suite
drives its assertions through real signed-in sessions.

### What else the change had knocked over

Six suites, one cause: approval stopped being something a role does.

- **`approve_payments()` (0127) had been dead since 0151 landed** — a shipped
  bulk-approve button that could no longer succeed at anything, because it wrote
  `status = 'approved'` directly. Rebuilt in `0155` as bulk *stage-3*, keeping
  the 200 cap, the per-row outcomes and the deliberately ambiguous "not yours"
  reason. `my_approval_limit()` kept its exact `TABLE(...)` return shape: two
  call sites read those three columns, and a scalar would have broken at runtime
  rather than at compile time.
- **`set_org_gateway_credential` refused the service role** (`0158`). It opened
  with `if auth.uid() is null then raise 'your session expired'`, and under the
  service-role client `auth.uid()` IS null — so every seed and fixture was told
  its session had expired. The mirror image of 0142's defect: that one treated a
  null actor as a person and wrote NULL; this one treated a null actor as an
  impostor and refused. Both come from assuming `auth.uid()` is always somebody.

### Killing a verification run has a cost

`npm run verify` buffers all output and exits 0 even when suites fail — the
first full run reported exit 0 with **13 of 84 failing**. Killing it mid-flight
then left probe fixtures behind that broke three further suites on the next run,
each with a message that read like a product defect:

- an orphaned `PROBERACE` property left ₦9,225,000 of collected-unremitted rent,
  which `verify-finance-journey` summed into a fixture it expected to be ₦450,000;
- a `PROBEFX-GBP` bank account and its postings left `verify-fx-collections`
  refusing at its own precondition.

📌 **`verify-fx-collections` can only pass once on a given database.** It
asserts GBP has no accounts, enables GBP, and never cleans up. That is not
visible until something interrupts a run. `scripts/lib/reset-fx-probe.mjs` now
clears that fixture, and refuses to touch any GBP account whose bank account is
not `PROBEFX-` prefixed — real ledger history is append-only and not a test
script's business.

And a genuine arithmetic disagreement, where the test was wrong and the product
right: `verify-remittance-race` computed its expected payout from
`management_fee_pct` alone, silently assuming `admin_fee_flat` was zero. True of
TFML and the POC org; **not** true of OEA, which carries ₦25,000 (decision 14).
The product had been deducting both and being reported as wrong for it.

Three suites (`verify-reconciliation`, `verify-fx-collections`, the asset-import
pair) import `.ts` modules and must run under `tsx`; invoking them with `node`
produces `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`, which reads as a broken suite
rather than a wrong command.

---

## A correction: what Day 11 actually was

Day 11 was cited earlier this session as a reason to stage a dashboard-wide
interactive-card redesign for later — decision 13's "internal dashboard's
polish stays in Day 11's existing production UX pass". Checked against the
actual commits (`6957137`, `a243c25`, `7896f49`, `ed042b4`, "Day 11 complete")
rather than the one-line summary: Day 11 was **correctness and accessibility**
polish — Module 5 (Audit & Compliance), dual-source vendor evaluation replacing
a free-typed number, confirmation dialogs on real money, loading states, work-
order photo/video evidence, and a **measured** WCAG AA pass that found and fixed
real failures (badge contrast down to 2.06:1, focusable-but-unnamed file
inputs).

None of that is an interaction-PATTERN change. Drawers, dropdowns, drill-downs
do not appear in it. So the caution against duplicating Day 11 was the right
instinct to check — a real board-minuted staging decision is not something to
route around on assumption — but the conflict it was checking for turns out not
to exist: Day 11 and a dashboard-wide drawer/dropdown pass are different kinds
of work that happen to share the word "polish". Corrected here rather than left
standing, since the wrong caution given confidently is its own kind of drift.

---

## The cleanup that never cleaned up — confirmed fixed

`b373b01` fixed `verify-approval-chain.mjs`'s teardown: `payment_approvals`
cannot be deleted by anyone (`trg_approvals_append_only`, 0151, fires on DELETE
regardless of caller, service role included — the control working as intended,
"a decision is never deleted"). Both the suite's start-of-run sweep and its
teardown tried to delete probe accounts anyway; supabase-js *returns* the error
rather than throwing, neither call read it, so every run since 0151 silently
failed to delete the approvals, then failed on the accounts those approvals
reference (foreign key), then reported a clean teardown regardless. Seventy
probe accounts had accumulated before anyone noticed — surfaced only because a
network outage made the failure noisy. The fix: delete what can genuinely be
deleted, deactivate the rest (same answer `seed-org-logins.mjs` already reached
for the same reason), and report which happened instead of leaving it implied.

That commit landed with an open flag — network dropped mid-run, so the fix was
checked by syntax and by the manual 2/68 split against the 70 stranded
accounts, not by a real end-to-end pass. Re-run today: clean, full 12-section
suite green (tier ladder, stage ordering, role gating, decision 16's threshold
rule, amount-tampering, 0175 re-approval, landlord payouts, append-only,
cross-org isolation), and the teardown itself now reports correctly —
`3 probe account(s) removed, 8 deactivated (they authored append-only approvals
and cannot be erased)` — rather than the prior silent no-op. Flag cleared.

---

## The full suite, and the flat admin fee's third and fourth victims

`npm run verify` — 88 suites — came back 9 failed. Seven were the same LAN-level
network drop already diagnosed once this session:
`verify-leases-and-rent` (timed out at 300s), `verify-ledger`,
`verify-logo-storage`, `verify-notifications`, `verify-operator-governance`
(all `fetch failed`), and `verify-notification-links` (`connect ECONNABORTED
192.168.68.105:5432`). That last one is the tell — `SUPABASE_DB_HOST` is
`aws-1-eu-west-2.pooler.supabase.com`, and 192.168.68.105 is a LAN address, not
an AWS one. When the WAN link actually drops, this router answers every DNS
query with itself rather than failing the lookup, so `pg.Client` dialled the
router on port 5432 instead of the pooler — and `pg.Client` is created here
with no `connectionTimeoutMillis`, which defaults to **no timeout**, so the
suite hung rather than erroring. All seven passed clean on re-run once
`nslookup` confirmed the hostname was resolving to AWS again.

The other two were real, and both were the admin_fee_flat omission
`verify-remittance-race` already found once this build — reproduced twice more
because it lives in a locally-computed constant in each suite, not a shared
helper:

- **`verify-rent-money`** (5 checks) — `FEE` was `management_fee_pct` only.
  `record_collection` posts ONE combined `fee_income` line (mgmt + admin
  together, `0092`), so every fee_income/landlord-share/remittance comparison
  in the suite was short by OEA's ₦25,000. Fixed by adding `TOTAL_FEE = FEE +
  admin_fee_flat` and using it everywhere the ledger's combined posting is
  compared against — including section B, which now reads
  `admin_fee_amount` off the snapshot row itself rather than assuming it's
  zero, and section D's remittance total (2.5×(RENT − TOTAL_FEE), not
  2.5×(RENT − FEE)).
- **`verify-rent-demands`** (1 check) — `landlord_net_amount` compared against
  `amount − management_fee_amount − 0`, a literal hardcoded zero where
  `admin_fee_amount` belonged (0091's `raise_rent_charge` subtracts both).

Three appearances of the identical shape — a test author reads
`management_fee_pct`, forgets `admin_fee_flat` exists because it is zero on
every org except OEA — is a pattern, not three unrelated typos. The fix each
time is one line different from the last; nothing here yet stops a fourth.

A fourth failure category, found while re-running `verify-lettings-grants` in
isolation (its *original* run had also just been network noise): `orgs` had
gained `vendor_enhanced_kyc_threshold` (`0164`, vendor self-service KYC
tiering, granted `update` to `authenticated`) since this suite's ALLOWED/
EXCLUDED classification was last written. The suite did exactly what its own
comment says it exists to do — flagged the column as unclassified rather than
silently passing or silently failing — and is now updated to include it.

📌 Two lessons, not one. First: a suite timing out or throwing `fetch failed`
is not evidence of a product defect — check whether the *transport* failed
before reading the failure as the *assertion* failing, same as the
`verify-lettings-grants` timeout-vs-permission distinction already built into
that suite (§C above). Second: when the same wrong assumption has now produced
three separate test failures across three suites, the fix that actually closes
this is a shared `totalManagementFee(org)` helper, not a fourth hand-derived
constant next time someone adds a suite that touches rent money.

---

## A fourth world, so "clean before go-live" stops being a wipe

`GO_LIVE_CHECKLIST.md`'s own rollback section already accepted rehearsal data
landing in production as a possibility — "if production is ever found to hold
synthetic data by accident: re-provision it." That's the tell: the plan as
written rehearsed UAT *on* the real production project (Stage 3, step 7) and
treated a wipe-and-recreate as the acceptable fallback if that went wrong.
Workable, but it puts the one truly irreversible step — recreating a live
Supabase project — on cutover day, under the most time pressure of the whole
sequence.

Added a `staging` world instead: same shape as the `demo` ↔ `dev` split that
already exists twice in this codebase (separate Supabase + Vercel project,
switched via `.env.<world>.local` + `.vercel.<world>.bak`), migrated in
lockstep with `prod` so it stays a true preview rather than drifting into its
own thing. Rehearsal, UAT, training recordings, board walkthroughs happen
there, freely and repeatedly. Production gets provisioned last, migrated
schema-only, and is never the thing being tested — clean by construction
instead of clean by a scramble.

Two scripts:
- `scripts/use-env.mjs` — extended `demo|dev` to `demo|dev|staging|prod`. The
  ref-lookup table (`HOSTS`, cosmetic — only affects what `active()` prints)
  and the switch-target list (`WORLDS`, load-bearing) are now separate, so a
  world can be switched to the moment its `.env.<world>.local` exists, before
  its project ref is known well enough to label.
- `scripts/migrate-all.mjs` (new) — runs `migrate.mjs` once per named world in
  one sitting, so a schema change applied to `dev` doesn't quietly stop being
  applied to `staging` because someone forgot the second `npm run migrate`.
  Still schema-only, still one idempotent transactional run per file, per
  world — this only removes "forgot the other world" as a failure mode. It
  does not and cannot copy a data row between worlds; nothing in this codebase
  does that, on purpose, and this script does not become the first.

Both smoke-tested against live state: unknown target refused before touching
`.env.local`, a target whose backing file doesn't exist yet (`staging`,
correctly — the project doesn't exist) refused the same way, active world
(`dev`) unchanged by either refusal.

Neither Supabase project exists yet — that provisioning step is a board/
billing action (`GO_LIVE_CHECKLIST.md` §1), same boundary as everything else
in that section. The tooling is ready for the moment it does.

**Update, later the same day: it does now.** Staging was provisioned —
Supabase `tjboghjzbalxwhhatogl` (`eu-west-2`), Vercel project
`oe-group-ipms-staging`, deployed from `phase-1`, live at
`oe-group-ipms-staging.vercel.app`. `.env.staging.local` and
`.vercel.staging.bak` exist alongside the `demo`/`dev` pair; `use-env.mjs
staging` and `migrate:all` both exercised against it, not just smoke-tested
against an absent target. Migrated to `0175`, schema only, zero synthetic rows
at that point.

Seeding it for demo/testing purposes the same day surfaced a real gap: no
application code anywhere provisions a new org — only `scripts/seed*.mjs` and
raw migrations ever have, so an org created outside migration 0085's one-off
slug backfill gets `slug = null` and silently can't take a custom domain
(`/login`'s redirect needs a slug). `oeaportal.com` / `tfmlportal.com` were
also found pointed at `oe-group-ipms-dev` rather than a clean environment, and
were repointed here. Both are logged in full in `GO_LIVE_CHECKLIST.md` §1 —
recorded there rather than duplicated here, since that is now where a reader
checking "is staging real" would look first.

That org-creation gap was closed the same way it was found — in code, not in
this journal: `56e976b` (slug derivation at `operator_provision_org` plus the
app-layer path that calls it), `8910939` (the verify suite switched from
guessed fixture logins to disposable probe users), `a6e0757` (the slug always
derives from the org's own name, never `delivery_brand`, after two OEA orgs
collided on the first attempt), `ac25a82` (random token hashes in the same
suite, not fixed literals). ⚠️ None of those four commits got a journal entry
of their own when they landed — this paragraph is the first record of them
here, after the fact, and is why this entry exists at all rather than ending
at "the tooling is ready for the moment it does."

---

## `scripts/seed.mjs` seeded zero tickets, silently, for as long as 0117 has existed

Found 2026-08-19 preparing staging for a live demo, the same night as the
Sentry/dev-redeploy mix-up: `POC_ORG_ID`'s ticket count on staging was **0**,
not the 20 `npm run seed` had just printed "Tickets: 20 across all categories
and urgencies" for.

The cause is two ordinary defects meeting badly. `0117_a_job_in_hand_has_a_hand.sql`
refuses `status IN ('assigned','acknowledged','in_progress')` with neither
`assigned_vendor_id` nor `assigned_to_user_id` set — "a job in hand, in
nobody's hand," and correctly so; that's the control working. But
`seed.mjs`'s ticket rows have used `i % 5 === 1 ? "in_progress" : ...` with no
assignee since before 0117 existed, and the insert's `.error` was never
checked — the exact pattern already flagged twice this build
(`seed-org-logins.mjs`'s own comment about it, and the approval-chain teardown
in `b373b01`). One statement, all twenty rows, rejected as a unit; the script
never noticed and printed success regardless. **Every seed since 0117 landed
has produced an org with vendors, properties, payments and SC cycles, and
zero tickets** — a demo walkthrough that opens the ticket list first would
have shown nothing, and nothing in the build's own verification suites caught
it because none of them assert on `npm run seed`'s output, only on
purpose-built fixtures inserted directly.

Fixed in `seed.mjs`: `in_progress` rows now carry `assigned_to_user_id: opsId`,
and the insert's error is checked and thrown rather than swallowed. The same
two mistakes existed in `scripts/seed-brand-demo-content.mjs` (new this
session, giving TFML/OEA their own demo content beyond the one placeholder
ticket `seed.mjs` gives each) — written by copying `seed.mjs`'s shape closely
enough to inherit the bug before either had a chance to diverge. Both now
check every insert's `.error` and throw.

📌 **A script that prints "N added" is not evidence N were added** — only a
subsequent read of the row count is. This is the fourth time this exact class
of finding has appeared in this build (0151/0152's approval-chain suite,
`verify-remittance-race`'s admin-fee omission surfaced the same "trusted the
log line" habit from a different angle, and now this) — worth treating as a
standing rule for any script that inserts and reports a count, not a
case-by-case catch.

Not caught earlier because staging was provisioned and seeded the same
session it was first looked at closely — dev's own POC-org ticket count was
never independently re-verified after its original seed either, though dev's
tickets predate 0117 and were very likely inserted before the constraint
existed to violate. Worth a five-minute check on dev too, next time someone's
in there.

---

## The admin fee was charged every year against a decision that said once

Decision 14 left the admin fee's shape open — "ongoing % vs one-time
per-tenancy charge" — and `orgs.admin_fee_flat` stood as what this journal and
`GO_LIVE_CHECKLIST.md` both called a flat placeholder, "not built out further
until this is decided." The 10 Aug entry already recorded that it was nothing
of the kind: `raise_rent_charge` had been deducting it from every demand since
Day 9. What that entry stopped short of saying is what the combination meant.
Rent is billed **annually in advance** (decision 15). A fee the board described
as one-time per tenancy was therefore being charged **once a year, every year,
for the life of the tenancy** — not by anyone's decision, but because the
decision was recorded as pending while the code implementing it was not.

📌 **A decision recorded as pending does not make the code that implements it
pending.** "Placeholder" described the state of the argument, and everyone
reading it — including two sessions of mine — took it to describe the state of
the software. The only reliable version of that sentence names which one it
means.

Resolved 21 Aug 2026: **one-time, per tenancy**, in `0181`. Confirmed first
that no row was ever affected — `admin_fee_amount > 0` matches zero
`rent_charges` on both dev and staging — so this closes as a change rather
than a correction with money to give back. Dev's OEA org still carries the
`25000` a manual test left behind months ago; under a decided rule that is now
an ordinary value rather than a stray one.

🟢 Built configurable rather than compiled in, because the answer to "can this
be set case by case from the dashboard" is the same answer decision 15 gave for
notice periods. `orgs.admin_fee_basis` is the organisation's default in
Settings → Lettings; `leases.admin_fee_basis` is NULL for "follow the org" and
set only where a letting was negotiated otherwise — decision 14's own
default-plus-override, reused rather than reinvented for the second fee in the
same statement.

The subtlety worth keeping: **a renewal is the same tenancy, and a different
row.** `renew_lease` closes one term and opens the next linked by
`renewed_from_lease_id`, so a rule keyed on `lease_id` would charge the fee
again at every renewal while passing every test that only ever billed one term.
`lease_tenancy_chain()` walks upwards from the lease being billed — upwards
only, since a renewal is always created after the term it replaces, and
searching downwards would make the answer depend on rows that do not exist yet.
`verify-rent-demands` §H asserts the renewal case explicitly for that reason.

---

## A vendor company could never be deleted, and its cleanup said so by saying nothing

`vendor_users_keep_an_owner` (0163) stops a living contractor company being
left unadministrable: its last owner cannot be removed or demoted. Right rule.
But `vendor_users.vendor_id` cascades from `vendors`, so deleting the **company**
deletes its members, the trigger sees the last owner going, and refuses —
naming a remedy ("appoint another owner") that cannot possibly help, because
the next owner blocks the delete exactly the same way. A vendor company has
been undeletable since 0163 landed.

It surfaced from the other end. `sweepProbeVendors` reported `0` removed while
a probe contractor sat in the analytics contractor filter — the precise defect
that helper exists to prevent. The helper counts successes and discards the
error, so "refused every time" and "there was nothing to remove" print
identically.

📌 **Fifth appearance in this build of a routine reporting a count it never
verified** (0151/0152's approval-chain suite, `verify-remittance-race`'s admin
fee, `seed.mjs`'s twenty tickets, `seed-brand-demo-content.mjs`, now this).
The standing rule from the seed.mjs entry — *a script that prints "N done" is
not evidence N were done* — has now been earned five times and is worth
applying to the swallowed-error half as well: a loop that counts successes must
say something about its failures.

🟢 `0180`: the trigger returns early when `vendors` no longer holds the row.
A cascade deletes the parent before its children, so an absent parent is the
exact, flag-free signal that the company itself is going. Removing a member
from a company that still exists is refused as before. The helper now warns on
every refusal instead of absorbing it.

---

## What the audit trail refuses to let you tidy away

Sweeping probe residue across dev and staging (`scripts/sweep-probe-residue.mjs`,
new — the broom for everything at once, since `probe-cleanup.mjs`'s per-suite
sweep only runs when that suite runs again, and a retired suite's fixtures
therefore live forever). Properties, hierarchy nodes, applications and vendors
went. Two categories would not, and should not have:

- **Probe orgs** hold 273 `audit_log` rows on staging. `audit_log.org_id`
  references `orgs(id)` with **no cascade**, so the delete is refused outright.
- **Probe users who acted** are held the same way by `audit_log.actor_id`.

That is A3's immutable-audit guardrail enforced by the schema rather than by a
document, and it is worth recording that it was found by trying. The fallback
is the one the app already uses everywhere: soft-delete the org (every query
filters `deleted_at is null`, so it appears in no directory, picker or login)
and deactivate the user with the login banned. 25 users on staging and 486 on
dev took that path; 3 dev vendors were likewise held by `payments` and
`payout_recipients` and were left where the ledger wants them.

📌 **A refusal is not always an obstacle.** The instinct on hitting a foreign
key mid-cleanup is to delete what holds it; here that would have meant deleting
audit rows to tidy test data, which is the one thing A3 says never happens.

Found while there: **dev was five migrations behind** (0176–0180) — the drift
`migrate-all.mjs` exists to prevent, and evidence that it only prevents drift
when someone remembers to name more than one world.

---

## Four suites crashed on a fixture email before stating a single claim

`verify-rent-demands`, `verify-rent-money`, `verify-remittance-race` and
`verify-leases-and-rent` each resolved OEA's landlord as
`oea.propertyowner@oegroup.test` and used `landlord.id` on the next line. The
brand-portal seeding introduced the previous day writes the shorter
`oea.owner@oegroup.test`, so on staging all four died with
`Cannot read properties of null (reading 'id')` before reaching an assertion.

🔎 Worth separating from the admin-fee finding recorded above, which the
checklist blamed for two of these being red. On dev they failed on fee
arithmetic; on staging they never got that far. **One red suite, two unrelated
causes, and the recorded diagnosis was only ever true of one world.**

📌 A red suite that never states a claim is worse than a failing one: it reads
as the code being broken when the fixture is. `fixtureUser()` in
`scripts/lib/org-lookup.mjs` resolves by **role within the org**, taking email
spellings only as hints, and raises a sentence naming the seed command when
nothing matches. The role is the durable fact; the email is a seeding
convention that has now legitimately changed twice.

The same file's existing warning — *refuse and list, never pick* — applies
unchanged; this is the fixture-shaped version of it.
