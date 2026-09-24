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

### `rc3-20260921.log` — the run of record for `v1.0.0-rc3`

`124 of 124 suite(s) passed.` The first clean sweep the build recorded.

📌 **Committed three days late, on 24 Sept 2026.** The build plan cited this
result at 2.11 from the moment `rc3` was cut, while the file itself sat
untracked on the operator's workstation. Nothing was wrong with the run — the
log says exactly what the plan said it said — but for three days the claim had
no evidence anywhere but one laptop. A run of record belongs in the repository
in the same commit that claims it.

### `rc3-audit.json` — the `npm audit` snapshot for `v1.0.0-rc3`

⚠️ **Byte-identical to `rc2-audit.json`, and nothing in it says why.**
`npm audit --json` writes no timestamp, so a genuine re-run against an
unmoved registry and a copy of the previous file are indistinguishable after
the fact. One day separates `rc2` and `rc3` and no advisory was published
between them, so identical output is entirely plausible — `rc2` and `rc4`,
three days apart, do differ. **Plausible is not proven, and this is recorded
as unproven.** It changes no gate: `rc3` is dead, and `rc4`'s snapshot was
made and checked properly.

📌 The lesson is cheap to act on: an audit snapshot with no timestamp cannot
vouch for itself, so commit it in the same commit as the run it belongs to.

### `rc4-candidate-20260923.log` — NOT a result, kept as evidence

An abandoned run against a tree that predates PR #53's own suite:
`verify-flutterwave-collections` fails immediately with
`ERR_MODULE_NOT_FOUND`, because the file did not exist yet. It is not a
verdict on anything and **must not be read as one** — the run of record for
`rc4` is `rc4-20260923.log`, with 128 suites. Kept only so that a reader
who finds two rc4-ish logs can tell which is which.

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
