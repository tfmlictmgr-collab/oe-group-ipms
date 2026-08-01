# Build Audit — 0729e (incremental)

**Date:** 2026-07-29 · **Range:** `fcf11d1..ac3b71e` (Day 8 two-tier review `0082`, org-retirement authz `0083`, Day 8.5 AI document verification `0086`, org directory/slugs/launcher `0085`, hierarchy UI `0084/0087`).
**Auditors:** `build-auditor` (security) + `/code-review` (correctness) — PC2.

> **Shared for PC1 to verify & action.** Fix directions are **suggestions for review, not applied changes**.
> **✅ Prior 0729d-M1 (org-retirement authz) CLOSED:** `0083/0083b/0083c` lock `deleted_at` out of the `orgs` update column-allowlist and give retirement its own audited, operator-admin-only RPC — no tenant-admin path to flip `deleted_at`.
> **Mostly clean:** two-tier maker-checker is genuinely DB-enforced; AI document verification structurally cannot decide/score (no verdict field, invalid severities dropped, special-category never sent, injection bounded to a human-read observation); the public org directory can't enumerate or leak retired/private orgs.
> **Open this round: 1 Medium (security) + 1 Medium + 1 Low (correctness).**

## New — Medium (security)

**0729e-M1 — the "documents complete" gate is UI-only.** `record_application_approval` (`0082_two_tier_application_review.sql:369-446`, unchanged by `0082b`) never checks `application_document_requirements` / `application_attachments`. The completeness gate is enforced only in React (`app/dashboard/people/tenancy/[id]/ReviewPanel.tsx:218`, `page.tsx:83,246`) — contradicting `docs/BUILD_JOURNAL.md:1955-1960`'s claim that "0082 re-checks all of it." An approver calling the RPC directly (or any future UI regression) can complete an approval and issue the tenant invitation **before a required document exists**. Not covered by `scripts/verify-application-review.mjs`. This is the same class as the Day-7 Critical (a completeness check that lived outside the DB).
- Fix direction: re-check required-vs-present documents inside `record_application_approval` and raise if incomplete, exactly as `submit_tenant_application` now does on the applicant side.

## New — correctness (`/code-review`)

**C-M1 (Medium) — document verification does no real text extraction.** `examineDocument` sends `doc.bytes.toString("utf8").slice(0,20000)` as the "extracted text" for any non-image type (`lib/document-verification.ts:201`). PDFs / office docs — typical for IDs, CAC, TIN — utf8-decode to garbage, so the model returns nothing and the Day-8.5 feature silently produces zero findings for a whole class of common uploads, despite the module comment promising "extracted text… wherever the file allows it." No security impact (a human still reviews), but the feature under-delivers invisibly. Extract real text (or route those formats through the image path).

**C-L1 (Low) — `image/jpg` sent as an invalid media_type.** `IMAGE_TYPES` accepts `image/jpg`, but it's passed straight through as the Anthropic image `media_type` (`lib/document-verification.ts:69,191`); the API requires `image/jpeg`, so such JPEGs 400 and silently yield no findings. Normalize `image/jpg` → `image/jpeg`.

---

## Full security audit report

# Incremental Audit — 0729e (Day 8 two-tier review, AI document verification, org slugs/directory, hierarchy UI, org launcher)

**Date:** 2026-07-29 (findings logged as "0729e")
**Auditor:** build-auditor (read-only static review)
**Scope:** `git diff fcf11d1..ac3b71e`, branch `phase-1`. 56 files changed, 15 commits: `0a46e87`/`26662cf`/`8781197`
(Day 8 two-tier review schema + UI), `78546f9` (org retirement authorisation fix), `c911076`/`0fd98a8` (Day 8.75
hierarchy UI), `89d356a` (Day 8.8 org slugs/directory), `2be8dd0`/`9ed9e3a` (Day 8.5 AI document verification),
`f2000bf` (region order amendment), `167b1fd`/`042b30b` (Day 8.9 UI polish), `9817138` (Day 9 unblock note),
`ac3b71e` (org launcher nav entry).
**Method:** static read of every changed migration (`0082`–`0087` and letter variants), `lib/document-verification.ts`,
`app/dashboard/people/tenancy/[id]/*`, `app/orgs/page.tsx`, `app/o/[slug]/page.tsx`, `components/auth/sign-in-panel.tsx`,
`components/patterns/hierarchy-picker.tsx`, `app/dashboard/properties/hierarchy/*`, `components/shell/nav-config.ts`,
`docs/BUILD_JOURNAL.md` (new sections, to identify already-fixed dev-time defects and avoid re-flagging them), and
`scripts/verify-application-review.mjs` / `verify-document-checks.mjs` / `verify-org-directory.mjs` /
`verify-hierarchy-ui.mjs` (read only, not executed, to check what is and isn't test-covered). No code run, no DB
writes, no offensive tooling, no verify-*.mjs scripts executed.

## Headline

**0729d-M1 is CLOSED.** `78546f9` + `0083`/`0083b`/`0083c` correctly gives org retirement its own authorised,
audited door and correctly closes the direct-PATCH hole — after two iterations that didn't work (a trigger
defeated by `SECURITY DEFINER` not changing `auth.uid()`; a column-level `REVOKE` defeated by a pre-existing
table-level grant that a column revoke cannot override), the final mechanism (`0083c`, revoke-all-then-allowlist)
is the same pattern already proven correct for `tenant_applications.sensitive`/`resume_token_hash`, and it
verifiably removes `deleted_at`, `is_platform_operator` and `id` from what `authenticated`/`anon` may write on
`orgs`. See "Prior fixes verified" below.

The new work is large and, on inspection, mostly matches its own stated design goals closely: the two-tier
review maker-checker rule is enforced in the database (not just the UI) with real duplicate/self-approval guards;
the AI document verification module is a genuinely well-built human-in-the-loop boundary — no score/verdict field
exists in the schema at all, findings are dropped rather than coerced when a model returns something outside the
permitted vocabulary, special-category data is structurally unable to reach a prompt, and a same-org
cross-application evidence-citation bug was caught and fixed in the same range (`0086b`); the org directory/slug
system correctly keeps the client list non-public and un-enumerable. One genuine new finding: the
document-completeness gate for application **approval** is UI-only, not DB-enforced, despite `docs/BUILD_JOURNAL.md`
explicitly stating "None of that is the boundary — `0082` re-checks all of it" for every disabled state on the
review panel including this one. See 0729e-M1.

---

## Prior fixes verified

### 0729d-M1 — Org retirement had no authorisation boundary — **CLOSED**

Confirmed by reading `supabase/migrations/0083_org_retirement_authorization.sql`,
`0083b_retirement_column_privilege.sql`, and `0083c_orgs_update_column_allowlist.sql` together — the migration
comments document two failed attempts before the working one, which is itself good evidence the fix was actually
verified rather than assumed:

1. **`0083`'s trigger did not work.** `orgs_block_direct_retirement()` keyed its check on `auth.uid() is not null`
   to tell a human session apart from `retire_org()`'s own trusted write — but `SECURITY DEFINER` changes which
   *role* Postgres checks privileges as, not what `auth.uid()` returns on the calling session. The trigger fired
   inside `retire_org()` itself and blocked its own UPDATE.
2. **`0083b`'s column-level `REVOKE UPDATE (deleted_at) ON orgs FROM authenticated` did not work either.**
   `authenticated`/`anon` both hold Supabase's default blanket table-level UPDATE grant, which a column-specific
   revoke cannot override — `has_column_privilege('authenticated','orgs','deleted_at','UPDATE')` still returned
   `true` after it ran.
3. **`0083c` is the fix that actually holds:** `revoke update on orgs from authenticated, anon;` followed by
   `grant update (name, delivery_brand, parent_org_id, theme_primary, theme_accent, theme_logo_text, logo_url,
   portal_name, tagline, support_email, support_phone, login_headline, vendor_applications_open, finance_email,
   it_email, email_from_name, email_from_address, tenant_applications_open) on orgs to authenticated;`
   (0083c_orgs_update_column_allowlist.sql:28-37). `deleted_at`, `is_platform_operator` and `id` are absent from
   the allowlist — a column left off is unwritable by construction, the identical pattern already proven for
   `tenant_applications.sensitive`/`.resume_token_hash` (0070, 0081). Confirmed no later migration in range
   re-grants a wider UPDATE on `orgs` (`grep ") on orgs to"` across the full migration set matches only
   `0083c_orgs_update_column_allowlist.sql`).

`orgs_admin_update` (0013_org_theming.sql:15-17) is genuinely unchanged, exactly as the migration header claims —
a brand admin keeps their theming write, and `deleted_at` is now unreachable through it regardless of the RLS
`using`/`with check` passing, because Postgres checks column privilege independently of and before RLS.

`retire_org(p_org_id, p_reason)`/`unretire_org(p_org_id, p_reason)` (0083_org_retirement_authorization.sql:41-124)
are `SECURITY DEFINER`, owned by the table owner (so the revoke never applies to them), gate on
`caller_is_operator_admin()` (the same 0079 gate every other operator crossing uses), require a ≥10-character
reason, write both `operator_actions` and `audit_log`, and `notify_role` the target org's admins/executives —
matching every other operator crossing's shape, closing the "right actor has no path" half of 0729d-M1 as well as
the "wrong actor can self-retire" half.

**No way found for a tenant admin to flip `deleted_at`.** Direct PostgREST PATCH fails on column privilege before
RLS is even consulted; `orgs_admin_update`'s allowed columns exclude it; no other write policy or function targets
it outside `retire_org`/`unretire_org`.

**One open, non-security observation, not a new finding:** there is still no application UI that calls
`retire_org`/`unretire_org` — grep across `app/`, `components/`, `lib/` finds no caller. The authorisation
boundary this audit was asked to verify is real and correct; the feature remains reachable only via direct RPC
call (e.g. `supabase.rpc('retire_org', ...)` from an authenticated operator-admin session, or migration/
service-role access) until an operator console screen is built. This matches 0729d's own note that the feature
"as shipped" had no UI, and nothing in this diff regresses that — it just fixes who is authorised to use the RPC
once a UI exists. Not re-flagged as a defect; noted so it isn't mistaken for newly closed.

**Verdict: CLOSED.**

---

## New findings (0729e)

### 0729e-M1 — Application approval's "documents complete" gate is UI-only; the DB function that is documented as re-checking it does not (Medium, CONFIRMED)

`app/dashboard/people/tenancy/[id]/ReviewPanel.tsx:218` disables the Approve button
(`disabled={busy !== null || !documentsComplete}`) while any required document is outstanding, and
`app/dashboard/people/tenancy/[id]/page.tsx:83,246` computes `documentsComplete` as `missing.length === 0`,
where `missing` is derived client-side by diffing `application_document_requirements` against uploaded
`application_attachments` **at page-render time**.

`docs/BUILD_JOURNAL.md:1955-1960` states this explicitly as a security property, not a UX nicety:

> "**Every disabled state mirrors a rule the database will enforce anyway.** Approve is greyed while a required
> document is outstanding... None of that is the boundary — `0082` re-checks all of it."

This is not true for the document-completeness rule. `record_application_approval`
(`supabase/migrations/0082_two_tier_application_review.sql:369-446`, re-confirmed unchanged in the bugfix
revision at `0082b_application_review_reason_check.sql:90-159`) checks, in order: application exists and is in
the caller's org; caller holds `applications.approve`; caller holds `applications.review_all` or the application's
property is in `current_user_property_ids()`; `status = 'under_review'`; caller is not the recommender; caller has
not already approved; `unit_id is not null`. **It never queries `application_document_requirements` or
`application_attachments`.** `record_application_rejection` and `record_application_recommendation` likewise never
touch document completeness (the only DB-side check of `application_document_requirements` anywhere in the diff
is inside `submit_tenant_application`, at the applicant's own submission/resubmission time —
`0082_two_tier_application_review.sql:298-354`). Confirmed with a full-repo grep for
`application_document_requirements`: it appears in exactly one function body plus the review page's own client
read.

Concrete scenario: an org admin edits `application_document_requirements` to add a newly-required document kind
(or a requirement is added between an application's submission and its review) after an application is already
`submitted`/`under_review`. `submit_tenant_application` enforced completeness against requirements *as they stood
at submission/resubmission time*; it is never re-run. The review page will correctly show "Still to upload: X"
and grey out Approve — but an approver who calls the underlying server action directly (browser devtools against
the exposed Next.js server-action endpoint, a future UI regression that drops the `disabled` prop, or simply a
different/future UI surface reusing the same RPC) completes the approval and issues the tenant invitation with
that document never having been provided. Because `record_application_approval` is the *only* enforcement point
the architecture's own stated design (see `0082`'s own comment, line 51: "that split is exactly how the Day 7
document gate went missing") says a check like this belongs in, this is the same class of defect the codebase has
already named and fixed once before (D7-D1/D7-S1) — reintroduced here for one specific rule.

Impact is bounded: it requires an already-privileged approver to act (no cross-tenant or unauthenticated path),
and the maker-checker/reason/unit-assignment rules that matter most for 0082's own stated purpose *are* correctly
DB-enforced (verified above and in `0082`/`0082b`'s code directly). This is a missing defense-in-depth check on
one compliance-relevant rule, not a privilege-escalation or data-isolation defect — Medium rather than High.

Not exercised by `scripts/verify-application-review.mjs` — the only place the suite checks
`application_document_requirements` is the resubmission path (`scripts/verify-application-review.mjs:376-378`,
"the Day 7 document-completeness gate applies to a resubmission exactly as it did to a first submission"); no
section constructs an application missing a required document and attempts `record_application_approval` against
it directly.

**Files:** `supabase/migrations/0082_two_tier_application_review.sql:369-446` (missing check);
`supabase/migrations/0082b_application_review_reason_check.sql:90-159` (same function, bugfix revision, check
still absent); `app/dashboard/people/tenancy/[id]/actions.ts:117-168` (`approveApplication` — thin wrapper, no
independent check); `app/dashboard/people/tenancy/[id]/ReviewPanel.tsx:218` (client-only gate);
`docs/BUILD_JOURNAL.md:1955-1960` (the claim this finding contradicts).

---

## Areas checked and clean

- **Two-tier maker-checker (`0082`/`0082b`/`0082c`/`0082d`)** — genuinely DB-enforced, not just UI-suggested:
  `record_application_approval` refuses the recommender (`a.recommended_by = auth.uid()`), refuses a duplicate
  approver (`exists (... kind='approve' and decided_by = auth.uid())`), requires `unit_id` assigned, and requires
  two *distinct* `decided_by` values for a corporate application before completing
  (`count(distinct decided_by)` against `application_decisions`, not a row count that a repeat approval could
  inflate). `record_application_rejection` independently refuses the recommender. Both correctly check org
  membership and property/`review_all` scoping before touching a row. The `0082c` enum-cast bug and `0082d`
  attachment-status bug are dev-time defects the project's own suite caught before shipping (documented in
  `docs/BUILD_JOURNAL.md:1845-1868`) — not re-flagged.
- **Special-category/PII walling from the reviewer view** — `application_overview` (0082, lines 502-531) is an
  explicit column list that never selects `tenant_applications.sensitive`; `app/dashboard/people/tenancy/[id]/page.tsx`
  and the tenancy queue both read exclusively through this view, never the base table. Consistent with the
  pre-existing D7-S1 fix (base-table column grant already excludes `sensitive`).
- **AI document verification — human-in-the-loop guarantee (`0086`/`0086b`, `lib/document-verification.ts`)** —
  CONFIRMED structurally, not just by convention: `application_document_findings` has no score/rank/recommendation
  column at all (schema-level, not a nullable/unused field); `severity` is a two-value enum (`info`/`attention`)
  with `attention` explicitly documented as never meaning reject; `parseFindings()`
  (`lib/document-verification.ts:127-166`) drops any `kind`/`severity` outside the fixed enums rather than
  coercing them, and explicitly refuses to accept a model-asserted `"duplicate"` finding (computed only from
  local hashes); no code path in `runDocumentChecks` or the DB functions from `0082` writes findings into
  `tenant_applications.status`, `.recommendation`, or `.decision_notes` — grep for `application_document_findings`
  outside `0086`/`0086b`/`DocumentChecks.tsx`/`actions.ts` finds nothing that reads it back into a decision path.
- **AI prompt/LLM injection from document text/filenames** — the extracted-text/filename content IS placed
  directly in the user message sent to the model (`lib/document-verification.ts:175-203`), so a malicious document
  could attempt to steer the model's output. The blast radius is structurally bounded by `parseFindings()`: even a
  fully-injected reply can only produce a finding within `{extraction, format, consistency, completeness}` ×
  `{info, attention}` with free-text `summary`/`detail` — there is no field an injected reply can use to set a
  status, trigger a side effect, or reach any other table (findings are inserted via `supabaseAdmin` from
  server-side code, not by relaying model tool-calls). Findings are rendered as plain React text (no
  `dangerouslySetInnerHTML` anywhere in `DocumentChecks.tsx`), so an injected `summary`/`detail` cannot XSS a
  reviewer either. Residual risk is a misleading/manipulated but schema-conforming observation reaching a human
  reviewer who is told explicitly, in the same UI, "These are notes for you to weigh — they decide nothing" — an
  acceptable residual for a decision-support tool whose entire design premise is that a human reads and can
  contest every finding (`contest_document_finding`, 0086:174-217).
- **AI output stored/trusted without bounds** — findings are replaced (not accumulated) per run
  (`app/dashboard/people/tenancy/[id]/actions.ts:321-324`), require `summary` ≥10 chars at the DB CHECK
  (0086_ai_document_verification.sql:64), and `0086b`'s trigger (`findings_cite_own_evidence`) now enforces that a
  finding's `attachment_id` genuinely belongs to the `application_id` it's filed against — closing a real cross-
  applicant evidence-mixing bug the project's own suite found before shipping (documented,
  `docs/BUILD_JOURNAL.md:2076-2081`). No length cap on `summary`/`detail` beyond the floor — a low-severity
  robustness note (a pathological model reply could write an oversized row), not treated as a finding given
  `max_tokens: 1000` on the API call already bounds the source.
- **PII handling in AI document verification** — `tenant_applications.sensitive` (religion, marital status) is
  not a parameter of any function in `lib/document-verification.ts` and cannot be passed in structurally, matching
  the file's own header claim. Duplicate detection compares SHA-256 hashes computed locally
  (`lib/document-verification.ts:65-67`) — no second applicant's document, name, or application id is ever placed
  in a prompt or in a finding's text (`duplicateFinding()`, lines 228-246, explicitly names no other applicant).
  Document bytes/text are sent to the Anthropic API (a third-party processor) when a check runs — called out
  explicitly in the module's own header as the DPA-relevant tradeoff, with extracted text preferred over images
  specifically to reduce it; this is a disclosed design decision, not an oversight, and outside a static read-only
  audit's ability to verify against Anthropic's actual data-retention terms.
- **Org directory / slugs (`0085`) — enumeration and data-leak surface** — `org_public_branding(slug)` returns at
  most one row (`limit 1`), excludes retired orgs (`deleted_at is null`), and returns only branding fields (name,
  logo, colours, tagline) — no member counts, no property counts, no indication anything else exists.
  `operator_org_directory()` (which does carry member/property counts and the retired flag) gates on
  `caller_is_operator_admin()` **inside the query**, so a non-operator gets zero rows rather than a permission
  error — the design's own stated reasoning (a refusal confirms something worth refusing) is real: verified the
  function has no other predicate branch a non-operator could exploit. `app/orgs/page.tsx` additionally requires a
  session before calling it (defense in depth, not the boundary) and correctly treats an empty result as "you are
  not an operator" rather than "the platform has no orgs." Slug uniqueness is enforced by a case-folded partial
  unique index scoped to live orgs (`orgs_slug_uidx`); slug lookup is parameterized (`lower(o.slug) =
  lower(trim(p_slug))`), not string-built — no injection surface. `app/o/[slug]/page.tsx` answers 404 identically
  for an unknown slug and a retired org's slug, so the two cannot be distinguished from outside.
- **Org launcher nav entry (`ac3b71e`)** — `components/shell/nav-config.ts`'s new "Operator" group is gated
  `show: (c) => c.isOperator`, and `isOperator` (`app/dashboard/layout.tsx`) is computed as `role === 'admin' &&
  org?.is_platform_operator`, reading `is_platform_operator` off the session's own org record fetched server-side —
  consistent with the nav config's own comment that this is presentation-only and `operator_org_directory()`'s
  in-query gate is the real boundary. Confirmed `is_platform_operator` was added to `getSessionProfile`'s org
  select (`lib/auth.ts`) as a read-only column, not writable by session (excluded from the `orgs` UPDATE allowlist
  per 0083c, verified above).
- **Hierarchy UI (`0084`, `0087`, `HierarchyTree.tsx`, `hierarchy/actions.ts`, `hierarchy-picker.tsx`)** —
  `retire_org_node()` mirrors `retire_property`'s refuse-rather-than-orphan shape (refuses if any live child node
  or live property still references it), checks the caller's org before checking permission, and is idempotent on
  an already-retired node. `createNode`/`renameNode`/`setNodeStakeholder` in `hierarchy/actions.ts` insert/update
  with the caller's own `org_id`, relying on RLS (`hierarchy.write`, pre-existing from `0066`, unchanged in this
  diff) as the sole enforcement point — consistent with the rest of the codebase's pattern of not duplicating RLS
  checks in the server-action layer. `0087`'s level reorder (LOCATION above PROJECT, amending the 29 July board
  order) re-levels existing nodes in place rather than deleting them, preserving `path` and every downstream
  assignment; `hierarchy_depth()` is an explicit function (not enum declaration order), as `0066` originally
  required for exactly this kind of future change. `HierarchyPicker`'s inline creation only offers `onCreate` when
  the caller supplied it (server action gated by RLS); a caller with no create rights gets a selection-only picker.
- **Sign-in panel (`components/auth/sign-in-panel.tsx`)** — shared between `/login` (OE Group, anonymous branding)
  and `/o/[slug]` (org-specific branding resolved server-side via `org_public_branding`); the component itself
  never learns another org exists (branding is passed in, not fetched by the component). `supabase.auth.signInWithPassword`
  is unscoped by design — visiting an org's branded URL and signing in with a *different* org's credentials
  succeeds and lands the user in their own org's dashboard (RLS, not the login chrome, is the isolation boundary,
  unchanged from before this diff) — this is expected behavior, not an isolation defect.

## FEATURE_BACKLOG.md

Updated: Day 8 (two-tier review), Day 8.5 (AI document verification), Day 8.75 (hierarchy UI) and Day 8.8 (org
slugs/directory + launcher) move from "Already PLANNED" to "Already BUILT" — all four shipped working UI, not just
schema, in this diff. See diff to `build-audit/FEATURE_BACKLOG.md`.
