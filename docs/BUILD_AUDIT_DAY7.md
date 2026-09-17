# Build Audit — Day 7 (incremental)

**Date:** 2026-07-29 · **Auditor:** `build-auditor` (read-only static review, PC2)
**Scope:** `git diff 0cc4d32..846867f` — Day 7 tenant application + KYC, plus verification of the baseline fixes.

> **Shared for PC1 to verify & action.** Read-only findings; "Fix direction" notes are
> **suggestions for review, not applied changes** — verify against the current tree first.
> ⚠️ **One CRITICAL:** the tenancy-application submit path is silently blocked end-to-end
> (RLS returns zero attachment rows to the anon session, so the required-documents check
> always fails). It is **not** caught by `verify-tenant-applications.mjs` (that tests the
> RPCs, not the server action). Baseline items S-1/S-2/E-2/D-1 verified genuinely closed;
> E-1 only PARTIAL (Budget-utilisation panel still aggregates in JS). Running one-line log
> lives in `build-audit/FINDINGS.md` (PC2-local); baseline detail in `docs/BUILD_AUDIT_BASELINE.md`.

---

# Incremental Audit — Day 7 (Tenant Application + KYC intake)

**Date:** 2026-07-29
**Auditor:** build-auditor (read-only static review)
**Scope:** `git diff 0cc4d32..HEAD` (baseline HEAD `0cc4d32` → current HEAD `846867f`, branch `phase-1`).
**Method:** static read of migrations `0057`–`0065`, `app/tenancy/[org]/*`, `lib/application-form.ts`,
`app/dashboard/{bi,people,properties}/*`, `lib/triage.ts`, the changed import libs, and the new
`verify-*.mjs` / `verify-deployment-safety.mjs` (read only — none executed). No code run, no DB
writes, no offensive tooling.

> Shared for PC1 to verify & action. Nothing here has been applied — verify each against the
> current tree before implementing a fix. Baseline items (S-1, S-2, E-1, E-2, D-1, D-2) are
> referenced by ID and not restated; see `docs/BUILD_AUDIT_BASELINE.md`.

## Headline

The baseline's four actionable findings (S-1, S-2, E-1, E-2) are genuinely fixed at the DB layer,
and D-1 now has an automated post-deploy guard (`scripts/verify-deployment-safety.mjs`) that would
have caught the original issue — this is real closure, not paperwork. The team's own Day 7 review
also caught and fixed two self-introduced regressions (fan-out in `property_summary`, a
verification script that left the vendor-application link closed) before this audit started.

Day 7 itself (tenant application + KYC) is well-designed on paper — anon-write/never-read via
`SECURITY DEFINER` functions, hashed resume tokens, JSONB special-category isolation, enforced
retention — but the build has **one Critical gap that appears to block the feature end to end**:
the document-completeness check in `submitApplication()` reads `application_attachments` through
the applicant's unauthenticated session, and there is no RLS policy letting an anonymous caller
read that table. Every submission with a required document (i.e. every submission — both forms
require at least one) should return "Still to upload" forever, regardless of what was actually
uploaded. `scripts/verify-tenant-applications.mjs` never exercises this code path (it tests the
DB RPCs directly, not the Next.js server action), which is consistent with why this wasn't caught.

---

## SECURITY

### D7-S1 · `sensitive` (special-category NDPA data) is reachable by any reviewer via the base table, not just the view — Medium — CONFIRMED
**Where:** `supabase/migrations/0062_tenant_applications.sql:183-202` (`tenant_applications_staff_select` /
`tenant_applications_staff_update`) vs `:220-243` (`application_overview`, which excludes `sensitive`).

**What:** The migration's own header and comments (`0062:79-84`, `:215-220`) state the design
intent explicitly: "RLS is row-level and cannot withhold a field... the separation is physical:
reviewers read `application_overview`, which does not select this." That is true of the view, but
the base-table SELECT policy (`tenant_applications_staff_select`) is a row filter only — it does
not restrict which columns come back, and no column-level `GRANT`/`REVOKE` was added for
`authenticated` on `tenant_applications.sensitive` (confirmed by grep: no such grant/revoke exists
anywhere in `0062`/`0063`). PostgREST exposes base tables the same way it exposes views once RLS
permits a row.

**Scenario (CONFIRMED against code):** Any user satisfying the same row condition the view uses —
an admin or finance_approver holding `applications.review_all`, or a Property Manager attached to
the application's property — issues `GET /rest/v1/tenant_applications?select=applicant_name,sensitive&id=eq.<id>`
with their own JWT and receives the applicant's religion and marital status: exactly the
special-category data the view was built to keep out of the reviewer's sight. `verify-tenant-applications.mjs`
section F only asserts the *view* excludes `sensitive` (`scripts/verify-tenant-applications.mjs:159-172`);
it never checks the base table.

**Why Medium, not Low:** same exploit shape as baseline S-1 — an authenticated insider with
legitimate row access, using a hand-crafted PostgREST call rather than the built UI — which the
baseline auditor calibrated to Medium for the identical reason (real control, not reachable from
the product surface). Here it defeats a control that exists specifically for NDPA special-category
data, which is why it isn't Low.

**Fix direction (not applied — review only):** either (a) add a column-level `REVOKE SELECT
(sensitive) ... FROM authenticated` / re-`GRANT` the remaining columns on `tenant_applications`, so
the table itself cannot return `sensitive` to anyone but `service_role`, or (b) move `sensitive`
into its own table with no `authenticated` policy at all, read only through a future definer
function for Day 8's decision flow if one is ever needed.

### D7-S2 · `saveDraft` has no rate limit, unlike its siblings — Low — CONFIRMED
**Where:** `app/tenancy/[org]/actions.ts:84-109` vs `:34-44` (`startApplication`, 5/10m) and
`:190-192` (`createUploadTarget`, 30/10m).

**What:** `startApplication` and `createUploadTarget` both call `checkRateLimit`; `saveDraft` and
`submitApplication` do not. Once a caller holds one resume token (itself rate-limited to 5 starts
per 10 minutes per IP), `saveDraft` can be called an unlimited number of times with an arbitrarily
large `values` object — `save_application_draft` (`0063:66-95`) writes `form`/`sensitive` as JSONB
with no size cap, unlike the 10 MB check on document uploads (`actions.ts:201-203`).

**Impact:** a held token permits unbounded-frequency, unbounded-size writes to one row — a minor
storage/row-bloat vector rather than anything that crosses org or reads other applicants' data.
Low because it requires first clearing the `startApplication` rate limit and only affects the
attacker's own draft row.

**Fix direction:** add the same `checkRateLimit` call used elsewhere (e.g. 60/10m) to `saveDraft`.

### Security — checked and clean (new code only)
- **Org/brand isolation on the new tables:** `tenant_applications`, `application_attachments`,
  `org_modules` all scope on `org_id = current_user_org_id()`; `resolve_chat_sender` and
  `application_overview` are `SECURITY DEFINER` with the org check inside the function body, not
  left to a caller-evaluated subquery — the exact pattern that caused the anon-insert-always-false
  bug in the vendor flow (`0021`→`0022`), correctly avoided here (`0062:145-165`).
- **Anon write-never-read shape:** `start_tenant_application` / `save_application_draft` /
  `submit_tenant_application` / `record_application_attachment` are all `SECURITY DEFINER`,
  re-check `org_accepts_tenant_applications()` internally, and the anon INSERT policies are
  dropped once the functions exist (`0063:186-190`) — one way in, asserted by the suite.
  `record_application_attachment` also re-validates the storage path is under the caller's own
  `org/application` prefix (`0063:165-170`), so one valid token cannot register a row pointing at
  another application's file.
- **Cross-org resolution in the new WhatsApp fix:** `resolve_chat_sender` (`0064`) is org-scoped
  inside the function, requires an unambiguous single match, and the migration's own verification
  script explicitly tests that the same phone number does not resolve across a brand boundary
  (`scripts/verify-chat-request-visibility.mjs`, section C) — read only, not executed.
- **`tickets.triage_unassigned`:** the new RLS clause is structurally incapable of admitting a row
  that has a `property_id` (`0064:826-828`); confirmed by reading the clause, and the accompanying
  verify script (not run) specifically asserts this.
- **Injection:** all new SQL is parameterized functions/RPCs; `form`/`sensitive` are stored as
  JSONB values, never interpolated into SQL text or used to build dynamic queries. No triager/LLM
  or reviewer surface renders applicant-supplied text as HTML yet (Day 8 not built), so no stored-XSS
  surface exists in this diff.
- **Public tenancy page:** reads only branding columns via the admin client (id, name, portal_name,
  logo_url, theme_primary, tenant_applications_open, delivery_brand) — the same "public face" shape
  as the existing vendor-application page; `force-dynamic` correctly removes the caching hazard the
  team found and fixed themselves (`d96e444`).
- **S-1/S-2 regressions:** none found in the new payment- or property-adjacent code touched this
  stage (`app/dashboard/properties/actions.ts`, `0057`–`0059`) — see baseline verification below.

---

## EFFICIENCY

### D7-E1 · BI budget-utilisation panel still aggregates an unbounded table in JS — Medium — CONFIRMED (partial re-introduction of baseline E-1)
**Where:** `app/dashboard/bi/page.tsx:148-163`.

**What:** `0061` moved ticket/financial/vendor aggregation into DB-side `security_invoker` views
(`bi_ticket_status`, `bi_financials`, `bi_vendor_scores`) and the page correctly consumes them
(`bi/page.tsx:95-99`). The one remaining figure — invoiced-per-budget, for the "Budget utilisation"
panel — is still assembled by selecting **every** `service_charges` row that has a `budget_id`
(`.from("service_charges").select("budget_id, amount").not("budget_id", "is", null)`, no `limit`)
and summing in JavaScript by `budget_id`.

**The comment is incorrect and the risk is real:** the code says "It is bounded by the number of
BUDGETS... not by invoices" (`bi/page.tsx:145-147`), but the query's row count is the number of
service-charge invoices with a budget assigned, not the number of budgets — potentially every
invoice ever raised against a budgeted property. This is exactly baseline E-1's shape: past
PostgREST's 1000-row cap, `invoicedByBudget` silently undercounts, and the "Budget utilisation"
bar for an affected property reads as under-invoiced when it isn't. An executive reading this
panel has no way to tell a truncated figure from a true one — the same failure mode E-1 already
described for this exact page.

**Why this makes E-1 PARTIAL rather than fully closed:** three of the four aggregations E-1 flagged
(tickets, financials, vendor scores) are now correctly DB-side; the fourth is not, and the comment
claiming it's safe would stop a future reader from noticing.

**Fix direction:** replace the JS sum with a DB-side `group by budget_id` (either a new view or a
`.select("budget_id, amount.sum()")`-style aggregate query), mirroring the scalar-subquery pattern
already used in `bi_financials`.

### Efficiency — checked and clean (new code only)
- `app/dashboard/page.tsx` (E-2) bounded to 200 with an honest truncation notice — see baseline
  verification.
- `app/dashboard/properties/page.tsx` now reads `property_summary` (DB-aggregated, `0059`) instead
  of pulling every unit; counts are correct at any scale.
- `app/dashboard/people/tenancy/page.tsx` and `layout.tsx` count applications with
  `{ count: "exact", head: true }` rather than fetching rows — the heaviest-PII table in the system
  is not pulled through a page that only needs a number (`a4a4bdf`, already fixed within this diff).
- `resolve_chat_sender` (`0064`) does one indexed lookup per unresolved sender at ticket-creation
  time, not a query per existing ticket; the backfill `do $$` block in the same migration is a
  one-time migration cost, not a recurring one.

---

## DISCONNECTS

### D7-D1 · Tenant application submission appears permanently blocked by an RLS gap in its own document check — Critical — CONFIRMED
**Where:** `app/tenancy/[org]/actions.ts:145-157` (inside `submitApplication`).

```ts
const { data: attachments } = await supabase
  .from("application_attachments")
  .select("kind")
  .eq("application_id", applicationId);

const present = new Set((attachments ?? []).map((a) => a.kind));
const missingDocs = REQUIRED_DOCUMENTS[type].filter((d) => !present.has(d.kind));
if (missingDocs.length > 0) {
  return fail(`Still to upload: ${missingDocs.map((d) => d.label).join(", ")}.`, ...);
}
```

**What:** `supabase` here is the request-scoped client bound to the applicant's cookies
(`lib/supabase/server.ts`) — for an unauthenticated applicant this resolves to the Postgres `anon`
role. `application_attachments` has exactly two RLS policies: `application_attachments_staff_select`,
scoped `to authenticated` only, and the insert policy (which `0063:190` drops once
`record_application_attachment` exists). **There is no SELECT policy for `anon` on this table.**
Under Postgres RLS, a query with no matching policy for the caller's role returns zero rows with
no error — it does not throw. So `attachments` is always `[]` for the applicant who is actually
submitting, regardless of how many documents they uploaded through
`createUploadTarget`→`record_application_attachment` (which succeeds, because that RPC is
`SECURITY DEFINER` and bypasses RLS internally — the insert really happens).

**Scenario (CONFIRMED against code, not run):** An applicant completes the individual form,
uploads a government ID, a passport photo, and a guarantor ID exactly as the UI asks (all three
show "Uploaded" with a green check in `ApplicationForm.tsx`), ticks consent, and clicks "Submit
application." `submitApplication` re-reads `application_attachments` under their own anon session,
gets zero rows back, computes `missingDocs = REQUIRED_DOCUMENTS[type]` (i.e. *all* of them), and
returns `"Still to upload: Government-issued ID, Passport photograph, Guarantor's ID."` — even
though every one of those was uploaded seconds earlier. There is no code path by which this check
can pass for an anonymous applicant as the flow is currently wired, for either application type
(both have a non-empty `REQUIRED_DOCUMENTS` list).

**Why not caught:** `scripts/verify-tenant-applications.mjs` (the new Day 7 verification suite)
never calls `submit_tenant_application` or exercises the document-completeness check — it tests
`start_tenant_application`, `resume_application`, RLS read-back, and `purge_expired_applications`
directly against the DB RPCs with service-role/anon Supabase clients, but not the Next.js server
action layer where this bug lives. `docs/PHASE1_WORKPLAN.md`'s Day 7 status entry ("Done when: both
individual and corporate applications submit cleanly" / "Status — built... 22 checks pass") reflects
the DB-level suite passing, not an end-to-end submission.

**Fix direction (not applied — review only):** read the attachment count through the same
`SECURITY DEFINER` pattern already used for everything else an applicant needs to check about their
own application — e.g. have `resume_application()` (or a new function) also return the set of
uploaded `kind`s, since it already resolves the token to the row under definer rights; or add a
narrow `record_application_attachment`-style read function. A direct anon SELECT policy on
`application_attachments` would also work but would need to stay scoped by resume-token match
rather than `application_id`, to avoid the same enumeration risk `0063`'s header discusses for
`tenant_applications` itself.

### D7-D2 · The promised "resume on a different device" (emailed link) does not exist — Medium — CONFIRMED
**Where:** `app/tenancy/[org]/ApplicationForm.tsx:234-237` ("using the link we emailed you — for 30
days"); `app/tenancy/[org]/actions.ts:54-55` ("The token is also emailed, which is what covers a
different device"); `supabase/migrations/0062_tenant_applications.sql:245-249` header comment
("The applicant holds an unguessable token... Resume without an account").

**What:** No email is ever sent for the tenancy flow. `startApplication` (`actions.ts:34-82`)
creates the draft and resume token and returns them to the client; `StartApplication.tsx:31-46`
persists them only to `window.localStorage`, keyed per `orgId`/`type`. There is no email-sending
call anywhere in `app/tenancy/`, `lib/application-form.ts`, or the new migrations (confirmed by
grep for `resend`/`sendEmail`/`notify`), and there is no route or page that would consume a
`?token=` (or similar) from a URL even if one were emailed — `app/tenancy/[org]/page.tsx` only ever
starts a *new* application or, via `StartApplication`, reads the *same-device* localStorage entry.
`resume_application()` (`0062:250-268`) exists and is fully correct as a DB function, but it is
only ever called from within `submitApplication`/`createUploadTarget` to re-validate a token the
client already holds — never to fetch-and-repopulate a draft from a token supplied by the user.

**Impact:** an applicant who changes phones, clears browser storage, or fills the form on a shared
device (common on the mobile-data, shared-phone usage this form is explicitly designed for — see
`ApplicationForm.tsx`'s "Photographs of documents are fine" mobile-first framing) has no way back
into a draft, despite being told twice in the UI that they do. This is a UX/data-loss disconnect on
the "heaviest PII in the system" form, not a security hole — the token itself is never actually
exposed insecurely, because it is never sent anywhere.

**Fix direction:** either wire an actual email (mirroring the existing `lib/email.ts` pattern used
for invitations) with a `/tenancy/[org]/resume?token=...` route that calls `resume_application()`
and repopulates `ApplicationForm`, or remove the "we emailed you" copy until that exists so the
promise made to an applicant matches what the product does.

### Disconnects — checked and clean (new code only)
- **`property_id = null` blocking PM review** — already self-identified by the team and recorded
  in `docs/PHASE1_WORKPLAN.md`'s Day 8 section (commit `d204b76`) as a blocker to resolve before
  Day 8 starts; not re-flagged here per scope (Day 8 not yet built, and it's already on record).
- **Vendor-application verify script closing the live link on cleanup** — already self-identified
  and fixed within this diff (`0ffd3d6`); not re-flagged.
- **Tenancy count-fetch pulling PII rows to render a number** — already self-identified and fixed
  within this diff (`a4a4bdf`); not re-flagged.
- **WhatsApp tickets invisible to non-`read_all` roles** — already self-identified and fixed within
  this diff (`3299d38`, `0064`, `0065`); not re-flagged.
- **`seed_b7_permissions()` vs. one-off grants** — the same "rule applied in one place, not in its
  source" mistake was caught and corrected by the team within this diff (`0065`); the fix is
  structurally sound (the capability is now named explicitly in the seed function rather than
  falling through to `else false`).
- Module gate (`org_has_module`) is independent of the open/closed window in both the DB function
  and `setTenantApplicationsOpen`/`setVendorApplicationsOpen`-style actions, so a facilities org
  cannot show "open" while the module is off.

---

## Baseline fixes verified

| ID | Title | Verdict | Evidence |
|----|-------|---------|----------|
| **S-1** | Approval threshold not enforced at the DB | **CONFIRMED closed** | `enforce_payment_transition()` (`0060`) now compares `new.amount` against `payment_settings.approval_threshold_amount` (default ₦1,000,000 when unconfigured) and requires `caller_role = 'admin'` above it, on the `approved` transition, unconditionally of caller — holds against a direct PostgREST PATCH. `scripts/verify-deployment-safety.mjs` section C asserts the check is present in the trigger source on every deploy. |
| **E-1** | BI dashboard whole-table JS aggregation (1000-row truncation) | **PARTIAL** | Tickets, financial totals and vendor scores are now DB-side `security_invoker` views (`0061`) and the page consumes them correctly. The budget-utilisation panel (`bi/page.tsx:148-163`) still selects every `service_charges` row with a `budget_id` and sums in JS with no limit — the same truncation risk, on a narrower but still unbounded query, with a comment that incorrectly claims it's bounded by budget count. See **D7-E1**. |
| **E-2** | Unbounded service-request list | **CONFIRMED closed** | `app/dashboard/page.tsx` now selects with `{ count: "exact" }` and `.limit(200)`, and shows an explicit "Showing the 200 most recent of N requests" notice when truncated — no silent drop-off. |
| **S-2** | `units` insert doesn't verify property's org | **CONFIRMED closed** | `0057` adds a structural composite FK `units_property_same_org_fk (property_id, org_id) → properties(id, org_id)` (and the equivalent for `assets`), which holds even for the service role — stronger than the RLS-check fix direction the baseline suggested. `verify-deployment-safety.mjs` section D asserts both FKs exist post-deploy. |
| **D-1** | Read-leak fix depends on `0055` being applied | **CONFIRMED closed** | `scripts/verify-deployment-safety.mjs` section A is exactly the smoke check the baseline's fix direction asked for ("no matrix-governed table carries a `FOR ALL` policy in prod"), plus four more schema invariants (RLS-on-every-org-table, the S-1 trigger check, the S-2 composite FK, fan-out-free aggregate views, `channel_routes` unreachability). This is a genuine operational guard, not just documentation. |

No re-flagged baseline items were found broken by Day 7's changes.

---

## Severity summary (new findings, this audit)

| Sev | ID | Title | Status |
|-----|----|-------|--------|
| Critical | D7-D1 | Document-completeness check always fails for an anon applicant — submission appears permanently blocked | CONFIRMED |
| Medium | D7-S1 | `sensitive` (special-category) column readable via the base table, not just `application_overview` | CONFIRMED |
| Medium | D7-E1 | BI budget-utilisation panel still JS-aggregates an unbounded `service_charges` select | CONFIRMED |
| Medium | D7-D2 | Promised emailed/cross-device resume link does not exist | CONFIRMED |
| Low | D7-S2 | `saveDraft` has no rate limit, unlike `startApplication`/`createUploadTarget` | CONFIRMED |

No High findings this pass.
