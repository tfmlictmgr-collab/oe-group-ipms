# OE Group IWMS

Integrated FM / property-management platform for **TFML** (facilities) and
**OEA** (property) — two brands, one backend, fully isolated. Next.js on Vercel,
Postgres on Supabase with row-level security as the enforced boundary.

> ⚠️ **This file replaced the `create-next-app` boilerplate**, which survived an
> entire Phase-1 build. Anyone who cloned this repo — a new developer, an
> auditor, the second build machine — opened it and learned how to scaffold a
> Next.js app. If you are looking for something and it is not linked below,
> that is a bug in this file; fix it here rather than remembering where it
> lives.

---

## Start here

| You are… | Read |
|---|---|
| new to the project | `docs/HANDOFF.md` — current state, the two environments, gotchas |
| setting up a machine | `docs/DEV_SETUP.md`, then `docs/PHASE1_SETUP.md` |
| looking for the brief | `CLAUDE.md` — the master build prompt and every locked board decision |
| asking "what's built?" | `docs/PHASE1_WORKPLAN.md`, and the tail of `docs/BUILD_JOURNAL.md` |
| taking it live | `docs/GO_LIVE_CHECKLIST.md`, sequenced by `docs/GO_LIVE_RUNWAY.md` |
| **running security tests** | **`security/README.md`** — ZAP, k6, and the pre-flight that refuses unsafe targets |
| answering a compliance question | `docs/NDPA_COMPLIANCE_PACK.md`, `docs/DAY12_SECURITY_PASS.md` |
| testing with real staff | `docs/UAT_SCRIPT.md` — all ten roles |

---

## Commands

```bash
npm run dev          # local dev server
npm run migrate      # apply pending migrations — .env.local must NOT point at the frozen POC
npm run seed         # synthetic demo data (same caveat)
npm run verify       # the full verification suite
```

Security and load testing — see `security/README.md` before running any of
these, especially `pentest:full`:

```bash
npm run pentest:baseline -- https://target   # passive; safe anywhere
npm run pentest:full     -- https://target   # ACTIVE; empty production only
npm run loadtest         -- https://target   # read-only weekday profile
npm run loadtest:spike   -- https://target   # burst; asserts graceful shedding
npm run loadtest:ratelimit -- https://target # fails if nothing is refused
```

⚠️ `pentest:full` runs a pre-flight that **refuses** a target with a live
payment key, the frozen POC project, or a database that has ever sent a real
remittance. That gate is not advisory — an active scan replays captured POSTs,
and this application writes through Next.js Server Actions.

---

## How it is organised

```
app/            Next.js App Router — dashboard, public entry surfaces, API routes
components/     shared UI + the app shell
lib/            server-side logic: triage, gateways, notifications, remittance
supabase/       migrations — the schema and every policy, in order
scripts/        migrations runner, seeds, and ~50 verification suites
security/       pen-test and load-test configuration
docs/           the brief, the plans, the audits, the compliance pack
```

**The database is the boundary.** RLS policies and `SECURITY DEFINER` functions
decide who may see and do what; the application never re-implements those rules,
and where it once did, the two drifted (see `BUILD_JOURNAL.md`). If you are
adding a permission check, check whether the database already answers it.

---

## Verification

Around 50 suites under `scripts/verify-*.mjs`, each written against a defect
that actually happened. Run them all with `npm run verify`, or one at a time:

```bash
node scripts/verify-security-posture.mjs      # RLS, anon reachability, audit trail
node scripts/verify-role-surface.mjs          # all ten roles, matrix vs menu
node scripts/verify-payment-gate.mjs          # the B4 gate against direct API calls
node scripts/verify-notification-links.mjs    # no notification points at nothing
```

Some suites need `npx tsx` rather than bare `node` — each says so in its own
header. Read it before concluding a suite is broken.
