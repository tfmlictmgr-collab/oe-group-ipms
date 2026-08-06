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

- [ ] **Designate the DPO** (Data Protection Officer) — a named person, per NDPA.
- [ ] **Sign processor DPAs** — Supabase, Vercel, Anthropic, 360dialog (WhatsApp),
      Telegram (if a DPA is even offered — confirm), Paystack, Flutterwave.
      `CLAUDE.md` A3 requires a data-processing agreement with every processor
      before real personal data flows through it.
- [ ] **Publish the privacy notice** — covers the automated document-verification
      consent line added for decision 10 (AI may verify, never screen).
- [ ] **Obtain live payment gateway keys.** Checked directly against the
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
- [ ] **Confirm the 360dialog account tier** for both numbers (TFML
      `+234 703 689 1329`, OEA `+234 708 471 4148`) — direct-client tier has no
      request signature at all (see `WHATSAPP_360DIALOG_MIGRATION.md`); if that
      changes, the webhook auth path changes with it.
- [ ] **Create the two Telegram bots** (TFML, OEA) in @BotFather — a personal
      Telegram-account action, same category as the Meta/360dialog business
      accounts above. **Not done yet** as of 2026-08-05. Full field-by-field
      guide (display name, username + fallbacks, `/setdescription`,
      `/setabouttext`, `/setuserpic`, `/setcommands`, `/setjoingroups`,
      `/setprivacy`) is in `docs/TELEGRAM_BOT_SETUP.md` — don't duplicate it
      here, follow it exactly, then hand the two tokens to whoever runs
      `scripts/register-telegram-bot.mjs` (§1 below, "Actions I execute" —
      registration itself is mechanical once the tokens exist).
- [ ] **Provision a production Supabase project and a production Vercel
      project** — separate from `oe-group-dev` and separate from the frozen POC
      demo. Billing/account-owner action; I can configure everything inside them
      once they exist.
- [ ] **Board go/no-go** after UAT (Day 12) — a person decision, not a technical
      one.
- [ ] **Decide the admin-fee shape** — flagged as an open decision since Day 9
      (ongoing % vs one-time per-tenancy charge). The column exists
      (`orgs.admin_fee_flat`) as a flat placeholder; it is not built out further
      until this is decided.

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
      Nothing else.
- [ ] Confirm `tfmlportal.com` / `oeaportal.com` (already live and linked per the
      journal) resolve correctly against the **new** production deployment, not
      the dev one — a DNS record pointing at the right Vercel project needs no
      client action if it already targets Vercel's edge, but the project itself
      changes.
- [ ] Run the Day 12 security pass (dependency + secret scan, OWASP ZAP, k6 load
      test, rate-limit confirmation) against the production URL specifically —
      not the dev preview.
- [ ] Run `npm run verify` against production credentials before declaring it
      live, and confirm the production DB is clean (schema only, zero synthetic
      rows) as the Day 12 exit gate states.
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
- If the production DB is ever found to hold synthetic/rehearsal data by
  accident (Day 12's stated risk if a rehearsal writes into it): **re-provision
  it**, per the Day 12 gate. Do not hand-delete rows — `audit_log` cannot be
  cleaned this way (it's append-only by trigger) and financial rows are
  retained by design, so a partial cleanup would leave the DB in a state this
  codebase was specifically built to prevent existing.

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
