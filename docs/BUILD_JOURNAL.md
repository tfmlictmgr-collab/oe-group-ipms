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
