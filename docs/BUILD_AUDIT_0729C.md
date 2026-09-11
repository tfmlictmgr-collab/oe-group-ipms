# Build Audit — 0729c (incremental)

**Date:** 2026-07-29 · **Range:** `da0bbff..343ac12` (0729b fixes `0077`, regional-manager management `0078a–d`).
**Auditors:** `build-auditor` (security, read-only static) + `/code-review` (correctness) — PC2.

> **Shared for PC1 to verify & action.** Fix directions are **suggestions for review, not applied changes** — verify against the current tree first.
> **⚠️ TWO HIGH escalation paths** were introduced by the invitation-hierarchy migrations (`0078c/d`) — the work that was meant to *close* the 0729b regional-manager over-grant partly re-opened the privilege boundary. **Action these first.**
> **All prior findings verified CLOSED:** 0729b High/Med/Low (regional_manager `applications.review_all`, two views missing `security_invoker`) and the five `/code-review` items C1–C5 (resume ordering, duplicated quick-reply map, admin no-store comment, `openThread` error-swallow, null-id greeting). Not reopened by `343ac12`.

## New — High (both CONFIRMED)

**0729c-S1 — invite attaches to any property/unit/vendor org-wide.** `invitations_insert` scopes `node_id` to the inviter's own subtree but does **not** scope `property_ids` / `unit_id` / `vendor_id` on the same INSERT. An FM or regional_manager holding `people.invite` can therefore invite someone attached to **any** property, unit or vendor in the org — reaching the same `property_stakeholders` outcome that manual assignment gates behind admin-only `hierarchy.write`.
- Where: `supabase/migrations/0078c_invitation_hierarchy.sql:64-99`, `0078d_admins_may_appoint_peers.sql:33-65`, `0020_onboarding_invitations.sql:146-163`, `app/dashboard/people/actions.ts:93-104`.
- Fix direction: scope `property_ids`/`unit_id`/`vendor_id` to the inviter's subtree in `invitations_insert` exactly as `node_id` is, or route attachment through the admin-only `hierarchy.write` path.

**0729c-S2 — `apply_invitation_node` is an unauthenticated escalation primitive.** `SECURITY DEFINER`, granted to `authenticated`, with **no** `auth.uid()` / org / invitation-status check; it bypasses the admin-only hierarchy gate. Currently **dead code** (never called — the "invite with a region" feature does not work end-to-end), but it is a live escalation the moment any invitation carries a `node_id`, and invitation ids are already rendered into the DOM (`PendingList.tsx`).
- Where: `supabase/migrations/0078c_invitation_hierarchy.sql:101-123`.
- Fix direction: add caller authorisation (org + admin/`hierarchy.write` + invitation ownership/status) or drop the function until it is wired and gated.

---

## Full audit report

# Incremental Audit — 0729c (regional-manager operationalisation: supersedes-FM, functions, invitation hierarchy)

**Date:** 2026-07-29 (findings logged as "0729c"; commits reviewed run through the repo's 2026-07-30/31 clock)
**Auditor:** build-auditor (read-only static review)
**Scope:** `git diff da0bbff..343ac12` (audit-0729b-fixes HEAD `da0bbff` → current HEAD `343ac12`, branch `phase-1`).
**Method:** static read of both commits in range (`git show` on `1849334`, `343ac12`), migrations `0077`–`0078d`,
`lib/roles.ts`, `app/dashboard/people/actions.ts`, `app/dashboard/people/InviteDialog.tsx`,
`app/dashboard/people/invitations/page.tsx`, `app/dashboard/people/PendingList.tsx`, the changed webhook/cascade/
acknowledgement/handle-inbound/admin.ts files, `docs/BUILD_JOURNAL.md`, and the new `scripts/verify-audit-0729b.mjs`
/ `scripts/verify-role-hierarchy.mjs` / `scripts/generate-fm-role-*.mjs` (read only — none executed, per the
read-only mandate). No code run, no DB writes, no offensive tooling.

## Headline

`1849334` genuinely closes all three 0729b security findings and all five C1–C5 correctness items — verified
line-by-line below, not taken on the commit message's word. `343ac12`'s regional-manager work
(`0078a`/`0078b`, "supersedes FM") is a faithful, spot-checked-correct mechanical extension of facility_manager's
existing permission shape onto regional_manager — every policy that matters is still scoped by
`current_user_property_ids()` (which already expands a node to its subtree), and the handful of predicates that
carry no property scoping (`vendor_applications_staff_select/update`, `vendor_properties_write`,
`payments_insert`) are pre-existing facility_manager behaviour, byte-identical to before 0078a, not a new leak.

The invitation-hierarchy work (`0078c`/`0078d`) is where this pass finds real problems. The rank-based escalation
guard and the peer-admin exception are both correct — verified against every branch. But the migration fixes
**one** scoping hole (`node_id`, added in this same file) while leaving **two** others of identical shape wide
open in the same policy and the same accompanying function:

- `invitations_insert` validates that a `node_id` handed to an invitee is inside the inviter's own subtree, but
  never validates `property_ids` (or `unit_id`, or `vendor_id`) the same way — so a facility_manager or
  regional_manager can invite someone into **any property in the org**, not just their own, through the exact
  same INSERT the node_id fix was written to close (0729c-S1, High).
- `apply_invitation_node`, the function meant to apply the node on acceptance, has **no caller-authorisation
  check at all** — not `auth.uid()`, not org membership, not invitation status/expiry — and is granted to
  `authenticated`. It is also never called from `accept_invitation` or any app code, so the region-on-invite
  feature this migration exists to deliver does not currently work (0729c-S2, High).

Both are inside the two files the task named (`0078c_invitation_hierarchy.sql`), not pre-existing debt.

---

## Prior fixes verified (0729b High/Med/Low + C1–C5)

| ID | Verdict | Evidence |
|----|---------|----------|
| **0729b-S1** (High — `regional_manager` held `applications.review_all`) | **CLOSED** | `0077_audit_0729b_fixes.sql:28-88` rewrites `seed_b7_permissions`; the `regional_manager` capability list (lines 53-59) no longer includes `applications.review_all`. Lines 90-96 additionally `UPDATE role_permissions SET granted = false ... WHERE role='regional_manager' AND capability='applications.review_all'` — closing the real gap the original finding called out, that the seed function only inserts and would otherwise leave any already-granted row standing. Verified `tenant_applications_staff_select/_update` and `application_overview` (0062, unchanged by this diff) now resolve a `regional_manager` purely through `property_id in (select current_user_property_ids())`, which correctly expands to their node subtree via 0067 — genuinely region-bounded, not just the seed edited. As a second, deliberate change, `executive` is granted the capability instead (lines 98-105), consistent with its designed org-wide oversight role and unrelated to the fix. |
| **0729b-S2** (Medium — `property_application_windows` no `security_invoker`) | **CLOSED** | `0077:117-137` recreates the view `with (security_invoker = on)`. The `WHERE` clause is unchanged (`org_id = current_user_org_id() and deleted_at is null`), but with `security_invoker` on, the view now runs under the caller's own RLS on `properties`/`units`, so a tenant/vendor querying it only sees rows their own `properties_select` policy would already return — the base-table RLS is what actually narrows it now, matching the pattern used everywhere else in the codebase. |
| **0729b-S3** (Low — `stakeholder_assignments` inaccurate comment) | **CLOSED** | `0077:148-172` recreates the view `with (security_invoker = on)` and replaces the comment with one that states the actual mechanism (explicit `WHERE`-clause narrowing, not RLS delegation) rather than asserting a protection that wasn't implemented. The `WHERE` clause itself is unchanged (it was already correct). |
| **C1** (Med — resume-link dead when intake closes) | **CLOSED** | `app/tenancy/[org]/page.tsx`: the `!tenant_applications_open \|\| ... \|\| accepting.length === 0` closed-intake gate is moved to *after* the `resume=` branch (diff moves lines 73-87 down past the resume-handling block). A valid resume token is now processed before the closed-intake short-circuit can fire. |
| **C2** (Med — 1-4→urgency map duplicated) | **CLOSED** | `lib/acknowledgement.ts` now exports `QUICK_REPLY_OPTIONS` as the single source; `lib/inbound-router.ts`'s `QUICK_REPLIES` is derived from it via `Object.fromEntries(QUICK_REPLY_OPTIONS.map(...))` instead of a separately hand-maintained literal. One list, two consumers. |
| **C3** (Low — admin.ts blanket no-store contradicts its own comment) | **CLOSED** | `lib/supabase/admin.ts`'s comment is rewritten to state the absolute-override behaviour is deliberate ("There is no per-call escape hatch, and that is the intended behaviour... a caller who genuinely wants a cached read should build their own client for it"). The code is unchanged; the comment no longer claims something the code doesn't do. Resolved via the fix direction's second option ("or drop the misleading comment") rather than adding a real escape hatch — a legitimate resolution since the original finding was about the comment/code mismatch, not the behaviour itself. |
| **C4** (Low — `openThread` swallows DB errors as "no thread") | **CLOSED** | `lib/handle-inbound.ts:48-56` now splits `if (error)` (logs via `console.error` and returns null) from `if (!data)` (returns null silently) — the error case is distinguishable in logs from the legitimate empty case. |
| **C5** (Low — greeting cascades with null ticket id) | **CLOSED** | `lib/cascade.ts`'s `CascadeTarget.entityType` gains a `"conversation"` variant; both webhook routes (`app/api/webhooks/whatsapp/route.ts`, `app/api/webhooks/telegram/route.ts`) now pass `entityType: outcome.ticketId ? "ticket" : "conversation"` instead of always `"ticket"` with a null id. |

No prior CLOSED item was reopened by this diff.

---

## SECURITY

### 0729c-S1 · `invitations_insert` scopes `node_id` to the inviter's reach but not `property_ids`/`unit_id`/`vendor_id` — regional manager (or FM) can invite someone into any property in the org — **High — CONFIRMED**

**Where:** `supabase/migrations/0078c_invitation_hierarchy.sql:64-99` (superseded by the identical gap in
`0078d_admins_may_appoint_peers.sql:33-65`, the currently-live version of `invitations_insert`) combined with
`supabase/migrations/0020_onboarding_invitations.sql:146-163` (`accept_invitation`'s attaché/unit/vendor
application) and `app/dashboard/people/actions.ts:93-104` (`inviteMember`, which forwards `input.propertyIds`
from the request body straight into the insert with no server-side check against the caller's own scope).

**What:** `0078c`'s own header explains exactly why `node_id` needed scoping: *"A node handed out must be one the
inviter can actually reach. Without this, a regional manager for the North could invite someone into the South —
the invitation being the thing that grants the scope."* (0078c:83-85). The migration then adds precisely that
check for `node_id` (0078c:86-98, carried unchanged into 0078d:52-64):

```sql
and (
  node_id is null
  or current_user_role() = 'admin'
  or exists (
    select 1
      from property_stakeholders s
      join org_nodes mine on mine.id = s.node_id and mine.org_id = s.org_id
      join org_nodes target on target.id = invitations.node_id and target.org_id = s.org_id
     where s.user_id = auth.uid()
       and s.node_id is not null
       and target.path like mine.path || '%'
  )
)
```

But `invitations.property_ids` (the pre-existing "attaché assignment" column, `0020_onboarding_invitations.sql:33`)
carries **no equivalent check**, anywhere in `invitations_insert` — old, `0078c`'s, or `0078d`'s version. Neither
does `unit_id` (tenant enrolment) or `vendor_id` (vendor login link). The policy's only conditions are `org_id`,
`invited_by = auth.uid()`, the `admin`/`fm_roles()` role gate, the rank comparison, and the node check quoted
above — `property_ids` is never mentioned.

On acceptance, `accept_invitation` (`0020:146-163`, unchanged by this diff) applies whatever `property_ids` the
invitation carries, unconditionally:

```sql
foreach p in array inv.property_ids loop
  insert into property_stakeholders (org_id, property_id, user_id, relation)
  values (inv.org_id, p, v_uid, inv.property_relation)
  on conflict (property_id, user_id, relation) do nothing;
end loop;
```

**Why this defeats the entire point of the day's work:** the only other route to a `property_stakeholders` row —
manually assigning an existing user — is gated by `hierarchy.write`, which `seed_b7_permissions`/`0066` grants to
`admin` only (`0066_org_hierarchy.sql:203`, `select o.id, r.role, 'hierarchy.write', r.role = 'admin'`;
`property_stakeholders_write`, `0067:97-100`, requires it). The invitation path — gated only by `people.invite`
(held by `facility_manager`/`regional_manager`) plus the rank check — reaches the **identical outcome**
(a `property_stakeholders` row granting `manager` or `owner` relation on an arbitrary property) without ever
holding `hierarchy.write`. `node_id` got a bespoke scope check specifically because it grants the same kind of
row; `property_ids` grants the same row through the same function and was not given one.

**Scenario (CONFIRMED against code, not run):** A `regional_manager` for "North" (rank 60, `property_ids`
resolved to North's subtree via `current_user_property_ids()`) calls `inviteMember` (or the underlying
`supabase.from('invitations').insert(...)` directly — the UI's property picker in `InviteDialog.tsx` sources its
list from `writableProperties()`, which is itself scoped by the caller's own session, so the *dropdown* would
not offer a South property; the server action and the RLS policy behind it place no such limit on the raw
input) with `role: 'facility_manager'` (rank 50 < 60, passes the rank check) and
`propertyIds: ['<a property_id belonging to "South">']`. The insert succeeds — `org_id`, `invited_by`, role rank
and the (irrelevant, since `node_id` is null) node check all pass. The invitee accepts; `accept_invitation` grants
them `facility_manager` with a `manager` relation on the South property, which (via `fm_roles()` + the newly
extended `current_user_property_ids()`) gives them read/write on that property's assets, tickets, vendor links and
occupant assignment — a manager the North regional manager was never authorised to place there, planted without
ever touching `hierarchy.write`. The same gap lets a plain `facility_manager` do the same to an `fm_ops_staff` or
`property_owner` invitee, and lets either role attach a `tenant`/`vendor` invitee's `unit_id`/`vendor_id` to a
unit or vendor outside their own properties the same way (`accept_invitation:154-163`, org-scoped only).

**Not caught by the team's own suite:** `scripts/verify-role-hierarchy.mjs`'s `tryInvite` helper (lines 70-80)
only ever sets `node_id`, never `property_ids`/`unit_id`/`vendor_id` — the exact field this finding is about is
never exercised.

**Why High, not Critical:** requires an account that already holds `facility_manager`/`regional_manager`
(not reachable by a tenant/vendor/anonymous caller), is bounded to a single org (`org_id = current_user_org_id()`
holds throughout), and is not reachable through the shipped UI's property picker — only via a direct call to the
server action or the table. It is High rather than Medium because it is a structural gap in the very policy this
diff rewrote twice for an adjacent field, fully defeats the region-boundedness the day's work exists to establish,
and grants a *write*-capable role placement, not merely a read.

**Fix direction (not applied — review only):** add a `property_ids <@ (select array_agg(id) from ... current
scope ...)` (or equivalent per-element check) to `invitations_insert`, mirroring the `node_id` `exists (...)`
clause; apply the same reasoning to `unit_id`/`vendor_id` if those are meant to be scoped to the inviter's
properties/vendors rather than free org-wide.

---

### 0729c-S2 · `apply_invitation_node` has no caller-authorisation check, is granted to `authenticated`, and is dead code — the node-on-invite feature does not work, and the function is a live escalation primitive — **High — CONFIRMED**

**Where:** `supabase/migrations/0078c_invitation_hierarchy.sql:101-123`.

**What:** The function this migration adds to apply an invitation's `node_id` on acceptance:

```sql
create or replace function apply_invitation_node(p_invitation_id uuid, p_user_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  inv invitations%rowtype;
begin
  select * into inv from invitations where id = p_invitation_id;
  if inv.id is null or inv.node_id is null then
    return;
  end if;

  insert into property_stakeholders (org_id, user_id, node_id, relation)
  values (inv.org_id, p_user_id, inv.node_id, 'manager')
  on conflict do nothing;
end;
$$;

revoke all on function apply_invitation_node(uuid, uuid) from public;
grant execute on function apply_invitation_node(uuid, uuid) to authenticated, service_role;
```

There is no `auth.uid()` reference anywhere in the body: no check that the caller is `p_user_id`, no check the
caller belongs to `inv.org_id`, no check on `inv.status` (works on an `accepted`, `revoked`, or `expired`
invitation identically to a `pending` one), and no check tying `p_user_id` to the invitation's `email` at all.
`p_invitation_id` and `p_user_id` are both plain parameters supplied entirely by the caller. Being
`SECURITY DEFINER` and granted to `authenticated` (not `service_role`-only, unlike the conversational-triage RPCs
this same codebase otherwise uses for privileged writes — see 0729b's "checked and clean" notes on
`set_ticket_urgency_by_reporter`/`append_reporter_message`), it bypasses `property_stakeholders_write`'s RLS
(`hierarchy.write`, admin-only) exactly as directly as 0729c-S1 does, through a second door.

**Two independent problems:**

1. **It is never called.** Grepped the entire tree (`.ts`/`.tsx`/`.sql`) for `apply_invitation_node`: it appears
   only in this migration file (definition, revoke, grant). `accept_invitation` (`0020`, unchanged by this diff)
   still only applies `property_ids`/`unit_id`/`vendor_id` — it does not call `apply_invitation_node`, despite
   this migration's own comment directly above it stating *"`accept_invitation` creates the user and applies
   `property_ids`. It has to apply the node too, or the region on the invitation is decoration."*
   (0078c:103-104). No app code calls it either. The feature `0078c` was written to deliver — inviting someone
   *as* a regional manager with their region in the same act — **does not work**: today, accepting an
   invitation with `node_id` set creates the user with the invited role but leaves them with zero
   `property_stakeholders` rows, i.e. zero property reach, contradicting the role they were just given.

2. **It is nonetheless live and unauthorised.** Any authenticated user (any role, any org — the function checks
   neither) who can supply a valid `invitations.id` that has `node_id is not null` can call
   `supabase.rpc('apply_invitation_node', { p_invitation_id, p_user_id })` with `p_user_id` set to their own id
   (or anyone's) and receive a `manager` stakeholder row on that node — the same regional-manager-grade property
   reach 0729c-S1 describes, through a function with no rank check, no role check, and no relationship to the
   invitation at all beyond knowing its id. Invitation `id`s are not secret within an org: `PendingList.tsx`
   (`app/dashboard/people/PendingList.tsx:55,66-67`) renders each pending invitation's raw `id` into the DOM
   (as a React `key` and an `onClick` handler argument) for anyone who can load `/dashboard/people/invitations`
   — every admin, and every `facility_manager`/`regional_manager` viewing their own sent invites.

**Why this hasn't fired yet:** no invitation in normal use carries a `node_id` today, because nothing in the app
(`InviteDialog.tsx`, `actions.ts`) sets it — problem (1) above. It becomes reachable the moment either: (a) the
UI is extended to let a regional-manager invite carry a node (the change `0078c` was written for), (b) anyone —
including a legitimate `regional_manager` inviting within their own already-authorised region — creates an
invitation with `node_id` via a direct call rather than the UI (already possible today, since `invitations_insert`
accepts `node_id` and the UI simply doesn't expose the field), or (c) a test/probe script leaves a
`node_id`-bearing row behind (`scripts/verify-role-hierarchy.mjs:70-80` creates exactly such rows for its own
probe accounts).

**Not caught by the team's own suite:** grepped `scripts/verify-audit-0729b.mjs` and `scripts/verify-role-hierarchy.mjs`
for `apply_invitation_node` — zero matches in either.

**Why High, not Critical:** requires a precondition (a `node_id`-bearing invitation to exist and its `id` to be
known to the caller) that is not met by any invitation the shipped UI can currently create, so it is not
reachable by clicking through the product today. It is High rather than Medium because the defect itself — a
`SECURITY DEFINER` function granted to `authenticated` with literally no caller check, silently bypassing an
admin-only RLS gate — is unconditionally present in the migration regardless of data state, and will go live the
instant the feature it exists for is actually wired up (which is the natural next step, since the column and the
comment both say this is the intended flow).

**Fix direction (not applied — review only):** add `where s.user_id = auth.uid()`-equivalent authorisation —
at minimum, verify `p_user_id = auth.uid()` and `inv.status = 'pending'` and `inv.email` matches the caller's own
auth email (mirroring `accept_invitation`'s own checks at `0020:131-140`) — and call it from inside
`accept_invitation` (or fold its body into that function directly, removing the separate grant to `authenticated`
altogether) so it can no longer be invoked out-of-band.

### Security — checked and clean (new code only)

- **`fm_roles()`-scoped policies (0078a) are correctly bounded.** `asset_certificates_write`, `asset_identifiers_write`
  gate on `asset_id in (select assets.id from assets where assets.property_id in (select current_user_property_ids()))`
  — unchanged in shape from the pre-existing `facility_manager`-only version, just with `regional_manager` added to
  the role check via `fm_roles()`. `archive_asset`/`restore_asset` (0078b) likewise gate on
  `v_property in (select current_user_property_ids())`. Since `current_user_property_ids()` already expands a
  node assignment to its full subtree (0067, unchanged), these correctly bound a regional manager to their region.
- **The predicates with no property scoping (`vendor_applications_staff_select/_update`, `vendor_properties_write`,
  `payments_insert`, `payment_intents_insert`) are pre-existing `facility_manager` behaviour, not a new leak.**
  Diffed each against its pre-0078a definition: `vendor_applications_staff_select`/`_update` are unchanged in
  shape since `0021_vendor_applications.sql:94-107` (Day 3) — org + role check only, no property scoping, ever.
  `vendor_properties_write` is unchanged in shape since `0012_vendor_property_scoping.sql:29-31`, whose own
  comment documents this as deliberate: *"The vendor DIRECTORY stays org-visible to FMs (they need it to assign
  work) — the sensitive money/performance data is what gets scoped."* `vendor_applications` and `vendor_properties`
  have no `property_id`/`node_id` column at all (a vendor application is inherently an org-level record), so
  region-scoping isn't structurally possible for them regardless of role. `0078a`'s header explicitly states these
  are read from `pg_policies`/`pg_get_functiondef` and substituted, never retyped — spot-checked two of the eight
  changed predicates against the live pre-diff catalogue text and both are byte-identical apart from the added
  role.
- **Rank/escalation logic is correct in both directions.** `role_rank()` (0078c) and `ROLE_RANK` (`lib/roles.ts`)
  hold identical values for every role. `invitations_insert`'s `role_rank(role) < role_rank(current_user_role())`
  (0078c) blocks lateral and upward invites (a `facility_manager` cannot invite a `regional_manager`,
  `finance_approver`, `executive`, or another `facility_manager`); `0078d`'s added
  `or (current_user_role() = 'admin' and role = 'admin')` is strictly additive and gated on the caller already
  being `admin` — no non-admin can reach it. `app/dashboard/people/actions.ts:65-71`'s app-layer check
  (`peerAdmin` + rank comparison) matches the DB rule exactly, defence-in-depth as intended, not the sole gate.
- **A regional manager cannot invite an `executive`.** `executive` (rank 90) exceeds `regional_manager` (rank 60);
  the rank check blocks it, and `executive` is absent from `INVITABLE_ROLES`'s reachable set for that inviter via
  `invitableBy()` (`lib/roles.ts:96-100`) — the UI would not even offer it, and the DB would refuse it regardless.
- **`0078a`/`0078b`/`0078c`/`0078d` do not reopen 0729b-S1/S2/S3 or the baseline S-1/S-2/D-1** — no new direct
  table write bypassing the composite FKs or the capability matrix was found in the touched files; `0077`'s fixes
  are untouched by this later diff.

---

## EFFICIENCY

Nothing new to flag. `0078a`/`0078b` are pure policy/function text substitutions (no new queries, no new loops);
`role_rank()` is an `immutable` `case` expression, O(1); the invitation `node_id` scope check
(0078c/0078d) is a single indexed `EXISTS` against `org_nodes.path` using the same `text_pattern_ops` prefix-match
index the 0729b audit already validated for `current_user_property_ids()`.

---

## DISCONNECTS

- **The node-on-invite feature (0078c's stated purpose) is not wired up anywhere in the app.** `invitations.node_id`
  is never set by `app/dashboard/people/actions.ts` or `InviteDialog.tsx` (grepped both — zero references), and
  `apply_invitation_node` is never called (see 0729c-S2). A regional manager can be invited today only by an
  admin manually creating the `property_stakeholders` node row after the fact (the exact "two steps where the
  second gets forgotten" problem `0078c`'s own header says it was written to close) — or by someone calling the
  `invitations` insert directly with `node_id` set, bypassing the UI entirely. Not itself a security finding
  (the DB-side pieces exist and are individually reachable), but the feature described as done in
  `docs/BUILD_JOURNAL.md`'s "A regional manager who could not invite anyone" entry does not function end-to-end
  through the product yet.

---

## Severity summary (new findings, this audit)

| Sev | ID | Title | Status |
|-----|----|-------|--------|
| High | 0729c-S1 | `invitations_insert` scopes `node_id` to the inviter's reach but not `property_ids`/`unit_id`/`vendor_id` — a regional manager (or FM) can invite/attaché someone onto any property in the org, bypassing the admin-only `hierarchy.write` gate that governs every other path to the same row | CONFIRMED |
| High | 0729c-S2 | `apply_invitation_node` has no caller-authorisation check and is granted to `authenticated` — dead code today (never called by `accept_invitation` or any app code, so the node-on-invite feature doesn't work), but a live, unconditional escalation primitive the moment any invitation carries a `node_id` | CONFIRMED |

No Critical or Medium/Low findings this pass. No Critical findings carried forward — all 0729b items and C1–C5
verified genuinely CLOSED (see table above).
