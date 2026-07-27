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
