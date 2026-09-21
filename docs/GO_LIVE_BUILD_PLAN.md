# Go-Live Build Plan — the staged route from `phase-1` to production

**Written:** 2026-09-17 · **Candidate:** `v1.0.0-rc2` · **Status:** **Stage 0 CLOSED 2026-09-20** — all six steps done. Stage 1 is the critical path; 1.7 gates Stage 3. See *What Stage 0 found*.

**What this is.** `GO_LIVE_CHECKLIST.md` is the reference (every variable, every
rollback, organised by who performs it). `GO_LIVE_RUNWAY.md` sequences the
external long poles. Neither has been updated since **25 August**, and the code
has moved to **14 September** — 89 commits and migrations `0203`–`0296` later,
carrying off-platform payments, bank-transfer payouts, the tenancy
offer/accept/record flow, the records export and the Directory. **This document
is the plan that reconciles the two**: it re-verifies the build as it stands
today, states what genuinely blocks go-live, and lays out the stages, the steps
inside each, and the tracker that says where we are.

It does not replace the other two. Where a step here says "per checklist §2",
that is deliberate — one source of truth per fact, and this document is the
*sequence*, not a second copy of the reference.

**The rule every stage below obeys, restated because it is the one thing that
cannot be undone:** production starts **empty**. `npm run migrate` (schema
only), **never** `npm run seed`. `audit_log` is append-only by trigger and
ledger rows are retained by design, so synthetic data in production cannot be
cleaned out afterwards — it can only be escaped by destroying and re-creating
the project.

---

## 0. Where the build actually stands — measured 2026-09-17

Not inherited from the older docs. Re-run today against `phase-1` @ `384c0af`
in a clean worktree.

| Check | Command | Result |
|---|---|---|
| Dependencies install from the lockfile | `npm ci` | ✅ exit 0 |
| Types | `npx tsc --noEmit` | ✅ exit 0 |
| Lint | `npx next lint` | ✅ exit 0 — warnings only (2 × `jsx-a11y/alt-text` in the PDF generators) |
| Production build | `npm run build` | ✅ exit 0 — compiled, 81/81 static pages, **with no environment variables set at all** |
| Branch topology | `git merge-base --is-ancestor` | ✅ `claude/kyc-records-export` is fully contained in `phase-1` — one line of work, nothing to reconcile |
| PR #1 (`phase-1` → `main`) | GitHub | ✅ `mergeable_state: clean`, 347 commits, 961 files |
| Verification suites present | `scripts/verify-*.mjs` | 121 |
| Verification runner honesty | `scripts/verify-all.mjs:306` | ✅ `process.exit(failed.length === 0 && skipped.length === 0 ? 0 : 1)` — the "exits 0 while suites fail" defect named in PR #1's reviewer notes is **fixed** |

**Three blockers recorded in the older docs are closed:**

- *"No application code anywhere creates a new org"* (19 Aug, the thing that
  blocked provisioning TFML/OEA through the real UI) → `app/orgs/CreateOrgForm.tsx`,
  `app/orgs/actions.ts`, `scripts/verify-org-creation.mjs`, and `0176` gives an
  org its slug at creation rather than by backfill.
- *"Add `/dashboard/new` to `outputFileTracingIncludes` before production ever
  builds"* (20 Aug) → present in `next.config.mjs`.
- *`0178_a_request_is_reviewed_before_it_is_dispatched`* was "built but not
  merged" → it is on `phase-1`.

**What was NOT verified today, and cannot be from here:** anything needing
database credentials. `npm run verify` (124 suites), the migration run, and
every RLS assertion are green *as of the last recorded run*, not as of today.
Re-running them against the release tag is step 0.3 below, and it is not a
formality — it is the only thing that proves the 89 commits since the last
full-suite record did not break something.

---

## 1. What stands in the way

The honest answer is: **nothing in the code**, and **nine things around it**.
Six are other people's timelines, three are ours.

### 1a. Ours — real gaps found today, none large

| # | Gap | Why it matters | Where it lands |
|---|---|---|---|
| A | **The cutover doc names 3 storage buckets. The migrations create 7.** `org-logos` (public by design), `application-documents`, `work-order-media`, `vendor-documents`, `invoice-attachments`, `payment-proofs`, `payout-evidence`. | The cutover step "confirm the buckets exist and the private ones are private" would verify three and wave four through. Four of the missing ones hold identity documents, vendor KYC, payment proof and payout evidence. A bucket silently public in production is a disclosure of exactly the material this system exists to protect. | 2.1, 3.4 |
| B | **`GATEWAY_CREDENTIAL_KEY` is absent from the env-var table.** It is the AES key for every organisation's stored gateway credentials, held in the application environment *by design* so it is not in the database. `lib/gateway/credentials.ts:12` states the consequence: losing it makes every stored credential unrecoverable. | It is not optional and it has no fallback. Missing at cutover = no organisation can take a payment. Lost after cutover = credentials must be re-entered by every org, with no recovery path. | 2.2, 2.3 |
| C | **`NEXT_PUBLIC_SITE_URL` is absent from the env-var table**, and `lib/portal-origin.ts` (11 Sept) exists precisely because it is the wrong answer to "whose portal is this link for". It is now step 3 of 3, behind the request host and `orgs.custom_domain`. | If an org has no bound domain in production, every invitation, receipt link, renewal notice and gateway return URL falls through to the deployment address. B1 says a user on one portal must never see the other brand's existence, and an address is the most visible thing in a message. **Binding `custom_domain` per org on production is a cutover step that appears in no current document.** | 2.2, 5.8 |
| D | **No production bootstrap path for the first operator admin.** `0088` creates the operator org `oe-group` by migration, so that part is handled. Every script that creates a *user* (`seed-demo-user`, `seed-org-logins`, `seed.mjs`, …) is a demo seeder, and `0208` records that the seed **truncates orgs the migrations created**. | There is currently no safe way to create the one account production needs without reaching for a script that must never touch it. This is the single highest-risk moment of the whole cutover and it has no tooling. | 2.4 |
| E | **No CI.** `.github/workflows/` does not exist. The only check on PR #1 is `Vercel Preview Comments`. | Nothing automatically runs types, lint, build or the suites before a merge to `main`. For the branch that becomes the production build of a system that moves client money, the gate should not be "someone remembered". | 0.6 |
| F | ✅ **CLOSED 20 Sept 2026** — `BACKUP_AND_RESTORE.md` (posture, procedure, quarterly drill), with PITR considered and declined on a recorded basis. ⛔ One thing it opened: Storage backup is unconfirmed — see 2.5. *Original finding:* **No backup or restore policy, and no restore drill.** `DEPLOYMENT.md`, `GO_LIVE_CHECKLIST.md`, `NDPA_COMPLIANCE_PACK.md` and `DAY12_SECURITY_PASS.md` contain no mention of backups, PITR or restore. The one place it appears — `INCIDENT_2026-08-06` — says of the demo project that *"the only lever is a daily-backup restore, which is blunter still"*, i.e. PITR is not enabled. | NDPA s.39 is not only confidentiality; availability and recoverability are part of it. A ledger with no tested restore is a ledger with one copy. | 2.5, 7.6 |
| G | **The rollback story covers the application and not the database.** Reverting the Vercel deployment is real and instant. There is no rehearsed answer to "the schema is fine but the data is wrong". | Fix-forward is the right default given additive migrations — but it should be a decision with a rehearsed alternative, not the absence of one. | 4.5 |

Two more are decisions rather than gaps, and both are cheap now and expensive
late: **rate-limit posture** for payment webhooks and remittance execution
(currently fails open, correct for intake, arguable for money), and **Gemini
failover** (key set, free tier's *daily* quota exhausted on first use — either
enable billing or record that failover shortens an outage rather than
preventing one).

### 1b. Theirs — the six that set the date

None of these can be shortened by anything in this repository, and every one of
them gates real data or real money. They are Stage 1 and they start today.

1. **13 processor DPAs, all unsigned** (`NDPA_COMPLIANCE_PACK.md` §4). Drafts
   exist in `DPA_TEMPLATE_AND_TRACKER.md`. This is the largest compliance gap
   and it gates *any* real personal data.
2. **Privacy notice unpublished** — drafted, needs legal review and the DPO's
   contact details.
3. **Breach procedure (NDPA s.40, 72 hours) unwritten.**
4. **Data-subject-rights procedure unpublished**; subject-access export and
   portability are not built.
5. **Live Paystack keys** — production is still test mode. KYC is a queue at
   their end.
6. **External penetration test not commissioned** — and its only clean window
   is *after* cutover and *before* the first client is onboarded.

Alongside them: NDPC registration threshold, the cross-border/hosting-region
basis, the board's decision on whether special-category data is collected at
all, the segregated client-funds bank account, and an explicit in-or-out on
Flutterwave (FX).

### 1c. Accepted, with reasons, and not blockers

- **`next@14.2.35`, 23 advisories.** Applicability was assessed rather than
  assumed (`DAY12_SECURITY_PASS.md` §4a): the Image Optimizer, Pages Router,
  custom-server and CSP-nonce classes do not apply to this deployment.
  **Upgrading two majors in the cutover window trades non-applicable advisories
  for an untested regression surface across the money path.** First post-go-live
  work item (7.4), not a cutover edit.

  ⚠️ **Re-checked 2026-09-20 against `v1.0.0-rc2` (step 0.5), and one clause of
  the original reasoning has expired.** It read "availability and
  cache-correctness, not disclosure". That is no longer true:
  `GHSA-955p-x3mx-jcvp`, *unauthenticated disclosure of internal Server Function
  endpoints*, applies to App Router applications and this one carries
  `"use server"` in **54 files**. Two further applicable entries have appeared —
  `GHSA-m99w-x7hq-7vfj` (DoS in App Router using Server Actions, high) and
  `GHSA-4c39-4ccg-62r3` (unbounded Server Action payload, Edge runtime).

  Re-confirmed as still NOT applicable, by inspection rather than by title: both
  criticals (`GHSA-p293-qw3h-jr36` is windows-hosted only and Vercel is Linux;
  `GHSA-2xp9-vwfh-vxw4` needs the app's own Image Optimization API with AVIF,
  and `sharp` is absent while Vercel's managed optimizer serves `next/image`),
  the rewrites SSRF and smuggling pair (no `rewrites` in `next.config.mjs`), the
  Pages Router i18n middleware bypass (no `pages/`), and the custom-server SSRF
  (no custom server).

  📌 **The deferral stands; the reason for it narrows.** The fix is
  `next@>=15.5.24`, which npm marks `isSemVerMajor` — still a two-major
  migration and still the wrong thing to attempt in a cutover window. But it now
  defers a disclosure-class advisory, not only availability ones, so it wants a
  dated owner in Stage 7 rather than an open-ended "first work item". Snapshot:
  `docs/verify-runs/rc2-audit.json` — 32 findings (1 critical, 10 high, 21
  moderate); the critical is one of the two non-applicable ones above.

- **CSP is `Content-Security-Policy-Report-Only`.** Deliberate: a report-only
  header cannot break checkout, and it is the only way to learn what an
  enforcing policy would refuse. Promote after UAT runs against it with a
  clean console (7.3).
- **ZAP active scan not run.** It needs an empty production, which does not yet
  exist. That is a sequencing fact, not an omission — it is step 6.1.

---

## 2. The stages

| Stage | Name | Owner | Gate to leave it |
|---|---|---|---|
| **0** | Freeze the candidate | Engineering | Tagged RC, full suite green against it, CI running |
| **1** | External long poles | Board / legal / DPO / bank | DPAs signed, notice published, live keys in hand |
| **2** | Close the technical gaps | Engineering | 1a A–G closed or explicitly accepted in writing |
| **3** | Provision production, empty | Engineering | Schema-only production proven empty by query |
| **4** | Dress rehearsal on staging | Everyone | A clean end-to-end rehearsal run with no fixes needed |
| **5** | Cutover | Engineering | Every hostname serving the new deployment, verified by content |
| **6** | Prove it, then open it | Everyone | Security pass green, UAT passed, board go/no-go given |
| **7** | Operate | Everyone | — ongoing |

Stages 0, 1 and 2 **run in parallel**. Stage 1 starts first and finishes last;
starting it late is the classic go-live delay and nothing in Stage 0 or 2 waits
on it. Stages 3→6 are strictly sequential.

---

## Stage 0 — Freeze the candidate

**Purpose:** establish one immutable commit that is the thing being taken live,
and prove it against the suites rather than against memory.

**0.1 Merge PR #1 and tag.** `main` is still the POC (`0001`–`0010`). Production
must ship from a tag, not from a moving branch.

```
# PR #1 reports mergeable_state: clean
# merge phase-1 -> main via the PR, then:
git fetch origin main
git checkout main && git pull origin main
git tag -a v1.0.0-rc1 -m "Phase 1 release candidate 1"
git push origin v1.0.0-rc1
```

**Why a tag and not a branch:** every later stage — the staging rehearsal, the
production deploy, the security pass — must run against *the same bytes*. A
branch moves; a tag does not. If Stage 2 or Stage 4 changes anything, cut
`rc2` and start the sequence again rather than deploying a branch tip.

**0.2 Re-run the local gates on the tag.** Already green at `384c0af` today; do
it again on the tag because the merge commit is a different commit.

```
npm ci && npx tsc --noEmit && npx next lint && npm run build
```

**0.3 Run every verification suite against `dev`, and record it.** 124 suites.
Do **not** run it against staging or production.

```
node scripts/use-env.mjs dev
npm run verify 2>&1 | tee docs/verify-runs/rc1-dev.log
```

⚠️ **Exclude `verify-checkout-e2e`** — it drives the simulated gateway, which
`getAdapterByName()` correctly refuses wherever a real gateway key exists. Ten
"got 403" failures there are the control working. ⚠️ `verify-fx-collections`
passes once per database (it enables GBP and does not clean up);
`scripts/lib/reset-fx-probe.mjs` clears the fixture. ⚠️ Six suites are slow by
nature (`verify-access-matrix`, `verify-bi-scoping`, `verify-finance-journey`,
`verify-conversational-intelligence`, `verify-notification-links`,
`verify-role-workflows`) — the runner already gives them room; a timeout there
is the budget, not the code.

**The exit condition is not "mostly green".** Every failure is either fixed or
written down with a named reason before Stage 3. A suite that fails and is
waved through teaches everyone to discount failures — this repository has
already recorded that lesson twice.

**0.4 Secret scan the full history on the tag.** `gitleaks detect --log-opts="v1.0.0-rc1"`.
The last run found 4 hits, all false positives; confirm that is still true, and
that `.gitleaksignore` still names only those.

**0.5 Dependency snapshot.** `npm audit --json > docs/verify-runs/rc1-audit.json`.
Confirm the Next-14 deferral (1c) is still the decision and that nothing new
and *applicable* has appeared.

**0.6 Add CI — gap E.** `.github/workflows/ci.yml`: on every PR to `main` and on
the tag, run `npm ci`, `tsc --noEmit`, `next lint`, `next build`. Make it a
required status check on `main`. Do **not** put `npm run verify` in CI: it needs
live database credentials, and a CI secret with service-role access to a real
project is a worse trade than running it manually. CI proves the build; the
operator proves the database.

**Exit gate:** a tag exists; 0.2 is green on it; 0.3's log is committed with
every failure resolved or reasoned; CI is running and required.

📌 That gate was met on 2026-09-20, and 0.4 and 0.5 were closed against
`v1.0.0-rc2` the same day. The secret scan is clean; the dependency snapshot
is committed and the Next-14 deferral survived re-checking, with one clause of
its recorded reasoning corrected (1c).

---

## What Stage 0 found — 2026-09-20

Written after the fact, from the runs rather than from the plan. `rc1` was cut
on 17 Sept; `rc2` replaced it once a migration landed, per rule 7. Logs live in
`docs/verify-runs/` and that directory's README says which are results and
which are not.

### The headline

**Of ten suite failures, exactly one was a defect in the product.** The rest
were suites that had fallen behind decisions the migrations already
implemented, or fixtures that had rotted. That ratio is the argument for 0.3
existing at all — and also the reason a failing suite must never be waved
through, because the one that mattered looked exactly like the nine that did
not.

### The one real defect

**`escalate_stale_unassigned_requests()` had never written a row** — on any
organisation, on any hour, since `0212`. `0117` refuses a ticket claiming
`assigned`/`acknowledged`/`in_progress` with nobody on it, and deliberately
left the rows already in that state alone, reasoning the trigger "fires on
UPDATE, so each will refuse the next status change". The escalation's working
set is exactly those rows, and its first act is `update tickets set
escalated_at = now()` — not a status change. With no exception handler, the
first legacy row aborted the entire pass. Dev showed **66 waiting requests**
with `escalated_at` null on every one: the rescue queue was correct on screen
and no administrator was ever told.

Fixed by `0298`, which narrows the guard to the write that *moves* a row into
the state. Rejected alternative: filtering those statuses out of the job's
SELECT — those rows **are** stale unassigned requests, so hiding them would
silence exactly the ones most needing rescue.

### The nine that were not

| suite | what it actually was |
|---|---|
| `verify-embeds` | The extractor paired `.from("x")` with the next *string-literal* select, walking past `.select(USER_COLUMNS)`. Invented `users::user_id, properties(name)` — a query nothing makes — and *consumed* the `.from()` the select belonged to, so a real embed went untested. One regex, a fabricated failure and lost coverage. |
| `verify-payment-approver-reach` §B | `0293` moved `sc.manage` off `finance_approver`. The check modelled the two desks' divergence one-sidedly. |
| `verify-chat-payment-report` | Same migration: stage 3 became the Payment Approver's and the suite still signed in as the Officer. Its second failure was only the first one's shadow. |
| `verify-lettings-grants` §C | `uses_platform_gateway` (`0288`) arrived unclassified — section C working exactly as designed. |
| `verify-rent-money` | `0181` made the admin fee once-per-tenancy; the suite still charged it per demand. Reconciled to the naira. |
| `verify-invoice-appeal` | The assertion named `executive` as the final approver. `0211` puts OEA's executive at **stage 2**; final approval there is `payment_approver`'s. The chain refused an act that was not the executive's, correctly, and that refusal was read as the separation rule failing. |
| `verify-portfolio-and-controls` §G | OEA has 12 tenancies and **zero** owner-of-record rows. An empty register, not a broken view. |
| `verify-deactivation` §E | A genuine judgement, not a stale test — resolved by `0297`. |
| `verify-role-workflows` §D | The fixture pointed at `vendor@oegroup.test`, deactivated since 1 Aug. `0194` refused it everything and the guard working was printed as an RLS defect. |

### The timeouts were never the suites

Four suites hit their budget (`finance-journey` and `notification-links` at
900s, `application-review` and `approval-chain` at 300s). The cause was a
backlog of probe users — **752 by 19 Sept** — re-read and retried by sweeps
that did not skip accounts already neutralised. After adding
`.is("deactivated_at", null)` to those sweeps and clearing the backlog:

| suite | before | after |
|---|---|---|
| `verify-finance-journey` | 900s (timed out) | **173s** |
| `verify-notification-links` | 900s (timed out) | **693s** |
| `verify-application-review` | 300s (timed out) | completed |
| `verify-approval-chain` | 300s (timed out) | completed |

### Two lessons that cost the most

**A run containing `NET` lines is not a result.** Two full runs were triaged
before it was noticed that `getaddrinfo EAI_AGAIN` and `ECONNRESET` were
scattered through them, and that crashes reading `Cannot read properties of
null` were dropped connections rather than defects. Re-run; do not triage.

**`git pull` is not proof you have the code.** A stale `origin/main` ref
reports "Already up to date" and the suite then runs against whatever is on
disk. This produced three separate rounds of analysis of code that was not
being executed. Use `git fetch && git reset --hard origin/main`, and assert the
SHA before running anything.

Two more, smaller: `tee` will not create its directory and fails quietly into a
pipe; and `node --check` proves syntax, not scope — two changes passed it and
threw `ReferenceError` at runtime in a branch that only executes on failure.
Exercise a change against a stub rather than re-reading it.

### Carried forward — open, and deliberately not closed here

These are *not* Stage 0 blockers. They are written down so they are not
rediscovered as surprises.

1. ~~**An OEA administrator reads 2 of 12 tenancies.**~~ **CLOSED 2026-09-20 —
   not a defect.** Measured rather than assumed: `oea.admin@oegroup.test` is in
   the org whose slug is `oea` (same id, `is_platform_operator` false), and both
   report the same live-lease count, so `leases_select` behaves exactly as
   written. OEA holds **3 live units**, and `tenancy_schedule` INNER JOINs
   `units` while `units_select` requires `deleted_at is null` — so a tenancy on
   a retired unit cannot appear. Every such tenancy is `terminated`, `draft` or
   `expired` (9/3/3, **zero active or renewed**), i.e. the unit was retired
   *after* the tenancy ended, which is correct. `0287`'s migration-time
   invariant — no active or renewed tenancy behind a retired unit — holds.

   📌 An earlier count suggested a cross-org leak. It did not exist: I had the
   queries run while the full verify was mid-flight, so the numbers moved under
   us. Read-only is not the same as valid.
2. **OEA has no owner-of-record rows at all.** Whether its buildings have
   external landlords or OEA holds them is a business question, not a schema
   one. No records were invented to turn the check green.
3. **Two stranded tickets on the POC org** (`0117`'s legacy rows). Reported,
   never rewritten — guessing an assignee puts a name against work nobody was
   told about. `0298` makes them reachable by the escalation, which is how a
   human finally hears about them.
4. **The payment approver is blocked from remitting by RLS, the executive by
   the trigger.** Both are blocked; the layers differ. Worth knowing before
   anyone edits `payments_update`.
5. **`sweepProbeVendors` does not check the error on its `payout_recipients`
   delete** — in a function whose own comment says "never swallow this" about
   the next loop. "Retained because a remittance names it" and "delete silently
   refused" are indistinguishable in its output today.

---

## Stage 1 — External long poles (start today, in parallel)

**Purpose:** start every clock that somebody else controls. Nothing in this
stage needs anything from engineering first.

| # | Action | Owner | Lead time | Blocks |
|---|---|---|---|---|
| 1.1 | Sign the 13 processor DPAs — drafts in `DPA_TEMPLATE_AND_TRACKER.md` | Legal + DPO | 2–6 weeks | **All real personal data.** Hard gate on Stage 6. |
| 1.2 | Legal review and publish the privacy notice — must carry the automated document-verification line (locked decision 10) | Legal | 1–2 weeks | Sign-in and application screens |
| 1.3 | Write the 72-hour breach procedure | DPO + legal | days | Stage 6 go/no-go |
| 1.4 | Publish the data-subject-rights procedure, naming who receives a request | DPO | days | Stage 6 go/no-go |
| 1.5 | Confirm NDPC registration threshold; register the DPO; publish contact details | Legal | 1–3 weeks | 1.2 |
| 1.6 | Board decision: is special-category data (religion, marital status) necessary at all? The cleanest NDPA position is not to collect it | Board | days | Application form scope |
| 1.7 | Confirm cross-border transfer basis **and the production hosting region** | DPO | days | **3.1 — cannot provision until the region is decided** |
| 1.8 | Complete Paystack business verification; obtain live key pair | Finance | 1–3 weeks | **Real money. Hard gate on Stage 6.** |
| 1.9 | Open/confirm the segregated client-funds bank account (locked decision 2) | Finance | 1–4 weeks | Daily reconciliation (7.1) |
| 1.10 | **Decide: is Flutterwave/FX in scope for go-live?** An explicit *no* is a good answer; the code is built and verified and turns on later with a key and no code change | Board | now | 2.2 env table |
| 1.11 | Commission the external penetration test, scheduled for the empty-production window between 5 and 6 | Board | 2–4 weeks to book | 6.2 |
| 1.12 | Set the target go-live date and the board go/no-go slot | Board | now | Everything |

**The single most useful thing to do today is 1.1, 1.8 and 1.11 in one
sitting** — they are the three longest queues and they are independent.

---

## Stage 2 — Close the technical gaps

**Purpose:** everything in §1a, plus the decisions that change what gets
deployed. Runs in parallel with Stage 1. Each item is small; the list is what
makes it a stage.

**2.1 Refresh the cutover documents to the code as it is.** The checklist is
three weeks and 89 commits behind. Specifically:

- Bucket list **3 → 7**, each with its intended `public` flag, size limit and
  MIME allowlist read out of the migration that creates it (gap A).
- Env-var table: add `GATEWAY_CREDENTIAL_KEY`, `NEXT_PUBLIC_SITE_URL`,
  `SENTRY_ORG`/`SENTRY_PROJECT` (build-time, for source maps) and the tunables
  that currently have silent defaults — `INTAKE_IP_LIMIT`, `INTAKE_IP_WINDOW`,
  `INTAKE_SENDER_LIMIT`, `INTAKE_SENDER_WINDOW`, `REMITTANCE_LIMIT`,
  `REMITTANCE_WINDOW`, `ANTHROPIC_MODEL`, `ANTHROPIC_EFFORT` (gaps B, C).
- New cutover steps the older doc cannot know about: binding `custom_domain`
  per org, the offline-payment and bank-transfer-payout paths (`0281`–`0296`),
  the tenancy offer/accept/record flow (`0263`), and the operator-governed
  records export (`0239`).

**✅ Done 20 Sept 2026.** Four documents changed, everything measured against
`supabase/migrations/`, `lib/` and `app/` rather than carried forward:

- `GO_LIVE_CHECKLIST.md` §1 — the bucket check is now a **seven-row table**
  with each bucket's `public` flag, size limit, MIME allowlist and creating
  migration. Two things the count alone would have hidden: **`vendor-documents`
  is 2 MiB, not the 15 MiB `0164` created it at** (`0213` lowered it and cut the
  allowlist to four types), and the operator-admin step is no longer marked
  blocked — it now names `scripts/bootstrap-production.mjs` (§2.4) and records
  that `0088` creates the `oe-group` org by migration, so there is nothing to
  seed.
- `GO_LIVE_CHECKLIST.md` §2 — the eight named variables added, **and three
  struck that the code no longer reads**, found by sweeping every
  `process.env.*` in `lib/`, `app/`, `middleware.ts` and `next.config.mjs`:
  `NEXT_PUBLIC_PAYSTACK_PUBLIC_KEY` (read **nowhere** — checkout is Paystack's
  hosted page, initialised server-side, so there is one key and not a pair),
  and `WHATSAPP_ACCESS_TOKEN` / `WHATSAPP_PHONE_NUMBER_ID` (the shared-token
  fallback was deliberately removed from `lib/notify.ts` on 11 Sept 2026;
  outbound resolves from `channel_routes.outbound_token` only). Both are still
  needed **locally** by the registration scripts at cutover, which is now
  stated. `TELEGRAM_WEBHOOK_SECRET` is likewise not a runtime variable —
  webhook auth is the per-bot header matched against `channel_routes`.
- `GO_LIVE_CHECKLIST.md` **§2a, new** — eight configuration steps that are a
  *row in the production database*, not a bucket or a variable, none of which
  appeared in any document: binding `custom_domain` per org; designating the
  **one** org that may hold `uses_platform_gateway` (`0288` defaults it false
  for every org with a unique index enforcing at most one — so **every other org
  cannot take an online payment until it connects its own merchant account**);
  publishing each org's collection account number (`0286`); staffing the four
  desks the inflow and outflow chains need (`0282`/`0293`); confirming each
  org's approval-chain shape and bands, which ship off/null by default
  (`0248`/`0261`, screen added by `0268`); deciding `records.export` per client
  org (`0239`, off for every role including admin); rehearsing the tenancy
  offer → acceptance → lease sequence (`0263`) in production UAT by name; and
  the standing fact that payout bank details are **evidence, not a stored
  field** (`0289`/`0296`).
- `GO_LIVE_RUNWAY.md` step 2 and `NDPA_COMPLIANCE_PACK.md` §2 carried the same
  stale count — the compliance pack's data inventory named **two** buckets of
  seven, omitting four that hold personal data (vendor KYC, invoices, payment
  proof, bank evidence). Both corrected; the inventory now also records that the
  full bank account number is never stored.
- `DEPLOYMENT.md` — **not** rewritten. It is a dated POC snapshot and rewriting
  it would destroy the record of what the POC ran on; its banner now says
  explicitly that its env list is wrong in both directions and points at
  `GO_LIVE_CHECKLIST.md` §2.

⚠️ **One finding a document cannot fix, recorded as an open question in
`GO_LIVE_CHECKLIST.md` §5 rather than changed here.** `application-documents`
carries **no size limit and no MIME allowlist**, and it is the system's only
anonymous-writable surface (`0062` grants `insert` to `anon`, gated on the org
accepting applications). Every bucket built since sets both. The only ceiling
today is the Supabase **project-level** upload limit. Two defensible answers —
set the project-level limit deliberately at cutover (no code change), or narrow
the bucket by migration the way `0213` narrowed `vendor-documents` (safer, but
it re-opens §2.11: cut `rc3`, re-run Stage 0). **This needs a decision; 2.1
could not make it**, because 2.1 is a documentation refresh and this is a
property of the schema.

**2.2 Put every production secret in the secret manager**, `GATEWAY_CREDENTIAL_KEY`
first (gap B). Generate it with `openssl rand -base64 32` — `credentials.ts`
refuses anything that does not decode to 32 bytes, which is the good kind of
failure. Record, in the manager and in the runbook, that **losing this key is
not recoverable**; that is the deliberate trade for keeping it out of the
database. Escrow it the way the bank mandate is escrowed, not the way an API
key is.

**⚠️ The custody paperwork is `docs/KEY_CUSTODY_RECORD.md`** (added 20 Sept
2026) — a printable form covering **both** unrecoverable secrets:
`GATEWAY_CREDENTIAL_KEY` and the backup passphrase added with `--encrypt`. It
carries the sealing procedure, the two-holder custody record, a quarterly
verification log that rides the §7.6 restore drill, the two-person recovery
procedure, and the rotation rules — including that **K1 cannot be rotated
quietly**: changing it makes every stored credential unreadable, exactly as
losing it would, so rotation is an operation with notice given, not
maintenance. 2.2 is not done when the key is in the safe; it is done when that
form is signed and filed.

**2.3 Prove the key works before production depends on it.** On staging: store a
gateway credential, restart the deployment, read it back. A key that is present
but wrong fails at the first payment, not at deploy.

**2.4 Build `scripts/bootstrap-production.mjs` (gap D).** One script, one job:
create the first operator admin. It must

- refuse unless the target is the production project **and** `orgs` contains
  only what the migrations created and every business table is empty — the
  same shape of guard `migrate.mjs` already applies to the frozen demo;
- create exactly one auth user, attach it to the `oe-group` operator org as
  `admin`, and write an `audit_log` row naming the act;
- issue a one-time password that must be changed on first sign-in, and print it
  once to the operator's terminal rather than storing it anywhere;
- be idempotent — a second run against a bootstrapped project is a no-op, not a
  second admin;
- **never** import from `seed.mjs` or anything it touches (`0208`: the seed
  truncates orgs the migrations created).

Ship `scripts/verify-bootstrap.mjs` beside it, proving on staging that the
guards refuse a non-empty target and that the created admin can sign in, create
an org, and nothing else it should not.

**2.5 Decide and enable the backup posture (gap F).** For a system holding a
client-funds ledger the recommendation is **PITR enabled on the production
Supabase project from day one**, with the retention window written into
`NDPA_COMPLIANCE_PACK.md` §8 as a stated security measure. Daily backups alone
mean the worst case is a day of ledger entries re-keyed from bank statements.

**2.6 Decide the rate-limit posture for the money path.** General intake stays
fail-open (an outage in the limiter must not take intake down — that reasoning
still holds). Payment webhooks and remittance execution are the two routes
where failing open is the worse risk. Recommendation: **fail closed on those
two, fail open everywhere else**, and say so in the code at the call site.

**2.7 Gemini.** Enable billing on the Google Cloud project, or record in writing
that failover is best-effort. The failure mode to avoid is neither of those —
it is believing failover works because a key is present. Settings → AI &
Classification already tests reachability rather than configuration and reported
the 429 correctly on its first run; that screen is the check.

**2.8 Turnstile and SMS — an explicit in or out.** Both no-op cleanly when
unconfigured, so *out* is defensible: the public vendor-application form still
has per-IP rate limiting, a honeypot and submission timing in front of it. What
is not defensible is discovering on cutover day that the layer was silently off.

**2.9 Retention and subject rights.** The 6-year approved-application clock has
no job (`NDPA_COMPLIANCE_PACK.md` §5) — build it or record it as accepted with a
review date. Assess whether the operator-governed records export (`0239`) can
serve a subject-access request; if it can, document the procedure, and if it
cannot, write the manual one. 1.4 cannot be published without an answer.

**✅ 2.9 done 20 Sept 2026 — `0299`, and the reason it stamps rather than
purges.** The 6-year rule is closed by adding the one thing that was missing:
the date. `purge_expired_applications()` (0062) fires on `purge_after < now()`
alone, and the 90-day rule has always worked only because `0082` sets that date
on rejection. `0299` sets it on approval — nightly, because the clock runs from
the end of the **tenancy**, which is unknown at approval and moves every time
the lease is renewed. It contains no `DELETE` of its own, which
`verify-retention-clock` asserts against the source, since the behavioural test
for it is six years away.

⚠️ **The renewal trap.** `leases.application_id` is not carried forward by a
renewal, so "the end date of the lease this application produced" answers with
the **first** lease and would stamp a purge clock on a sitting tenant. `0299`
walks `renewed_from_lease_id` forward recursively and calls the tenancy ended
only when nothing in the chain is still `draft` or `active`. Same mistake
`0181` found in the admin fee, with personal data on it instead of money.

A stamp is also **withdrawn** if a renewal is recorded after the clock started.
That asymmetry is the design: a stamp that is wrong has six years to be
corrected, a purge that is wrong has none.

Proven against PostgreSQL 16 across eight cases before shipping — no lease, a
live tenancy, a single ended tenancy, the renewal trap, a fully-ended chain
(stamped from the **last** end), withdrawal after a late renewal, soft-deleted
leases in both directions, and a rejection's own 90-day clock left untouched.

Two things found on the way past and fixed here: the purge job's own "how many
were due" count did not filter `purged_at is null`, so it re-counted
already-purged rows every night and wrote a wrong number into the record a DPO
reads; and `verify-bootstrap`'s never-list cross-check matched
`/(demo|dev|staging)/` — every world that existed when it was written — so it
could never have caught the new world it exists to catch. Both now hold.

**2.10 Add `prod` to `scripts/use-env.mjs`'s `HOSTS`** and create
`.env.prod.local` **from the new project's own dashboard**. Never by copying
another world's file and editing it — a stray unedited value is how two worlds
end up sharing a secret.

**✅ The code half is done, 20 Sept 2026.** `prod` was already in `WORLDS`, so
switching to it always worked; everything around it was missing. `active()` now
names PRODUCTION from the backing file even before the ref is recorded, and the
switch prints a banner. Two refusals were added, and the first is rule 8 turned
from a sentence into a guard: a backing file naming the **same project** as
another world's is refused rather than copied, which is exactly the
`.env.prod.local`-copied-from-staging mistake this item warns about. The second
refuses a backing file that disagrees with the ref recorded in `HOSTS`.
`lib/target-env.mjs`'s reasoning was corrected at the same time — it said
production is safe because it "has no file in the repo at all", which stops
being true the moment this item is finished. What keeps production out is that
`.env.prod.local` is not in `SAFE_FILES`, and nothing else.

**Exit gate:** A–G each either closed or accepted in writing by a named person;
2.6, 2.7, 2.8 decided; a fresh RC tag cut if any of this changed code.

---

## Stage 3 — Provision production, empty

**Entry gate:** 1.7 answered (the region), Stage 0 exit gate met, Stage 2 exit
gate met. Do not start this early "to save time" — an idle production project
is a project someone experiments on.

**3.1** Create the production Supabase project in the region confirmed at 1.7.
Record the project ref in the runbook.

**3.2** Create the production Vercel project. Link a **separate** checkout, or
`vercel switch`, and back the link up as `.vercel.prod.bak` beside the existing
`.vercel.dev.bak` / `.vercel.staging.bak`.

**3.3 Confirm what every tool is pointed at, before anything runs.** Two
incidents in seven days came from a stale environment pointer — one aimed a
deploy at the wrong Vercel project, one aimed a migration at the frozen demo
database. With four worlds the risk is worse, not better.

```
node scripts/use-env.mjs prod     # then read back what it prints
node scripts/use-env.mjs          # active() — confirm the ref matches 3.1
```

Then, and only then:

```
npm run migrate                   # schema only. npm run seed is NEVER run here.
```

`migrate.mjs` refuses a mismatched target and refuses the frozen demo on its
own. That guard is a backstop for a mistake, not a substitute for reading the
target.

**3.4 Verify all seven buckets** — that each exists, that only `org-logos` is
public, and that the caps match the migrations:

| Bucket | Public | Holds | Created by |
|---|---|---|---|
| `org-logos` | **yes, by design** | brand marks painted on the sign-in page | `0015` |
| `application-documents` | no | tenancy applicants' identity documents | `0062` |
| `work-order-media` | no | photographs inside client homes, 25 MB, image/video | `0106` |
| `vendor-documents` | no | vendor KYC, **2 MB** (`0164` created it at 15 MB; `0213` lowered it) | `0164`, `0213` |
| `invoice-attachments` | no | vendor and staff-filed invoices | `0140` |
| `payment-proofs` | no | payers' evidence of off-platform payment | `0281` |
| `payout-evidence` | no | payees' bank evidence | `0289` |

A bucket silently missing means an upload fails at the moment a technician is
standing in front of the work. A bucket silently **public** means the inside of
a client's home, or somebody's ID, is reachable by URL. Check the flag, do not
assume the migration ran.

**3.5 Set every environment variable** from the table refreshed at 2.1 — live
keys, not the test ones. Then confirm on screen: `gatewayMode()` reads the
key's own prefix (`sk_test_` / `sk_live_`) and displays it. That label is the
proof a live key was pasted, not a rehearsal leftover.

**3.6 Prove production is empty by query, not by eye.** Count rows in every
business table; the only non-zero results permitted are what the migrations
themselves create — the operator org (`0088`), the permission baseline, the
chart of accounts. Commit the query and its output. This is the Day 12 exit
gate and it is the last moment it is cheap to check.

**Exit gate:** schema at `0296`, seven buckets correct, every variable set, the
emptiness query committed with its output.

---

## Stage 4 — Dress rehearsal on staging

**Purpose:** staging exists so that nothing in Stage 5 is being done for the
first time. Rehearse on staging, never on production.

**4.1** Bring staging to the exact RC tag and schema: `npm run migrate:all -- staging`,
deploy the tag to `oe-group-ipms-staging`.

**4.2 Run the whole of Stage 5 against staging, in order, timed.** Including the
bootstrap script (2.4), the per-org `custom_domain` binding, and re-registering
both WhatsApp and both Telegram webhooks to a staging host. The output is a
runbook with real durations, not estimates.

**4.3 Full multi-role UAT** on staging against `UAT_SCRIPT.md` and the UAT
decks — all ten roles, each one's golden path.

**4.4 Money-path rehearsal, end to end, on test keys.** Collection → ledger
posting → bank reconciliation → three-stage approval chain → payout by gateway
**and** payout by bank transfer (`0289`) → remittance advice → receipt. Plus one
off-platform payment recorded with proof and confirmed by three desks (`0282`).
This is the path where a defect costs money rather than time.

**4.5 Rehearse the rollback (gap G).** Prove that pointing the Vercel production
project back at the previous deployment works and how long it takes. Prove the
database answer too: with PITR enabled (2.5), restore staging to a point ten
minutes earlier and confirm what is lost. Fix-forward remains the default —
migrations are additive, so there is no schema to roll back — but "we would fix
forward" should be a choice, not the only thing anyone knows how to do.

**4.6** Fix what the rehearsal finds. **If anything changed, cut `rc2` and
repeat 4.1–4.5.** A rehearsal whose findings ship untested is not a rehearsal.

**Exit gate:** one complete rehearsal run start to finish with no fixes needed.

---

## Stage 5 — Cutover

**Entry gate:** Stages 3 and 4 complete; 1.8 delivered (live keys in hand); a
date and a person for every step. One sitting, one person driving, one person
reading the steps aloud. Verify after each step; do not batch.

1. **Confirm the target** — `use-env.mjs prod`, read the ref back, compare with
   3.1. Every time, including now.
2. **Deploy the RC tag** to the production Vercel project from the checkout
   linked to it.
3. **Set/confirm every environment variable** (3.5 if not already done), then
   check the gateway-mode label on screen says *live*.
4. **Bootstrap the first operator admin** — `scripts/bootstrap-production.mjs`.
   Capture the one-time password out of band; change it at first sign-in;
   **enable MFA on that account before it does anything else** (`0139`).
5. **Re-register both 360dialog webhooks** to the production host —
   `scripts/register-whatsapp-number.mjs`, per org, tokens rotated.
6. **Re-register both Telegram webhooks** — `scripts/register-telegram-bot.mjs`.
   ⚠️ While here, fix the stale label: `dev` still carries the pre-rename
   `@tfml_facilities_bot`. Register production with the real usernames
   (`@tfml_support_bot`, `@oea_properties_bot`).
7. **Move the three domains** — `tfmlportal.com`, `oeaportal.com`,
   `portal.tfmlconsultant.com` — Settings → Domains → Add Domain → take the
   **move** option. ⚠️ **Move, never `vercel alias set`.** An assigned domain
   follows the project's production deployment forever; an alias pins the
   hostname to one immutable deployment. That mistake left both brand portals
   serving an 18-day-old build across four deploys, found the day before a demo.
   ⚠️ The apex `tfmlconsultant.com` stays where it is — Vercel will warn it is
   unconfigured and that warning is correct to ignore.
8. **Bind each organisation's `custom_domain`** through the operator's
   `set_org_domain` (gap C). Until this is done, `portal-origin.ts` falls
   through to the deployment address and OEA's tenants receive links on a host
   that is not OEA's.
9. **Verify propagation by content, not by status code:**

```
curl -sSL https://tfmlportal.com/login | grep -o 'dpl_[A-Za-z0-9]*' | head -1
curl -sSL https://oeaportal.com/login | grep -o 'dpl_[A-Za-z0-9]*' | head -1
curl -sSL https://portal.tfmlconsultant.com/login | grep -o 'dpl_[A-Za-z0-9]*' | head -1
```

   All three must return the same `dpl_` id as the deployment from step 2.

10. **Run `npm run verify` against production credentials** — minus
    `verify-checkout-e2e` (1c/0.3). Then re-run the emptiness query from 3.6:
    the suites must not have left rows behind.

**Exit gate:** every hostname serving the new deployment, verified by `dpl_`
id; production still empty apart from the operator org and its one admin.

---

## Stage 6 — Prove it, then open it

**6.1 Security pass against the production URL** — `security/README.md` has the
ordered sequence and a pre-flight that refuses an unsafe target.

```
npm run pentest:preflight
npm run pentest:baseline      # passive
npm run pentest:full          # ACTIVE — empty production only
npm run loadtest && npm run loadtest:ratelimit
```

⚠️ **Target the production alias or a custom domain — never a
deployment-specific `…-abc123-….vercel.app` URL.** Vercel Deployment Protection
answers those anonymously before the application runs, so a scan aimed there
measures Vercel's SSO wall and reports a clean bill of health for a target it
never reached. ⚠️ The **active** scan's window is now and only now: after
cutover, before the first client. Once production holds client data it becomes a
third-party test against a staging clone instead.

**6.2 External penetration test** (1.11) in the same window, with written
authorisation. This is NDPA_COMPLIANCE_PACK §8's one remaining ⛔ under security
measures.

**6.3 Production UAT with real staff** across all ten roles, on the real
hostnames, with realistic rehearsal data — entered through the real screens, so
it is indistinguishable from real use and leaves no fixture behind.

**6.4 Board go/no-go.** Its inputs: 6.1 and 6.2 clean, 6.3 passed, and **Stage 1
items 1.1–1.5 complete** — no real personal data may flow before the DPAs are
signed and the notice is published. This is a person's decision, not a technical
one, and it should be minuted.

**6.5 Onboard the first real org end to end** through the real UI: create the
org, bind its domain, invite its people, add a property with at least one unit
(`0252`), then application → review → tenancy offer → accept → record → first
demand. This is the proof the clean-data gate held, and it is deliberately a
real org rather than a synthetic stand-in.

**6.6 First real money, watched.** One collection through the live gateway, one
bank reconciliation against the real statement, one payout through the full
three-stage chain. Reconcile every figure by hand once. Everything after this is
routine; this one is not.

---

## Stage 7 — Operate

| # | Item | Why it is here and not earlier |
|---|---|---|
| 7.1 | **Daily bank reconciliation becomes a real routine** (locked decision 2) | It is the thing an auditor asks to see, and it only exists once there is money to reconcile |
| 7.2 | **Role-based user guides** — one per role, plus the combined admin/onboarding guide, as PDF and two screen recordings (tenant raising a request; finance approving and remitting) | Written from the production screens, so no guide describes a button that moved. **The admin guide must exist before a second org is provisioned.** |
| 7.3 | **Promote CSP from report-only to enforcing** | Needs UAT to have run against it with a clean console first |
| 7.4 | **Next 14 → 16 and `@sentry/nextjs` major upgrade**, with its own regression cycle | Two majors across routing, caching and Server Actions. First post-go-live work item, never a cutover edit |
| 7.5 | **Monitoring that someone actually reads** — Sentry (root-cause the `NEXT_PUBLIC_SENTRY_DSN` rejection seen on staging first), cron-job failure alerts, and a standing query on `tickets.classified_by` so "are we quietly running on the fallback?" is a fact rather than a hunch | |
| 7.6 | **Restore drill on production**, quarterly, from the PITR window enabled at 2.5 | A backup nobody has restored is a belief, not a backup |
| 7.7 | **Re-run `npm run verify` after every production deploy** | 124 suites are the regression net; CI proves the build, this proves the database |

---

## 3. The tracker

Status: `[ ]` not started · `[~]` in progress · `[x]` done · `[!]` blocked ·
`[-]` accepted/out of scope, with the reason written in.

Update in place. If a step turns out to be wrong, strike it through with a
one-line reason rather than deleting it silently.

### Stage 0 — Freeze the candidate — ✅ CLOSED 2026-09-20 (6 of 6)
- [x] 0.1 Merged PR #1, tagged `v1.0.0-rc1` → superseded by **`v1.0.0-rc2`** once
      `0297`/`0298` landed (rule 7). All later work is `scripts/` only, outside
      `next build`, so `rc2` still deploys the bytes it was cut from.
- [x] 0.2 `npm ci` · `tsc --noEmit` · `next lint` · `next build` green **on the tag**
- [x] 0.3 `npm run verify` against `dev` — every failure resolved or reasoned.
      Final run of record **119 of 120, 0 NET** (`rc2-20260920-final.log`); the
      one failure, `verify-notification-links`, was a 900s timeout closed by
      batching its target lookups — **600s → 97s**, verified standalone. Ten
      suite failures in all: **one product defect** (`0298`, the escalation cron
      that had never written a row), nine stale suites or fixtures. Logs and
      their README in `docs/verify-runs/`.
- [x] 0.4 `gitleaks` on the tag — **clean on `v1.0.0-rc2`, 2026-09-20.** 402
      commits, 10.65 MB scanned, `no leaks found`, exit 0. `.gitleaksignore`
      still carries exactly 4 fingerprints, across the same two files it
      documents (`verify-fx-collections.mjs`, `application-form.ts`).
- [x] 0.5 `npm audit` snapshot committed (`docs/verify-runs/rc2-audit.json`);
      Next-14 deferral **re-affirmed with a correction** — see 1c. Both criticals
      remain non-applicable, but a disclosure-class advisory now does apply, so
      the recorded reason was amended rather than re-stamped.
- [x] 0.6 CI workflow added and required on `main` *(gap E)* — `types, lint, build`
      now blocks direct pushes to `main`, as intended

### Stage 1 — External (start today)
- [ ] 1.1 13 processor DPAs signed *(hard gate on Stage 6)*
- [ ] 1.2 Privacy notice legally reviewed and published
- [x] 1.3 72-hour breach procedure written — `BREACH_PROCEDURE.md`, drafted
      2026-09-20 against NDPA s.40(2). ⚠️ **Contact table must be completed
      before it is usable**: a procedure whose first step is "tell the DPO"
      fails at 3am if nobody can find the number.
- [~] 1.4 Data-subject-rights procedure — `DATA_SUBJECT_RIGHTS_PROCEDURE.md`,
      drafted 2026-09-20, operationalising the 30-day promise already made in
      `PRIVACY_NOTICE.md` §6. **Written, not yet published**; publishing is
      1.2's gate, and both need the same DPO contact details.
- [ ] 1.5 NDPC threshold confirmed; DPO registered; contact published
- [ ] 1.6 Board decision on special-category data
- [x] 1.7 Cross-border basis + **production hosting region** — **CLOSED
      2026-09-20. Stage 3 is unblocked.** Region: Supabase `eu-west-1`, Vercel
      `dub1` (both Ireland), fixed at project creation. Basis: **contractual
      clauses under NDPA s.41**, recorded in `CROSS_BORDER_TRANSFER_BASIS.md`;
      Legal confirmed the clauses can be approved and filed, and that work runs
      in parallel rather than gating the build. Board confirmed Supabase over a
      Nigerian alternative (§5b — 157 RLS policies and 639 `auth.uid()`
      references make it a rebuild, not a migration, and Supabase offers no
      African region).
      ⚠️ Still true and still load-bearing: GAID 2025 repealed the NDPR
      whitelist and the NDPC has issued no adequacy decision, so **hosting in
      the EU supplies no basis on its own** and this rides on the 13 DPAs
      (1.1). A DPA without transfer clauses does not discharge s.41.
- [ ] 1.8 Paystack live keys obtained *(hard gate on Stage 6)*
- [ ] 1.9 Segregated client-funds bank account confirmed
- [ ] 1.10 Flutterwave / FX — explicit in or out
- [ ] 1.11 External pen test commissioned and booked for the empty-production window
- [ ] 1.12 Target date and board go/no-go slot set

### Stage 2 — Close the technical gaps
- [x] 2.1 Cutover docs refreshed: 7 buckets, full env table, new flows *(gaps A, B, C)* — **done 20 Sept 2026**
- [x] 2.2 **Done 21 Sept 2026** *(gap B)*. `GATEWAY_CREDENTIAL_KEY` generated
      at the destination, set on staging Vercel as a **Config**-typed variable,
      proven working by 2.3, and **escrowed with the custody record signed** —
      `KEY_CUSTODY_RECORD.md` §3: two sealed envelopes, signed across the seal,
      two named holders in different buildings.
      ⚠️ **K2, the backup passphrase, is escrowed the same way the first time
      `npm run backup -- --encrypt` is used** — different envelopes, and never
      stored with the media holding the backups.
- [x] 2.3 **Gateway credential proven end to end on staging, 20 Sept 2026** —
      and by a stronger route than the one planned. Raising a payment request
      from Collections calls `resolveOrgGateway` → `getOrgCredential` →
      `decryptSecret`, then hands the DECRYPTED key to Paystack's
      `initialise`. A request was raised successfully
      (`OE-F2ED01-SE-MUAB9ZBY-55FBD4`), which means three things in sequence:
      the stored ciphertext was read, `GATEWAY_CREDENTIAL_KEY` on the
      deployment decrypted it, and **Paystack accepted the result**. A key that
      decrypted to garbage would have produced an auth failure, not a payment
      link — so "present but wrong", which is the failure 2.3 exists to
      exclude, is excluded by evidence rather than by inspection.
      ⚠️ The Settings → Banking screen shows only `secret_last4` and never
      decrypts, so reading it back there would have proven nothing. Noted
      because it is the obvious place to look.
- [~] 2.4 `bootstrap-production.mjs` + `verify-bootstrap.mjs` **built 2026-09-20**
      *(gap D)*. Guard chain exercised across 10 scenarios against stubs: it
      refuses demo/dev/staging by name with no override, refuses a `--confirm`
      that does not match `.env.local`, refuses without `--email`, refuses a
      project with no operator org, with a third organisation, or with any
      existing account — and on a clean target creates exactly one admin, writes
      `operator.bootstrapped` to the trail, and issues a one-time link. A second
      run is a no-op.
      ✅ **Run against dev and staging, 20 Sept 2026 — and it found something.**
      Three of the suite's own checks (`--confirm` missing, `--confirm`
      mismatched, `--email` missing) were **unreachable on any world it is safe
      to run on**: `bootstrap-production.mjs` checks the never-list FIRST and
      dies there, so all three observed the never-list refusal instead of the
      guard they named and reported FAIL for a script behaving perfectly. The
      suite passed against stubs and could not have passed against a real
      database. Fixed by exercising those three against a synthetic project ref
      the never-list does not know — each dies at a flag guard, before the
      first network call — and the suite now asserts that ref is not on the
      never-list, so the checks cannot silently go hollow again. **17/17 pass
      on dev and staging.**
      ⚠️ **Still unproven, and unprovable until Stage 3:** "the created admin
      can sign in and create an org". That needs an empty production project,
      which exists once. The refusals are proven; the happy path is not.
- [x] 2.5 **Backup posture decided and recorded, 20 Sept 2026** *(gap F)* —
      `BACKUP_AND_RESTORE.md`, `NDPA_COMPLIANCE_PACK.md` §8. **PITR considered
      and declined** on a recorded basis ($100/mo per project; a day of ledger
      is reconstructible from gateway and bank records; and it covers Postgres
      only, so it would protect no identity document or payment proof).
      Baseline is Supabase Pro **daily backups, stated RPO ~24h**, plus
      `npm run backup` — a `pg_dump` that **reads the archive back with
      `pg_restore --list` before reporting success and deletes it if it
      cannot**, writes a manifest of row counts to check a future restore
      against, and records `operator.backup_taken` in the trail. Proven end to
      end against PostgreSQL 16: a real dump, a real restore, counts matching
      the manifest, and a deliberately truncated archive correctly refused and
      deleted.
      ✅ **Encryption added 20 Sept 2026** (`--encrypt` / `--decrypt`), so a
      second copy can live off-site — Drive, an external disk, a second office
      — as ciphertext. It encrypts only AFTER `pg_restore --list` has verified
      the dump, then decrypts it back and compares byte for byte before
      deleting the plaintext. Proven: wrong passphrase refused, a single
      flipped byte refused, correct passphrase restoring to matching row
      counts. ⚠️ It adds a second unrecoverable secret — escrow the
      passphrase like `GATEWAY_CREDENTIAL_KEY`, never beside the backups.
      ⛔ **One thing this opened, and it is bigger than PITR:** every backup
      line concerns **Postgres**. Whether Supabase's daily backup covers
      **Storage** — identity documents, payment proofs, payout evidence — is
      undocumented and unconfirmed. **Confirm with Supabase before cutover.**
- [x] 2.6 **Rate-limit posture decided, 20 Sept 2026** — and the fail-closed
      half was **already implemented**, which checking first is the only reason
      this did not get built twice. The payment webhook answers 503 on
      `degraded` and all four remittance routes refuse;
      `RateResult.degraded` exists precisely to separate "never configured"
      (fail open) from "meant to be running and is not" (fail closed on money).
      The checklist had carried it as an open question long after the code
      answered it; the posture is now recorded in `lib/rate-limit.ts`'s header.
      **The real decision was the ceiling: `REMITTANCE_LIMIT` 30 → 20 per 5
      minutes.** Not the 10 first proposed — measurement showed the four call
      sites share one namespace keyed by user id with **no bulk-payout path**,
      so twenty landlords is twenty actions, and 10/5min would have invented an
      outage on the first real payout day. Env-overridable without a deploy.
- [x] 2.7 **Gemini best-effort accepted in writing, 20 Sept 2026.** Billing
      not enabled for Phase 1: an Anthropic outage degrades triage to "needs
      human review", which is correct and safe rather than broken, and cutover
      is the wrong moment to add a paid dependency to improve a path that
      already fails safely. **Accepted with a condition** — 7.5's
      `tickets.classified_by` monitoring query must exist, so "are we quietly
      running on the fallback?" is a fact and not a hunch.
- [~] 2.8 **Decided 20 Sept 2026. Turnstile IN, SMS OUT.**
      **Turnstile keys set on Vercel, 20 Sept 2026.** The layer was already
      wired end to end (widget, form, server-side verification) and had only
      ever been missing its keys.
      ⚠️ **The test was run on 20 Sept and it FAILED — but not on Turnstile.**
      A real application was refused with "We couldn't accept this submission".
      A Turnstile failure says "Bot check failed"; this was the **honeypot**,
      which **Chrome's autofill had filled**. The field was named
      `company_website_alt`, Chrome's address autofill matches on tokens in the
      field name, and Chrome ignores `autocomplete="off"` on a form it reads as
      a contact form — which this is. The applicant had nothing to clear (the
      field is off-screen) and a message that by design cannot name the control.
      **Fixed:** renamed to a token no browser targets, opted out of the
      password managers, and — the deeper fix — the honeypot and timing checks
      **no longer veto a request Turnstile has vouched for**. Held by
      `verify-vendor-application-guards`, which lists every autofill token and
      was tested by putting the old name back.
      ⚠️ **Re-run the submission once deployed.** That is what closes this row.
      **SMS is out for Phase 1**, recorded: WhatsApp, Telegram and email reach
      every role, and a fourth channel at cutover adds a 14th processor needing
      its own DPA for a path nothing depends on.
- [x] 2.9 6-year retention clock **built and PROVEN on dev and staging,
      2026-09-20** (`0299`) — the last open
      row in `NDPA_COMPLIANCE_PACK.md` §5. It works by setting `purge_after`,
      so `purge_expired_applications()` (0062) remains the only code in the
      system that deletes applicant PII. Proven against PostgreSQL 16 across
      eight cases before shipping, the headline being the **renewal trap**: a
      renewal does not carry `application_id` forward, so the obvious query
      would have stamped a purge clock on a tenant still living there under a
      later renewal. Held by `verify-retention-clock`.
      ✅ **Applied to dev and staging 20 Sept 2026; `verify-retention-clock`
      passes 19/19 on both.** The renewal trap holds against real data, not
      only the local PostgreSQL 16 harness it was developed against.
      ✅ The subject-access half is answered: `DATA_SUBJECT_RIGHTS_PROCEDURE.md`
      records that `records.export` (`0239`) is an operator-gated internal bulk
      export and **not** the route for a subject-access request, and writes the
      manual procedure instead. 1.4 is no longer waiting on this.
- [~] 2.10 `prod` is now a **first-class world** in `use-env.mjs` (2026-09-20).
      `WORLDS` already listed it; what it lacked was everything else. Now: the
      `HOSTS.prod` slot is a visible `null` with the instruction to fill it at
      3.1 rather than a commented-out line; `active()` names **PRODUCTION**
      from the backing file even before the ref is recorded, because "unknown"
      about production is the worst answer this tool can give; switching to it
      prints an unmissable banner; and two refusals were added — a backing file
      that names the **same project** as another world's (rule 8's
      copied-and-edited `.env.prod.local`, caught mechanically rather than
      written down), and one that disagrees with the ref recorded in `HOSTS`.
      Exercised across six scenarios against stub env files.
      ⚠️ **Two halves remain, both needing the project to exist:** record the
      ref in `HOSTS.prod` (3.1) and create `.env.prod.local` from the
      production dashboard — never by copying another world's file, which the
      new guard now refuses outright.
- [~] 2.11 **`v1.0.0-rc3` cut 21 Sept 2026 at `c628e90`** — rule 7, because
      `0299` and everything after it killed `rc2`. 28 commits and 44 files
      since: schema `0296` → `0300`, suites 121 → 124.
      ✅ **Stage 0's local gates are green on this exact tree** (0.2): `npm ci`
      from the lockfile, `tsc --noEmit` clean, `next lint` **0 errors** (2
      pre-existing `alt-text` warnings), `next build` **81 pages**.
      ⚠️ **Three still to run, and they need credentials or tooling this
      session does not have** — `npm run verify` against `dev` (0.3),
      `gitleaks` (0.4), `npm audit` snapshot (0.5). Until those are recorded,
      Stage 0 is not re-met and **Stage 3's entry gate is not open**.
      ⚠️ The tag itself had to be pushed by a person: a tag push from this
      session is refused with **HTTP 403** (branch refs are permitted, tag refs
      are not), so the annotation was composed here and the tag created
      locally.

### Stage 3 — Provision production, empty
- [x] 3.1 Production Supabase project created in the confirmed region; ref recorded
      — `TENTai-production`, eu-west-1, ref `civwriqvghvyqtfrzftu`, recorded in
      `scripts/use-env.mjs` so the switch guard can refuse a mismatched backing
      file rather than trust its label. The frozen POC demo project was deleted
      after its ref was matched against the never-list. Empty: no schema yet.
- [ ] 3.2 Production Vercel project created and linked; `.vercel.prod.bak` saved
      — project `tent-ai-production` created and connected to the repo; first
      deployment built from the merge of #36. **Not done until the link file is
      backed up**, which happens on the operator's machine, not in the
      dashboard: `vercel link` writes `.vercel/project.json`, and that is what
      gets copied to `.vercel.prod.bak`.
- [ ] 3.3 Target confirmed out loud, then `npm run migrate` — **schema only**
- [ ] 3.4 All 7 buckets verified: existence, public flag, size and MIME caps *(gap A)*
- [ ] 3.5 Every environment variable set; gateway-mode label reads **live**
- [ ] 3.6 Emptiness proven by committed query and output

### Stage 4 — Dress rehearsal on staging
- [ ] 4.1 Staging on the exact RC tag and schema
- [ ] 4.2 Full Stage 5 rehearsed on staging, timed, runbook written from it
- [ ] 4.3 Multi-role UAT, all ten roles
- [ ] 4.4 Money path end to end — gateway payout, bank-transfer payout, off-platform payment
- [ ] 4.5 Rollback rehearsed: deployment revert **and** PITR restore *(gap G)*
- [ ] 4.6 Findings fixed; if anything changed, `rc2` cut and 4.1–4.5 repeated

### Stage 5 — Cutover
- [ ] 5.1 Target confirmed
- [ ] 5.2 RC tag deployed to production
- [ ] 5.3 Variables set; gateway-mode label reads live
- [ ] 5.4 Operator admin bootstrapped; password changed; **MFA enabled**
- [ ] 5.5 Both 360dialog webhooks re-registered
- [ ] 5.6 Both Telegram webhooks re-registered with the correct usernames
- [ ] 5.7 Three domains **moved** (never aliased)
- [ ] 5.8 `custom_domain` bound per org *(gap C)*
- [ ] 5.9 Propagation verified by matching `dpl_` id on all three hostnames
- [ ] 5.10 `npm run verify` against production; emptiness re-confirmed

### Stage 6 — Prove it, then open it
- [ ] 6.1 Security pass against the production hostname — passive, **active**, load, rate limit
- [ ] 6.2 External penetration test completed in the empty window
- [ ] 6.3 Production UAT with real staff, all ten roles
- [ ] 6.4 Board go/no-go minuted *(requires 1.1–1.5)*
- [ ] 6.5 First real org onboarded end to end through the real UI
- [ ] 6.6 First real collection, reconciliation and payout, reconciled by hand

### Stage 7 — Operate
- [ ] 7.1 Daily bank reconciliation running as a routine
- [ ] 7.2 Role guides + admin/onboarding guide + two screen recordings *(admin guide before org #2)*
- [ ] 7.3 CSP promoted to enforcing
- [ ] 7.4 Next 16 + Sentry upgrade, with its own regression cycle
- [ ] 7.5 Monitoring wired and watched
- [ ] 7.6 Quarterly restore drill scheduled; first one done
- [ ] 7.7 `npm run verify` after every production deploy

---

## 4. Rules that hold in every stage

These are not stage-specific, which is exactly why they are the ones that get
skipped under time pressure.

1. **Production is never seeded.** `npm run seed` has no legitimate use against
   `prod`, ever. `0208` records that the seed truncates orgs the migrations
   created, so the damage is not confined to the rows it adds.
2. **Confirm the target before every destructive or deploying command.** Two
   incidents in seven days came from a stale pointer. `use-env.mjs` and
   `migrate.mjs`'s own guard are the tools; reading what they print is the
   habit.
3. **No command in this codebase copies data between worlds, and none should be
   written.** Seeding is per-world and manual. That boundary is the reason four
   worlds exist.
4. **Real personal data waits for the DPAs.** 1.1 is a gate, not a formality —
   `CLAUDE.md` A3 requires a processing agreement with every processor before
   personal data reaches it.
5. **Verify by content, never by status code.** A 200 from a hostname proves a
   hostname answers. The `dpl_` id proves *which build* answered.
6. **A failing suite is a finding, not noise.** Fix it or write down why it is
   expected, with a name against the reason. The two exceptions
   (`verify-checkout-e2e` against a real gateway; `verify-fx-collections` run
   twice) are already documented — anything else is new and must be treated as
   new.
7. **If a fix lands after the tag, the tag is dead.** Cut a new RC and re-run
   Stage 0 against it. Deploying "the tag plus one small fix" is how a
   rehearsed sequence stops describing the thing being deployed.
8. **Secrets are generated at the destination, never copied between worlds.**
   `.env.prod.local` is built from the production dashboard, not from
   `.env.staging.local` with the values edited.
