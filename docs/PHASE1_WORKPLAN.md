# Phase 1 — Production Build Workplan & Workflow

**12 days, AI-led** (10-day compression noted at the end). Same operating style as
the POC daily workflow: one deliverable per day, behind a verification gate, with a
**visible** result you can open and show.

**Scope source of truth:** `RECONCILED_ROADMAP.md` (incl. the locked OEA expansion +
interactive-analytics items), `OEA_TENANT_ONBOARDING.md`, `PHASE1_VENDOR_EVALUATION.md`,
`OE_Group_Phase1_Production_Roadmap.docx`.

---

## Status board

Where the build actually is. Updated at each day's gate. The narrative record —
what was verified, what broke, what was decided — is `BUILD_JOURNAL.md`; this is
the one-glance version.

| Day | Deliverable | Status | Gate evidence |
|-----|-------------|--------|---------------|
| 0 | Preconditions (accounts, keys, domains) | 🟢 done | dev Supabase, Upstash, Sentry, Vercel dev project, Paystack test keys |
| 1 | Environment split (demo frozen / phase-1 dev) | 🟢 done | seeding dev left demo untouched; limiter + Sentry proven live |
| 2 | Brand isolation (routing, JWT claims, RLS, middleware) | 🟢 done | `verify-channel-routing`, `verify-jwt-claims` |
| 3 | Omnichannel intake + AI triage, notification centre | 🟢 done | `verify-notifications`, `verify-cascade`, `verify-email-routing` |
| — | *(inserted)* UI redesign, org branding, asset register, vendor applications | 🟢 done | `verify-org-theming`, `verify-asset-access`, `verify-asset-import`, `verify-vendor-applications`, `verify-invitations` |
| 4 | Segregated client-funds ledger + reconciliation | 🟢 done | `verify-ledger`, `verify-reconciliation` — clean statement reconciles to 0, planted ₦75,000 debit flagged |
| 5 | Live collections (checkout → webhook → ledger → receipt) | 🟢 done | `verify-collections`, `verify-checkout-e2e` — payload claiming ₦999,999,999 ignored; exactly-once under concurrency |
| 6 | Live remittance (vendor payouts + landlord rent) | 🟢 done | `verify-remittance` — gate refuses every incomplete payment; 3 concurrent claims → 1 winner; re-confirming posts once; cannot pay more than is owed; `unknown` stays unknown |
| 6.5 | Operator-governed permission matrix (toggles) | 🟢 done | `verify-permissions` — revoking a capability returns ZERO rows (RLS, not the menu); locked capabilities refuse to move; a brand admin reads but cannot edit; isolation and identity survive every capability being off |
| 6.75 | Property & unit register *(gap found 27 Jul — was in no plan)* | 🟢 done | `verify-properties` — unique unit label per property, strictly positive apportionment factor, retire refuses while obligations remain, attaching an FM grants access and detaching removes it |
| 7 | OEA tenant application + KYC intake | 🟢 done | `verify-tenant-applications` — module + window both gate intake; an applicant writes but can never read back; special-category data stored apart and absent from the reviewer's view; retention purges the person and keeps the decision |
| 8 | Two-tier human review + approval | ⬜ | |
| 9 | Lease admin + rent roll | ⬜ | |
| 10 | Interactive analytics dashboard (filters, drill-down) | ⬜ | |
| 11 | Vendor KPI/SLA evaluation, work-order media, UX pass | ⬜ | |
| 12 | Security audit, NDPA pack, UAT, go-live | ⬜ | |

**Baseline audit (PC2, `docs/BUILD_AUDIT_BASELINE.md`) — actioned 28 Jul:**
- **S-1** approval threshold not enforced at the DB → **fixed** (`0060`). Was
  confirmed exploitable: finance approved ₦5,000,000 against a ₦1,000,000
  threshold by direct PATCH, and could then remit it.
- **E-1** BI dashboard aggregated whole tables in JS → **fixed** (`0061`), now
  DB-side `security_invoker` views; figures cross-checked against the raw sums.
- **E-2** unbounded service-request list → **bounded** at 200 with the total
  stated on screen. Keyset pagination stays Day 10.
- **S-2** unit insert not checking the property's org → **already fixed** by
  `0057`'s composite FK, before the audit was shared.
- **D-1** read-leak fix depends on `0055` → **guarded**:
  `scripts/verify-deployment-safety.mjs` fails if any matrix-governed table
  carries a `FOR ALL` policy. Run it after migrating any environment.

**Open items carried forward** (none blocking Day 7):
- **Resend webhook** — add the endpoint + `RESEND_WEBHOOK_SECRET` so invitation
  delivery outcomes (delivered / bounced) are recorded rather than assumed.
- **Telegram bots** — not yet created in BotFather. Per-brand routing, tokens and
  interactive buttons are built and waiting; see `TELEGRAM_BOT_SETUP.md`, then
  `node scripts/register-telegram-bot.mjs <TFML|OEA> <token>`.
- Client-funds **opening balance** and its allocation — placeholder ₦0 in all three orgs.
- **Management/admin fee %** OEA deducts from rent — needed *by* Day 9 (rent roll).
- **Flutterwave (FX)** keys — not set, so non-Naira collections refuse cleanly (403).
- `oraegbunike.com` sending domain — DNS is on Zoho, not HostGator; subdomain steps pending.
- **Per-brand portal URLs** — `portal.tfmlconsultant.com` / `portal.oraegbunike.com`
  CNAME to Vercel at go-live; email sending domains are unaffected (separate records).

**Closed on 27 July** (were listed here, now fixed — kept briefly so a reader of an
older copy is not misled):
- `recordOpeningBalance` atomicity → one RPC (`0048`).
- `record_remittance_sent` inline account resolution → `canonical_ledger_account`
  (`0048`), and the COLLECTION credit side too (`0049`, after `0048` alone made
  the two halves of the ledger disagree).
- Migration numbering collision → renamed `0040a`/`0040b` with their ledger rows
  retagged, plus a runner guard that now refuses two files claiming one number.
- **WhatsApp cross-brand replies** → each number routes to its own brand; Meta's
  callback URL was still pointing at the frozen POC deployment.
- **`channel_routes` credential leak** → any signed-in user could read the
  Telegram webhook secret. Policy removed (`0039`).

---

## Standing rules (carried from the POC)

1. **Never touch the demo.** All work on the `phase-1` branch against the **dev**
   Supabase. `main` + the live demo stay frozen (`poc-demo-v1`).
2. **Human-in-the-loop for money and for tenant screening.** No automated payouts,
   no automated tenant decisions.
3. **RLS is the enforced backstop**; UI gating sits on top, never instead.
4. **No live payment keys** until the ledger + reconciliation pass their gate (Day 4).
5. **Verify before stacking** — each day's gate must pass before the next begins.
6. Build the JSON body as a real object + `JSON.stringify()` — never string-spliced.

---

## Day 0 — Preconditions (do these before Day 1)

**You do — accounts & assets to have ready:**
- [ ] **Supabase:** create a new project `oe-group-dev` → copy Project URL, `anon`
      key, `service_role` key, and the **session-pooler** DB connection string.
- [ ] **Paystack** account (Naira collections + Transfers) → get **test** keys.
      Start business/KYC verification now; it gates going live, not building.
- [ ] **Flutterwave** account (FX collections) → **test** keys.
- [ ] **Bank:** confirm the **segregated client-funds account** exists (or is being
      opened) — this is the account the ledger reconciles against.
- [ ] **Domains:** access to DNS for `tfmlconsultant.com` and `oraegbunike.com`.
- [ ] **WhatsApp:** a second number for OEA (TFML already live on +234 708 471 4148).
- [ ] **Cloudflare R2** (or confirm Supabase Storage) for photo/video + documents.
- [ ] Decide the **management/admin fee %** OEA deducts from rent before remitting.

**🔒 Security-review preconditions (see the tracker in `RECONCILED_ROADMAP.md`):**
- [x] **S6 — Next.js: CLEARED (2026-07-24).** `main` is pinned at `next@14.2.35`
      (package.json + lockfile agree, tree clean) — the proven POC baseline. The
      14→16 bump exists only as an uncommitted change in PC2's working copy;
      **discard it there.** Phase 1 branches from `main` as-is.
- [x] **S8 — classifier model id: VERIFIED (2026-07-24).** A live Anthropic API
      call with `claude-sonnet-4-6` returned HTTP 200, so triage is genuinely
      classifying, not silently degrading. *(The missing Gemini failover is still
      open — Day 12.)*

**Neither precondition blocks Day 1 any longer.** The remaining Day 0 work is
purely the accounts/keys checklist above.

**Done when:** all keys are in hand (test mode is fine) and pasted to Claude on
request. Nothing is built yet.

---

# TRACK A — Foundation & isolation (Days 1–3)

## Day 1 — Environment split, branch, production hardening
**Goal:** a Phase-1 world that cannot touch the demo.

**Claude prompt:**
> "Create the `phase-1` branch. Point `.env.local` at the new `oe-group-dev`
> Supabase, run migrations + seed there. Add Upstash rate-limiting to both intake
> webhooks, wire Sentry error tracking and uptime monitoring, and confirm automated
> backups. Verify the demo database is untouched."

**🔒 Security-review call (S1):** keep `WHATSAPP_APP_SECRET` + `TELEGRAM_WEBHOOK_SECRET`
set in every environment — webhook auth is now **fail-closed in production** (missing
secret → reject), so a new prod env without them silently kills intake. Secure the
**SMS (Africa's Talking) callbacks** the same way once that channel is wired.

**You do:** paste the `oe-group-dev` keys; create Upstash + Sentry accounts (free
tier) and paste those keys.

**You verify:** open the demo URL — unchanged. Open the Phase-1 preview URL — same
app, different (dev) data.

**👁 Visible deliverable:** a **Phase-1 preview URL** running on its own database,
with the demo provably untouched side-by-side.

**Done when:** two independent environments; rate-limiting active; errors reporting.

---

## Day 2 — Four-layer brand isolation + per-org channel routing
**Goal:** each brand is isolated on the way *in*, not just at rest.

**Claude prompt:**
> "Implement the remaining B1 isolation layers: JWT org claims, brand API
> middleware, and DNS/domain routing for tfmlconsultant.com and oraegbunike.com.
> Replace the hardcoded `DEMO_ORG_ID` in both webhooks with a channel→org mapping so
> each brand's WhatsApp/Telegram number lands in its own org. Extend
> `verify-access-matrix.mjs` to prove cross-brand isolation at all four layers."

**🔒 Security-review call (S5):** while reworking scoping, **extend property-scoping to
the money side** — today an FM sees *all* vendors, payments and vendor_evaluations
org-wide (only tickets/SC were property-scoped in 0008/0009). This needs a
**vendor↔property association** (a link table, or derive via assigned tickets); then
re-run `verify-access-matrix.mjs` so the FM sees only their properties' vendors/pay.

**You do:** add the DNS records Claude gives you; register the OEA WhatsApp number
and give Claude its Phone Number ID.

**You verify:** message the **TFML** number → ticket appears under TFML only.
Message the **OEA** number → under OEA only. Neither can see the other.

**👁 Visible deliverable:** two branded portals on their own domains, and a
**passing cross-brand isolation test** printed to screen.

**Done when:** the 4-layer test passes; no `DEMO_ORG_ID` hardcoding remains.

---

## Day 3 — Self-service onboarding & enrollment
**Goal:** an org can enroll its own people without a script.

**Claude prompt:**
> "Build onboarding: invite-by-email for staff (admin adds member + assigns role),
> vendor self-registration with admin approval, and tenant↔unit assignment UI. All
> org-scoped, all audited. Include an accept-invite signup flow."

**You do:** confirm the sender email domain for invites (Resend), and who may invite.

**You verify:** invite yourself at a second email → accept → land in the right org
with the right role and nothing more.

**👁 Visible deliverable:** an **invite email → signup → correctly-scoped login**,
performed live.

**Done when:** every role can be enrolled in-app; seed scripts no longer required.

---

# TRACK B — Money (Days 4–6) · highest compliance risk

## Day 4 — Segregated client-funds ledger + reconciliation engine
**Goal:** close the biggest gap — money has a real, auditable ledger.

**Claude prompt:**
> "Build the segregated client-funds ledger: double-entry postings, per-org and
> per-landlord/vendor balances, immutable entries, and a daily bank-vs-ledger
> reconciliation job that flags variances. Include a ledger view and a
> reconciliation report. No gateway yet."

**You do:** provide the client-funds bank account details (name/number only) and the
opening balance to reconcile from.

**You verify:** post a few test entries; confirm balances add up and the
reconciliation report shows zero variance, then deliberately introduce one and see
it flagged.

**🔒 Security-review call (S3/S4):** apply migration `0010` here so the ledger's
immutability extends to the money-adjacent tables — **audit `vendor_evaluations`
inserts** (they drive the KPI payment gate, so an unaudited insert can game a payout)
and **`service_charges` writes**, plus **soft-delete** (`deleted_at`) with user
hard-delete blocked.

**👁 Visible deliverable:** a **ledger screen with balances** and a **daily
reconciliation report** showing matched vs flagged.

**Done when:** ledger balances, reconciliation runs, variances surface. *(Gate for
live keys.)*

---

## Day 5 — Live collections (rent + service charge)
**Claude prompt:**
> "Integrate Paystack (Naira) and Flutterwave (FX) collections for both service
> charge and rent invoices. HMAC-verified webhooks, idempotent posting to the
> ledger, branded receipt PDFs, and server-side amount verification."

**You do:** paste Paystack + Flutterwave **test** keys; set the fee % for rent.

**You verify:** pay a test invoice with a test card → receipt arrives, ledger posts,
reconciliation still balances.

**👁 Visible deliverable:** a **real (test-mode) payment** flowing from checkout →
receipt → ledger, on screen.

**Done when:** collections post exactly once and reconcile.

---

## Day 6 — Live remittance (vendor payouts + landlord rent)
**Claude prompt:**
> "Wire Paystack Transfers behind the existing B4 gate for vendor payouts, and add
> **custodial landlord rent remittance**: collect rent, deduct management/admin
> fees, remit the balance — same gate, same ledger, with remittance advice PDFs.
> Support the per-landlord `collection_mode = custodial | direct` flag."

**🔒 Security-review call (S2/S9) — do NOT ship the "existing gate" as-is:** before
wiring real transfers, **harden the gate**. (1) Enforce `approval_threshold_amount`
server-side — above the limit requires a higher approver (app fix is on
`phase-1-hardening`; extend to a full **admin-configurable approval hierarchy**).
(2) Apply the migration `0010` **payment state-machine trigger** so a direct
PostgREST PATCH can't jump straight to `approved`/`remitted` — the DB, not just the
server action, enforces verify→validate→approve→remit and finance/admin-only money
moves. Live money on an unenforced gate is the single highest-liability shortcut.

**You do:** approve the fee model; add a test recipient/bank account.

**You verify:** run a payout through verify → performance → approve → remit; confirm
the ledger shows fee retained and balance remitted.

**👁 Visible deliverable:** a **gated landlord remittance** with fees deducted and a
**remittance advice PDF**, fully reconciled.

**Done when:** no transfer executes without the gate; ledger + bank agree.

---

## Day 6.5 — Operator-governed permission matrix

Replaces role names hardcoded into RLS policies with a permission catalogue an
administrator toggles. Sequenced **after** Day 6 deliberately: the permission
system has to know which permissions are non-delegable, and that list is not
final until the B4 approval gate is complete.

**Claude prompt:**
> "Introduce a per-org permission matrix. RLS policies stop naming roles and
> instead ask `has_permission('<capability>')`, resolved against a
> `role_permissions` table seeded from the B7 matrix. Build the toggle UI, the
> locked-permission set, the deviation badge, and a verification suite that
> proves a toggle changes what the DATABASE returns."

### Locked decisions (agreed 27 July 2026)

**1. Only the OE Group operator portal may change permissions.**
TFML and OEA administrators **cannot** reach the editor. They see the matrix
**read-only**, so they know what applies to their staff without being able to
alter it — transparency without control.

This needs a concept the model does not yet have: a **platform operator org**,
distinct from a brand org. Add an explicit `orgs.is_platform_operator boolean
not null default false`, set true for OE Group only. **Do not** infer it from
`delivery_brand = 'direct'` — that field describes who delivers the service, not
who governs the platform, and a future direct-delivery client would silently
inherit operator rights.

Editing another org's permissions is the **only** deliberate crossing of the
org-isolation boundary in the system. It therefore goes through a single
`SECURITY DEFINER` function that (a) verifies the caller is an admin of an org
with `is_platform_operator`, (b) writes to exactly one target org, (c) writes an
audit row naming both orgs. No table-level cross-org policy is added.

**2. Locked — never appears as a toggle, hardwired in policy.**
Each is a control someone external audits, not a preference:

| Capability | Fixed to | Why it cannot be delegated |
|---|---|---|
| `payment.approve` | finance_approver + admin; above threshold **admin only** | B4 approval gate |
| `payment.remit` | finance_approver + admin | executes a real transfer |
| `ledger.write` | **no role** — system only | the ledger is written by collections/remittance, never by hand |
| `ledger.read` | admin + finance_approver | client funds |
| `bank.configure` | admin | defines what reconciliation compares against |
| `audit.read` | admin + finance_approver | the trail must not be readable by those it records |
| `permissions.edit` | operator admin only | the toggle that grants toggles |
| `invitation.create_admin` | admin | prevents privilege escalation by invitation |
| channel routing | service role only | `external_id` is a webhook credential (0039) |

Cross-org isolation is **not** a permission at any level — it is an invariant.

**3. Every configurable permission defaults to its most restrictive workable
state.** The seed grants a capability only where B7 explicitly names the role;
anywhere B7 is silent, the default is OFF. A new org therefore starts locked
down and is opened deliberately, rather than starting open and being closed by
memory.

**4. B7 remains the approved baseline.** Any org whose matrix differs shows a
**"differs from approved matrix"** badge with a per-capability diff, and a
one-click reset to the B7 default. Drift must be visible and deliberate.

**You do:** confirm the capability catalogue before the RLS rewrite begins.

**You verify:** toggle `assets.write` off for FM/PM → an FM's asset save is
refused **by the database**, not just hidden in the UI; toggle it back → the save
succeeds. Attempt the same edit signed in as a TFML admin → the editor is
unreachable. Attempt to move `payment.approve` → no toggle exists, and a direct
API call still refuses.

**👁 Visible deliverable:** a **permission matrix screen on the OE Group portal**
with per-role toggles, locked rows shown as locked with their reason, and the
deviation badge.

**Done when:** a toggle changes what the database returns; locked permissions
cannot be moved by UI or by direct API call; a brand admin cannot reach the
editor; and every change is in the audit trail naming who changed what, for
which org.

---

# TRACK C — OEA lettings (Days 7–9)

## Day 7 — Tenant application & KYC capture
**Claude prompt:**
> "Build the tenant application module per `OEA_TENANT_ONBOARDING.md`: individual
> and corporate (commercial) forms mirroring the three OEA forms, save-and-resume,
> document uploads (ID, CAC, TIN, passport photo) to R2, plus a
> download-fill-upload path. Explicit NDPA consent capture; special-category fields
> optional and access-gated."

**You do:** confirm the final field list per form and which documents are mandatory.

**You verify:** complete an application as a prospective tenant on a phone; upload a
document; resume a half-finished one.

**👁 Visible deliverable:** a **public application link** a real prospect can fill
on mobile, with documents attached.

**Done when:** both individual and corporate applications submit cleanly.

**Status — built.** Schema, RPCs, both forms, uploads, save-and-resume, consent
capture and the 90-day purge are in (`0062`, `0063`); 22 checks pass. The
operator surface was missing and has been added: **People → Tenancy
Applications** now carries the open/close switch and the public link, and the
public page is no longer cached. The tab appears only for an org with the
lettings module.

**Status — closed, 30 July.** PC2's build audit found submission **silently
blocked end to end**: the document check read `application_attachments` through
the applicant's anon session, which has no SELECT policy, and a query with no
matching policy returns zero rows *without erroring* — so every uploaded document
read as missing. Reproduced before fixing. The gate now lives inside
`submit_tenant_application()` (`0070`), which also closes a second hole the audit
did not name: that RPC is granted to `anon`, so a check in the server action could
be posted past.

Also closed from the same audit: `sensitive` and `resume_token_hash` are no longer
readable by `authenticated` (the latter matters more — the resume/save/submit
functions take that hash as their argument, so reading it meant being able to
submit someone else's application); `saveDraft` is rate limited; and the emailed
resume link the form promised now actually exists and works (`?resume=<token>`,
with `Referrer-Policy: no-referrer` on `/tenancy/*`).

**Mandatory documents are now configuration, not code** —
`application_document_requirements` per org and application type, which answers the
question that was previously outstanding here. Turning one off is proven to change
what is enforced.

Suites: `verify-tenant-applications` (22), `verify-application-submission` (14),
`verify-audit-followups` (12).

*Awaiting you:* confirm the final field list per form, then walk the form on a
phone. Also needs a verified Resend sending domain for `oraegbunike.com` before
the resume email will reach an OEA applicant.

---

## Day 6.75b — Portfolio hierarchy + oversight roles *(inserted 30 July, board of 29 July)*

**REGION → PROJECT → LOCATION → SITE**, above the property register. One
`org_nodes` table with a materialised path rather than five nested tables, so the
property stays the security anchor for all 42 policy clauses that scope on it
(`0066`). Node-scoped assignments were added *inside* `current_user_property_ids()`
— one resolver, extended — so a manager assigned to a region reaches properties
added to it later with no re-assignment (`0067`).

Two trigger defects found by the suite before pushing: `UPDATE OF col` fires on the
columns a statement *names*, not those that changed (`0068`); and an AFTER
trigger's `WHEN` clause is evaluated outside any trigger, so a `pg_trigger_depth`
guard there is never true (`0069`).

**Roles (`0071`–`0073`):** `executive` (MD / Managing Partner) — full visibility,
co-holds approval including above threshold, **cannot remit**; `regional_manager` —
operational plus inviting staff for their own region, nothing financial. Eighteen
SELECT policies were rewritten mechanically from `pg_policies` into
`oversight_roles()` rather than retyped.

⚠️ **Regression caught here:** adding `executive` to `enforce_payment_transition()`
meant rewriting it from a partial read, which dropped the legal-transition state
machine — a forged jump straight to `approved` became possible.
`verify-payment-gate` caught it; restored in `0073`. **`create or replace` is a
full rewrite: whatever you do not restate, you delete.**

Suites: `verify-hierarchy` (24), `verify-oversight-roles` (21).

**Still to do from the 29 July board** (design in
`docs/BOARD_JULY29_STRUCTURE_AND_REPORTING.md`):
- `assets.scope` enum (`unit | property | site`) + shared-asset cost apportionment
- `scope.org_wide` capability so **write** policies are bounded to a subtree — this
  *tightens* current access (an FM loses org-wide `properties.write`), so it is
  staged separately and confirmed against live data first
- per-property application window (`auto` / `open` / `closed`) — also closes the
  Day 8 blocker below
- import templates gaining region/project/location/site columns
- AI document verification (locked decision 10), after Day 8's human review

---

## Day 8 — Human review, approval, and auto-onboarding
**Claude prompt:**
> "Build the two-tier review workflow: PM reviews/recommends (property-scoped),
> admin/finance approves; individual = single approval, corporate = dual;
> admin-configurable. On approval, automatically provision the tenant account,
> allocate the unit, and kick off onboarding. Immutably audited. Add the 90-day
> rejected-PII purge job."

**You do:** name the reviewers and approvers; confirm single vs dual thresholds.

**You verify:** submit → review → approve → confirm a tenant login and unit
allocation appear automatically. Then reject one and confirm the purge is scheduled.

**👁 Visible deliverable:** an **application moving through review to approval**, and
a **tenant account created automatically** from it.

**Done when:** no tenant exists without an approved application; all steps audited.

**⚠ Blocker found in Day 7 review — a PM will see zero applications.** Nothing in
the public flow captures a property or unit, so every application has
`property_id = null`. Both the RLS policy and `application_overview` scope a
reviewer without `applications.review_all` to
`property_id in (select current_user_property_ids())`, and **NULL never matches
an IN list** — so property-scoped review, which is this day's premise, currently
returns nothing. Two ways out:
> - ask the applicant which property/unit they want, or
> - have an admin assign the application to a property on receipt, before it
>   enters the PM queue.
>
> The second is the safer default: an applicant's own free-text preference should
> not decide who may read their identity documents. It does mean the queue needs
> an explicit *unassigned* stage. **Confirm which before Day 8 starts.**

**Blocker closed, 31 July.** Per-property intake (`0081`) gave the public form a
property to carry, so an application now arrives with `property_id` set and
property-scoped review works as designed. No unassigned stage was needed.

**Status — built, 31 July.** `application_decisions` records every recommend,
request-info, approve and reject with its author and a reason; the recommender is
refused their own approval *and* their own rejection; individual completes on one
approval, corporate on two distinct approvers; the completing approval issues a
real invitation through the same hardened `accept_invitation` every other person
is onboarded by, occupying the unit assigned during review. Rejection sets the
90-day purge date, approval sets none. Two capabilities added to the B7 matrix:
`applications.recommend`, `applications.approve`.

The review queue and detail page ship with it: applicant, documents behind
click-minted signed URLs, every non-sensitive form section, review history, and a
decision panel whose disabled states mirror what the database enforces.

🔎 Verified in the browser against a real applicant submission — queue, detail,
a live recommendation, and the maker-checker gate correctly refusing to let the
recommender also decide.

Suites: `verify-application-review` (35).

*Awaiting you:* name the reviewers and approvers on the live org, and confirm
whether the executive stays eligible as a second corporate approver (currently
yes, by default). Rejected-PII purge runs on the same job as Day 7's.

**Your role from here:** you are the *approver*, not the recommender — a
property/facility manager recommends, and you (or a second admin) decide. The
system will not let one person do both.

---

## Day 8.75 — The regional structure, made visible *(inserted 31 July 2026)*

**Status — built, 31 July.** `0066` gave the board's REGION → PROJECT → LOCATION
→ SITE its schema, `0067` extended the one resolver so a regionally-assigned
manager reaches everything beneath their node, and `0078c`/`0081` wired it into
invitations. **None of it had a screen.** Nothing created a region, filed a
property under a site, or assigned a regional manager — every property in the
system was unfiled, and the structure the board asked for on 29 July was
invisible to a user.

Shipped: **Properties → Regions & sites** (create, rename, retire, and assign
regional managers at any level of the tree), a shared cascading picker on the
property form, a "Region / site" column on the property list, and the invite
dialog finally passing `node_id` — so a regional manager can be scoped from the
UI for the first time. `retire_org_node` refuses while a live child node or
property still depends on it, the same refuse-rather-than-orphan shape as
`retire_property`.

🔎 14 checks (`verify-hierarchy-ui`), `verify-hierarchy` still green, and in the
browser: created a project under North, saw it nest, and confirmed the property
form's cascade unlocked Project with only that node offered while Location and
Site stayed disabled.

**Your role:** you are the **administrator** here — `hierarchy.write` is
admin-only by default (B7 is silent on portfolio restructuring, and locked
decision 7 says silence means OFF). Nobody else can reshape the portfolio.

*Awaiting you:* the real region/project/location/site names for both brands.
Nigeria's three geopolitical regions (North, South, East) are seeded; everything
below them is yours to name.

**Still outstanding from the 29 July board:** import templates gaining
region/project/location/site columns, and `assets.scope` shared-asset
apportionment.

---

## Day 8.8 — Per-org front doors + operator launcher *(inserted 31 July 2026)*

**Status — built, 31 July.** Each org now carries a unique `slug` and its own
sign-in at **`/o/<slug>`**, branded with that org's colours, logo and portal
name. The **grid of organisation icons** replaces the single anonymous login box
— at **`/orgs`**, behind the operator sign-in.

**⚠ Why it is behind sign-in and not in front.** B1 says a user on one portal
must never see another brand's data *or existence*. A public grid publishes the
whole client list — both brands, the SC client, every landlord org onboarded
later — to anyone who loads the page, competitors included. A link someone was
handed is not an enumeration; a directory is. `org_public_branding` therefore
takes a slug and returns at most one row (wildcards match literally, an unknown
slug and a retired org both 404), while `operator_org_directory` gates on
`caller_is_operator_admin()` inside the query so a brand administrator gets an
empty set rather than a refusal.

🔎 13 checks (`verify-org-directory`) — including that a brand admin lists
nothing and that quotes and wildcards cannot escape into the lookup. Verified in
the browser: `/o/oea` renders OEA's own branding, an unknown slug 404s, and the
launcher lists the three live orgs with their addresses and counts.

**Your role:** **operator**. Only a member of the platform-operator org
(`orgs.is_platform_operator`) sees the launcher. Your brand administrators
cannot list the platform's clients, by design.

*Awaiting you:* confirm the public slugs (`tfml`, `oea` are set; the POC org
has a long derived one). **If the board does want the grid public, that needs a
recorded exception to B1** — the switch itself is one line.

---

## Day 8.9 — Client-facing UI/UX upgrade *(inserted 31 July 2026)*

**Claude prompt:**
> "Bring the public entry surfaces up to a modern, conventional client-serving
> standard: the org launcher, the `/o/<slug>` sign-in, and the tenancy
> application. Typography scale, spacing rhythm, motion on state change, real
> empty and loading states, and a mobile-first pass. Keep the existing semantic
> token system — this is a refinement of the design language, not a replacement."

**You do:** approve the direction on the launcher first, since every other
surface follows its treatment.

**You verify:** open the launcher and an org sign-in on a phone; both should read
as a product a client would trust with money.

**👁 Visible deliverable:** the **first screen a client or prospect sees**,
finished to a standard you would put in front of a board.

**Done when:** the three public surfaces are upgraded and pass mobile + WCAG AA.

> **Sequencing.** Only the *client-facing* surfaces are done here, while there
> are three of them. The internal dashboard's polish stays in **Day 11**'s
> existing production UX pass — doing it now would mean doing it again after
> Days 9–11 add lease, rent-roll and evaluation screens.

---

## Day 9 — Lease administration, rent billing & rent roll
**Claude prompt:**
> "Build lease administration: lease creation + unit allocation, term/rent/escalation,
> automated **renewal** and **demand** notices via the B8 cascade, plus rent
> invoicing on schedule. Add the **rent roll / tenancy schedule** report, occupancy,
> net income (management + admin fees) and rental inflows."

**You do:** confirm notice lead times (e.g. renewal at 90/60/30 days) and rent
invoicing cadence.

**You verify:** create a lease → rent invoice generates → rent roll shows the unit →
a renewal notice is queued.

**👁 Visible deliverable:** a **rent roll / tenancy schedule** you could hand a
landlord, and an **automated renewal notice**.

**Done when:** lease → rent → roll → notice works end to end.

---

# TRACK D — Intelligence & experience (Days 10–11)

## Day 10 — Interactive analytics dashboard + role reporting

> **Sequencing confirmed 2026-07-26.** The BI charts stay static until this day,
> deliberately. Days 4–6 create the financial data the console must report on —
> collection rate, receivables, budget utilisation, vendor liabilities and
> remittance flow all come from the ledger. Building the filter engine,
> aggregation layer and exports before that data exists would mean building them
> twice. The operational half (requests, vendors, assets, timestamps) is already
> in place and waiting.

**Claude prompt:**
> "Build the locked interactive analytics dashboard for both brands: filters (date
> range, vendor, classification, property, status); completion rate % by vendor and
> by classification; best/worst performer; average time-to-resolve;
> weekly/monthly/quarterly/yearly toggles with trends and period-over-period.
> Materialised aggregates for speed, RLS preserved on every filtered view, CSV/PDF
> export. Then add the tenant 'Track my request' timeline and the vendor
> 'performance & pipeline' view."

**You do:** confirm the default period (e.g. monthly) and which KPIs lead.

**You verify:** filter to one vendor and one quarter — numbers change coherently;
log in as FM and confirm you still only see your properties.

**👁 Visible deliverable:** a **filterable analytics console** answering "which
vendor completes fastest this quarter?" live, plus a **tenant request tracker**.

**Done when:** filters work, scoping holds, exports produce a file.

---

## Day 11 — Vendor KPI/SLA evaluation, work-order media, UX pass
**Claude prompt:**
> "Implement the KPI/SLA dual-source vendor evaluation per
> `PHASE1_VENDOR_EVALUATION.md`: admin-editable rubric, auto-measured
> response/completion vs SLA, tenant review on completion + PM evaluation combined
> via the AURA weights. Add photo/video uploads to work orders. Then the production
> UX pass: mobile drawer nav, password reveal, toasts, loading skeletons, empty
> states, confirmation dialogs on money actions, WCAG AA, and branded PDF exports."

**You do:** provide/approve the **KPI & SLA checklist** (criteria, points, targets)
for FM and vendor.

**You verify:** complete a job → tenant rates it → score updates from both sources;
upload a photo to a work order; run the app one-handed on your phone.

**👁 Visible deliverable:** a **vendor score built from a real tenant review + PM
checklist**, and a visibly **polished mobile UI**.

**Done when:** no free-typed scores remain; UI passes mobile + accessibility checks.

---

# TRACK E — Harden & launch (Day 12)

## Day 12 — Security, compliance, UAT, training, go-live
**Claude prompt:**
> "Run the production security pass: dependency + secret scan, OWASP ZAP against the
> Phase-1 URL, k6 load test to target, and confirm rate limits. Produce the NDPA
> compliance pack (DPO, processor DPAs, privacy notice, consent records, retention
> jobs). Then generate the multi-role UAT script and user guides."

**🔒 Security-review call (S8):** add **triage resilience** — implement the Gemini
**auto-failover** promised in CLAUDE.md B3 (today an Anthropic error degrades to a
static "needs human review", it does not fail over), and confirm the classifier
model id is valid so classification can't silently go dark.

**🧹 Clean-data go-live gate:** production is a **fresh, separate** Supabase + Vercel
project, **stood up empty**. Run `npm run migrate` (schema only) and **do NOT run
`npm run seed`** — the seed generates synthetic/test data. Every production record
must arrive through real Day-3 self-service onboarding. All test/synthetic data stays
in `oe-group-dev` and the frozen `poc-demo-v1` demo and is **never migrated in**. This
removes any real-vs-test confusion *by construction* — not by deleting test rows later,
which is unsafe here anyway (the `audit_log` is append-only, and financial/ledger rows
are retained, not deletable). If a rehearsal ever writes test data into the prod env,
**reset/re-provision it before the real cutover**, don't hand-delete rows.

**You do:** designate the **DPO**, sign processor DPAs (Supabase, Vercel, Anthropic,
Meta, Paystack, Flutterwave), publish the privacy notice, run UAT with real staff,
and give the **go/no-go**.

**You verify:** complete the UAT script start to finish with no criticals.

**👁 Visible deliverable:** a **clean security + load report**, a **compliance pack**,
and the **production system live** for TFML and OEA.

**Done when:** no critical findings, UAT signed off, production deployed, rollback
confirmed, and the **production DB verified clean** — migrations run, seed **not** run,
zero synthetic rows before the first real onboarding.

---

## Compression to 10 days
Keep Days 1–10 and Day 12. Fold **Day 11** into a fast-follow sprint: ship
work-order media with Day 9, keep the KPI/SLA evaluation and the full UX/PWA polish
for the week after launch. **Never compress Days 4–6 (money) or Day 12 (security &
compliance)** — those are the two places where shortcuts create real liability.

## Exit gate — Phase 1 is done when
- Cross-brand isolation passes at all four layers, per-org channels route correctly.
- A collection **and** a gated remittance both reconcile against the bank.
- A tenant is onboarded from application → human approval → lease → rent invoice.
- The analytics console answers service-improvement questions with correct scoping.
- No critical security findings; NDPA pack signed off; multi-role UAT clean.
- The `poc-demo-v1` demo still runs untouched.
