# Incident — POC production briefly overwritten by Phase-1 code

**Date:** 2026-08-05 · **By:** PC2 · **Duration:** ~5–8 minutes · **Status:** resolved, root cause fixed

> **Shared for PC1 to be aware of.** No data loss, no code loss, no lasting
> effect — but this briefly violated Standing Rule #1 ("never touch the
> demo") and is recorded in full rather than only mentioning the fix.

## What happened
While force-deploying a favicon fix to clear a stale build cache, I ran
`vercel deploy --prod=false --force` without an explicit `--project` flag.
The local `.vercel/project.json` link on PC2 — left over from earlier session
work — was pointed at **`oe-group-ipms`** (the frozen POC/demo project), not
`oe-group-ipms-dev`. `--prod=false` did not do what I expected; the deploy
went out as **Production** and got aliased to the live demo URL,
**`https://oe-group-ipms.vercel.app`**, running Phase-1 code (commit
`db97bc1`) against what is meant to be a frozen `main`-branch deployment.

**Exposure window:** the bad deployment reached `Ready` ~07:44–07:47 UTC.
Caught via the routine deployment-status check I run after every deploy;
rollback completed ~07:52 UTC. No report of anyone hitting the demo in that
window, but it should be treated as a real (if brief) exposure, not a
theoretical one.

## How it was found and fixed
1. Deployment-status check showed `target: production` and an aliased demo
   URL where a Preview build was expected — caught immediately, not
   discovered later.
2. `oe-group-ipms`'s recent deployment history was almost entirely
   `phase-1`-branch Preview builds (that project auto-deploys every pushed
   branch as Preview — a separate, harmless, known quirk). The genuine prior
   `main`/production deployment wasn't in the visible recent history at all.
3. Queried the Vercel API directly, filtered to `target=production`, to find
   it without guessing: `oe-group-ipms-28ppkulx6-…`, commit `dcab82b`
   ("Apply 0010 to demo DB + prove the payment gate blocks direct API
   calls") — recognisable as genuine prior POC history, not a guess.
4. `vercel rollback` to that deployment. Verified **by content, not just
   status code** — `/login` correctly shows "OE Group Portal / Sign in to
   your account" again (not just an HTTP 200).

## Root cause and fix
The local Vercel CLI project link was stale/wrong, and `--prod=false` is not
a reliable way to force a Preview deploy (it did not behave as documented).
Fixed:
- Removed and correctly relinked `.vercel/project.json` to
  `oe-group-ipms-dev` (`prj_apZGqo3YPBnMyDZBRXifrl6eC2e4`), verified against
  the deploy hook's own project ID.
- Going forward on PC2: no raw `vercel deploy`/`vercel rollback` without
  explicitly confirming the linked project first (now a standing step before
  any such command); prefer the project-scoped deploy hook or git-push
  auto-deploy over ad hoc CLI deploys where possible.

## Worth PC1 checking
- **On any machine that runs `vercel` CLI commands directly**, worth
  confirming `.vercel/project.json` is correct before deploying — this
  exact class of mistake (stale link + an ambiguous flag) is easy to repeat
  on a different machine.
- The `oe-group-ipms` project auto-deploying every `phase-1` push as Preview
  is itself harmless (doesn't touch the production alias) but adds noise —
  worth deciding whether that project's Git integration should be scoped to
  `main` only, which would have prevented the confusing "which project is
  this" moment even before the flag mistake.

## What shipped once correctly deployed to `oe-group-ipms-dev`
The actual intended work (unrelated to the incident): a dynamic per-org
favicon (`app/favicon.ico/route.ts`, resolves the org from the Host header
for bound custom domains; `/o/[slug]`'s own `generateMetadata` covers the
shared-host slug-path case) and `scripts/set-org-logo.mjs` for setting an
org's logo from a local file. Verified live: TFML and OEA each show their
own uploaded logo on their respective `/o/<slug>` pages.
