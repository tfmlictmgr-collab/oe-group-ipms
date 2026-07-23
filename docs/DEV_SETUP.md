# Developer Setup & Working Across Machines

The project is **cloud-backed**, so moving to a new computer is safe and quick, and
you can work on two machines interchangeably. The three sources of truth all live
in the cloud, not on any laptop:

| What | Where | Shared? |
|---|---|---|
| Code | GitHub `tfmlictmgr-collab/oe-group-ipms` | yes (git) |
| Database | Supabase (cloud Postgres) | yes |
| Live app | Vercel | yes |

The **only** thing not in git is `.env.local` (secrets) — correctly ignored. That
single file is the one thing you carry between machines.

## Set up on a new machine

1. Install **Git**, **Node.js 20+** (this project was built on v24), and an editor
   (VS Code).
2. Clone and install:
   ```bash
   git clone https://github.com/tfmlictmgr-collab/oe-group-ipms.git
   cd oe-group-ipms
   npm install
   ```
3. **Copy `.env.local`** from the old machine into the project root — securely
   (encrypted USB, a password manager, or an encrypted note). **Never** email it or
   commit it. This is the one manual step; without it the app can't reach Supabase,
   Claude, or WhatsApp.
4. (Only if you'll deploy from this machine) authenticate + link Vercel:
   ```bash
   npx vercel login
   npx vercel link      # pick tfmlictmgr-collabs-projects / oe-group-ipms
   ```
5. Verify it works:
   ```bash
   npm run dev                       # open http://localhost:3000, log in
   node scripts/verify-rls-rest.mjs  # confirms DB access + RBAC
   ```

Nothing to migrate manually: there is **no local database** (it's Supabase),
`node_modules` is rebuilt by `npm install`, and `.next` is just build cache.

## Working interchangeably (two machines)

Standard git hygiene keeps them in sync — nothing breaks:

- **Start of a session:** `git pull` before you change anything.
- **End of a session:** `git add -A && git commit && git push`.
- Don't edit on both machines at the same time without pulling first.
- If you add a **new secret** (env var) on one machine, copy the updated
  `.env.local` to the other, and add it to Vercel (`vercel env add`) once.

## ⚠️ Important while local and production share one database

Right now **local dev and the live site use the same Supabase project.** That means:

- **`npm run seed` truncates and reseeds the LIVE data** — only run it when you
  intend to reset the demo dataset. Running it on either machine affects production.
- Migrations (`npm run migrate`) also apply to the shared database.

This is a deliberate POC simplification. **Phase 1 Day 1 splits this** into separate
production and development Supabase projects, after which dev work can't touch live
data. Until then: treat `npm run seed` with care.
