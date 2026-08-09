# Day 12 — Security pass

**Run:** 8 August 2026, against the Phase-1 dev deployment
(`oe-group-ipms-dev`, aliased by `tfmlportal.com` / `oeaportal.com`) and its
Supabase project.

> ⚠️ **This is not the go-live run.** `GO_LIVE_CHECKLIST.md` requires the Day 12
> pass to target the **production** URL and the **production** Supabase project,
> neither of which exists yet. Everything below re-runs unchanged against
> production once it does — `scripts/verify-security-posture.mjs` takes its
> target from the environment, so pointing it at production is a matter of
> credentials, not code.

---

## 1. Verdict

| Area | Result |
|---|---|
| Database boundary (RLS, anon reachability, audit trail, storage) | ✅ **Pass** — 30 checks |
| Application boundary (auth, gates, org isolation, roles) | ✅ **Pass** — the standing suites, ~600 checks |
| Dependencies | ⚠️ **Two accepted risks**, both recorded below |
| Secrets | ✅ **Pass** — no credential in the repository |
| External penetration test | ⛔ **Not done** — needs a third party and written authorisation |

**No blocking technical defect was found.** The two dependency items are
judgement calls for the board, not bugs, and both are argued below rather than
waved through.

---

## 2. The database boundary

`scripts/verify-security-posture.mjs` — new, and written to be re-run at
cutover.

- **Row-level security is on for every table in `public`.** No exceptions.
- **An anonymous caller holding the public key reaches nothing.** Tested by
  doing it, against 17 tables covering people, money, the ledger, the client
  list, applications, leases, bank accounts and the audit trail. Every read
  returned zero rows; a delete and an update against `audit_log` affected zero
  rows; an insert was refused; and `operator_provision_org` refused with *"only
  an administrator of the OE Group operator organisation may provision
  organisations"*.
- **No `SECURITY DEFINER` function relies on the caller's `search_path`** — the
  classic escalation against definer functions.
- **The audit trail has no UPDATE or DELETE policy.** It can only be added to.
- **The two private storage buckets are private:** `application-documents`
  (identity documents) and `work-order-media` (photographs taken inside client
  properties). `org-logos` is public by design — it paints an anonymous
  sign-in page.

### ⚠️ A false alarm worth recording

The first version of this check read the **grant** tables
(`information_schema.role_table_grants`, `has_function_privilege('anon', …)`)
and reported:

> ANON CAN WRITE: *(68 tables)* · ANON MAY EXECUTE 237 UNEXPECTED FUNCTIONS ·
> audit_log is mutable by anon

**Every one of those was wrong**, and publishing that verdict in a go-live
report would have been worse than publishing nothing. The grant layer is the
wrong thing to measure on Supabase: `ALTER DEFAULT PRIVILEGES … GRANT ALL ON
TABLES TO anon, authenticated` is the platform's standard posture, and **RLS is
the boundary that sits on top of it**. Of the 237 functions, 24 were triggers
(not callable), 194 were `SECURITY INVOKER` (so RLS applies to everything they
touch), and all 22 definer functions were either public application surfaces or
gated internally.

The check now does what an attacker would do — holds the anon key and tries.

**Residual, recorded as a note not a finding:** 67 tables carry the platform's
default anon write grant. RLS refuses them, proven above. Revoking the grants
as well is defence in depth and is worth doing at cutover on a fresh production
project, where it costs nothing; it is not a fix for an open door.

---

## 3. The application boundary

Existing suites, all green on this tree:

| Suite | Covers |
|---|---|
| `verify-rls-rest` | org isolation over the real REST API |
| `verify-access-matrix`, `verify-permissions` | the B7 matrix, operator-governed |
| `verify-role-surface` | all ten roles: what each must and must not reach |
| `verify-payment-gate` | the B4 gate against direct API calls |
| `verify-remittance`, `verify-remittance-race` | nothing leaves twice |
| `verify-invoice-appeal` | who verifies/approves/remits, and the appeal path |
| `verify-oversight-roles` | executive authorises, finance disburses |
| `verify-operator-separation`, `verify-operator-governance` | the single audited cross-org crossing |
| `verify-function-grants` | every function reachable by exactly its declared roles |
| `verify-jwt-claims`, `verify-invitations`, `verify-invite-acceptance` | identity |
| `verify-rate-limit` | abuse controls |
| `verify-embeds` | every PostgREST join the app asks for resolves |

---

## 4. Dependencies

`npm audit` after applying every non-breaking fix: **0 critical, 7 high, 21
moderate.**

Two accepted risks, both requiring a board decision rather than a code change:

### 4a. `next@14.2.35` — fix requires a major upgrade to 16.x

Twenty-one advisories. **This is the significant one, and it is not being
silently accepted** — the recommendation is a deliberate deferral:

- A Next 14 → 16 upgrade is two major versions, touching routing, caching and
  Server Actions. Doing it days before go-live trades a set of largely
  non-applicable advisories for a large, untested regression surface across a
  system that moves client money.
- **Applicability was assessed, not assumed:**
  - The Image Optimizer advisories name **self-hosted** deployments; this runs
    on Vercel, and no `images.remotePatterns` is configured at all.
  - The Pages Router / i18n middleware bypass needs both; this is App Router
    with no i18n.
  - The custom-server SSRF needs a custom server; there isn't one.
  - The CSP-nonce XSS needs nonces; none are used.
  - What **does** apply is the Server Components DoS class (CVSS 7.5) and RSC
    cache poisoning (5.4) — availability and cache-correctness issues, not
    data disclosure. Vercel mitigates several at the edge.
- **Recommendation:** schedule the Next 16 upgrade as the first post-go-live
  work item, with its own regression cycle. Do not attempt it inside the
  cutover window.

### 4b. `@sentry/nextjs` — fix requires a major upgrade

Same shape, smaller blast radius. Error tracking, not a request path. Upgrade
alongside Next 16.

The remaining moderates are OpenTelemetry transitives pulled in by Sentry and
resolve with it.

---

## 5. Secrets

- `.env.local` is git-ignored and has never been committed (`git log --all
  --full-history -- .env.local` is empty).
- No API key, token or password is hardcoded anywhere in `app/`, `lib/`,
  `components/` or `scripts/` — every credential is read from `process.env`.
- The seeded demo password (`OEGroupDemo2026!`) appears in `scripts/` by
  design: it is a fixture for synthetic accounts on a synthetic database.
  **It must never exist in production**, which the clean-data gate already
  guarantees — production is migrated, never seeded.
- `SUPABASE_SERVICE_ROLE_KEY` is used only in server-side code and scripts,
  never in a client component.

---

## 6. What this pass does NOT cover

Stated plainly, because a security report that implies more coverage than it has
is itself a risk.

- **No external penetration test.** An external test needs a third party plus
  written authorisation from OE Group; neither exists yet.

  ⚠️ **The tooling is now configured and ready** — `security/README.md` carries
  the ZAP automation plans (baseline and full), the k6 profiles, install steps,
  and `scripts/pentest-preflight.mjs`, which refuses a target where an active
  scan would be unsafe. It is unrun rather than unbuilt. **Read that runbook
  before running any of it**: this application writes through Next.js Server
  Actions, so an active scanner replaying a captured POST can fire a real
  payout.
- **No load test.** k6 is specified; it should run against production, since
  results from a dev preview on shared infrastructure would not transfer.
- **No review of the hosting providers' own posture** — Supabase, Vercel,
  Paystack, 360dialog. That is covered contractually by the DPAs in
  `NDPA_COMPLIANCE_PACK.md` §4, not technically by us.
- **Nothing about physical or personnel security** at OE Group.

---

## 7. Re-running this at cutover

```bash
npm run verify
```

```bash
node scripts/verify-security-posture.mjs
```

Both take their target from the environment. Point them at production
credentials, confirm the same results, and record the run date here.
