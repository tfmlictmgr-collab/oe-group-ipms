# Go-Live Checklist — cutover to production

**Status: not started.** This is the living document for the day Phase 1 moves
off `oe-group-dev` onto a real, board-approved production environment carrying
real TFML/OEA/client data. Nothing here has been executed yet — it exists now so
that when the board gives the go/no-go (Day 12, `PHASE1_WORKPLAN.md`), the answer
to "what happens next" is already written down rather than assembled under time
pressure.

**Rule this whole document follows:** production starts **empty**. `npm run
migrate` (schema only), never `npm run seed` (synthetic data). Every real row —
every org, every user, every property — arrives through the actual onboarding
flow the board will use, not through a fixture. This is stated as a locked gate
in `PHASE1_WORKPLAN.md` Day 12 and repeated here because it is the one step that
cannot be undone by deleting rows afterward (`audit_log` is append-only; ledger
rows are retained, not deletable).

Update this checklist as each item is confirmed — check it off in place, don't
rewrite the doc from scratch. If a step turns out to be wrong or unnecessary when
we actually get there, strike it through with a one-line reason rather than
deleting it silently.

---

> **Looking for "what do I do first?" — see `GO_LIVE_RUNWAY.md`.** This
> document is the reference: every variable, every step, every rollback,
> organised by who performs it. The runway sequences the same work by lead
> time, because several items here depend on external parties (bank KYC,
> legal signatures, Meta/360dialog review) and need starting well before
> cutover rather than on the day.

## 1. Who does what — the split

### Actions only OE Group / the board can take
These need a person with authority outside this codebase — a bank, a legal
signature, a Meta/360dialog business account, a payment processor. I can prepare
everything around them but cannot execute them.

- [x] **Designate the DPO** — **Ebube Ikechwu**, confirmed 2026-08-19.
      NDPC registration of the DPO and publishing their contact details on the
      privacy notice are still open (see draft below).
- [ ] **Sign processor DPAs** — Supabase, Vercel, Anthropic, 360dialog (WhatsApp),
      Telegram (if a DPA is even offered — confirm), Paystack, Flutterwave.
      `CLAUDE.md` A3 requires a data-processing agreement with every processor
      before real personal data flows through it. **Drafted 2026-08-19:**
      `docs/DPA_TEMPLATE_AND_TRACKER.md` — a model NDPA-aligned DPA for
      processors with none of their own, plus the addendum clauses and
      per-vendor status table. Still needs legal review and an actual
      signature from each vendor — drafting is not executing.
- [ ] **Publish the privacy notice** — covers the automated document-verification
      consent line added for decision 10 (AI may verify, never screen).
      **Drafted 2026-08-19:** `docs/PRIVACY_NOTICE.md`. Needs legal review,
      the DPO's contact details filled in, and a publish decision before it's
      live-linked from the sign-in/application screens.
- [ ] **Obtain live payment gateway keys.** Paystack + Flutterwave business
      verification is **in progress** (started 2026-08-19) — no keys yet, but
      no longer "not started". Checked directly against the
      deployed dev host (`oe-group-ipms-dev.vercel.app`): Paystack is already
      configured with a **test** key — the Collections screen shows "Paystack
      test mode. Checkout is the real Paystack page, but no card is charged"
      and real (test) checkouts are working, not the `simulated` adapter. At
      cutover: swap for the live key.
      **Flutterwave** — updated 2026-08-04: no key is set on any environment
      yet, so this remains the item to action, but everything CODE-SIDE it
      needed is now built and verified, not just the pre-existing adapter
      class:
        - a foreign-currency client-funds account is a genuinely separate,
          independently-segregated balance (its own bank account, its own
          `client_funds`+`suspense` ledger accounts) — never summed with Naira
          in the segregation position, the balances page, or the journal;
        - Settings → Banking lets an admin add one (currently USD/GBP/EUR);
        - Collections has a "Request an international payment" flow, currency-
          correct formatting throughout (checkout page, receipts, reconciliation,
          journal), and its own Flutterwave-mode banner;
        - `verify-fx-collections` (21 checks) proves the isolation end to end —
          a foreign-currency collection cannot leak into or be summed with the
          NGN position, an opening-balance allocation cannot cross currencies,
          and the resolvers never return the wrong currency's account.
      **What's still open:** get a Flutterwave account and a test/live secret
      key + webhook hash, set `FLUTTERWAVE_SECRET_KEY` /
      `FLUTTERWAVE_WEBHOOK_HASH`, then the existing "Add a foreign-currency
      account" flow is how it goes live — no further code change. Decide
      before cutover whether FX collections are in scope for go-live or a
      fast-follow; nothing currently depends on it being ready.
- [x] **Confirm the 360dialog account tier** for both numbers — **confirmed
      2026-08-25: direct-client tier, both numbers** (TFML `+234 703 689 1329`,
      OEA `+234 708 471 4148`), verified against the 360dialog dashboard and a
      support-ticket reply. No request signature is available on this tier —
      the token-in-webhook-URL auth path in `WHATSAPP_360DIALOG_MIGRATION.md`
      stays the permanent design, not a stopgap; `verifyWhatsAppInbound()`'s
      HMAC path remains dormant. Nothing code-side changes.
- [x] **Create the two Telegram bots** (TFML, OEA) in @BotFather — **done and
      registered, confirmed 2026-08-25.** Both firing correctly: `@tfml_support_bot`
      (TFML) and `@oea_properties_bot` (OEA). Confirmed live against
      `channel_routes` on `staging` — TFML registered 2026-08-19 as
      `@tfml_support_bot`, OEA registered 2026-08-19 as `@oea_properties_bot`,
      alongside both orgs' WhatsApp routes (`+234 703 689 1329` / `+234 708 471
      4148`) registered 2026-08-20. Matches `docs/TELEGRAM_BOT_SETUP.md` §0's
      record of the actual usernames in use.
      ⚠️ **Housekeeping, not a blocker:** `dev`'s stored Telegram route for TFML
      still carries the pre-rename label `@tfml_facilities_bot` (registered
      2026-07-28, before the username settled) — cosmetic only if the
      underlying bot/token is unchanged and just renamed in Telegram, since
      `register-telegram-bot.mjs` stores the label at registration time and
      doesn't re-read it later. Worth a `getMe` check and, if it really is
      stale, a re-run of `register-telegram-bot.mjs TFML <token>` against
      `dev` — not required before cutover since `staging` (the environment
      that matters for rehearsal) is already correct.
- [x] **Provision a STAGING Supabase project and Vercel project** — done
      2026-08-19. Supabase `tjboghjzbalxwhhatogl` (eu-west-2), migrated to
      `0175` (schema only, zero synthetic rows). Vercel project
      `oe-group-ipms-staging`, deployed from `phase-1`, live at
      `oe-group-ipms-staging.vercel.app`. Full runtime env-var table (§2) set
      to mirror `dev` — test-mode Paystack, no live keys. `use-env.mjs staging`
      switches a local checkout to it; `.vercel.staging.bak` / `.vercel.dev.bak`
      hold both links so switching between them doesn't need re-linking.
      Console shows one non-blocking issue (`NEXT_PUBLIC_SENTRY_DSN` rejected
      by the Sentry SDK on this fresh build despite a verified-correct value —
      SDK just disables itself, no functional impact; flagged as a follow-up,
      not yet root-caused).
      **2026-08-19, for demo/testing:** seeded with the standard demo dataset
      (`npm run seed`) and `oeaportal.com`/`tfmlportal.com` repointed here from
      `oe-group-ipms-dev` (both were serving dev, not a clean environment).
      Doing this surfaced a real gap, not just a staging quirk: **no
      application code anywhere creates a new org** — only `scripts/seed*.mjs`
      and raw migrations ever have. An org created without going through
      migration 0085's one-off slug backfill gets `slug = null` and silently
      cannot use a custom domain (`/login`'s redirect requires a slug). This
      blocks the "provision TFML, OEA, and any client org through the real
      UI" plan below until that UI/action is actually built — flagged as its
      own task, not fixed here (staging's orgs were patched by hand for
      tomorrow only).
- [ ] **Provision the production Supabase project and production Vercel
      project** — separate again, and untouched by anything but the real
      cutover sequence below. Billing/account-owner action; provision this
      only once staging has proven out, so production is never the thing
      being rehearsed on.
- [ ] **Board go/no-go** after UAT (Day 12) — a person decision, not a technical
      one.
- [x] **Decide the admin-fee shape** — **decided 21 Aug 2026: one-time, per
      tenancy.** Implemented in `0181`, and made configurable rather than
      compiled in, on the same reasoning decision 15 gives for notice periods:
      `orgs.admin_fee_basis` (`per_tenancy` — the default — or `per_demand`) in
      Settings → Lettings, with `leases.admin_fee_basis` as the per-case
      override on the lease form. A renewal continues the same tenancy, so it is
      not charged again; the chain is walked through `renewed_from_lease_id`.
      Five checks in `verify-rent-demands` §H hold the behaviour, including the
      renewal case a per-lease check would get wrong.
      **The history, kept because it is the point.** Flagged as open since Day 9
      (ongoing % vs one-time per-tenancy) with `orgs.admin_fee_flat` standing as
      "a flat placeholder, not built out further until decided" — and found on
      10 Aug 2026 to be nothing of the kind: `raise_rent_charge` (`0091`) and
      the rent-collection split (`0092`) had deducted it from every demand since
      Day 9. "Placeholder" described the DECISION; the code was fully wired the
      whole time, and on an annual cadence that meant charging a
      once-per-tenancy fee once a year. 📌 **A decision recorded as pending does
      not make the code that implements it pending.** Confirmed 21 Aug 2026 that
      no row was ever affected — `admin_fee_amount > 0` matches zero
      `rent_charges` on dev and staging alike — which is the only reason this
      closes as a change rather than a correction with restitution attached.
      Dev's OEA org still carries the `25000` left by manual testing; it is now
      a legitimate value under a decided rule rather than a stray one.

### Actions I (Claude) execute
Everything mechanical once the accounts above exist.

- [ ] Point a fresh checkout at the new production Supabase project; run
      `npm run migrate` only.
- [ ] Confirm the three **storage buckets** the migrations create actually
      exist on the new project, and that the two private ones really are
      private: `org-logos` (public by design — it paints the sign-in page),
      `application-documents` (private, identity documents, `0062`) and
      `work-order-media` (private, 25 MB cap, image/video only, `0106`).
      They are created by migration rather than by hand, so this is a
      verification step, not a setup one — but a bucket silently missing means
      evidence uploads fail at the moment a technician is standing in front of
      the work, and a bucket silently *public* means photographs of the inside
      of client homes are reachable by URL.
- [ ] Set every required environment variable on the production Vercel project
      (list in §2 below) — live keys, not the dev/test ones currently in
      `.env.local`.
- [ ] Re-register both 360dialog webhook URLs to the production host (currently
      both point at `oe-group-ipms-dev.vercel.app` per
      `WHATSAPP_360DIALOG_MIGRATION.md`) via
      `scripts/register-whatsapp-number.mjs`, same tokens or freshly rotated.
- [ ] Re-register the Telegram webhook to the production host via
      `scripts/register-telegram-bot.mjs` (now hardened against the
      `delivery_brand`-ambiguity bug — audit 0804 D3).
- [ ] Seed the **operator org only** (`oe-group`, `is_platform_operator = true`)
      and the first real operator admin account — the minimum needed for a human
      to then provision TFML, OEA, and any client orgs through the real UI.
      Nothing else. **⚠️ Blocked: that UI doesn't exist yet** — found
      2026-08-19 while seeding staging, see the staging entry above. Needs
      building before this step is possible for real.
- [ ] **Move** `tfmlportal.com`, `oeaportal.com` and `portal.tfmlconsultant.com`
      to the production Vercel project — Settings → Domains → Add Domain →
      take the "move" option. DNS needs no client action (it already targets
      Vercel's edge); what changes is which project owns the hostname.
      ⚠️ **Move them, never `vercel alias set` them.** An assigned domain
      follows the project's production deployment forever; an alias pins the
      hostname to one immutable deployment that no later deploy moves. That
      exact mistake left both brand portals serving an 18-day-old build across
      four deploys, found the day before the demo (2026-08-20) — see the
      warning block in `CUSTOM_DOMAINS.md`.
      Verify propagation by comparing the `?dpl=` id served on every hostname
      after a deploy, not by eye:
      `curl -sSL https://<host>/login | grep -o 'dpl_[A-Za-z0-9]*' | head -1`
      ⚠️ The **apex** `tfmlconsultant.com` stays where it is (currently
      `50.6.204.142`, TFML's marketing site). Vercel will warn that the apex
      isn't configured; that warning is correct to ignore — only the `portal.`
      subdomain belongs to this system.
- [ ] Run the Day 12 security pass (dependency + secret scan, OWASP ZAP, k6 load
      test, rate-limit confirmation) against the production URL specifically —
      not the dev preview. **How: `security/README.md`** — the ordered sequence,
      which step is safe against what, and the pre-flight that refuses an unsafe
      target. The exact command list, and what "green" looks like for each, is
      `DAY12_CLOSEOUT.md` §8. ⚠️ The ACTIVE scan's window is after cutover and
      **before the first client is onboarded**; once production holds client data
      it becomes a third-party test against a staging clone instead.
      ⚠️ **Target the production alias or a custom domain — never a
      deployment-specific `…-abc123-….vercel.app` URL.** Vercel Deployment
      Protection answers those 302/401 anonymously before the application runs,
      so a scan or load test aimed there measures Vercel's SSO wall rather than
      this system, and reports a clean bill of health for a target it never
      reached.
- [ ] **Both of these ship with whatever commit becomes the production build**
      — built and verified live on staging 2026-08-20, neither yet merged:
      - `0178_a_request_is_reviewed_before_it_is_dispatched.sql` — a request
        can no longer be dispatched to a vendor or ops person until an FM (or
        regional_manager) has reviewed it, enforced by trigger. Closes a real
        gap: `admin` held identical dispatch authority to `facility_manager`
        with nothing requiring the operational review to happen first — same
        shape as decision 9/16, one layer earlier than the money path.
        `tickets.assign_without_review` is the operator-toggle escape hatch,
        off by default for every role including admin. All three paths
        verified against real signed-in sessions on staging: blocked before
        review (real error, not a silent no-op), succeeds after, admin
        equally blocked by default, the toggle correctly overrides when an
        operator turns it on, and `raiseWorkOrder`'s existing "raise and
        dispatch in one step" flow still works unchanged (it stamps its own
        review on creation — raising it yourself IS the review).
      - **Add `/dashboard/new` to `next.config.mjs`'s `outputFileTracingIncludes`
        before production ever builds.** Found 2026-08-20 on staging: the
      portal's own "Submit Request" action calls `classifyMessageWithProvider`
      directly (not through the webhook routes' `handle-inbound.ts` path), and
      was never added to the include list added for the 2026-08-05 webhook
      incident. Every portal-submitted request silently fell back to
      general/normal/needs-human-review — `tickets.classified_by = 'none'`
      for all of them, indistinguishable from a missing API key unless that
      column is checked. Fixed on staging; the fix is in the working tree and
      needs to ship with whatever commit becomes the production build.
- [ ] Run `npm run verify` against production credentials before declaring it
      live, and confirm the production DB is clean (schema only, zero synthetic
      rows) as the Day 12 exit gate states.
      ⚠️ **Exclude `verify-checkout-e2e` from this run** (`npm run verify -- <name>`
      filters, so run the set in two parts, or expect and ignore this one).
      It drives the **simulated** gateway, which `getAdapterByName()` correctly
      refuses to instantiate wherever real money is possible — in production, or
      anywhere a Paystack/Flutterwave key is set. On production it reports ten
      "got 403" failures that are the control working, not a defect; the suite
      now detects this itself and says so, but the checklist should not send
      anyone into it blind. The real gateway path is covered here by
      `verify-collections` and `verify-payment-gate`, which do run against
      production. (Found 2026-08-09 — `DAY12_CLOSEOUT.md` §3.2.)
- [ ] Generate the role-based user guides (§3).
- [ ] Confirm rollback path (§4) is real, not assumed.

### Sequenced together, cutover day
- [ ] UAT with real staff, using real (or realistic rehearsal) data on the
      **production** environment before any live client is onboarded onto it.
- [ ] First real org onboarded end-to-end (application → review → lease/tenancy
      → first invoice or first request) as the actual proof the clean-data gate
      worked, not a synthetic stand-in.

---

## 2. Environment variables — production Vercel project

Grouped by what breaks if missing. "Fails closed" means the feature refuses
rather than doing something unsafe with no key; "fails open" would be a bug.

**Ground-truthed against the current deployment** (`vercel env ls`, live check of
the Collections screen, 2026-08-04) — not assumed from `.env.local`, which is
missing several of these locally even though they're set on Vercel.

| Variable | Required for | Currently on `oe-group-ipms-dev` (Vercel) | At cutover |
|---|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` | everything | ✅ set (Production) | new values, pointing at the **new** production Supabase project |
| `ANTHROPIC_API_KEY` | triage classification, document-check findings | ✅ set (Production) | reuse or rotate |
| `CRON_SECRET` | rent demand + lease notice jobs | ✅ set (Preview + Production) | reuse or rotate |
| `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_APP_SECRET`, `WHATSAPP_VERIFY_TOKEN` | WhatsApp — now the FALLBACK path only; live routing is per-org via `channel_routes` (360dialog migration) | ✅ set (Production) | re-register both org webhooks to the new host (§1) |
| `WHATSAPP_360D_SIGNING_SECRET` | the dormant signature-verification path | not set | only matters if 360dialog Partner tier is obtained |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET` | Telegram — same fallback/per-org split | ✅ set (Production) | re-register to the new host |
| `PAYSTACK_SECRET_KEY`, `NEXT_PUBLIC_PAYSTACK_PUBLIC_KEY` | Naira collections + vendor/landlord transfers | ✅ set, **test mode confirmed live on screen** ("Paystack test mode... no card is charged") | swap for the live key pair |
| `FLUTTERWAVE_SECRET_KEY`, `FLUTTERWAVE_WEBHOOK_HASH` | FX collections | ❌ not set — but the code path IS built and verified now (`verify-fx-collections`, §1); this is purely a missing credential | decide in/out of scope for go-live (§1) |
| `RESEND_API_KEY`, `RESEND_FROM`, `RESEND_WEBHOOK_SECRET` | email notifications | ✅ set (Preview + Production) | reuse or rotate; confirm the sending domain is verified for both brands (`notify.tfmlconsultant.com`, `notify.oraegbunike.com`) |
| `AFRICASTALKING_API_KEY` | SMS fallback | ❌ not set — cascade logs `skipped`, other channels unaffected | decide in/out of scope |
| `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` | rate limiting | ✅ set (Production) | reuse; confirm fail-open posture is still intended (§5) |
| `NEXT_PUBLIC_SENTRY_DSN` | error tracking | ✅ set (Production) | reuse or point at a production Sentry project |
| `TURNSTILE_SECRET_KEY`, `NEXT_PUBLIC_TURNSTILE_SITE_KEY` | bot resistance on the **public vendor-application form** | ❌ not set on any environment — added to this table 2026-08-09, having been missing from it entirely | **decide in/out of scope.** `lib/turnstile.ts` no-ops cleanly when unconfigured, so the layer is silently off today. Three defences remain in front of it (per-IP rate limit → honeypot → submission timing) on one of the few anonymous write surfaces in the system, so out is a defensible answer — but it should be a decision, not a discovery. Free Cloudflare product; ~5 minutes if in. |
| `GEMINI_API_KEY`, `GEMINI_MODEL` | LLM failover when Anthropic is unavailable | ✅ key set — but the free tier's **daily** quota was exhausted immediately | enable billing on the Google Cloud project, or accept the failover is best-effort. See `GO_LIVE_RUNWAY.md` Stage 1. |
| `SIMULATED_GATEWAY_SECRET` | the simulated payment gateway | n/a | **never set in production.** Simulation is refused wherever a real gateway key exists or `NODE_ENV=production`, which is the control that stops an endpoint marking invoices paid without money arriving. |
| `SUPABASE_DB_*` | local migrate/seed only | n/a — local-only | never needed on Vercel |

**Reading this table right:** most secrets already exist because
`oe-group-ipms-dev` is the live, working Phase-1 deployment, not a stub — the
work at cutover is mostly *swapping* (test→live keys, dev DB→production DB,
dev host→production host in the two webhook registrations), not *inventing from
nothing*. The two genuine gaps are Flutterwave (never configured) and Africa's
Talking (never configured) — both are guarded/optional today, so neither blocks
anything currently working; both need an explicit in/out-of-scope decision
before go-live rather than being discovered missing on the day.

`gatewayMode()` in `lib/gateway/index.ts` reads the key's own prefix (`sk_test_`
/ `sk_live_`, `FLWSECK_TEST-` / `FLWSECK-`) and surfaces it on screen exactly as
seen above — check that label right after cutover as confirmation a live key was
actually pasted, not a test one left over from rehearsal.

---

## 3. Role-based user guides — plan, not yet written

Nine roles exist today: `admin`, `executive`, `regional_manager`,
`facility_manager` (branded "Properties Manager" on OEA), `finance_approver`,
`property_owner`, `fm_ops_staff`, `vendor`, `tenant`, plus `viewer` (read-only,
external oversight). B7 already defines what each may reach — the guides
document *how*, screen by screen, not re-derive *what*.

**Plan for each guide:**
- Written from the actual production screens once live (or the final Phase-1
  screens if written slightly ahead of cutover) — not from the spec, so a guide
  never describes a button that moved.
- One guide per role, short — the golden path for that role's B7 capabilities,
  plus the 2–3 things they'll actually ask support about (password reset,
  "why can't I see X" answered by pointing at their own scope, how to read a
  refusal message).
- A combined **admin/onboarding guide** covering org provisioning, permission
  matrix, inviting people, and the settings screens (branding, banking,
  lettings) — this is the one guide that needs to exist before a second org is
  ever provisioned for real.
- Delivered as both a PDF (offline, printable, WhatsApp-shareable) and short
  screen-recorded walkthroughs for the two highest-friction flows: a tenant
  raising and tracking a request, and finance approving + sending a remittance.

**Trigger to actually write these:** once the production UX pass (Day 11) and
security/UAT pass (Day 12) are both done, so the guides are written against
screens that won't change again before go-live.

---

## 4. Rollback

- The frozen POC demo (`poc-demo-v1` tag, its own Supabase project, its own
  Vercel deployment) is untouched by any of this and remains available as a
  fallback demo/sales tool regardless of production's state.
- `oe-group-dev` (this environment) also stays untouched — production is a
  **new**, separate Supabase + Vercel project, not a promotion of dev.
- If UAT or the security pass finds a critical issue after cutover has started:
  the production Vercel project can be pointed back at the previous deployment
  (Vercel keeps every deployment addressable) while the database issue is fixed
  forward — Postgres migrations in this codebase are additive, not destructive,
  so there is no "roll the schema back" step to worry about.
- **The staging world exists so this shouldn't happen.** Rehearsal, UAT
  rehearsals and training recordings run on `staging`, never on `prod` — see
  `GO_LIVE_RUNWAY.md` §"Four worlds, one codebase". Production only ever sees
  `npm run migrate` (schema) before cutover and real onboarding after it.
- If the production DB is nonetheless ever found to hold synthetic/rehearsal
  data by accident: **re-provision it** — recreate the Supabase project and
  run `npm run migrate` fresh, per the Day 12 gate. Do not hand-delete rows —
  `audit_log` cannot be cleaned this way (it's append-only by trigger) and
  financial rows are retained by design, so a partial cleanup would leave the
  DB in a state this codebase was specifically built to prevent existing.

---

## 5. Open questions to resolve before this doc can be executed

- 360dialog account tier / signature availability at go-live — confirms whether
  the dormant `verifyWhatsAppInbound()` HMAC path ever needs to go live, or the
  per-channel token path is permanent.
- Gemini auto-failover (CLAUDE.md B3) — flagged as a Day 12 security-review item
  and not yet implemented; today an Anthropic outage degrades triage to a static
  "needs human review" rather than failing over. Decide whether this ships
  before go-live or is accepted as a known gap with a monitoring alert instead.
- Whether Upstash rate-limiting's fail-open posture is acceptable for production
  as-is, or needs to fail closed for specific high-risk routes (payment
  webhooks, remittance execution) even if general request rate-limiting stays
  fail-open for availability.
