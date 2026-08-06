# Incident — 117 migrations applied to the frozen POC demo database

**Date:** 2026-08-06 · **By:** PC2 · **Status:** contained; one decision open for the account owner

> **PC1: please read and action §4.** Two items need you specifically — the
> demo database decision, and applying `0109` to the dev database (PC2 cannot;
> see §3). Nothing here blocks the Phase-1 build, and no dev or production data
> was touched.

## 1. What happened

While fixing audit finding **0805-C1** (the `sc_budgets` duplicate-period race),
I wrote migration `0109_one_sc_budget_per_property_period.sql` and ran
`npm run migrate`.

`.env.local` on PC2 had its two halves pointing at **two different Supabase
projects**, and nothing in the codebase had ever compared them:

| Half | Project ref | Who uses it |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | `uszwigxdvjlwcwkjsjmc` | the app, every `verify-*.mjs` — **the Phase-1 dev database** |
| `SUPABASE_DB_*` | `egqzjrmzxqqxrrqpdwbt` | **`npm run migrate` only** — the frozen POC demo database |

So the migration runner caught the demo database up from `0010` to `0109` —
**117 migrations (0011 → 0109)**, applied 04:59 UTC. That database had
deliberately sat at `0010_money_integrity_hardening.sql` since **24 July**
(commit `dcab82b`, "Apply 0010 to demo DB"), which is what "frozen" meant.

This violates Standing Rule #1 ("never touch the demo"). It is the same root
cause *class* as `INCIDENT_2026-08-05_PROD_ALIAS.md` — a stale environment
pointer on PC2 — but a different pointer, so yesterday's fix did not cover it.

**The check that should have happened and did not:** I ran a migration without
first confirming which database the runner was actually pointed at. Yesterday's
incident established that exact discipline for `vercel` commands; I did not
extend it to `npm run migrate`.

## 2. Blast radius — what was and was not affected

**Affected: the POC demo database only.**
- Its schema is now Phase-1 (`0109`), not POC (`0010`).
- Its **data is intact**: 5 orgs, 9 users, 3 properties, 40 tickets, 6
  service-charge budgets, 3 payments, 136 audit-log rows — consistent with the
  POC demo fixture set, and every migration applied without error inside its
  own transaction. The migrations in this codebase are additive by design
  (`GO_LIVE_CHECKLIST.md` §4), so no destructive statement ran.
- The demo still serves: `https://oe-group-ipms.vercel.app/login` returns
  **200** and renders "OE Group Portal / Sign in to your account" correctly.

**Not affected:**
- **The dev database (`uszwigxdvjlwcwkjsjmc`) — untouched.** It remains at
  `0108`, exactly where PC1 left it at 04:20 today. `0109` is **not** applied
  there.
- No production environment exists yet to affect.
- No dev data was created or destroyed: `verify-sc-budget-uniqueness.mjs` writes
  fixtures to the REST target and cleans up in a `finally`; confirmed afterwards
  that **zero** `PROBEC1%` rows remain and `sc_budgets` is back to its own 9
  rows.

**The one thing not verified:** whether a *signed-in* demo session still works
against the drifted schema. Pre-auth pages are fine, but `0011+` includes policy
rewrites and the permission matrix (`0050`–`0055`), which a POC-era client on
`main` was never written against. Checking needs a demo login (credentials are in
`DEPLOYMENT.md`); I did not run it.

## 3. Why this was not "reversed"

**Deliberately not attempted: unwinding the 117 migrations by hand.** There are
no down-migrations in this codebase — migrations are forward-only and additive
by design — so a hand-rollback of table creations, policy rewrites, function
replacements and enum changes would produce a *third* state that is neither POC
nor Phase-1, and that nobody has ever tested. That is strictly worse than either
endpoint. The `_migrations` ledger was likewise left alone: it now truthfully
describes that schema, and editing it would only make it lie.

**The clean reversal is a point-in-time restore of `egqzjrmzxqqxrrqpdwbt` to
before 04:59 UTC on 6 Aug 2026.** That is a Supabase dashboard action on the
billing account — PC2 cannot perform it, and it is destructive if aimed wrongly,
so it is deliberately left as an owner decision rather than improvised.

`0109` itself was left in place on the demo database (an inert unique index there
— that database has no duplicate budgets) for the same reason: one more ad-hoc
change to a database I should not have written to is not an improvement.

## 4. What PC1 / the account owner needs to do

- [x] **Decide on the demo database.** → **RESOLVED 2026-08-06 by PC1: accept
      the drift, no restore.** The decision turned entirely on the one thing
      §2 listed as unverified — whether a *signed-in* demo session still
      works against the drifted schema. It does; see §6 for the evidence.
- [x] **Apply `0109` to the dev database** → **DONE (PC1, 2026-08-06).**
      Pre-flight confirmed PC2's finding independently (9 budget rows, zero
      duplicate `(property_id, normalised period)` groups); the index built
      cleanly and `verify-sc-budget-uniqueness` now passes all 15 checks
      against dev, including its own pre-fix race reproduction.
- [x] **Check your own `.env.local`** on PC1 for the same split. → **Clean.**
      Both halves derive to `uszwigxdvjlwcwkjsjmc` (dev). PC2's new guard was
      also exercised on PC1 by deliberately pointing the runner at the demo
      ref: it refused before opening a connection, naming both refs.

## 6. Verification of the demo — the decision evidence (PC1, 2026-08-06)

Read-only, against the live demo at `https://oe-group-ipms.vercel.app`. No
writes of any kind were made to `egqzjrmzxqqxrrqpdwbt`.

The demo runs **POC-era code from `main` against a Phase-1 schema** — the
drift itself is real and visible (the page title is still `Create Next App`,
the sign-in still reads "OE Group Portal / Sign in to your account"). The
question was only whether that combination still *functions*.

| Check | Result |
|---|---|
| `/login` renders | ✅ POC-era UI intact |
| Sign in as `demo@oegroup.test` | ✅ lands on `/dashboard` |
| Dashboard data | ✅ real tickets render, "Live — updates in real time" (realtime subscribed) |
| `/dashboard/vendors` | ✅ all 5 vendors, ranked, with composite scores (93.4 → 53.0) and evaluation counts |
| `/dashboard/sc`, `/payments`, `/statements`, `/audit`, `/settings` | ✅ 200, correct headers, no client error |
| `/dashboard/people` | 404 — **correct**: that route was added after the POC; old code never had it. Not a drift symptom. |

**Why the migrations were survivable, stated plainly:** they are additive by
design (`GO_LIVE_CHECKLIST.md` §4). Nothing dropped a column or table the POC
client reads, so POC-era queries still resolve. The permission-matrix and
policy rewrites (`0050`–`0055`) *widened* what the schema can express without
narrowing what the demo's admin account could already reach.

**Why not restore anyway.** A point-in-time restore is destructive, is aimed
by hand at a project reference, and would be performed to fix something that
demonstrably is not broken — the same category of action, on the same
account, that caused both incidents this week. The risk of aiming it wrongly
strictly exceeds the benefit of undoing drift that has no functional effect.
PITR is also a paid add-on and may not be enabled on this project, in which
case the only lever is a daily-backup restore, which is blunter still.

**Residual risk accepted, and the one instruction it changes.**
`DEPLOYMENT.md`'s demo-day checklist opens with "`npm run seed` beforehand
for a clean, known dataset (optional)". Against a drifted database, running a
POC-era seed script is now the one action with a genuinely unpredictable
outcome — and it is unnecessary, because §2 confirmed the demo data is intact
and this section confirms it renders. **Do not run `npm run seed` against the
demo.** Noted in `DEPLOYMENT.md` itself so the instruction and the caveat are
not in two different documents.

**If the demo is ever needed as a contractual or audit artefact** — as
opposed to a sales walkthrough — revisit this: "the schema is not the one the
POC was signed off on" is a fair objection in that setting, even though
nothing is broken. For a demo or a fallback, it is not.

## 5. Fix landed with this report

`scripts/migrate.mjs` now derives the Supabase project ref from **both** halves
of the environment and **refuses to run when they disagree** — before it opens a
connection, let alone applies anything. A direct host carries the ref as
`db.<ref>.supabase.co`, a pooled one carries it in the username as
`postgres.<ref>`; if either cannot be derived (local or self-hosted Postgres) the
check stays silent rather than insisting on one topology. `ALLOW_MIGRATE_TARGET_MISMATCH=1`
is the deliberate escape hatch.

Verified against the still-mismatched `.env.local` on PC2 — it now refuses, with
both refs named and which one each is used by:

```
Refusing to migrate: .env.local points at two different Supabase projects.

  SUPABASE_DB_*            -> egqzjrmzxqqxrrqpdwbt   (this runner would write HERE)
  NEXT_PUBLIC_SUPABASE_URL -> uszwigxdvjlwcwkjsjmc   (the app and every verify script read HERE)
```

Both failure directions were silent before this: migrating the wrong database
looks exactly like a successful catch-up, and a fix you just wrote appears
applied when it is not. Had this guard existed at 04:59, the incident would not
have occurred.
