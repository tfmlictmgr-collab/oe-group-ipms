# Build Audit — 0729d (incremental) — Stage-7 wrap-up

**Date:** 2026-07-29 · **Range:** `343ac12..fcf11d1` (0729c fixes `0081`, operator governance `0079/b/c`, org retirement `0080`).
**Auditors:** `build-auditor` (security) + `/code-review` (correctness) — PC2.

> **Shared for PC1 to verify & action.** Fix directions are **suggestions for review, not applied changes**.
> **✅ Both prior HIGHs CLOSED (verified):** 0729c-S1 (`0081` scopes all four attachment columns under one predicate) and 0729c-S2 (`apply_invitation_node` dropped, folded into `accept_invitation`, tested for signed-in + anon). Operator governance (`0079/b/c`) holds to "open a door, never grant a privilege" — all four functions require `caller_is_operator_admin()`, no tenant-data path, break-glass time-boxed + dual-audited.
> **Open this round: 1 Medium + 2 Low.** None reopen the escalation boundary.

## New — Medium

**0729d-M1 — org retirement has the authorization backwards.** `0080` adds `orgs.deleted_at` but no authorization for it. The pre-existing `orgs_admin_update` RLS (`0013_org_theming.sql:15-17`) lets **any tenant org's own admin self-retire or un-retire their org** via a direct PostgREST PATCH — no operator involvement, and none of `0079`'s audit machinery (only a generic `org.updated` row). Conversely an **operator admin has no RLS-reachable path to retire a *different* org** (the policy requires `id = current_user_org_id()`); the feature only works via the service-role bypass in `scripts/verify-operator-governance.mjs`.
- Where: `supabase/migrations/0080_orgs_can_be_retired.sql:22-47`, `supabase/migrations/0013_org_theming.sql:15-17`.
- Fix direction: gate `deleted_at` writes to the operator (an `operator_retire_org(...)` SECURITY DEFINER like the other `0079` operator actions, audited), and exclude `deleted_at` from what `orgs_admin_update` may set.

## New — Low

**0729d-L1** — the new `vendor_id` scoping in `invitations_insert` is correct on inspection but has **no test** in the new "H" block of `scripts/verify-role-hierarchy.mjs`. Add a case so a regression can't slip in silently.

**0729d-L2 (/code-review)** — `scripts/register-telegram-bot.mjs:49` resolves the org by `delivery_brand` via `.maybeSingle()` with no `deleted_at` filter. `0080` makes orgs retirable and its own rationale flags `delivery_brand` as non-unique; the `verify-*` scripts were swept to add `.is("deleted_at", null)`, this one was missed. Add the same filter.

---

## Full audit report

# Incremental Audit — 0729d (operator governance, org retirement, notification_kind fix, invitation-scope closure)

**Date:** 2026-07-31 (findings logged as "0729d")
**Auditor:** build-auditor (read-only static review)
**Scope:** `git diff 343ac12..fcf11d1`, branch `phase-1`. Commits in range: `2d6c419` (0729c audit doc),
`bf9fd13` ("Give OE Group a door to open, never a privilege to grant" — `0079`/`0079b`/`0079c`), `fcf11d1`
("Scope every attachment an invitation carries" — `0081`).
**Method:** static read of `0079_operator_governance.sql`, `0079b_operator_governance_fixes.sql`,
`0079c_notification_kind.sql`, `0080_orgs_can_be_retired.sql`, `0081_invitation_scope_every_attachment.sql`,
`claude.md` diff, `docs/BUILD_JOURNAL.md` (new sections), `scripts/verify-operator-governance.mjs`, the diff to
`scripts/verify-role-hierarchy.mjs`, `app/dashboard/people/actions.ts`, `lib/auth.ts`, and a grep sweep of
`orgs`-table policies/grants across the whole migration history to check the retirement authorization boundary.
No code run, no DB writes, no offensive tooling, no verify-*.mjs scripts executed.

## Headline

The two 0729c HIGH findings are genuinely closed. `0081` scopes every attachment column (`property_ids`,
`unit_id`, `vendor_id`, alongside the already-fixed `node_id`) in `invitations_insert` via one shared
`current_user_may_attach_property()` predicate, is exercised by a new "H" block in
`scripts/verify-role-hierarchy.mjs` covering own-region/foreign-region/mixed-array/tenant-unit cases, and the app
path (`app/dashboard/people/actions.ts`) inserts the raw client input without any client-side scoping that could
diverge from the DB check — it relies entirely on RLS, which is now correct. `apply_invitation_node` is dropped
outright (not merely gated); its work moved inside `accept_invitation`, under the same token/transaction as the
property assignment; a new "I" block confirms the RPC no longer exists for a signed-in user or anon.

New work (`0079`/`0079b`/`0079c`, operator governance) matches its own stated design goal — "a door to open, never
a privilege to grant." Every operator-crossing function requires `caller_is_operator_admin()` (administrator of
an org where `is_platform_operator = true`), `provision_org` only ever creates an org plus an *invitation* (never
an account/session/password), `operator_suspend_user` only removes access, `operator_unsuspend_user` may only
reverse a suspension the operator itself applied (checked against `operator_actions`, not a blanket unsuspend),
and `operator_break_glass_admin` issues a 24-hour admin invitation, logged on both sides of the org boundary and
announced to the target org's remaining admins/executives. No function reads or writes tenant business data
(payments, tickets, applications, ledger). `0079b`/`0079c` are pure bugfixes to `0079` (wrong `audit_log` column
names, missing enum cast, invalid `notify_role` kind) — same authorization shape carried through unchanged, no
new exposure introduced by the fixes.

The one real new problem is in `0080_orgs_can_be_retired.sql`: it adds `orgs.deleted_at` and a consuming function
(`org_accepts_tenant_applications`), but never restricts *who* may set that column, and never adds a dedicated
authorized retire path. See finding 0729d-M1 below — this is the one place the diff does not match the audit
brief's "can only an authorised operator/admin retire an org?" question.

---

## Prior fixes verified

### 0729c-S1 — `invitations_insert` scoped `node_id` but not `property_ids`/`unit_id`/`vendor_id` — **CLOSED**

`supabase/migrations/0081_invitation_scope_every_attachment.sql:44-120` replaces `invitations_insert` with a
version that checks all four scope-bearing columns under one policy:

- `node_id` (lines 79-92): unchanged existing subtree check via `property_stakeholders`/`org_nodes.path like`.
- `property_ids` (lines 94-100): `not exists (... unnest(property_ids) ... where not current_user_may_attach_property(pid))` —
  an empty array passes, any single foreign property fails the whole INSERT.
- `unit_id` (lines 102-112): resolves the unit's `property_id` and runs it through the same
  `current_user_may_attach_property()` predicate.
- `vendor_id` (lines 114-119): checked against `current_user_scoped_vendor_ids()` (pre-existing helper from
  `0012_vendor_property_scoping.sql`).

`current_user_may_attach_property()` (lines 48-56) is a single shared definition (`admin` unbounded, everyone else
bounded to `current_user_property_ids()`, which already expands hierarchy nodes to their subtree per `0067`) —
used by all three attachment checks, so they cannot drift apart from each other the way `node_id` drifted from
the other three in `0078c`.

App path agrees: `app/dashboard/people/actions.ts:93-104` inserts `property_ids`, `unit_id`, `vendor_id` straight
from client input with no client-side re-scoping, so the DB policy is the sole enforcement point and there's no
possibility of the app silently "fixing" what the DB would otherwise reject (or vice versa).

Test coverage: `scripts/verify-role-hierarchy.mjs`, new block "H" (own-region property passes, foreign property
fails, mixed array with one bad element fails, tenant enrolment into a unit outside the region fails, admin stays
unbounded). `vendor_id` is not exercised by this new block, but the SQL fix for it is present and structurally
identical to the tested `unit_id`/`property_ids` checks — noted as a minor test-coverage gap, not treated as open.

**Verdict: CLOSED.**

### 0729c-S2 — `apply_invitation_node` SECURITY DEFINER, no caller/org/status check — **CLOSED**

`supabase/migrations/0081_invitation_scope_every_attachment.sql:126` drops the function outright
(`drop function if exists apply_invitation_node(uuid, uuid);`) rather than gating it. Its work (applying
`inv.node_id`) is folded into `accept_invitation` (lines 191-195), inside the same transaction, under the same
`token_hash`-verified, not-yet-expired, status-`pending` invitation row already required for the property/unit/
vendor attachments immediately above it (lines 150-156, 181-205). No new entry point to the same effect was
introduced elsewhere in this diff — grep for `apply_invitation_node` across `*.sql`/`*.ts`/`*.tsx`/`*.mjs` finds
only the drop, its own comment, and the verify script's negative test.

Test coverage: `scripts/verify-role-hierarchy.mjs`, new block "I" — confirms the RPC no longer exists for a
signed-in user, and separately for `anon`.

**Verdict: CLOSED.**

---

## New findings (0729d)

### 0729d-M1 — Org retirement has no authorization boundary; the wrong actor can do it, and the right actor mostly can't (Medium, CONFIRMED)

`supabase/migrations/0080_orgs_can_be_retired.sql` adds `orgs.deleted_at` (line 22) and updates
`org_accepts_tenant_applications()` to also require `deleted_at is null` (lines 38-47). It does **not**:

- add a dedicated `retire_org()`/`unretire_org()` RPC,
- restrict which columns the existing `orgs_admin_update` UPDATE policy covers, or
- add any `caller_is_operator_admin()` check anywhere near `deleted_at`.

The only pre-existing RLS policy governing UPDATE on `orgs` is `orgs_admin_update`
(`supabase/migrations/0013_org_theming.sql:15-17`):

```sql
create policy orgs_admin_update on orgs for update
  using (id = current_user_org_id() and current_user_role() = 'admin')
  with check (id = current_user_org_id() and current_user_role() = 'admin');
```

This has always granted an org's own administrator UPDATE on every column of their own `orgs` row (originally for
theming fields); there is no column-level `grant`/`revoke` narrowing it (confirmed by grep across all
migrations — no `grant update ... orgs` or `revoke ... orgs` statement exists anywhere in the schema). Since
`0080` added `deleted_at` to that same table without touching this policy, **any ordinary tenant-org admin can set
or clear their own org's `deleted_at` directly via PostgREST** (`supabase.from("orgs").update({ deleted_at:
new Date() }).eq("id", myOrgId)`), with no reason required, no operator involvement, and none of the
double-audit-log / `operator_actions` / `notify_role` machinery that every other operator crossing in `0079` gets.
The only record left behind is the pre-existing generic `audit_org_update` trigger's `org.updated` row
(`0013_org_theming.sql:20-23`, via `log_audit()`), indistinguishable from a routine theme-colour change unless
someone diffs `before_state`/`after_state`.

Concrete scenario: a facility admin at org X, angry or careless, runs the above PATCH against their own org.
`org_accepts_tenant_applications(X)` now returns `false` — tenant applications silently stop being accepted
org-wide — and they can flip it back the same way, with the only trace being an `org.updated` audit row that
looks like any other settings change. This directly contradicts the audit brief's premise that retirement is an
operator/admin-gated action; there is currently no gate at all beyond "you administer this org."

The converse gap is at least as real: **the intended actor — an OE Group operator admin — has no functional path
to retire *another* org through the app layer either.** `orgs_admin_update`'s `using`/`with check` both require
`id = current_user_org_id()`, so an operator-org admin (whose `current_user_org_id()` is the *operator's* org)
cannot update a *target* org's row under this policy at all. The only place `deleted_at` is actually set on a
target org in this diff is the one-off backfill UPDATE inside the migration itself (lines 30-34, run as migration
owner) and the manual `svc.from("orgs").update({deleted_at: ...})` in
`scripts/verify-operator-governance.mjs:63-64` and `verify-role-hierarchy.mjs` (both using the service-role key,
which bypasses RLS entirely). So as shipped, "org retirement" is reachable only via direct DB/service-role access
for its intended purpose, while being inadvertently reachable by the wrong, unintended actor (any tenant admin,
self-service) through the normal app-facing RLS path.

Impact is currently self-limited — a tenant admin can only touch their own org's row, and the only consuming
check (`org_accepts_tenant_applications`) just disables tenant-application intake, not data access, other orgs,
or existing users' sessions (`lib/auth.ts:20-26` and no `middleware.ts` reference to `orgs.deleted_at` — a
"retired" org's own members keep full normal access; retirement is not enforced anywhere except the one gate
added in this migration). That bounds the blast radius, which is why this is Medium rather than High: no
cross-org leak, no data destruction, reversible by the same actor who caused it. But it fails the specific
authorization property the audit brief asked to verify, and it means the feature as built cannot actually be
exercised by an operator admin against a target org without going around the RLS layer entirely.

Not exercised by `scripts/verify-operator-governance.mjs` (which only manipulates `deleted_at` via the
service-role client, `orgRes`/lines 45, 63-64, 71) — no test signs in as a brand admin and attempts to set
`deleted_at` on their own org, and none attempts to sign in as an operator admin and retire a *different* org
through RLS.

**Files:** `supabase/migrations/0080_orgs_can_be_retired.sql:22-47`;
`supabase/migrations/0013_org_theming.sql:15-17` (the policy this gap runs through);
`scripts/verify-operator-governance.mjs:45,63-64,71` (untested path).

### 0729d-L1 — `vendor_id` scoping in `invitations_insert` fix has no test coverage (Low, CONFIRMED as a test gap only)

Covered above under the 0729c-S1 verdict. The SQL check at
`supabase/migrations/0081_invitation_scope_every_attachment.sql:114-119` is structurally sound (same
`current_user_scoped_vendor_ids()` helper used pre-existingly elsewhere), but the new "H" test block in
`scripts/verify-role-hierarchy.mjs` covers `property_ids` and `unit_id` and does not construct a
foreign-vendor case. Not treated as open — the code is correct on inspection — flagged only so the gap is
recorded rather than silently assumed covered.

---

## Areas checked and clean

- **Every new `SECURITY DEFINER` function in the diff** (`caller_is_operator_admin`, `provision_org`,
  `operator_suspend_user`, `operator_unsuspend_user`, `operator_break_glass_admin`,
  `org_accepts_tenant_applications`, `current_user_may_attach_property`, `accept_invitation`) — each either has an
  explicit caller check appropriate to its purpose, or (for `current_user_may_attach_property` and
  `org_accepts_tenant_applications`) is a narrow, correctly-scoped boolean predicate meant to be called by
  `anon`/`authenticated` as part of a larger policy, matching its pre-existing 0062-era counterpart's grant shape.
- **The `v_caller is not null and not caller_is_operator_admin()` pattern** used by all four operator functions
  (allows the check to be skipped when `auth.uid()` is null) is not a new gap — it is the same, already-audited
  convention introduced by `set_role_permission` in `0050_permission_matrix.sql:230-231` ("The service role
  (auth.uid() is null) is allowed through for seeding"), carried forward consistently. `authenticated`-role JWTs
  issued by Supabase always carry a `sub` claim, so this bypass is reachable only via the `service_role` key,
  which already has unrestricted DB access independent of this check.
- **`0079c_notification_kind.sql`** does not alter any enum or check constraint — despite the filename, it only
  changes two `notify_role(...)` call sites from an invalid `'security'` kind literal to the already-valid
  `'system'` value (the third of three runtime faults `0079`'s own commit history records, all caught by the
  verify suite on first execution, none live in production). No existing rows, no widening, no risk.
- **Operator actions are visible to the org they were done to** — `operator_actions_select`
  (`0079_operator_governance.sql:69-73`) allows `target_org = current_user_org_id() OR caller_is_operator_admin()`,
  matching the stated "not silent" design goal.
- **Last-admin protection** (`block_removing_last_admin`, `0079_operator_governance.sql:84-115`) correctly blocks
  demoting/deactivating the sole remaining active admin of an org, trigger-enforced ahead of any RLS-level
  update — cannot be bypassed by a direct PostgREST PATCH.
- **`provision_org`** seeds new orgs from `seed_b7_permissions` (most-restrictive baseline) and correctly derives
  `lettings` module enablement from `delivery_brand = 'OEA'` via the registry rather than trusting caller input
  for anything beyond name/brand/admin email — no path for a caller to seed an over-privileged org.

## FEATURE_BACKLOG.md

No update needed — nothing built in this diff changes what's on the backlog (operator governance and org
retirement were not backlog items; `0080`'s `deleted_at` column was a fixture-cleanup fix, not a roadmap feature,
per its own migration header and `docs/BUILD_JOURNAL.md` lines 1760-1776).
