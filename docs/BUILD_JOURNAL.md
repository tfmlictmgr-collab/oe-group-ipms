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
