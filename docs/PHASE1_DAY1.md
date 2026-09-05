# Phase 1 — Day 1: Environment split (DONE)

**Goal (from `PHASE1_WORKPLAN.md`):** a Phase-1 world that cannot touch the demo.

## What now exists

Two fully independent worlds — separate Supabase **and** separate Vercel
projects — on one codebase:

| World | Supabase ref | Region | Vercel project | Live URL | Branch |
|-------|-------------|--------|----------------|----------|--------|
| **Demo** (frozen) | `egqzjrmzxqqxrrqpdwbt` | eu-west-1 | `oe-group-ipms` | oe-group-ipms.vercel.app | `main` / `poc-demo-v1` |
| **Dev** (Phase 1) | `uszwigxdvjlwcwkjsjmc` | eu-west-2 | `oe-group-ipms-dev` | **oe-group-ipms-dev.vercel.app** | `phase-1` |

Proven independent on 2026-07-24: seeding dev left the demo DB unchanged
(demo still 26 tickets on its own host; dev 22 on a different host). Full
verification suite passes against **dev** — access matrix, RLS REST, and the
payment-gate bypass test all green.

### Why two Vercel projects (not Preview-scoping)

The demo project's env vars (incl. `NEXT_PUBLIC_SUPABASE_URL`) are set for **all**
environments — Development, Preview *and* Production. So a phase-1 *Preview*
deployment inside the demo project would have inherited the **demo database**.
A separate `oe-group-ipms-dev` project gives the dev world its own env, its own
URL, and zero chance of touching the demo — mirroring the Supabase split.

**Deploy the dev world:** from the `phase-1` branch, `npx vercel deploy --prod`
(this working copy is linked to `oe-group-ipms-dev`; the demo link is backed up
at `.vercel.demo.bak`, gitignored). The dev project holds only the **runtime**
env vars — the `SUPABASE_DB_*` pooler creds are deliberately excluded (migrations
run locally, least-privilege). Verified live: the deployed login bundle references
`uszwigxdvjlwcwkjsjmc.supabase.co` (dev), webhooks fail-closed 403, demo untouched.

*(GitHub auto-deploy on push is not connected for the dev project — deploy via the
CLI command above. Connect it in the Vercel dashboard later if wanted, setting the
dev project's production branch to `phase-1`.)*

## Switching worlds on one machine

`.env.local` is the only thing that decides which DB you hit. Two gitignored
backing files hold each world's secrets:

- `.env.demo.local` — the frozen demo/POC project
- `.env.dev.local` — the Phase-1 dev project

Flip between them:

```bash
node scripts/use-env.mjs dev    # point at Phase-1 dev
node scripts/use-env.mjs demo   # point at the frozen demo
node scripts/use-env.mjs        # show which is active
```

Restart the dev server after switching so it reloads env.

**Standing rule #1 still holds:** normal Phase-1 work runs on `phase-1` + dev.
Only touch demo to *show* it. Never `npm run seed`/`migrate` while pointed at
demo — `use-env.mjs demo` is for running the app read-only, not for writes.

## Second machine (PC2)

`git pull` gets the `phase-1` branch and `scripts/use-env.mjs`, but **not** the
`.env.*.local` files (gitignored — secrets never go in git). On PC2, recreate
`.env.dev.local` and `.env.demo.local` from the same credentials, then
`node scripts/use-env.mjs dev`.

## Still open on Day 1 (need your accounts)

The env split, branch, migrations, seed, and verification are done. These remain,
each needs a key you create:

- [x] **Upstash Redis** — DONE (2026-07-24). Sliding-window limiter on both
      intake webhooks (`lib/rate-limit.ts`): coarse per-IP shield (100/10s) +
      per-sender burst cap (5/10s), both env-tunable. Drops with 200 (no provider
      retry-storm) and **fails open** when Redis is unconfigured, so the demo is
      unaffected. Proven live: `node scripts/verify-rate-limit.mjs`.
- [x] **Sentry** — DONE (2026-07-24). `@sentry/nextjs` wired for server, edge,
      and client runtimes via `instrumentation.ts` + the three `sentry.*.config.ts`
      files, plus an `app/global-error.tsx` boundary. DSN is env-gated
      (`NEXT_PUBLIC_SENTRY_DSN`) so an env without a DSN — the demo — runs Sentry
      **disabled**, sending nothing. Source-map upload deferred to Day 12 (needs
      an auth token). Proven live: a test event flushed to the project
      (`flushed: true`); no-DSN path confirmed to send nothing without crashing.
- [x] **Vercel** — DONE (2026-07-24). Separate `oe-group-ipms-dev` project,
      14 runtime env vars (Production scope), phase-1 deployed and verified live
      at **https://oe-group-ipms-dev.vercel.app**. Demo project untouched.
- [x] **Uptime monitor** — DONE (2026-07-24). UptimeRobot HTTPS check live on the
      dev deployment, reporting **100%**.

**Day 1 is COMPLETE.** Env split, isolated dev DB, rate-limiting, error tracking,
an isolated live dev deployment, and uptime monitoring are all done and verified.
Day 2 — brand isolation + per-org channel routing (removing the hardcoded
`DEMO_ORG_ID` from the webhooks) — can begin.
