# Verify runs

One file per full `npm run verify` against a tagged candidate, named
`<tag>-<yyyymmdd>.log`. The runner buffers each suite's output and prints only
a one-line verdict, so a log is a *summary* — to see why a suite failed, run it
directly: `npx tsx scripts/verify-<name>.mjs`.

## Reading a line

    PASS verify-embeds        29s  ALL CHECKS PASSED — every embed resolves…
    FAIL verify-invoice-appeal 8s  1 CHECK(S) FAILED
    NET  verify-approval-chain 72s network unavailable — Error: fetch failed
    DEMO verify-cascade       111s demonstration only — asserts nothing

`NET` is the runner classifying a connection failure rather than a defect
(`verify-all.mjs`, the `NETWORK` regex). **A run containing `NET` lines is not a
result.** The suites that did run may have been reading a database they kept
losing, and crashes like `Cannot read properties of null` are that, not a bug.
Re-run it; do not triage it.

## What is here

### `rc2-20260920.log` — the run of record for `v1.0.0-rc2`

115 PASS, 2 FAIL, 3 DEMO, **0 NET** across 120 suites. The two failures
(`verify-invoice-appeal`, `verify-role-workflows`) were open at the time of
writing.

📌 Worth keeping for the timings alone. Four suites used to hit their budget:

| suite | before | this run |
|---|---|---|
| `verify-finance-journey` | 900s (timed out) | 173s |
| `verify-notification-links` | 900s (timed out) | 693s |
| `verify-application-review` | 300s (timed out) | completed |
| `verify-approval-chain` | 300s (timed out) | completed |

The cause was never the suites. A backlog of probe users — 752 by 19 Sept —
was being re-read and retried by sweeps that did not skip accounts already
neutralised. Adding `.is("deactivated_at", null)` to the sweeps, and clearing
the backlog with `scripts/sweep-probe-residue.mjs --apply`, is what moved these.

### `rc2-20260919.log` — NOT a result, kept as evidence

Aborted partway (38 of 120 suites) with 5 `NET` lines, `getaddrinfo EAI_AGAIN`
and `ECONNRESET`. Two runs were also started over each other, which leaves
fixtures colliding. Retained because it is the clearest example of what a
contaminated run looks like next to a clean one — and because the timing
contrast above is only legible with both.

## Before a run

1. `git fetch origin main && git reset --hard origin/main` — not `git pull`.
   A stale `origin/main` ref reports "Already up to date" and the run then
   proves nothing about the code you think you are testing.
2. `npm run use-env -- dev`, and check the project id it prints.
3. `node scripts/sweep-probe-residue.mjs` — dry run. Confirm the URL is the
   world you mean before `--apply`.
4. `mkdir -p docs/verify-runs` — `tee` will not create the directory, and
   fails quietly into a pipe if it is missing.

One run at a time, nothing else touching the database. If the connection drops
mid-run, stop and re-run from the start rather than starting a second over it.
