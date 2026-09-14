# Build Audit — 0729b (incremental) + correctness review

**Date:** 2026-07-29 · **Range:** `846867f..da0bbff` (Day-7 hardening, org hierarchy, oversight/regional roles, conversational triage, per-property windows).
**Auditors:** `build-auditor` (security/efficiency, read-only static) + `/code-review` (correctness) — PC2.

> **Shared for PC1 to verify & action.** Fix directions are **suggestions for review, not applied changes** — verify against the current tree first.
> **Prior fixes all verified CLOSED:** Day-7 Critical (submit path), E-1 (BI budget-utilisation), NDPA `sensitive` exposure, resume-link, `saveDraft` rate-limit. The team's own payment-gate regression (`0072b`→`0073`) was self-caught before this audit.
> **Two items worth PC1's attention first:** the **High** regional-manager over-grant (security) and the **resume-link** bug (correctness).

---

## Part B — Correctness review (`/code-review`, 846867f..HEAD)

| # | Sev | File:line | Finding | Fix direction |
|---|-----|-----------|---------|---------------|
| C1 | Med | `app/tenancy/[org]/page.tsx:95` | **Resume link dead when intake is closed** — the `!tenant_applications_open \|\| accepting.length === 0` gate runs *before* the `if (resume)` branch, so a valid 30-day resume link returns the "closed" card and strands an in-progress draft whenever the org (or all its properties) stops accepting. Contradicts the emailed 30-day promise. | Evaluate the `resume` branch **before** the intake-open gate — resuming an existing draft is not the same as starting a new one. |
| C2 | Med | `lib/inbound-router.ts:63` ↔ `lib/acknowledgement.ts:56` | **1–4→urgency map duplicated** across `QUICK_REPLIES` and the numbered acknowledgement lines; reorder/relabel one and a user tapping "1" for "low" gets "critical". Same class as the INVITABLE_ROLES bug already fixed. | Extract one shared `number → {urgency,label}` map used by both. |
| C3 | Low | `lib/supabase/admin.ts:31` | **Blanket `cache:"no-store"` overrides call-site opt-in** — `{ ...init, cache:"no-store" }` beats any `next.revalidate`, so the comment's "ask for caching at the call site" is impossible for the admin client. | Implement so the escape hatch works, or drop the misleading comment. |
| C4 | Low | `lib/handle-inbound.ts:53` | **`openThread` swallows DB errors as "no thread"** (and does not log, unlike its sibling) → a transient `conversation_context` error opens a duplicate ticket, undiagnosable. | Separate the error case from the empty case; log it. |
| C5 | Low | `app/api/webhooks/whatsapp/route.ts:132` (+ telegram) | **Greeting logs a ticket notification with null id** — a first-time "hi" (pleasantry, no thread) still calls `sendCascade({entityType:"ticket", entityId:null})`. Nullable column → no crash, but a mislabeled notification per greeting. | Skip the cascade (or use a non-ticket entity type) when there is no ticket. |

---

## Part A — Security / efficiency audit (`build-auditor`)

# Incremental Audit — 0729b (post Day-7 follow-ups: hierarchy, oversight roles, conversational triage)

**Date:** 2026-07-29 (findings logged as "0729b"; commits reviewed run through 2026-07-30 per repo clock)
**Auditor:** build-auditor (read-only static review)
**Scope:** `git diff 846867f..da0bbff` (Day-7 audit HEAD `846867f` → current HEAD `da0bbff`, branch `phase-1`).
**Method:** static read of every commit in range (`git show` on each), migrations `0066`–`0076`, `lib/roles.ts`,
`lib/handle-inbound.ts`, `lib/inbound-router.ts`, `lib/application-resume.ts`, `lib/supabase/admin.ts`,
`app/tenancy/[org]/*`, `app/dashboard/bi/page.tsx`, `app/dashboard/people/*`, `next.config.mjs`, and the new
`verify-*.mjs` suites (read only — none executed, per the read-only mandate; `docs/BUILD_JOURNAL.md` read instead
for narrative confirmation of what the team found/fixed themselves). No code run, no DB writes, no offensive
tooling.

## Headline

The team closed all five Day-7 findings for real, including a genuine self-caught regression along the way
(0072b's `enforce_payment_transition()` rewrite silently dropped the legal-transition state machine; `0073`
restored it in full before this audit started, and the journal documents `verify-payment-gate` catching it).
The Day-7 Critical (D7-D1, submission blocked) is fixed correctly and does not reopen a read-back hole — the
document check now lives inside `submit_tenant_application()` itself, keyed by resume-token hash, closing both
the read gap and the anon-bypass the fix uncovered along the way.

The new org-hierarchy / oversight-role work (`0066`–`0072b`) is careful and mostly correct — the "MD/Managing
Partner: oversight, not chequebook" design genuinely holds at the database layer (`executive` gains read access
and co-approval, and is structurally excluded from remittance, bank config, ledger posting and the approval
threshold, verified line-by-line against every migration that mentions the role). But the same pass introduced
one real scope leak: **`regional_manager` was granted `applications.review_all`**, an org-wide bypass capability,
when the node-hierarchy scoping already in place (`0067`) would have given it exactly the region-bounded access
the design intends without that grant. This lets a regional manager read and decide on tenant applications —
and rewrite document requirements — for every region in the org, not just their own. Two supporting views
(`property_application_windows`, `stakeholder_assignments`) also deviate from this codebase's own established
`security_invoker` pattern for RLS-sensitive views; one of those deviations is a second, independent, smaller
information leak.

The conversational-triage work (`0075`, `lib/handle-inbound.ts`, `lib/inbound-router.ts`) is well defended
against the injection risk its design brief implies: the LLM's output is parsed into a closed enum, every
action it can trigger is carried out by a `SECURITY DEFINER` RPC that re-verifies `channel_sender_ref` ownership
independently of what the model said, and per-IP/per-sender rate limits and per-channel org routing are
untouched by this diff. Nothing to flag there.

---

## SECURITY

### 0729b-S1 · `regional_manager` granted `applications.review_all`, bypassing region scoping — **High — CONFIRMED**

**Where:** `supabase/migrations/0072b_role_governance.sql:48-55` (the `regional_manager` branch of
`seed_b7_permissions`) combined with `supabase/migrations/0062_tenant_applications.sql:183-202` and `:220-237`
(`tenant_applications_staff_select`/`_update`, `application_overview`) and
`supabase/migrations/0070_day7_hardening.sql:52-57` (`adr_admin_write` on `application_document_requirements`).

**What:** `0072b`'s seed function grants `regional_manager` the capability `applications.review_all`:

```sql
when r = 'regional_manager' then cap.key in (
  'tickets.assign', 'tickets.close', 'tickets.triage_unassigned',
  'assets.write', 'assets.import',
  'vendors.read', 'vendors.write', 'vendors.evaluate',
  'properties.write', 'units.assign_occupant',
  'people.invite', 'bi.read',
  'applications.review_all'                                   -- line 54
)
```

Every policy that gates tenant-application access reads that capability as an **OR**, not an AND, against
property scoping:

```sql
-- 0062:183-192
create policy tenant_applications_staff_select on tenant_applications
  for select to authenticated
  using (
    org_id = current_user_org_id()
    and purged_at is null
    and (
      (select has_permission('applications.review_all'))
      or property_id in (select current_user_property_ids())
    )
  );
```

The identical `OR` shape governs `tenant_applications_staff_update` (0062:194-202) and `application_overview`
(0062:220-237). Holding `applications.review_all` is therefore sufficient **on its own** to read and update
every tenant application in the org, regardless of `property_id` — it does not need the property-scoping branch
at all.

**Why this is a genuine leak, not the intended design:** `current_user_property_ids()` was extended in `0067`
specifically so that a node-assigned manager's scope expands to every property beneath their region/project/site
automatically (`0067_scoped_stakeholders.sql:49-75`). That means the *second* branch of the `OR` —
`property_id in (select current_user_property_ids())` — **already** gives a `regional_manager` exactly the
region-bounded access the design calls for, with no extra grant needed. Adding `applications.review_all` on top
does not widen their *intended* region — it removes the boundary entirely, because the policy is an `OR`.

This directly contradicts the design intent stated in `0072b`'s own file header: *"`regional_manager` —
decentralised FM/PM administration. ... Bounded to their subtree by the node assignment (0067) and, for writes,
by 0073"* (`0072b_role_governance.sql:17-19`), and in `lib/roles.ts`'s own hint text: *"Runs a region. ... all of
it bounded to the region, project or site they are assigned to."* (`lib/roles.ts:69-70`). Tenant-application
review is not mentioned as an exception anywhere in either document.

**Scenario (CONFIRMED against code, not run):** An org has `regional_manager` accounts assigned to "North",
"South" and "East" (`property_stakeholders.node_id`, per `0067`). The North regional manager, using their own
session (their own JWT, `role = 'regional_manager'`), issues `GET /rest/v1/tenant_applications?select=*` or
queries `application_overview` through the Supabase client exactly as a legitimate reviewer would. Because
`has_permission('applications.review_all')` is true for their role, the `OR` short-circuits and every South and
East application — applicant name, email, phone, form contents — is returned, not just North's. The same account
can also `PATCH` a South applicant's `decided_by`/`decided_at`/`decision_notes`/`status` (via
`tenant_applications_staff_update`), and can write to `application_document_requirements` for the whole org
(`0070_day7_hardening.sql:52-57` uses the same capability with no region scoping at all, since that table has no
`property_id`/`node_id` column to scope by), silently changing which documents are mandatory for every applicant
org-wide.

**Not caught by the team's own suites:** `scripts/verify-oversight-roles.mjs` and `scripts/verify-hierarchy.mjs`
were grepped for `applications`/`tenant_applications`/`application_overview` — zero matches in either. Neither
verification script exercises a `regional_manager` account against the tenant-applications surface at all.

**Why High, not Critical:** the leak is bounded to a single org (no cross-org or cross-brand crossing — `org_id
= current_user_org_id()` still holds in every clause), and there is no Day-8 UI yet that would surface this to a
casual user — it requires deliberately querying the table/view/RPC directly rather than clicking through the
product. It is High rather than Medium because it is a structural capability grant (not a hand-crafted edge
case), reaches the heaviest-PII table in the system per the Day-7 audit's own description, includes a write/
decision capability, and would trigger the instant a Day-8 review UI is built on top of these existing policies
— at which point it becomes trivially reachable through the product.

**Fix direction (not applied — review only):** remove `applications.review_all` from the `regional_manager`
branch of `seed_b7_permissions` (0072b:54). The `property_id in (select current_user_property_ids())` branch
already resolves correctly for a region-assigned manager via `0067`'s node expansion — no additional capability
is needed to reach the intended scope.

---

### 0729b-S2 · `property_application_windows` exposes portfolio-wide vacancy data to every authenticated role — **Medium — CONFIRMED**

**Where:** `supabase/migrations/0076_per_property_application_window.sql:153-175`.

**What:** Every other RLS-sensitive view introduced in this codebase declares `with (security_invoker = on)` —
`bi_budget_utilisation` (0074), `property_summary` (0058/0059), all four `bi_*` views (0061) — each with a
comment explaining that without it, the view would run with the *owner's* privileges rather than the caller's,
defeating RLS on the underlying tables. `property_application_windows` is the one exception:

```sql
create or replace view property_application_windows as
  select p.id as property_id, p.org_id, p.name, p.applications_state, p.applications_state_note,
         p.applications_state_set_at, property_accepts_applications(p.id) as accepting_now,
         (select count(*) from units u where u.property_id = p.id and u.deleted_at is null) as unit_count,
         (select count(*) from units u where u.property_id = p.id and u.deleted_at is null
            and u.occupant_user_id is null) as vacant_count
  from properties p
 where p.org_id = current_user_org_id()
   and p.deleted_at is null;
...
grant select on property_application_windows to authenticated;
```

No `security_invoker`, and the `WHERE` clause scopes only by `org_id` — there is no `property_id in (select
current_user_property_ids())` and no capability check, unlike the base `properties` table itself
(`properties_select`, `0056_property_register.sql:135-142`, requires `properties.read_all` or property
assignment) and unlike the equivalent `property_summary` view, which is explicitly `security_invoker` "so the
caller's RLS on properties/units/assets still decides what is included" (0058:9-13).

**Scenario (CONFIRMED against code, not run):** Any authenticated user in the org — including a `tenant` or
`vendor` role, who under `properties_select` cannot read a single row of the base `properties` table beyond
their own attachment — can query `property_application_windows` directly and receive `unit_count`/
`vacant_count`/`applications_state` for **every property in the org**, not just ones they are attached to. This
is portfolio-wide occupancy data, not merely the small "which properties are currently open" list the public
tenancy page already shows strangers (that page uses `properties_accepting_applications`, a narrower,
purpose-built `SECURITY DEFINER` function returning only `id, name, address` for open properties — a much
smaller surface than this view).

**Why not caught:** grepped `scripts/verify-property-windows.mjs` for `property_application_windows` — the
script never queries this view as an authenticated non-admin role; it only exercises the underlying RPCs
(`property_accepts_applications`, `set_property_application_state`) with service-role and anon clients.

**Fix direction:** add `with (security_invoker = on)` and scope the `WHERE` clause the same way
`property_summary` does — `property_id in (select current_user_property_ids()) or
has_permission('properties.read_all')` — or restrict the `GRANT` to the roles that actually need this view
(admin, executive, facility_manager, regional_manager).

---

### 0729b-S3 · `stakeholder_assignments` also lacks `security_invoker`; not currently exploitable, but the comment claiming it is safe is wrong — **Low — CONFIRMED (misleading, not presently dangerous)**

**Where:** `supabase/migrations/0067_scoped_stakeholders.sql:103-129`.

**What:** Same missing-`security_invoker` gap as 0729b-S2, on the view listing who is assigned where. Its own
comment claims: *"Definer-free: it reads through the caller's own policies, so it cannot show more than they may
already see."* (0067:125-126). That is not accurate — without `security_invoker`, the view runs with the
**owner's** privileges against `property_stakeholders`, `users`, `org_nodes` and `properties`, the same
definer-like behaviour 0729b-S2 exploits.

**Why this one is not currently exploitable:** the view's own explicit `WHERE` clause independently reproduces
the correct row-scoping (`s.org_id = current_user_org_id() and (s.user_id = auth.uid() or
has_permission('properties.read_all') or has_permission('hierarchy.write'))`), and `auth.uid()`,
`current_user_org_id()` and `has_permission()` are themselves `SECURITY DEFINER` functions that read the actual
calling session regardless of which role is evaluating the view — they do not fall back to the view owner's
identity. Every join in the view (`users`, `properties`, `org_nodes`) is a 1:1 lookup keyed off a
`property_stakeholders` row that already passed that filter, so no additional rows can surface through the
joins. Read carefully, line by line, this view is safe today.

**Why it is still worth flagging:** it is the identical failure shape — a comment asserting a security property
the code does not actually implement — that produced the 0068/0069 cascade bug this same diff had to fix twice
(*"A column-scoped trigger tests the statement's shape, not the data's"*, and then *"a WHEN clause runs in a
different context from the function body it gates"*). A future edit that trusts this comment and loosens the
`WHERE` clause on the assumption that RLS is still enforcing the boundary (because "it reads through the
caller's own policies") would silently reopen cross-user exposure of `property_stakeholders`/`users`/
`org_nodes`/`properties` data, with nothing in the migration to catch it.

**Fix direction:** add `with (security_invoker = on)` to make the comment true (harmless given the `WHERE`
clause is already correct), or rewrite the comment to describe the actual mechanism (explicit `WHERE`-clause
scoping, not RLS delegation).

### Security — checked and clean (new code only)
- **`executive` role — "oversight, not chequebook" holds structurally.** Grepped every occurrence of
  `'executive'` across all new migrations (`0071`–`0076`): it appears only in read-role arrays
  (`oversight_roles()`/`oversight_roles_with_fm()`, 0072a), the payment-approval branch of
  `enforce_payment_transition()` (approve, including above-threshold — 0072b/0073), the matching
  `payments_update` RLS policy, and `set_property_application_state`'s admin/executive check (0076). It is
  **never** granted `sc.manage`, never appears in any `bank_accounts`/`ledger_accounts`/`ledger_entries`/
  `ledger_postings`/`reconciliations`/`payment_settings` write policy, and is explicitly excluded from the
  `remitted` transition in both `0072b` and its `0073` restore ("`executive` is absent BY DECISION"). The
  `seed_b7_permissions` capability list for `executive` (0072b:39-42) is read-only capabilities exclusively.
- **`0073` restoring the B4 gate did not weaken it.** Compared `0073_restore_payment_state_machine.sql`
  line-by-line against `0072b`'s (broken) version and the original: the legal-transition state machine, the
  service-role exemption, the no-status-change short circuit, the verification/performance gate, the
  amount-threshold check (0060's contribution), and the `executive`-can-approve/`executive`-cannot-remit split
  are all present together in the final version. This is a self-caught-and-fixed regression, documented in
  `docs/BUILD_JOURNAL.md` ("I broke the payment gate while adding `executive` to it") — the fix is genuine, not
  paperwork.
- **`org_nodes` path cascade (0066→0068→0069) is now correct.** The first version's trigger never fired
  (`UPDATE OF path` fires on columns named in the statement, not columns that changed — re-parenting names
  `parent_id`, not `path`). `0068`'s fix added a `WHEN (pg_trigger_depth() = 1)` guard that is also always
  false for an AFTER trigger (`WHEN` for an AFTER trigger evaluates before any trigger body has run, so depth is
  always 0 at that point). `0069` moves the recursion guard into the function body
  (`if pg_trigger_depth() > 1 then return null`) and narrows the `WHEN` clause to a value comparison
  (`new.path is distinct from old.path`) — this is the correct fix and both migrations include a repair `DO`
  block that walks the tree fixing any row corrupted while the cascade was inert.
- **Cross-org structural enforcement.** `org_nodes_parent_same_org_fk`, `properties_site_same_org_fk`,
  `property_stakeholders_node_same_org_fk` are all composite FKs `(child_id, org_id) → (parent_id, org_id)`,
  matching the pattern the baseline/Day-7 audits already validated for `units`/`assets`/`properties` — a
  cross-org parent/site/node assignment is structurally impossible, not merely policy-refused.
- **Conversational triage (`0075`, `lib/handle-inbound.ts`, `lib/inbound-router.ts`).**
  - *Injection:* the LLM's entire output surface is a JSON object parsed into a closed enum (`parse()` in
    `inbound-router.ts:98-119` rejects anything outside `["new_request","follow_up","correct_priority",
    "ask_status","pleasantry"]` and outside `["critical","high","normal","low"]`); nothing from the model is
    interpolated into SQL, HTML, or a shell command. Worst case from a crafted message is an intent
    misclassification, not privilege escalation.
  - *State/session integrity:* every action the router can trigger (`set_ticket_urgency_by_reporter`,
    `append_reporter_message`, `remember_conversation`) is a `SECURITY DEFINER` function granted to
    `service_role` only, and independently re-checks `channel_sender_ref = p_sender_ref` against the ticket
    before acting (`0075_conversational_triage.sql:107-128`, `:173-192`) — the LLM's classification decides
    *which* function is called, never *whether* the caller owns the ticket. A reporter cannot re-prioritise or
    append to someone else's ticket even if the model is confused.
  - *Per-channel org routing:* `resolveOrgForChannel` is unchanged by this diff; `route.orgId` is threaded
    unchanged through `handleInboundMessage` → `conversation_context`/`remember_conversation`, both of which are
    keyed by `(org_id, channel, sender_ref)` — a phone number messaging two different brands' WhatsApp Business
    numbers cannot cross state between them.
  - *Rate limiting:* both webhooks retain their unmodified per-IP (`coarsePerIp`) and per-sender (`perSender`)
    `checkRateLimit` calls ahead of `handleInboundMessage` — confirmed by diff, these lines are untouched.
  - *Unbounded growth:* `chat_conversations` is one upserted row per `(org, channel, sender)` with an
    `expires_at`, not a log — bounded by definition. `ticket_messages` grows per follow-up, which is the
    intended behaviour of a conversation thread (same shape as any messaging feature); no pagination-less read
    of it was introduced in this diff.
- **`0073`/`0076` did not reopen S-1/S-2/D-1 from the baseline** — no new direct table write bypassing the
  composite FKs or the matrix was found in the touched files.

---

## EFFICIENCY

Nothing new to flag. `bi_budget_utilisation` (0074) replaces the last unbounded JS aggregation with scalar
subqueries per budget (see Prior fixes verified, below); `properties_under_node`/`node_full_name` (0066) do one
indexed prefix-match query rather than a recursive CTE per call, which matters at B5's 100+-property scale; the
`org_nodes` path index uses `text_pattern_ops`, the correct operator class for `LIKE 'prefix%'`.

---

## DISCONNECTS

Nothing rising to a findable defect. Two small observations, not flagged as findings:
- `application_document_status()` (0070) — token-scoped, correctly avoids enumeration — is exercised by
  `scripts/verify-application-submission.mjs` but is not called from any app code yet (`ApplicationForm.tsx`
  still relies on the client-side upload confirmations rather than this function). Not a defect; the
  server-side gate that actually matters (`submit_tenant_application`'s internal check) does not depend on it.
- `0073`'s self-correction of `0072b`'s partial rewrite is already fully documented in `docs/BUILD_JOURNAL.md`
  and is the kind of self-caught regression the Day-7 audit noted the team does well; not re-flagged as a new
  finding since it was fixed within this same diff before the audit began.

---

## Prior fixes verified

| ID | Title | Verdict | Evidence |
|----|-------|---------|----------|
| **D7-D1** | (Day-7 **Critical**) `submitApplication()`'s document check read `application_attachments` through the applicant's anon session and always saw zero rows — submission appeared permanently blocked | **CLOSED** | `151693d` moves the check inside `submit_tenant_application()` (`0070_day7_hardening.sql:96-152`), which runs `SECURITY DEFINER` and reads `application_attachments` with owner rights — no RLS gap to fall into. The required-document list is now per-org/per-type configuration (`application_document_requirements`) rather than duplicated in SQL. Verified the fix does **not** reopen a read-back hole: the companion read function `application_document_status(p_token_hash)` (0070:76-91) is scoped by the resume-token **hash**, not by `application_id`, so it cannot be used to enumerate or read another applicant's status — matching the anti-enumeration shape `0063` already established for `resume_application()`. `submit_tenant_application` remains granted to `anon` (needed for the flow to work at all), but the document-completeness check is now enforced *inside* that same function, so nothing can post past it — closing the second defect the fix-commit found along the way (the check previously living in the server action could be skipped by calling the RPC directly). |
| **D7-S1** | `tenant_applications.sensitive` (NDPA special-category data) readable via the base table, not just `application_overview` | **CLOSED** | Same commit (`151693d`, `0070_day7_hardening.sql`, final block): `revoke select on tenant_applications from authenticated` followed by an explicit column-list `grant select (...) ... to authenticated` that **omits** both `sensitive` and (a second defect the fix-commit found while investigating) `resume_token_hash` — reading the hash would have been equivalent to holding the applicant's resume link. `application_overview` is unaffected (it's a plain view reading with its owner's rights, per Postgres semantics, and does not select `sensitive`). |
| **E-1** | (fully — supersedes Day-7's "PARTIAL") BI "Budget utilisation" panel summed every `service_charges` row with a `budget_id` in JavaScript, unbounded, under a comment incorrectly claiming it was bounded by budget count | **CLOSED** | `598eab5` + `0074_bi_budget_utilisation.sql`: replaced with `bi_budget_utilisation`, a `security_invoker` view using one scalar subquery per budget (`invoiced`, `collected`), the same fan-out-safe pattern `0061` used for the other three BI aggregates. `app/dashboard/bi/page.tsx:95-99,143-149` now selects from the view instead of aggregating in JS. No unbounded row-count query remains on this page. |
| **NDPA** (base-table exposure) | Same item as D7-S1 above — the audit brief lists it separately; verdict is identical | **CLOSED** | See D7-S1 row. |
| **D7-D2** | Promised emailed/cross-device resume link did not exist — no email sent, no route to consume `?token=` | **CLOSED** | `151693d`'s `actions.ts` wires a real `sendEmail()` call in `startApplication` (fire-and-forget, does not fail the request on mail-provider outage) using `lib/application-resume.ts`'s `resumeUrl()`/`hashToken()`; `598eab5`'s `app/tenancy/[org]/page.tsx:90-135` adds the `resume=` query-param branch, calling `resume_application()` under the service role and **re-checking `draft.org_id !== org`** so a token cannot be replayed against a different organisation's page. `next.config.mjs` adds `Referrer-Policy: no-referrer` and `Cache-Control: no-store` on `/tenancy/*` (the token travels in a query string, same exposure shape as a password-reset link). |
| **D7-S2** | `saveDraft` had no rate limit, unlike its siblings | **CLOSED** | `151693d`'s `actions.ts:90-95` adds `checkRateLimit("apply-save", resumeToken, 60, "10 m")` ahead of the RPC call, matching the pattern already used by `startApplication`/`createUploadTarget`. |

No re-flagged Day-7 or baseline item was found broken by this pass's changes, beyond the already-self-corrected
`0072b`→`0073` payment-gate regression (see Security — checked and clean, above), which was fixed before this
audit began.

---

## Severity summary (new findings, this audit)

| Sev | ID | Title | Status |
|-----|----|-------|--------|
| High | 0729b-S1 | `regional_manager` granted `applications.review_all` — reads/decides tenant applications and rewrites document requirements org-wide, not region-bounded | CONFIRMED |
| Medium | 0729b-S2 | `property_application_windows` view exposes portfolio-wide vacancy/occupancy data to every authenticated role (tenant, vendor included) | CONFIRMED |
| Low | 0729b-S3 | `stakeholder_assignments` view's "definer-free" comment is inaccurate (missing `security_invoker`); not currently exploitable because its explicit `WHERE` clause substitutes correctly, but fragile against a future edit | CONFIRMED (misleading, not presently dangerous) |

No Critical findings this pass — the one Critical carried in from Day 7 (D7-D1) is genuinely closed.
