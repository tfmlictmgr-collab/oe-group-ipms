# Phase 1 — Day 1: Environment split (DONE)

**Goal (from `PHASE1_WORKPLAN.md`):** a Phase-1 world that cannot touch the demo.

## What now exists

Two fully independent Supabase projects, one codebase:

| World | Supabase ref | Region | Branch | DB |
|-------|-------------|--------|--------|-----|
| **Demo** (frozen) | `egqzjrmzxqqxrrqpdwbt` | eu-west-1 | `main` / tag `poc-demo-v1` | migrations 0001–0010, live seed |
| **Dev** (Phase 1) | `uszwigxdvjlwcwkjsjmc` | eu-west-2 | `phase-1` | migrations 0001–0010, fresh seed |

Proven independent on 2026-07-24: seeding dev left the demo DB unchanged
(demo still 26 tickets on its own host; dev 22 on a different host). Full
verification suite passes against **dev** — access matrix, RLS REST, and the
payment-gate bypass test all green.

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

- [ ] **Upstash Redis** (free tier) → rate-limit both intake webhooks. Paste
      `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN`.
- [ ] **Sentry** (free tier) → error tracking. Paste the DSN.
- [ ] **Uptime monitor** (Better Uptime / free) → point at the Phase-1 preview URL.
- [ ] **Vercel:** link a Phase-1 preview deployment to the `phase-1` branch with
      the dev env vars (separate from the demo production deployment).

Once those keys are in, Day 1 closes and Day 2 (brand isolation + per-org channel
routing) begins.
