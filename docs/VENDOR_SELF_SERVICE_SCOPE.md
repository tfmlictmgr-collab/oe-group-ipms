# Vendor Self-Service: Sub-Users, Registration Pack & Cross-Brand Introduction

**Status:** database layer built and verified (`0163`–`0167`, applied to the Phase-1 dev world).
UI not yet built. Board decisions taken 17 Aug 2026 are recorded in §2.

**Trigger:** Afreximbank's own Vendor Management System (`vendors.afreximbank.net`), seen while
TFML completed its own vendor onboarding there. Two patterns adapted: a vendor inviting their own
sub-users against a small fixed permission set, and a staged registration wizard. UX pattern only
— not their branding, not their flow verbatim, and not their Mansa KYC-network step, which has no
OE Group equivalent and was dropped.

---

## 1. What was actually wrong before this

Verified against the migrations, not assumed:

- `vendors.user_id` (`0001_init_schema.sql`) was a single nullable FK — **one login per vendor
  company** — and `vendors.user_id = auth.uid()` was the live vendor-side permission check in
  `0064` (tickets_select), `0052` (tickets_update, vendors_select), `0157` (payments_select,
  remittances_select), `0072a` (payout_recipients_select), `0078a` (vendor_evaluations_select),
  `0104` (evaluation_responses_select), `0118` (decline/complete work order), `0162`
  (submit_vendor_invoice) and `0161` (vendor_invoiceable_jobs).

- ⚠️ **A live defect sat in the same place.** `accept_invitation` (live in `0153`) ended with
  `update vendors set user_id = v_uid`. Inviting a *second* person to an existing vendor did not
  add them — it silently **evicted the first**, leaving the original user with a `role = 'vendor'`
  account attached to no vendor at all. That is precisely the broken state `0116` was written to
  prevent, reached from the other direction. Fixed in `0163`; regression-tested as section A3 of
  the suite.

- Bank details were **never** on `vendors` — they live in `payout_recipients` (`0040b`), created
  by staff, with the full account number sent to the gateway once and never stored. The earlier
  draft of this document assumed otherwise; §4 below is the corrected design.

---

## 2. Board decisions (17 Aug 2026)

1. **Standard tier is the default**, with compulsory business-document verification uploads.
   Enhanced tier is set per vendor by the managing organisation.
2. **A vendor serving both brands keeps one registration, not two.** They **grant permission**
   from wherever they were first registered, and the receiving brand **verifies and approves** it
   themselves. **No fresh uploads and no restart from scratch.**
3. **Bank-detail verification is manual**, not an automated test transfer.

---

## 3. What shipped

### `0163` — a vendor company is not a single login

- `vendor_capability` enum, fixed by migration, four values: `manage_users`, `manage_profile`,
  `manage_work`, `manage_contracts`. Deliberately **not** part of the operator-governed permission
  matrix (`0050`): that matrix governs OE Group's own staff roles and a vendor must never reach or
  appear on its control surface.
- `vendor_users` membership table. One person → one vendor company (`users` is already org-scoped).
  Owner rows hold everything implicitly; a company must keep at least one owner; a non-owner with
  no capabilities is refused at creation.
- `current_user_vendor_ids()` — the vendor-side twin of `current_user_property_ids()`. **Every**
  site listed in §1 now resolves through it. One resolver extended, never a second mechanism
  (decision 8).
- `vendor_user_can(capability)` gates the vendor's own actions. Reading stays company-wide; acting
  requires the capability.
- Colleague invites reuse `invitations` (token hashing, expiry, single use, email match already
  correct there) via a **separate, airtight** `invitations_insert_by_vendor_user` policy rather
  than editing `0081`'s, which took four migrations to get right.
- Backfill makes every existing vendor login the owner of its company — nobody lost access.

### `0164` — a vendor registers once, in proportion

- `vendor_registrations` (one pack per vendor) + `vendor_documents` + a
  `vendor_document_requirements` catalogue seeded per tier.
- **Standard:** CAC certificate, TIN certificate, bank evidence, proof of address — all four
  compulsory. Insurance and trade licence optional.
  **Enhanced:** those four plus compulsory insurance, tax clearance, audited accounts, director ID,
  and the ownership/directors sections.
- `vendor_registration_missing()` is the single definition of "complete", read by both the screen
  and the submit function, so a refusal can never surprise somebody the screen said was finished.
- Review is a human decision **with a stated reason on approval as well as refusal** — an approval
  nobody had to justify is the rubber stamp decision 10 refuses. `machine_findings` on a document
  is support recorded against its own evidence, never a score or a recommendation.
- **No payment gate.** Nothing here refuses an invoice from an unregistered vendor.
  `vendor_registration_state()` reports; it refuses nothing (`0161`/`0162`'s standing lesson).

### `0165` — cross-brand introduction

The vendor initiates, addressing the target org **by slug** (`0085`'s rule: a link you were given
resolves; a dropdown would let a vendor discover which organisations exist). Consent is stored
verbatim and is withdrawable until acted on. On acceptance the receiving org gets **its own** vendor
row, pack and document rows — a copy, not a view, so nothing afterwards reads across the boundary.

**The B1 decision, stated plainly:** the offer **does not name the source organisation**. The
receiving org is told a contractor holds an approved registration elsewhere on the platform, not
with whom. Naming it would genuinely help the reviewer and is deliberately not done — it needs a
recorded board exception to B1, the same bar decision 12 sets for a public org directory.

What does not cross: verification status, machine findings, and any source-org user id.

### `0166` / `0167` — two defects the suite caught

- `0166`: `review_vendor_registration` could never approve anything — a `CASE` with untyped literals
  resolves to `text`, and plpgsql bodies aren't parsed until they run, so `0164` applied cleanly with
  the function broken. Every refusal path worked; the only broken path was the one that says yes.
- `0167`: `vendor_introductions` is the one row in this schema belonging to **two** organisations,
  so the generic `log_audit()` (which derives org from a single `org_id` column) resolved null and
  `audit_log.org_id NOT NULL` took the whole offer down. It is now audited into **both** trails,
  each redacted of the other's identity.

---

## 4. Bank details — the corrected design

The vendor **states** bank name, account name and the **last four digits only**, and uploads the
bank's own evidence of the account as a compulsory document. Finance reads the full number off that
document and registers the payout recipient through the existing `0040b` flow.

There is **no path** from `vendor_registrations` into `payout_recipients`. That is deliberate: a
self-service field that changes where money is sent is the highest-value target in the product, and
`0040b`'s rule — the number goes to the gateway once and is never stored by us — stands unchanged.
This also *is* the manual verification the board chose (decision 3): a human reads a bank document.

---

### The file-transfer worker

`app/api/jobs/copy-vendor-documents/route.ts`, on a `*/15 * * * *` Vercel cron.

`accept_vendor_introduction()` copies metadata; it cannot copy files, because `storage.objects`
indexes bytes the database does not hold. The alternative — letting the receiving org read the
sending org's storage prefix — would permanently widen the bucket policy that keeps one brand's
evidence out of the other's reach, for every request, to serve one transfer. So the boundary stays
where `0164` put it and the one actor legitimately holding paths in two orgs is the service role.

**Copy the file, then mark the row** — never the reverse. A crash between the two leaves
`copied_at` null and the pack reading as incomplete, so the next run finishes it. The opposite order
would tell a reviewer a document is present when it is not, and they would approve a registration
against evidence that does not exist. A destination that already exists is treated as done, which is
exactly that crash case on the following run.

⚠️ **`CRON_SECRET` must be set in the Vercel environment.** Every job route here is *closed* when it
is unset, not open — so a missing secret means this silently 401s forever and carried-over packs
never complete. It is not set in `.env.local`, which is why the local check below covers both paths.

## 5. Verification

`scripts/verify-vendor-self-service.mjs` — 47 checks, all passing. Each refusal is verified by
**attempting** the operation as a real signed-in user, never by reading a policy or grant table.
Section F stages real objects in the bucket and moves them across a brand boundary — a transfer
suite that never moves a byte proves only that two tables agree with each other.

The route itself was additionally exercised end to end against a running dev server: unauthenticated
and wrong-bearer both 401; authorised with an empty queue returns `{copied: 0}`; with one real
cross-org document queued it returned `{copied: 1}`, the file was readable at its new path with
contents intact, and a re-run was a no-op.

Also re-run green after the policy rewrites: `verify-vendor-journey`, `verify-vendor-onboarding`,
`verify-vendor-applications`, `verify-vendor-evaluation`, `verify-approval-chain`,
`verify-payment-gate`.

```bash
node scripts/verify-vendor-self-service.mjs
```

---

## 6. Still owed

1. **UI** — vendor Users screen, the tiered registration wizard, the staff review queue, and the
   introductions queue. None built. This is now the only thing standing between the feature and use.
2. **NDPA retention for `director_id`.** Enhanced-tier packs carry government ID for named
   individuals. There is no purge job; the tenant rule (decision 10(3)) is the obvious model. **Owed
   before enhanced onboarding opens to real vendors** — flagged in the migration itself, not left to
   be discovered. Standard tier does not collect it, so standard onboarding is unblocked.
3. **`orgs.vendor_enhanced_kyc_threshold`** exists and is grant-writable; Settings has no field for
   it yet.
4. **When the acceptance UI is built, have it kick the transfer** rather than waiting up to fifteen
   minutes for the cron. The job stays as the safety net — the queue is the state, the schedule
   never was.
