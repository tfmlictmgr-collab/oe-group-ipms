# Go-Live Runway — what to do, in what order

**Companion to `GO_LIVE_CHECKLIST.md`, not a replacement.** That document is
the reference: every variable, every step, every rollback. This one answers
the question it deliberately does not — **what do I do first, and what is
still blocked while I wait?**

The distinction matters because the checklist is organised by *who does what*,
which is the right shape on cutover day and the wrong shape today. Several
items here have **lead times measured in days or weeks and depend on other
people** (bank KYC, legal signatures, Meta/360dialog review). Those need to be
started now, in parallel, or they become the thing everyone waits on.

**Nothing in Stage 1 requires the build to be finished.** Days 1–11 are done;
Day 12 is the security pass, the compliance pack, UAT and cutover. Stage 1 can
run alongside all of that.

---

## Stage 1 — Start now, in parallel (long lead times, external parties)

These are the long poles. Each is independent of the others; none needs
anything from me first. **Start all six on the same day.**

| # | Action | Why it is first | Realistic lead time |
|---|---|---|---|
| 1 | **Designate the DPO** (a named person) | NDPA requires it, and every DPA below is signed *by* or *on behalf of* this person. Signing processor agreements without a designated DPO means redoing the paperwork. | Internal decision — days |
| 2 | **Start Paystack live-key verification** (business/KYC) | Gates real money. It is a review queue at their end, not a form you fill in — starting it late is the classic go-live delay. Test keys already work, so nothing is blocked meanwhile. | 1–3 weeks |
| 3 | **Open the segregated client-funds bank account** (if not already) | This is the account the ledger reconciles against daily (locked decision 2). Without it there is nothing to reconcile *to*, and it is a bank's timeline, not ours. | 1–4 weeks |
| 4 | **Confirm the 360dialog account tier** for both numbers | Decides whether the dormant signature path ever goes live or the per-channel token stays permanent. A support question, but the answer changes a security posture, so it should not be answered on cutover day. | Days |
| 5 | **Create the two Telegram bots** in @BotFather | Fully documented field-by-field in `TELEGRAM_BOT_SETUP.md` — follow it exactly. Personal-account action; ~20 minutes of real work, but it has sat undone for a fortnight, which is the argument for doing it in Stage 1. | 20 minutes |
| 6 | **Decide: is Flutterwave (FX) in scope for go-live?** | A yes starts another KYC queue (same shape as #2). A no costs nothing — the code is built and verified, and turns on later with a key and no code change. **An explicit no is a perfectly good answer**; an undecided is what hurts. | Decision now; 1–3 weeks if yes |

### Also decide during Stage 1 (they change what gets built)

These are open questions from `GO_LIVE_CHECKLIST.md` §5. They are cheap to
answer and expensive to answer late.

- ~~**Gemini failover.**~~ → **BUILT (2026-08-06).** No longer a decision.
  `lib/llm.ts` fails over to Gemini and records which model answered on
  `tickets.classified_by`, so "are we quietly running on the fallback?" is a
  query rather than a hunch. **What remains is one credential:** set
  `GEMINI_API_KEY` (and optionally `GEMINI_MODEL`, default
  `gemini-2.0-flash`) on the production Vercel project. Until it is set the
  fallback is skipped cleanly and behaviour is exactly what it was before —
  so this is safe to leave until cutover, but it is the difference between
  having a failover and having failover *code*. Free tier is sufficient for
  the volumes here; obtain from Google AI Studio. **Add to Stage 1 if you
  want the failover live before go-live rather than at it.**
- **Rate-limit posture.** Limiting currently fails **open** — if Redis is
  unreachable, requests pass rather than being refused. Correct for
  availability on ordinary routes; worth deciding deliberately for payment
  webhooks and remittance execution specifically.
- **SMS fallback** (`AFRICASTALKING_API_KEY`) — in or out? The B8 cascade
  currently logs `skipped` for SMS and carries on. Out is fine; it should just
  be a decision rather than a discovery.
- **The admin-fee shape** — ongoing % or one-time per-tenancy charge. Open
  since Day 9. The column exists as a flat placeholder and is deliberately not
  built out until this is settled.

---

## Stage 2 — Once the DPO is named and accounts exist

| # | Action | Blocked by |
|---|---|---|
| 7 | **Sign processor DPAs** — Supabase, Vercel, Anthropic, 360dialog, Paystack, Flutterwave (if in scope), Resend | #1 (DPO named) |
| 8 | **Publish the privacy notice** — must include the automated document-verification line (locked decision 10) | #1, #7 |
| 9 | **Provision the production Supabase project and production Vercel project** | Billing/account owner. Separate from dev *and* from the frozen demo — this separation is the whole point. |
| 10 | **Hand me the live Paystack keys** (and Flutterwave, if in scope) | #2 / #6 clearing their review queues |

> **⚠️ On #9, from experience this week.** Two incidents in seven days came
> from a stale environment pointer — one aimed a deploy at the wrong Vercel
> project, one aimed a migration at the frozen demo database. Both were
> recoverable; both were avoidable. When the production projects exist,
> **the very first thing to do is confirm which project every tool is pointed
> at**, before anything is deployed or migrated. `scripts/migrate.mjs` now
> refuses a mismatched target on its own, which closes the migration half.

---

## Stage 3 — Cutover (sequenced, one sitting)

Detailed steps are in `GO_LIVE_CHECKLIST.md` §1. The order that matters:

1. **I** point a fresh checkout at the new production Supabase and run
   `npm run migrate` — **schema only, `npm run seed` is never run.** Production
   starts empty by construction; every real row arrives through the real
   onboarding flow.
2. **I** verify the three storage buckets exist and that the two private ones
   really are private (`work-order-media` and `application-documents` hold
   photographs of client homes and identity documents respectively).
3. **I** set every production environment variable — live keys, not the test
   ones (full table: `GO_LIVE_CHECKLIST.md` §2).
4. **I** seed **only** the operator organisation and its first admin account —
   the minimum needed for a human to provision TFML, OEA and any client org
   through the real UI.
5. **I** re-register both 360dialog webhooks and both Telegram webhooks to the
   production host.
6. **I** confirm `tfmlportal.com` / `oeaportal.com` resolve to the **new**
   deployment, verified by content rather than status code.
7. **You** run multi-role UAT against production.
8. **You** give the go/no-go.

---

## Stage 4 — Immediately after go-live

- **Run the Day 12 security pass** — dependency and secret scan, OWASP ZAP
  against the production URL, k6 load test, confirm rate limits behave as
  decided in Stage 1.
- **Role-based user guides** — planned in `GO_LIVE_CHECKLIST.md` §3, not yet
  written. They need the production URLs and the final role labels, which is
  why they are here and not earlier.
- **Daily bank reconciliation** becomes a real operational routine, not a
  screen that exists. This is locked decision 2 and the thing an auditor will
  actually ask to see.

---

## What is genuinely NOT blocking

Worth stating, because it is easy to look at a long list and assume the
build is waiting on it. It is not.

- **Days 1–11 are complete and verified** — 62 suites, all passing.
- **Paystack works today** in test mode, end to end: real checkout page,
  signed webhook, server-side verification, ledger posting, receipt.
- **Flutterwave needs a key and nothing else.** The multi-currency ledger,
  the segregation-per-currency, the admin UI and the verification suite are
  all built and passing.
- **WhatsApp and Telegram intake are live** on both brand numbers, with the
  classifier now telling a greeting apart from a request.
- **The demo is unaffected** and stays available as a fallback asset
  (`INCIDENT_2026-08-06_DEMO_DB_MIGRATED.md` §6).

---

## The single most useful thing to do today

**Stage 1, items 1–6, started in one sitting.** They are the only items whose
duration is set by somebody outside this project, and every one of them is
independent. Everything in Stage 2 and 3 is fast once they clear.
