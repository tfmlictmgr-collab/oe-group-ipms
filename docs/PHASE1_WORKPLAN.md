# Phase 1 — Production Build Workplan & Workflow

**12 days, AI-led** (10-day compression noted at the end). Same operating style as
the POC daily workflow: one deliverable per day, behind a verification gate, with a
**visible** result you can open and show.

**Scope source of truth:** `RECONCILED_ROADMAP.md` (incl. the locked OEA expansion +
interactive-analytics items), `OEA_TENANT_ONBOARDING.md`, `PHASE1_VENDOR_EVALUATION.md`,
`OE_Group_Phase1_Production_Roadmap.docx`.

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
- [ ] **Domains:** access to DNS for `tfmconsultant.com` and `oraegbunike.com`.
- [ ] **WhatsApp:** a second number for OEA (TFML already live on +234 708 471 4148).
- [ ] **Cloudflare R2** (or confirm Supabase Storage) for photo/video + documents.
- [ ] Decide the **management/admin fee %** OEA deducts from rent before remitting.

**🔒 Security-review preconditions (see the tracker in `RECONCILED_ROADMAP.md`):**
- [ ] **S6 — Next.js decision (blocker):** revert to `14.2.35` (the proven POC
      baseline) **or** keep `16` with an exact pin + a route-by-route verification
      pass. Do **not** start Day 1 on the current uncommitted/unpinned bump.
- [ ] **S8 — verify the classifier model id** `claude-sonnet-4-6` in `lib/triage.ts`
      (a wrong id silently falls back to "needs human review" for every message).

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
> middleware, and DNS/domain routing for tfmconsultant.com and oraegbunike.com.
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

**You do:** designate the **DPO**, sign processor DPAs (Supabase, Vercel, Anthropic,
Meta, Paystack, Flutterwave), publish the privacy notice, run UAT with real staff,
and give the **go/no-go**.

**You verify:** complete the UAT script start to finish with no criticals.

**👁 Visible deliverable:** a **clean security + load report**, a **compliance pack**,
and the **production system live** for TFML and OEA.

**Done when:** no critical findings, UAT signed off, production deployed, rollback
confirmed.

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
