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

> **Refreshed against the code on 20 Sept 2026** (build plan §2.1, gaps A/B/C).
> The document had fallen three weeks and 89 commits behind the system it
> describes. What changed: the storage-bucket check went from **three buckets to
> seven**, each value now read out of the migration that creates it rather than
> from an older copy of this list; the environment table gained **eight
> variables it had never carried** — `GATEWAY_CREDENTIAL_KEY` first — and
> **struck three it carried that the code no longer reads**; and a new §2a
> records the configuration that is a row in the database rather than a
> variable or a bucket, all of it built after this document was last revised.
> Everything asserted here was measured against `supabase/migrations/`, `lib/`
> and `app/` on that date; nothing was carried forward on trust.

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
- [ ] Confirm the **seven storage buckets** the migrations create actually
      exist on the new project, and that the six private ones really are
      private. **This list said “three” until 20 Sept 2026** — four buckets
      built since (vendor KYC, invoice attachments, payment proof, payout
      evidence) were never added, so the check would have verified three and
      waved four through. Every value below is read out of the migration that
      creates the bucket, not copied from an earlier version of this document:

      | Bucket | `public` | Size limit | MIME allowlist | Created by | Holds |
      |---|---|---|---|---|---|
      | `org-logos` | **`true` — by design** | none set | none set | `0015` | brand marks painted on the sign-in page before anyone authenticates |
      | `application-documents` | `false` | **none set** | **none set** | `0062` | identity documents from tenancy applicants |
      | `work-order-media` | `false` | 26 214 400 (25 MiB) | `image/jpeg`, `image/png`, `image/webp`, `image/heic`, `video/mp4`, `video/quicktime`, `video/webm` | `0106` | photographs and video taken **inside** client homes |
      | `vendor-documents` | `false` | 2 097 152 (2 MiB) | `application/pdf`, `image/jpeg`, `image/png`, `image/webp` | `0164`, **narrowed by `0213`** | vendor KYC — CAC certificates, tax clearance, insurance |
      | `invoice-attachments` | `false` | 2 097 152 (2 MiB) | `application/pdf`, `image/jpeg`, `image/png`, `image/webp`, `image/heic` | `0140` | completion photographs and signed vendor invoices |
      | `payment-proofs` | `false` | 5 242 880 (5 MiB) | `application/pdf`, `image/jpeg`, `image/png`, `image/webp`, `image/heic`, `image/heif` | `0281` | teller slips and transfer receipts for off-platform payments |
      | `payout-evidence` | `false` | 5 242 880 (5 MiB) | `application/pdf`, `image/jpeg`, `image/png`, `image/webp`, `image/heic`, `image/heif` | `0289` | a payee's own bank evidence, and the officer's proof of transfer |

      They are created by migration rather than by hand, so this is a
      verification step, not a setup one — but a bucket silently missing means
      evidence uploads fail at the moment a technician is standing in front of
      the work, and a bucket silently *public* means photographs of the inside
      of client homes, vendor KYC and bank evidence are reachable by URL.

      ⚠️ **`vendor-documents` is 2 MiB, not 15.** `0164` created it at
      15 728 640; `0213` lowered it to 2 097 152 and dropped the allowlist to
      four types, to end the three-way disagreement it found between the
      bucket, the client and the board's stated limit. Read the *current*
      value off the dashboard and expect 2 MiB — a project restored from an
      older snapshot, or a hand-created bucket, will read 15 MiB and accept
      uploads the client refuses.

      ⚠️ **Two buckets carry no size limit and no MIME allowlist**, and one
      of them — `application-documents` — is the system's only
      **anonymous-writable** surface (`0062`: `for insert to anon,
      authenticated`, gated on `org_accepts_tenant_applications`). With the
      bucket's own limits null, the only ceiling is the Supabase
      **project-level** upload limit, so set that deliberately on the
      production project rather than inheriting the default. Recorded as an
      open decision in §5 rather than changed here: this refresh describes the
      code as it is, and tightening a bucket is a migration.
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
- [ ] Create the first real **operator admin account** — the minimum needed for
      a human to then provision TFML, OEA and any client orgs through the real
      UI. Nothing else. **The tool for this is `scripts/bootstrap-production.mjs`**
      (built 2026-09-20, build plan §2.4): it refuses every non-production
      target by hard-coded project ref, refuses any project whose `orgs` is not
      exactly what the migrations created or whose `users` is not empty, creates
      exactly one admin with a random password it never prints, writes an
      `audit_log` row naming the act, and issues a one-time recovery link. It is
      idempotent — a second run is a no-op, not a second admin — and imports
      nothing from `seed.mjs`, which `0208` records as truncating the very orgs
      the migrations create.
      ⚠️ The operator org `oe-group` itself is **created by migration `0088`**,
      not seeded. There is nothing to seed here.
      ⚠️ Set `NEXT_PUBLIC_SITE_URL` **in `.env.prod.local`** before running it,
      not only on Vercel — corrected 22 Sept 2026, having cost exactly the
      confusion it warned about. This script runs on the OPERATOR'S MACHINE and
      reads `.env.local` (`bootstrap-production.mjs:30`); Vercel's copy of the
      variable is invisible to it. The row previously said "(§2)", which points
      at the Vercel table, so the warning was followed and fired anyway.
      ⚠️ **And that alone is not enough — see step 0 of §2a.** The link is a
      Supabase `generateLink`, whose `redirect_to` is validated against the
      project's Redirect URLs allow-list and SILENTLY replaced by the project's
      Site URL when it is not on it. A fresh project's Site URL is
      `http://localhost:3000`, and the verify step consumes the token either
      way — so a link that bounces to localhost is a link that is now spent.
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

**Re-measured against the source on 20 Sept 2026** by sweeping every
`process.env.*` read in `lib/`, `app/`, `middleware.ts` and `next.config.mjs`.
That found eight variables the table had never carried and three it carried
that the code no longer reads — both directions are marked below. A variable
this table invents costs someone an hour at cutover; one it omits costs a
feature that fails closed with no obvious cause.

| Variable | Required for | Currently on `oe-group-ipms-dev` (Vercel) | At cutover |
|---|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` | everything | ✅ set (Production) | new values, pointing at the **new** production Supabase project |
| **`GATEWAY_CREDENTIAL_KEY`** | **the AES key for every org's stored gateway credentials** (`lib/gateway/credentials.ts`). Added 20 Sept 2026 — gap B; it had never been in this table | ❌ not set on any environment | **generate it at the destination** (`openssl rand -base64 32`) and put it in the secret manager FIRST (§2.2 of the build plan). `credentials.ts` refuses anything that does not decode to 32 bytes — the good kind of failure. **Missing at cutover: no org can connect a payment gateway. Lost after cutover: every stored credential is unrecoverable, by design** — it is held in the environment precisely so it is not in the database. Escrow it like the bank mandate, not like an API key |
| **`NEXT_PUBLIC_SITE_URL`** | the fallback origin for invitation, receipt, renewal and gateway-return links (`lib/portal-origin.ts:93`, `app/pay/[reference]/actions.ts:71`). Added 20 Sept 2026 — gap C | ❌ not set | **set it, but understand what it is.** It is step 3 of 3, behind the request host and `orgs.custom_domain`. It is reached only when an org has **no bound domain**, and then every message that org sends carries the deployment address — which on a two-brand system means a TFML recipient can be shown OEA's existence, the one thing B1 exists to prevent. Binding `custom_domain` per org (§2a, step 1) is what stops this being load-bearing |
| `ANTHROPIC_API_KEY` | triage classification, document-check findings | ✅ set (Production) | reuse or rotate |
| `ANTHROPIC_MODEL` | pins the classifier to one model. Added 20 Sept 2026 | ❌ not set — the resolver picks from `claude-opus-5` → `claude-sonnet-5` → `claude-haiku-4-5`, then Models-API discovery, caching the winner | **leave unset unless there is a reason.** A pinned model is tried **alone** — naming one is read as an instruction, not a preference — so a pin that goes stale takes the primary provider down instead of falling through the chain |
| `ANTHROPIC_EFFORT` | reasoning effort on classifier calls. Added 20 Sept 2026 | ❌ not set — defaults to `low` | **leave unset.** `low` is deliberate: these calls emit one small JSON object from a short message, and a classifier that deliberates is a webhook that times out |
| `CRON_SECRET` | rent demand + lease notice jobs | ✅ set (Preview + Production) | reuse or rotate |
| `WHATSAPP_VERIFY_TOKEN` | the Meta webhook **GET handshake** (`app/api/webhooks/whatsapp/route.ts:18`) | ✅ set (Production) | reuse or rotate; must match what is given to Meta/360dialog at re-registration |
| `WHATSAPP_APP_SECRET` | HMAC verification of **native Meta** inbound webhooks (`lib/webhook-security.ts:86`) | ✅ set (Production) | reuse; unused for 360dialog-delivered traffic, which carries no signature on our tier |
| ~~`WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`~~ | **no longer read at runtime** — struck 20 Sept 2026 | ✅ still set (Production), now inert | **do not set on production Vercel.** Outbound WhatsApp resolves its credential from `channel_routes.outbound_token` only; `lib/notify.ts` deliberately removed the shared-token fallback on 11 Sept 2026, because on 360dialog the key alone decides which business a message leaves as, so a route without its own key would have sent as the other brand. Both are still needed **locally** by `scripts/register-whatsapp-number.mjs` at cutover — local shell, not Vercel. |
| `WHATSAPP_360D_SIGNING_SECRET` | the dormant signature-verification path | not set | only matters if 360dialog Partner tier is obtained |
| `TELEGRAM_BOT_TOKEN` | **narrow fallback only**: downloading inbound Telegram media when the route carries no `outbound_token` (`lib/inbound-media.ts:102`) | ✅ set (Production) | reuse. Not the auth path and not the send path — both are per-bot via `channel_routes` |
| ~~`TELEGRAM_WEBHOOK_SECRET`~~ | **not read at runtime** — struck 20 Sept 2026 | ✅ still set (Production), now inert | **not needed on Vercel.** Webhook auth is the `x-telegram-bot-api-secret-token` header matched against a `channel_routes` row, which is both the auth and the org lookup. Needed **locally** by `scripts/register-telegram-bot.mjs` at cutover |
| `PAYSTACK_SECRET_KEY` | the **platform-level** Naira merchant account — collections and transfers for the one org holding `uses_platform_gateway` (`0288`). Every other org connects its own credential, encrypted with `GATEWAY_CREDENTIAL_KEY` | ✅ set, **test mode confirmed live on screen** ("Paystack test mode... no card is charged") | swap for the live key, and decide which org owns it (§2a, step 2) |
| ~~`NEXT_PUBLIC_PAYSTACK_PUBLIC_KEY`~~ | **read nowhere in the codebase** — struck 20 Sept 2026 | listed here since Day 12, never used | **do not set.** Checkout is Paystack's own hosted page, initialised server-side with the secret key; no publishable key is ever handed to the browser. Setting it is harmless but it is not "the live key pair" — there is one key |
| `FLUTTERWAVE_SECRET_KEY`, `FLUTTERWAVE_WEBHOOK_HASH` | FX collections | ❌ not set — but the code path IS built and verified now (`verify-fx-collections`, §1); this is purely a missing credential | decide in/out of scope for go-live (§1) |
| `RESEND_API_KEY`, `RESEND_FROM`, `RESEND_WEBHOOK_SECRET` | email notifications | ✅ set (Preview + Production) | reuse or rotate; confirm the sending domain is verified for both brands (`notify.tfmlconsultant.com`, `notify.oraegbunike.com`). ⚠️ **`RESEND_FROM` is far less load-bearing than this row once implied** — corrected 22 Sept 2026 after tracing all 17 `sendEmail` call sites, every one of which passes an `orgId`. It is reached ONLY when no org row can be loaded at all (a profile with a null `org_id`, or a lookup failure), never when an org exists but has no sender of its own — that case declines instead, deliberately. **What actually governs the From line is `orgs.email_from_address`, which no migration populates: see §2a step 1b.** Set `RESEND_FROM` to a brand-NEUTRAL verified address or leave it unset; setting it to either portal brand means a system mail with no owner goes out wearing one client's identity |
| `AFRICASTALKING_API_KEY` | SMS fallback | ❌ not set — cascade logs `skipped`, other channels unaffected | ✅ **DECIDED OUT for Phase 1, 20 Sept 2026.** WhatsApp, Telegram and email already reach every role, and adding a fourth channel at cutover would add a 14th processor needing its own DPA (1.1) for a path nothing depends on. Revisit post-go-live. Do not set |
| `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` | rate limiting | ✅ set (Production) | reuse; confirm fail-open posture is still intended (§5) |
| `INTAKE_IP_LIMIT`, `INTAKE_IP_WINDOW` | per-IP intake rate limit (`lib/rate-limit.ts:97`). Added 20 Sept 2026 | ❌ not set — silent defaults of **100 per 10 s** | set them explicitly if the default is not the intended posture. A tunable with a silent default is a setting nobody knows they have |
| `INTAKE_SENDER_LIMIT`, `INTAKE_SENDER_WINDOW` | per-sender intake rate limit (`lib/rate-limit.ts:101`). Added 20 Sept 2026 | ❌ not set — silent defaults of **5 per 10 s** | as above |
| `REMITTANCE_LIMIT`, `REMITTANCE_WINDOW` | ceiling on **remittance execution** per user (`lib/rate-limit.ts:110`, enforced in `lib/payout-actions.ts:353` and `app/dashboard/requisitions/send-actions.ts:32`). Added 20 Sept 2026 | ❌ not set — silent defaults of **30 per 5 min** | **decide this one deliberately** — it is the only rate limit on the money-out path, and §5's open question about fail-open posture is specifically about this route |
| `NEXT_PUBLIC_SENTRY_DSN` | error tracking | ✅ set (Production) | reuse or point at a production Sentry project |
| `SENTRY_ORG`, `SENTRY_PROJECT` | **build-time only** — source-map upload (`next.config.mjs:188`). Added 20 Sept 2026 | ❌ not set | set on the production Vercel project if stack traces should be readable. Without them the build succeeds and Sentry receives minified frames, which is a debugging cost discovered during an incident rather than before one |
| `TURNSTILE_SECRET_KEY`, `NEXT_PUBLIC_TURNSTILE_SITE_KEY` | bot resistance on the **public vendor-application form** | ❌ not set on any environment — added to this table 2026-08-09, having been missing from it entirely | ✅ **DECIDED IN, 20 Sept 2026.** Get a free Cloudflare Turnstile site+secret key pair and set both. **No code change is needed — the layer is already wired end to end** (`app/apply/[orgId]/page.tsx` loads the widget, `ApplyForm.tsx` reads the token, `actions.ts` verifies it); it has only ever been missing its keys. ⚠️ **It guards `/apply/<org-uuid>` — the VENDOR application form — and nothing else.** `/tenancy/<org>`, the tenancy application, has no Turnstile: it is reached by a one-time link rather than being openly public. So a Turnstile test must be done on `/apply/`, and the link to it is in the dashboard at **People → Applications**. The org must also have `vendor_applications_open = true`, or the page reads “Applications aren't open” — which looks like a Turnstile failure and is not. `lib/turnstile.ts` no-ops when unconfigured, so until the keys are set the layer is silently off and the three defences in front of it (per-IP rate limit → honeypot → submission timing) are all there is. ~5 minutes |
| `GEMINI_API_KEY`, `GEMINI_MODEL` | LLM failover when Anthropic is unavailable | ✅ key set — but the free tier's **daily** quota was exhausted immediately | ✅ **BEST-EFFORT ACCEPTED, 20 Sept 2026.** Billing not enabled for Phase 1: an Anthropic outage degrades triage to "needs human review", which is a correct and safe behaviour rather than a broken one, and cutover is the wrong moment to add a paid dependency to improve a path that already fails safely. **Paired with a condition:** the `tickets.classified_by` monitoring query at 7.5 must exist, so "are we quietly running on the fallback?" is a fact rather than a hunch. Revisit post-go-live |
| `SIMULATED_GATEWAY_SECRET` | the simulated payment gateway | n/a | **never set in production.** Simulation is refused wherever a real gateway key exists or `NODE_ENV=production`, which is the control that stops an endpoint marking invoices paid without money arriving. |
| `SUPABASE_DB_*` | local migrate/seed only | n/a — local-only | never needed on Vercel |

**Reading this table right:** most secrets already exist because
`oe-group-ipms-dev` is the live, working Phase-1 deployment, not a stub — the
work at cutover is mostly *swapping* (test→live keys, dev DB→production DB,
dev host→production host in the two webhook registrations), not *inventing from
nothing*.

**What is genuinely absent, in the order it hurts** (revised 20 Sept 2026 — this
paragraph previously named only two, and neither was the serious one):

1. **`GATEWAY_CREDENTIAL_KEY`** — never configured anywhere, and unlike the
   others it is not optional and has no fallback. It is generated once at the
   destination and escrowed. Everything else on this list can be added the week
   after go-live; this one cannot be added after the credentials it protects
   have been entered.
2. **`NEXT_PUBLIC_SITE_URL`** — never configured. Optional in the sense that
   nothing crashes without it, load-bearing in the sense that its absence sends
   the wrong brand's address to a real recipient.
3. **Flutterwave** (never configured) and **Africa's Talking** (never
   configured) — both guarded and optional today, so neither blocks anything
   currently working; both need an explicit in/out-of-scope decision before
   go-live rather than being discovered missing on the day.
4. **The six silent-default tunables** — intake and remittance rate limits.
   Not missing so much as unexamined; a default nobody chose is still a
   decision, and one of them governs the money-out path.

`gatewayMode()` in `lib/gateway/index.ts` reads the key's own prefix (`sk_test_`
/ `sk_live_`, `FLWSECK_TEST-` / `FLWSECK-`) and surfaces it on screen exactly as
seen above — check that label right after cutover as confirmation a live key was
actually pasted, not a test one left over from rehearsal.

---

## 2a. Configuration that is neither a bucket nor an env var

**Added 20 Sept 2026.** Everything below is a *row in the production database*
that nothing creates for you — the migrations build the mechanism and leave the
setting at a safe default, which is correct, and means a human sets it after
cutover. None of it appeared in this document before, because all of it was
built after the document was last revised (`0239`–`0296`, 11 Aug – 14 Sept 2026).

Order matters: 1 before 2, because a gateway return URL is a link like any
other.

**0. Configure Supabase Auth's URL settings — Authentication → URL
Configuration.** ⚠️ **Added 22 Sept 2026: this appeared nowhere in either
cutover document**, and it is the first thing that bites, because the very
first act on a new production project is the bootstrap script issuing a
sign-in link.

* **Site URL** → `https://tent-ai-production.vercel.app`. A new Supabase
  project ships with `http://localhost:3000`.
* **Redirect URLs** → add every production host that may terminate an auth
  link: `https://tent-ai-production.vercel.app/**`,
  `https://portal.tfmlconsultant.com/**`, `https://www.tfmlportal.com/**`,
  `https://www.oeaportal.com/**`.

The failure this prevents is a quiet one. `generateLink` embeds
`redirect_to`, Supabase checks it against the allow-list, and **silently
substitutes the Site URL when it does not match** — no error, no warning, a
link that looks completely normal. The verify step consumes the token
regardless, so the bounce does not merely land you in the wrong place: it
**spends the link**. Re-issue with `--reissue-link` and fix this first.

📌 Brand-neutral on purpose, for the same reason as `NEXT_PUBLIC_SITE_URL`
itself: Site URL is the fallback a link lands on when nothing better applies,
and a fallback that names one brand shows it to the other's people.

**1. Bind `custom_domain` on every org** — operator console `/orgs`, the domain
field on each org's card. Do this immediately after the domains are **moved**
to the production Vercel project (§1), and before a single invitation, receipt
or renewal notice is sent. `lib/portal-origin.ts` answers "whose portal is this
link for" in three steps — the request host, then `orgs.custom_domain`, then
`NEXT_PUBLIC_SITE_URL` — and for a message **we** initiate there is no request
host, so an org with no bound domain falls straight to the deployment address.
Verify by sending one real invitation per org and reading the link, not by
reading the settings page back.

⚠️ An org created outside the real onboarding flow gets `slug = null` and
silently cannot use a custom domain at all (found on staging 2026-08-19, §1).
On a correctly bootstrapped production this should not arise — but check the
slug before blaming the domain.

**1b. Set `email_from_address` on every org AS IT IS CREATED — not before.**
Settings → Organisation, per org. ⚠️ **Found 22 Sept 2026 while answering
"what happens if `RESEND_FROM` is blank", and it is not what that question
assumed.** `0024` adds the column and **no migration populates it**, so on the
fresh production database both orgs carry `null` — and `lib/email.ts:123`
reads:

```ts
const from = identity ? senderFor(identity) : envFrom;
if (!from) return { sent: false, reason: "this organisation has no sender address configured" };
```

`identity` is the org ROW. It is non-null the moment the org exists, so the
`envFrom` branch is never reached for an org that exists but has no address —
`senderFor()` returns null and the send **declines**. `RESEND_FROM` does not
rescue it and was never meant to: borrowing another organisation's identity is
the B1 breach the incident in that file's comment describes, so declining is
deliberate.

The blast radius is every email the system sends: invitations, password
resets, receipts, rent demands, lease notices, payment requests, remittance
advices. All of them return `sent: false` with that reason and nothing
reaches anyone. Nothing crashes and no screen shows an error — the links are
still returned on screen, because `inviteMember` and `provisionOrg` are
deliberately best-effort — so **the failure is invisible from the dashboard
and visible only in the logs.**

Use an address on a domain verified in Resend for that brand
(`notify.tfmlconsultant.com`, `notify.oraegbunike.com`), and set
`email_from_name` to the client-facing BRAND, never the holding entity.
Verify by sending one real invitation per org and reading the received
message's From line — not by reading the settings page back.

⚠️ **Corrected the same day, before anybody acted on it.** This step was first
written as "no email sends until you do", which is true of an org that sends
email and false of the two orgs production currently holds. Both were created
by MIGRATION, and neither is a client-facing brand:

* `oe-group` (`0088`) — the platform operator. The control plane.
* `sc-client` (`0094`) — the service-charge client, with no portal of its own yet.

The orgs that actually send to clients — `tfml` and `oea` — do **not exist in
production** and are not supposed to. They are created at cutover through the
operator console, which is why staging carries five orgs (it was seeded) and
production carries two (it never is, rule 1). So a null sender on those two
rows today is the correct state, not a defect, and nothing is currently
failing to send.

📌 **What this means in practice is a SEQUENCE, and it has a trap in it.**
`provisionOrg` (`app/orgs/actions.ts`) creates the org and then emails its
first admin **as the new org** — which by definition has no sender address one
line after being created. That first invitation therefore declines. It is
designed to: the function is deliberately best-effort and *always returns the
link on screen*, so onboarding is never blocked on mail. But it must be
**known** rather than discovered, because the screen shows a link and no
error, and the natural reading is "the email is on its way".

So at cutover, per org: **provision → set `email_from_address` and
`email_from_name` → then invite everyone else.** Hand the first admin their
link from the screen.

⚠️ **`oe-group` is the exception to "null is correct", and it becomes one the
moment 2.4 runs.** Observed live on 22 Sept: with the operator admin created
and no sender on `oe-group`, "Forgot password" at the portal shows *"a reset
link is on its way"* and **sends nothing**. `app/reset-password/actions.ts`
passes `profile.org_id`, which for that account is `oe-group`, so the send
declines — and the page's deliberate silence about whether an account exists
(an enumeration defence) hides the failure completely.

Null was the correct state for `oe-group` while the org had nobody in it.
Once it has an admin, that admin has no self-service recovery. So **set
`oe-group`'s sender immediately after 2.4**, brand-neutrally: its people are
OE Group staff, not a client's, so this is not the B1 question the client
orgs face.

📌 Nobody is ever locked out regardless: `--reissue-link` issues a fresh
one-time link through the service-role key and never touches email. But that
requires the repository and `.env.prod.local`, which is a fact worth knowing
when deciding where `.env.prod.local` lives and who else can reach it.

**2. Designate the one org that owns the platform gateway** — `0288` added
`orgs.uses_platform_gateway`, defaulted **false for every org**, with a unique
index enforcing **at most one** owner across the whole platform. That org's
collections and transfers run on `PAYSTACK_SECRET_KEY` /
`FLUTTERWAVE_SECRET_KEY`; every other org must connect its **own** merchant
account, whose credentials are encrypted with `GATEWAY_CREDENTIAL_KEY`, or take
no online payments at all. This is a deliberate refusal, not a gap: the state it
replaced paid OEA's landlords out of TFML's balance. Decide the owner before
cutover and expect that **every other org cannot take an online payment until
it connects its own account.**

**3. Publish each org's collection account number** — `bank_accounts.published_account_number`
(`0286`), constrained to `client_funds` accounts only. This is the number
printed on the "make a direct bank transfer" screen, telling a payer where to
send money. Without it the offline-payment path can record a payment that has
already happened but cannot tell anyone where to pay. A payout or operating
account cannot carry one, so decision 17 is not weakened by setting it.

**4. Staff the four desks the money paths need.** The off-platform inflow chain
(`0282`, revised by `0293`) is `payment_audit_approver` → `executive` →
`payment_approver`, with the Payment Approver posting to the ledger; outward
disbursement is released by `finance_approver` alone (decision 16). A chain
whose desk has nobody in it stalls silently at that stage. Confirm a real,
signed-in person holds each role in each org **before** the first real payment,
not after one is stuck.

**5. Confirm each org's approval-chain shape and amount bands** — operator
console `/orgs`, the approval-chain field (the screen `0268` added, after `0248`
and `0261` shipped the levers with none). Both ship at their safe default:
`approval_tiers_enabled` is **false** for every org, and the chain shape is
**null**, meaning "derive from the brand". If the board intends anything other
than the brand default for a given org, set it here — it is operator-only by
design and deliberately absent from the org's own settings form (decision 7).

**6. Decide `records.export` per client org** — `0239` added it **off for every
role, admin included**. The platform operator reaches bulk export and document
download through a hardcoded operator check in the route, so the operator never
needs the capability. The capability exists for exactly one purpose: turning
bulk export on for a *specific client org's own* admin, through Settings →
Permissions. It is the shape of capability a data-protection review asks about
by name, so leave it off unless a named org has asked and the answer is
recorded.

**7. Rehearse the tenancy offer → acceptance → lease sequence once** — `0263`
replaced "approval issues a portal invitation" with **offer, then acceptance,
then lease**: the approval records an offer carrying the unit, term, rent,
service charge, deposit and what is payable on acceptance, and issues an
acceptance link to a person with **no account**; accepting is what creates the
invitation. The link is one-time (only its SHA-256 is stored) and expires. This
is the first thing a real applicant touches, it runs entirely outside an
authenticated session, and its failure mode is a link that silently does not
open — so it belongs in production UAT (§1, "Sequenced together") explicitly,
by name.

**9. Set the Supabase project-level upload limit deliberately** — Dashboard →
Storage → Settings. `0300` caps `application-documents` at 10 MB with a
four-type allowlist, which closes the anonymous surface. The project-level
limit is the backstop for every **other** bucket, and it is the only control
covering `org-logos` — which is authenticated-write, **public**, and still
carries no size limit of its own, so an org admin can put an arbitrarily large
file on a publicly-reachable URL. Choose a ceiling rather than inheriting the
default.

**8. Know that payout bank details are evidence, not a stored field** — `0289`.
The full account number is **never stored**: the payee uploads a document
showing it, the payment officer reads the number off that document, and the
system keeps only the bank, the account name and the last four digits. `0296`
keeps the bank's own confirmation of the name against the link. Nothing here is
a setting to configure — it is here because the first payment officer to use it
will ask where the account number field is, and the answer is that its absence
is the control.

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
- **The database half of rollback is `BACKUP_AND_RESTORE.md`** (added 20 Sept
  2026 — gap G). Fix-forward stays the default for *schema* problems, because
  migrations are additive and there is nothing to roll back. A restore is for
  **wrong data**, which is the case a deployment revert never covered: take a
  verified copy with `npm run backup` before any migration or bulk correction,
  restore into a scratch database first, and check the restored row counts
  against the manifest rather than by eye.
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
- ~~Whether Upstash rate-limiting's fail-open posture is acceptable for
  production as-is, or needs to fail closed for specific high-risk routes.~~
  **CLOSED 20 Sept 2026 — and it was already closed in code.** Checked before
  changing anything: the payment webhook answers **503** on `degraded`, and all
  four remittance routes refuse. `lib/rate-limit.ts`'s `RateResult.degraded`
  exists precisely to separate "never configured" (fail open, correct for the
  demo) from "the limiter was meant to be running and is not" (fail closed on
  money). This question sat open in this document long after the code had
  answered it, which is how a control gets re-litigated or built twice; the
  posture is now recorded in `lib/rate-limit.ts`'s own header.
  **What genuinely was a decision:** the ceiling. `REMITTANCE_LIMIT` moved
  **30 → 20 per 5 minutes per user**. Not lower, on measurement: the four call
  sites share one namespace keyed by user id and there is **no bulk-payout
  path**, so a payment officer settling twenty landlords performs twenty
  separate actions. One every 30 seconds is an ordinary pace, so 10 per 5
  minutes would have invented an outage on the first real payout day. A runaway
  loop does hundreds per minute; the low twenties sit in the gap.
- ~~**Whether `application-documents` should carry a size limit and a MIME
  allowlist**~~ — **CLOSED 20 Sept 2026, both answers taken** (`0300` plus a
  deliberate project-level ceiling at cutover, §2a step 9). Reading the upload
  path to size the limits found the reason it mattered: the application code
  **already** refuses anything but PDF/JPEG/PNG/WEBP over 10 MB — but it checks
  the `contentType` and `sizeBytes` the **caller supplies**, then issues a
  signed upload URL, and the file goes straight to Storage with that token.
  Nothing re-checks the bytes that arrive. A caller claiming `application/pdf`
  and 1 KB could push anything of any size through it. The bucket was the only
  place it could be enforced, and it had no opinion. `0300` sets exactly the
  limits the form already claims — the same numbers, not stricter, because
  `0213`'s lesson is that a bucket and a form disagreeing about the limit *is*
  the defect. Original wording kept below for the record.

- *(original, 20 Sept 2026)* **Whether `application-documents` should carry a
  size limit and a MIME allowlist** — raised 20 Sept 2026 by the bucket re-measurement in §1. It is
  the system's only anonymous-writable surface (`0062` grants `insert` to
  `anon`, gated on the org accepting applications) and its bucket carries
  neither, so the only ceiling is the Supabase project-level upload limit. Every
  bucket built since — `0106`, `0140`, `0164`/`0213`, `0281`, `0289` — sets
  both. `org-logos` is in the same state but is authenticated-write and
  public-by-design, so it is the lesser case.
  **Two answers, both defensible:** set the **project-level** limit
  deliberately on the production project and leave the buckets alone (no
  migration, decided at cutover), or write a migration narrowing the bucket the
  way `0213` narrowed `vendor-documents` (safer, but it is a code change, so it
  re-opens build plan §2.11 — cut `rc3` and re-run Stage 0). Not decided here:
  §2.1 is a documentation refresh, and this is the one thing it found that a
  document cannot fix.
