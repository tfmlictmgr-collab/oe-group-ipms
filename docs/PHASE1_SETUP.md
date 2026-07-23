# Phase 1 Setup — three isolated worlds, one codebase

**Principle:** Phase 1 is built **on** the POC (reuse, not rebuild), but isolated at
the **data + deployment** layer so the client demo is never at risk.

## The three worlds

| World | Code | Database | Deployment | Purpose |
|---|---|---|---|---|
| **Demo** | `main` / tag `poc-demo-v1` | current Supabase (synthetic) | `oe-group-ipms.vercel.app` | client illustrations — frozen |
| **Phase 1 dev** | `phase-1` branch | **new** `oe-group-dev` Supabase | Vercel preview | building Phase 1 |
| **Production** (later) | `phase-1`→`main` when ready | new production Supabase | new deployment | real OEA/TFML data |

The demo and Phase 1 **share the code** (branches of one repo) but have **separate
databases and deployments**, so nothing in Phase 1 can touch the demo.

## One-time setup (on the new machine)

1. Get the project running (see `DEV_SETUP.md`): clone, `npm install`, copy
   `.env.local`.
2. **Create a new Supabase project** `oe-group-dev` (supabase.com → New Project).
   This is Phase 1's database — separate from the demo's.
3. **Branch:** `git checkout -b phase-1` (keeps `main`/demo frozen).
4. **Point `.env.local` at the dev DB** — swap `NEXT_PUBLIC_SUPABASE_URL`,
   `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, and the
   `SUPABASE_DB_*` values to the new project's. (Paste them to Claude and it wires
   it up.)
5. **Populate dev:** `npm run migrate` then `npm run seed` — now a full working
   copy with **zero** risk to the demo.

## Working rules

- Build Phase 1 **only on the `phase-1` branch**, with `.env.local` pointed at
  `oe-group-dev`. Commit + push often.
- Deploy Phase 1 to a **Vercel preview** (branch deploy), never to the demo's
  production URL.
- **Never point a Phase-1 machine's `.env.local` at the demo/current Supabase** —
  that is the only way `npm run seed` could reach the demo data.
- Merge `phase-1` → `main` only after Phase 1 is tested; production is then a fresh
  deployment + database, not the demo.

## Keeping the demo usable long-term

- The live demo URL + the 9 logins are your sales tool; keep them bookmarked.
- `poc-demo-v1` tag = restorable code snapshot (`git checkout poc-demo-v1`).
- If a demo session leaves messy data, reset it with `npm run seed` **from a
  machine whose `.env.local` points at the demo DB** (not the dev DB).
- Recommended before launch: give production its **own** Vercel project + Supabase
  so the demo URL never changes when production ships.
