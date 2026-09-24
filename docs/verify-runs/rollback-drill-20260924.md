# 4.5 — rollback drill, deployment half

**Run:** 24 September 2026, against production, while it was still empty.
**Recovery time: under 10 seconds**, click to content change.

## What was done

| # | Step | Evidence |
|---|---|---|
| 1 | Baseline — `5f5512a` (redeployed to attach `DPO_CONTACT_EMAIL`) | `/legal/privacy` → **200**, `mailto:ebubei@tfmlconsultant.com` |
| 2 | **Instant Rollback** to `c745150` (the PR #58 merge) | `/legal/privacy` → **404** |
| 3 | **Promote** back to the `5f5512a` redeploy | `/legal/privacy` → **200**, `mailto:ebubei@tfmlconsultant.com` |

## Why the 404 is the result, and the `dpl_` id is not

`c745150` predates the privacy notice, so `/legal/privacy` does not exist in
it. A **404 cannot be faked by a cache or a stale edge**: the rolled-back build
genuinely does not contain the route. That is content-level proof, which is the
standard the 20 August failure set — four deploys served an eighteen-day-old
build while every hostname answered 200.

⚠️ **Two builds of `5f5512a` exist**, and only one is correct. The original
(6h) was built before `DPO_CONTACT_EMAIL` was added and cannot see it; the
redeploy has it. Promoting the wrong one restores the site and silently
republishes the wrong Data Protection Officer address. **Whenever an
environment variable has been added since a deployment was built, "roll
forward" is not "the previous production deployment" — it is the redeploy.**
The second check above, reading the address back, is what distinguishes them;
the status code does not.

📌 **Every production check needs `curl -L`.** The apex 308s to `www`, so a
bare `curl -s -o /dev/null -w "%{http_code}"` reports **308** for a perfectly
healthy page. This cost one round trip here and would cost far more during a
real incident at 2am.

## What this does NOT cover

The database. `4.5` originally asked for a **PITR restore**, and PITR was
**declined on a recorded basis** (`BACKUP_AND_RESTORE.md` §1): $2,520/year
across two projects, and it covers Postgres only — not one identity document,
payment proof or payout evidence file, all of which live in Storage. So the
step as written names a mechanism this project deliberately does not have.

The database half is therefore a **restore drill of the backup that does
exist**: `npm run backup` (pg_dump custom format, encrypted), decrypted and
restored into a local PostgreSQL 16, verified against the committed production
proof — `_migrations` at 321, `max(name)` at `0300`, and the table counts of
`stage5-20260924-production-proof.md`.

⚠️ That proves the dump is complete and restorable. It does **not** prove
restoring into a *Supabase* project, where roles, extensions and the auth
schema differ — and that is the restore an actual incident would require.
Closing that gap needs a spare Supabase project.

📌 **`BACKUP_AND_RESTORE.md` §5 asks for the PITR decision to be revisited when
"a second client organisation is onboarded, so a bad day affects people who did
not choose this trade".** Four organisations are provisioned and real tenants
are arriving. **That trigger is met.** The decision was sound when the first
client had not been onboarded; it is now due for the board rather than for
whoever remembers.
