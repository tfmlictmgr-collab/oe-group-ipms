# Build Audit — 0806 (incremental) + correctness review

**Date:** 2026-08-06 · **Range:** `ed042b4..8acc3d3` (31 commits, 172 files, ~20,821 insertions / 608 deletions, migrations 0106-0142 — asset assemblies/mobility/maintenance strategy, account recovery (password reset + MFA backup codes), chat-channel notification parity, rate-limit fail-closed hardening, rejected-invoice reopen path, vendor self-creation, FM/PM journeys, tenant payment screen, bulk finance approval, role-based menu consolidation, Day 12 security/NDPA pack, and the finance-disburses-never-the-approver close-out).
**Auditors:** `build-auditor` (security/efficiency, read-only static) + `/code-review` (correctness) — PC2.

> **Shared for PC1 to verify & action.** Fix directions are **suggestions for review, not applied changes**.
> **One live, reachable issue worth fixing first: 0806-M2.** `cascadeToUserIds()` sends a real external message (SMS/WhatsApp/Telegram/email) to a caller-supplied user id with no org check — reachable today via `assignTicket()`'s `opsUserId` path — while its in-app sibling `notify_user()` was correctly hardened against exactly this in the same window (`0122`). Bounded by needing a foreign-org user UUID, but this platform's own operator/executive roles have designed cross-org visibility, so a UUID surfaces in ordinary places once known once.
> **0806-M1 is real but not currently reachable** — no asset edit UI exists yet, so file it against whoever builds that screen.
> **Both M1 and M2 have since been fixed by PC2 — see the Status section immediately below.** M1's application also surfaced that PC2's `.env.local` still carried the 2026-08-06 incident's exact project-drift; **PC1 should check theirs.**
> **The 0805 fixes are all genuinely closed** — H1/H2 both confirmed with real code reads, H2 needed a second pass PC1 already made and closed. D1 (landlord remittance UI) stays open by disclosed, deliberate deferral.
> **My own `/code-review` pass came back clean** — zero new correctness findings across the highest-risk new surfaces in this window (password reset, MFA backup codes, the remittance-run extraction, batch payment approval, and the new LLM failover module).

## Status — actioned by PC2, 2026-08-08

Both new findings closed, at different layers on purpose — see below for why the two were not treated the same way.

| # | Status | What was done |
|---|--------|----------------|
| **M2** | **Fixed, applied** (`lib/role-notify.ts`) | `cascadeToUserIds()` now filters its `users` lookup with `.eq("org_id", orgId)`, alongside the existing `.in("id", userIds)` — the exact boundary `notifyRoleWithCascade()` two functions above it already enforces, so this is the sibling catching up to a pattern already proven in the same file. Pure application code, no schema/DB change, no other caller exists (`cascadeToUserIds` has exactly one call site, `assignTicket()`, whose `orgId` comes from the ticket row PostgREST just returned — not client input). `npx tsc --noEmit` passes clean (exit 0) with this change in place. Applied directly; takes effect on next deploy, nothing further required. |
| **M1** | **Fixed, applied and verified** (`supabase/migrations/0143_a_parent_asset_cannot_leave_its_children_behind.sql`) | Extends `assets_parent_is_valid()` to also fire `before update of property_id`, adding the missing direction: if a row that is itself a parent has its `property_id` changed while any of its children remain on the old property, the update is refused. Case 1 (a component's own same-property check) is untouched. Confirmed by reading `app/dashboard/assets/actions.ts` that no code path currently updates `assets.property_id` outside of asset creation, so this changes no live behaviour today — it closes the gap ahead of an edit/relocate UI existing. The one existing test already exercising `property_id` relocation (`verify-asset-classification.mjs` section E, "StillFixed") is unaffected: that fixture has no children, so the new check is a no-op for it. **Applied to the Phase-1 dev database on 2026-08-08 and proven by test, not by reading the SQL** — see below. |

**Why the two were handled differently:** M2 is pure TypeScript — no database write, fully reversible by `git revert`, verified by a clean typecheck without touching any database, so PC2 applied it directly. M1 is a schema/trigger change, and this project's standing rule (reinforced by `docs/INCIDENT_2026-08-06_DEMO_DB_MIGRATED.md`) is that DB-mutating commands are run by a human who has just confirmed which project `.env.local` actually points at, never automatically by an assistant. So it was written as a migration file plus a regression test and handed over to be run — which is what happened.

### M2's other half — the write, not just the send (`0144`)

The M2 fix above stopped the *leak*. It deliberately did not touch the *write*, and reviewing what that left behind turned up a second, quieter problem worth closing in the same pass.

Nothing validates the value written to `tickets.assigned_to_user_id`. `tickets_update` (`0052`) has a `USING` clause constraining which ticket **rows** a caller may touch and **no `WITH CHECK` at all**, so the assignee id itself has never been checked against the ticket's org. Grepped the migrations: no trigger anywhere covers it.

**Checked rather than assumed: this is not a data leak.** `tickets_select` gates its assignee clause *inside* `org_id = current_user_org_id()`, so a foreign-org assignee genuinely cannot read the ticket. B1 isolation holds. What it produces instead is a **silently dead assignment** — the ticket records an assignee who structurally can never see it, the dispatcher is told "Request dispatched", and now that both notification paths correctly no-op for a foreign-org id (0122 for in-app, the M2 fix for external), *nobody is told anything at all*. The job just sits there. Arguably the M2 fix made this quieter, which is the right trade but is why the write needed closing too.

`0144` adds a trigger validating both `assigned_to_user_id` and `assigned_vendor_id` against the ticket's own org. The vendor column is included even though `assignTicket()`'s vendor branch is safe today — that safety comes from the application resolving the vendor through an RLS-scoped lookup, not from the database being correct, and the next caller to write that column inherits no such protection. Same reasoning as `0107` generalising its media-RLS fix to `invoice-attachments`.

Two deliberate choices worth flagging for review:

- **The fix is at the database only — no app-layer pre-check.** The obvious app fix (resolve `opsUserId` through an RLS-scoped `users` lookup, mirroring the vendor branch) was considered and **rejected**: `tickets.assign` is an *unlocked* capability (`0050`), so the platform operator can grant it to a role outside `oversight_roles_with_fm()` — `fm_ops_staff`, say — who cannot read a colleague's `users` row. That check would then be **stricter than the permission model** and would refuse a legitimate dispatch. The existing `failFromDb(error, "assign this job")` already surfaces the trigger's message, so no app change is needed.
- **The trigger is `SECURITY DEFINER`, and that is load-bearing rather than habitual** — for the same reason. An invoker-rights trigger would answer its `exists` through the caller's RLS-filtered view of `users`, making the failure mode a *false refusal* of a valid assignment. It reads two columns to answer one yes/no and returns nothing to the caller, so this widens no one's visibility. Per the 0806-L1 lesson, it carries an explicit `revoke ... from public, anon`.

The migration also **refuses to install over pre-existing violations**, listing the offending ticket ids rather than silently enforcing an invariant the table already contradicts — the same care `0108` took with `logo_url`. It is transactional, so that refusal rolls back cleanly.

Proven by `scripts/verify-cross-org-dispatch.mjs` (new): a cross-org user assignment is refused, a cross-org vendor dispatch is refused, an ordinary same-org dispatch of both kinds still succeeds (so this is not a blanket freeze — and that assertion is what would catch the invoker-rights false-refusal mode), unassigning still works, and the cascade's org filter demonstrably drops the foreign recipient while keeping the home one. It sends nothing: `verify-cascade.mjs` owns real delivery, and a test for "we must not message strangers" that messages strangers to prove it would be its own bug.

### Also closed — the demo-project denylist (`scripts/migrate.mjs`)

The audit's own residual gap under "Verified — item 2, remainder": the mismatch guard is *relational*, refusing only when the two halves of `.env.local` disagree. It says nothing when they agree on the **wrong** project, so a config with both halves naming the frozen POC demo would pass silently and re-violate Standing Rule #1 by a different route than the 6 Aug incident took. `migrate.mjs` now refuses outright if either half resolves to `egqzjrmzxqqxrrqpdwbt`, deliberately with **no escape hatch** — there is no legitimate reason for this checkout to migrate the frozen demo, and a guard whose bypass is an environment variable is one someone exports at 5am.

### M1 — how it was proven

New section **I** in `scripts/verify-asset-classification.mjs`, run against the Phase-1 dev database after `0143` applied. It asserts both directions, because a trigger that refuses everything would also "pass" a one-sided test:

- `PASS relocating a parent away from its components is refused`
- `PASS and the refusal left the whole assembly exactly where it was` — the assembly is still intact on its original property, not half-moved
- `PASS an asset with no parent and no children still relocates freely` — this is **not** a blanket freeze on `property_id`; section E's "a fixed asset can still be relocated" also still passes, so the advisory-not-mandatory mobility design is preserved

Full suite: **ALL CHECKS PASSED**. Worth recording that the same section **failed against the pre-fix database** on the first run — `!!! A PARENT WAS RELOCATED WHILE ITS COMPONENTS STAYED BEHIND`, with the split assembly's ids printed — so this test demonstrably catches the bug it was written for rather than passing vacuously.

**Known limitation, unchanged and documented in the migration's own comment:** a single statement moving a parent *and* all its children together will still be refused, because a `BEFORE ROW` trigger cannot see another row's new value from later in the same multi-row `UPDATE`. That is the safe direction to be wrong in — it over-refuses a legitimate batch move rather than silently allowing a stray component — but whoever builds the relocate UI will need either a per-row sequenced update (children first, parent last) or a deliberately different mechanism.

### ⚠️ A second finding, surfaced by applying M1 — for PC1 to check on their own machine

`npm run migrate` **refused to run** on the first attempt. `scripts/migrate.mjs`'s pre-flight guard caught that PC2's `.env.local` still had its two halves naming different Supabase projects:

- `SUPABASE_DB_*` → `egqzjrmzxqqxrrqpdwbt` — **the frozen POC demo project**
- `NEXT_PUBLIC_SUPABASE_URL` → `uszwigxdvjlwcwkjsjmc` — the Phase-1 dev project the app actually serves

This is the *exact* configuration that caused the 2026-08-06 incident, still present on PC2 two days later. The incident response added the guard but never corrected the underlying config, so the machine stayed one `ALLOW_MIGRATE_TARGET_MISMATCH=1` away from repeating it — and any migration run from PC2 in that state would have silently gone to the frozen demo database. **The guard worked exactly as designed and is the reason this didn't recur.**

Now corrected on PC2: `SUPABASE_DB_*` points at the Phase-1 dev project via its session pooler (port 5432 — session mode, not transaction mode, since the migration runner uses explicit `BEGIN`/`COMMIT`). One intermediate error worth noting for whoever hits it next: setting `SUPABASE_DB_USER` to `postgres.<new-ref>` while leaving `SUPABASE_DB_HOST` pointed at the *old* project's regional pooler produces `tenant/user not found` — the username and the pooler host must name the same region.

**PC1: check your own `.env.local` for the same drift before your next `npm run migrate`.** The guard will refuse rather than misfire, but the config is worth fixing at rest rather than discovering at the moment you need to migrate.

## Part B — Correctness review (`/code-review`, ed042b4..8acc3d3)

No new correctness findings. Reviewed in full, focused on money-path and new-auth-surface code given the size of the diff:

- [`app/reset-password/actions.ts`](../app/reset-password/actions.ts) — token generation/hashing, expiry, anti-enumeration, rate limiting, session revocation on reset, sibling-token invalidation.
- [`lib/mfa.ts`](../lib/mfa.ts) — backup code generation/hashing, TOTP-factor prerequisite, redemption path and the deliberate disable-MFA-on-redeem design.
- [`lib/remittance-run.ts`](../lib/remittance-run.ts) — the new claim→send→post extraction shared by vendor and landlord remittances.
- [`app/dashboard/payments/[id]/actions.ts`](../app/dashboard/payments/[id]/actions.ts) — `executeRemittance()`'s role check and explicit `p_executed_by`.
- [`app/dashboard/payments/actions.ts`](../app/dashboard/payments/actions.ts) / `BatchApprove.tsx` — batch approval running SECURITY INVOKER, RLS firing per-row.
- [`lib/llm.ts`](../lib/llm.ts) — the new Anthropic/Gemini failover module (closes CLAUDE.md locked decision B3): failure driven by parse success not HTTP success, `probeProviders()` health-checking with a real prompt rather than key presence alone.

Nothing to fix. Worth flagging as a housekeeping item, not a correctness finding: `@radix-ui/react-alert-dialog` is declared in `package.json` (`^1.1.23`) but missing from local `node_modules` on this machine, causing a `components/ui/alert-dialog.tsx` module-not-found at typecheck — almost certainly just needs `npm install` here, not a code issue. Flagging so it doesn't get mistaken for something introduced by this range if PC1 sees the same error.

---

## Part A — Security / efficiency audit (`build-auditor`)

# Stage 0806 — Incremental audit, ed042b4..8acc3d3

Scope: 31 commits, 172 files, ~20,821 insertions / 608 deletions, migrations 0106-0142. Read-only review. Given the size of the range, time was prioritised in the order the brief specified: (1) verify the three named prior items, (2) the flagged-major items (anon/SECURITY DEFINER, demo-DB drift, rate-limit fail-closed, finance-disburses/notifications/rejected-invoice/password-reset+MFA), (3) breadth across the remainder only as time allowed.

Every finding below is verified against the actual code at HEAD `8acc3d3`, not inferred from commit messages.

---

## Prior fixes verified

### 0805-H1 — work-order media storage RLS was org-scoped, not ticket-scoped — **CLOSED**

Fixed in `4dc5a3a` / `supabase/migrations/0107_media_and_scoring_fixes.sql:53-64`. The storage SELECT policy on `work-order-media` now does `exists (select 1 from ticket_attachments ta where ta.storage_path = storage.objects.name)`, so it inherits `ticket_attachments_select`'s full ticket-scoped visibility rather than re-deriving org membership. `getMediaUrl()` (`app/dashboard/tickets/[id]/media-actions.ts:79-93`) was also rewritten to take the attachment's **id**, never a caller-supplied path — it fetches `storage_path` through `ticket_attachments_select` first and only ever signs that row's own path. Confirmed by reading `TicketMedia.tsx:120`, which now calls `getMediaUrl(attachmentId)`.

Also closed in the same migration, found while fixing H1: the storage DELETE policy had the identical org-only shape (`owner = auth.uid()` with no open-ticket check) — factored into a shared `ticket_attachment_deletable()` function used by both the table and storage DELETE policies (0107:39-63).

The pattern held for the rest of the window: the new `invoice-attachments` bucket added in `0140_completion_photos_and_a_signed_invoice.sql:136-144` for signed paper invoices follows the identical "read follows the owning row's own SELECT policy" shape (`exists (select 1 from payments p where p.invoice_attachment_path = storage.objects.name)`), so the lesson generalised rather than being a one-off patch.

### 0805-H2 — vendor evaluation composite score not reaching the payment gate or BI — **CLOSED, in two passes**

`4dc5a3a` / `0107_media_and_scoring_fixes.sql:110-131` repointed `runPerformanceCheck` (`app/dashboard/payments/[id]/actions.ts`) and the `bi_vendor_scores` view at `vendor_evaluation_tickets`, the correct paired-source view. That closed the two consumers named in the original 0805-H2 finding.

It was **not** the whole picture. Commit `72614f7` ("The screen called the payment gate a liar: three consumers still averaged raw half-rows") found three more screens still reading the raw table directly: `app/dashboard/payments/[id]/page.tsx` (the payment detail screen itself — the one a finance approver reads while deciding whether to release money), `app/dashboard/vendors/page.tsx` (the ranking list), and `app/dashboard/overview/page.tsx`. All three now read `vendor_evaluation_tickets`. Confirmed at HEAD by grep: `app/dashboard/vendors/[id]/page.tsx:93-98` is the only remaining read of the raw `vendor_evaluations` table with `composite_score`, and it is correctly legacy-scoped (`.eq("vendor_id", id).is("ticket_id", null)` — pre-0104 rows that genuinely carry a complete composite). No other app file reads `composite_score` from the raw table unscoped.

`72614f7` also added a structural regression test (`scripts/verify-vendor-score-consumers.mjs` section E) that scans `app/` and `lib/` for any `from("vendor_evaluations")` read that pulls `composite_score` without `.is("ticket_id", null)` — an invariant-over-source check rather than a behavioural one, specifically because (their own words) "the wrong number is a perfectly valid query" and a behavioural test can't catch it. This is the right kind of guard for exactly the failure mode that let three consumers drift for weeks under a green suite.

**Verdict: fully closed at HEAD.** Worth noting for the record: the first pass (4dc5a3a) was incomplete — it fixed the two consumers the original audit named but missed three more reading the same corrupted number, one of them the payment-approval screen itself. The second pass found and closed those, and added the right regression guard this time.

### Asset classification — `779b3c2` (0121) + `004b085` (0134) — **CLOSED, with one gap found in this pass**

The brief's reference to "commit 779b3c2 + 0134" is two separate commits: `779b3c2` (0121, assemblies/mobility/maintenance strategy) and `004b085` (0134, the `scope` column), both implementing `docs/ASSET_CLASSIFICATION_AND_SCOPE.md`. Both checked.

**Cycle guard (0121, `assets_parent_is_valid()`, lines 24-63)** — sound. Direct self-parenting is refused explicitly; the general case is a recursive CTE walking up from the proposed parent, refusing if it arrives back at the row being updated — correctly catches re-parenting an ancestor under its own descendant, not just direct/simple cycles. `scripts/verify-asset-classification.mjs` section D exercises all three depths (direct, A-B-A, ancestor-under-descendant) plus a check that a refused re-parent leaves the existing chain intact.

**Scope/unit_id consistency (0134, `assets_scope_matches_unit()`)** — sound. Trigger fires on `insert or update of scope, unit_id`, keeps the two columns mutually consistent (`unit` requires `unit_id`; `property`/`site` forbid it), and `assets_serving_unit()` is `security invoker` so the asset RLS policy still governs what a caller sees through it.

**Gap found (new, this pass) — see M1 below:** the same-property invariant between an asset and its `parent_asset_id` is enforced only when `parent_asset_id` itself is written, not when either party's `property_id` changes afterward. Not a regression in what 0121 set out to do (assemblies didn't previously exist), but a real gap in how completely the invariant is enforced, in the same "constraint completeness" class this codebase has hit before (e.g. 0804-S2's vacuous index, 0729b-S3's untrue view comment).

One documentation-only inaccuracy, not a defect: `779b3c2`'s commit message says the UI "gates ... 'Reassign' offered only on a movable asset." No such UI exists — `app/dashboard/assets/actions.ts` has no update/edit path for an existing asset at all (only `createAsset`, `commitAssetImport`, and `archiveAsset`); `mobility` is set at creation only. Since there is no reassignment feature yet, this is inert, not a live gap by itself — it's the same absence that makes M1 below currently unreachable through the app.

---

## New findings (0806)

### M1 — Asset assembly's same-property invariant is not re-checked when a parent's or child's `property_id` changes after the fact (Medium, CONFIRMED code path / not app-reachable today)

`assets_parent_is_valid()` (`supabase/migrations/0121_asset_hierarchy_mobility_maintenance.sql:24-68`) enforces "same org AND same property" between an asset and its `parent_asset_id` — but only as a trigger `before insert or update of parent_asset_id`. It does not fire when `property_id` changes on either the parent or a child while `parent_asset_id` itself is left alone.

`assets_update` RLS (`supabase/migrations/0052_hoist_permission_checks.sql:73-86`) permits exactly this: an admin (org-wide) or an FM/PM staked to both the old and new property can `UPDATE assets SET property_id = ...` on any asset they may write to, and the RLS `USING`/`WITH CHECK` only require `property_id in (select current_user_property_ids())` for the row being touched — nothing checks the assembly it participates in.

**Concrete scenario:** Asset P (a chiller plant, `mobility = 'movable'`) on Property A has components C1, C2 with `parent_asset_id = P`, all on Property A — valid per the trigger at creation time. An admin later corrects P's property assignment (exactly the "a mistake stays correctable" case `0121`'s own comment defends for the mobility column) via `UPDATE assets SET property_id = 'B' WHERE id = P`. The trigger does not fire (it only watches `parent_asset_id`), so this succeeds. C1 and C2 still have `parent_asset_id = P` but sit on Property A while P is now on Property B — the exact state the trigger's own stated purpose ("a component that lives on a different property is not a component ... would make a property's own register lie about what is on it") was written to prevent, now reachable by the one write path (`property_id` reassignment) the trigger doesn't watch.

**Currently not reachable through the app**: `app/dashboard/assets/actions.ts` has no update/edit action of any kind (create, CSV-import-as-insert, and archive only) — so this requires a direct PostgREST/`supabase-js` call under an admin or dual-staked FM/PM's own session, not a UI flow. `scripts/verify-asset-classification.mjs` section E tests relocating a **standalone** fixed asset (line 169-176) but never tests relocating a parent or child that has an assembly relationship, so this gap has no test coverage in either direction.

Fix direction (not applied, per the read-only brief): extend the trigger to `before insert or update of parent_asset_id, property_id` and re-run the same same-org/same-property check whenever `property_id` changes on a row that has a parent or has children.

### M2 — `cascadeToUserIds` (the new external-notification dispatch cascade, `d33aac6`) sends real SMS/WhatsApp/Telegram/email to a caller-supplied user id with no organisation check, unlike the in-app notification it accompanies (Medium, CONFIRMED code path)

`lib/role-notify.ts:99-113`:
```ts
export async function cascadeToUserIds(
  orgId: string, userIds: string[], message: string, entityType: EntityType, entityId: string | null
): Promise<void> {
  if (userIds.length === 0) return;
  const { data: recipients } = await supabaseAdmin
    .from("users")
    .select(RECIPIENT_COLUMNS)
    .in("id", userIds)
    .is("deactivated_at", null);
  await cascadeToRecipients(orgId, (recipients ?? []) as Recipient[], message, entityType, entityId);
}
```
This runs on `supabaseAdmin` (service role, bypasses RLS) and filters only by `id` and `deactivated_at` — no `org_id` check anywhere in the function, and `sendCascade`/`lib/cascade.ts` uses `orgId` only to pick which sending credentials (WhatsApp/Telegram bot) to send **from**, never to validate the recipient. Compare `notify_user()` (`supabase/migrations/0122_a_notification_cannot_cross_an_organisation.sql:40-79`), fixed earlier in this same window specifically for this class of bug: a signed-in caller may only notify someone in their own org (`auth.uid() is not null and v_org is distinct from current_user_org_id() -> return null`), with the migration's own comment naming exactly this risk ("B1 says a user on one portal must never see the other brand's data OR EXISTENCE ... the sender was never [guarded]"). `cascadeToUserIds` is new in this window and does not carry the equivalent check.

**Concrete path**, traced in `app/dashboard/tickets/[id]/actions.ts:15-98` (`assignTicket`, the caller `d33aac6` added this cascade to):
- `vendorId`'s recipient is looked up via `supabase.from("vendors").select("user_id").eq("id", vendorId)` **on the caller's own session** (not service role) — `vendors_select` RLS (`0052_hoist_permission_checks.sql:92-98`) is `org_id = current_user_org_id()`, so a cross-org `vendorId` returns no row and never reaches `cascadeToUserIds`. This path is safe.
- `opsUserId` is pushed into `recipients` directly with **no lookup or validation at all** (`if (opsUserId) recipients.push(opsUserId);`, line 64) — it is a raw caller-supplied server-action parameter. It is then written to `tickets.assigned_to_user_id` under `tickets_update` RLS, whose `USING`/`WITH CHECK` (`0052_hoist_permission_checks.sql:32-41`) constrain which **tickets** may be touched but never validate that the **new `assigned_to_user_id` value** belongs to the ticket's own org — there is no FK-adjacent trigger checking this anywhere in the schema (grepped). The subsequent `notify_user(opsUserId, ...)` RPC (line 75-84) runs through the caller's own session and correctly no-ops for a cross-org id per 0122's fix. But `cascadeToUserIds(orgId, recipients, ...)` (line 89-95) runs on service role right after and has no equivalent check — it will fetch that user's phone/email/telegram_chat_id regardless of org and dispatch a real external message ("A job has been assigned to you. Open the portal to acknowledge and get started.") to them via `sendCascade`, using the calling org's own sender credentials.

**Net effect:** a staff member holding `tickets.assign` in their own org, who can supply (or already knows) another org's user id as `opsUserId`, can trigger a real WhatsApp/SMS/Telegram/email send to that person — confirming their existence and reachability to an unrelated org, using another org's paid sending credentials, for a message whose text is fixed (not attacker-controlled free text, unlike the pre-0122 `notify_user` case), but repeatable at will. Practical exploitability is bounded by needing a foreign-org user UUID, which is not casually guessable — but this platform's own operator/executive-tier roles have designed cross-org visibility (`operator_org_directory()`, `operator_consolidated_position`, 0131) and a UUID surfaces in ordinary places (URLs, audit rows, prior notifications) once known once. Not demonstrated end-to-end (read-only brief); traced precisely through the code, both the vulnerable path and the safe one it sits beside.

Fix direction (not applied): `cascadeToUserIds` should filter its `users` lookup by `.eq("org_id", orgId)` alongside `.in("id", userIds)`, the same boundary `notify_user`/`notify_role` already enforce for the in-app half of the same feature.

### L1 — SECURITY DEFINER anon-exposure fix (5057880) recurred three times before being caught by its own guard; closed at HEAD but the underlying trap has no CI enforcement (Low/informational — CLOSED at HEAD, residual process risk)

`5057880` (migrations `0113`-`0115`) correctly closed the original "101 of 103 SECURITY DEFINER functions callable by anon" defect and added a real regression check, `scripts/verify-function-grants.mjs`, which queries live `pg_proc`/`has_function_privilege` grants against intent parsed from the migration files.

The underlying mechanism is a genuine footgun, and it fired again within the same window: `CREATE OR REPLACE FUNCTION` re-triggers Supabase's `ALTER DEFAULT PRIVILEGES` grant to `anon`/`authenticated` **even when the function's signature is unchanged and its grants had already been correctly locked down** (confirmed by the codebase's own comment on this, `0126_the_correction_stays_on_the_audit_trail.sql:113-115`: "A `create or replace` re-grants; that is the part worth remembering."). Migrations `0122`-`0125` each did a bare `create or replace function ...` on an already-fixed SECURITY DEFINER function and only wrote `revoke all ... from public` (not `anon` explicitly), reopening anon-callability on 10 functions — including `record_collection`, the single function named as the sharpest risk in the original `5057880` report ("An anonymous caller could post a collection to the client-funds ledger, marking an invoice paid with no money received"). This was caught by `verify-function-grants.mjs` and closed in `0126` (all 10 functions individually re-revoked from `anon`, confirmed by reading `0126:82-126`).

Checked forward from `0126` to `0142` (the rest of the audit window): every subsequent `create or replace function` on a SECURITY DEFINER function (`0127`-`0142`, ~14 migrations) consistently includes an explicit `anon` revoke — `notify_user`/`notify_role` were replaced again in `0133` and correctly re-revoked from `anon` that time. No function created in `0116`-`0142` was found with a missing revoke as of HEAD.

**Residual risk:** `verify-function-grants.mjs` is a manual script — there is no `.github/` workflow or `package.json` script wiring it into CI, so the only thing standing between a future bare `create or replace function` and reopening this exact class of bug is a person remembering to run it. The discipline has held for 14+ migrations since `0126`, but the guard is not structurally enforced.

---

## Verified — item 2, remainder

- **`f850aa4` (fail-closed rate limiting on money-moving routes)** — sound and complete. `lib/rate-limit.ts` distinguishes `skipped` (Upstash never configured — dev/demo, stays fail-open) from `degraded` (Redis configured and erroring at call time — fails closed). Checked every `checkRateLimit` call site in the codebase (`grep -rn "checkRateLimit"`): both money-moving routes named in the commit (`app/api/webhooks/payments/[gateway]/route.ts`, `executeRemittance` in `app/dashboard/payments/[id]/actions.ts`) check `.degraded` and refuse; the third, later-added money-moving site — `app/dashboard/ledger/payouts/actions.ts:109-123` (landlord payouts, added afterward in `0129`/`21e7ed2`) — independently follows the identical fail-closed pattern, so the discipline held for a call site added after the fix landed.
- **Demo-DB-drift resolution (`af3929a`/`d32b4b9`)** — the specific failure mode that caused the incident (the two halves of `.env.local` silently naming different Supabase projects) is now guarded: `scripts/migrate.mjs` derives a project ref from both `NEXT_PUBLIC_SUPABASE_URL` and `SUPABASE_DB_*`, refuses to run when they disagree (escape hatch `ALLOW_MIGRATE_TARGET_MISMATCH=1`), and was verified against the actual mismatched PC2 config named in the incident report. The "accept the drift" decision itself was made on real evidence, not assumption (`docs/INCIDENT_2026-08-06_DEMO_DB_MIGRATED.md` §6: a read-only, signed-in walkthrough of the live demo confirming it still renders and functions on the Phase-1 schema). **Residual gap (Low, not raised as a numbered finding given time budget):** the guard is relational, not absolute — it only refuses when the two halves *disagree*. It has no hardcoded check against the specific frozen demo project ref (`egqzjrmzxqqxrrqpdwbt`), so a `.env.local` whose *both* halves pointed at the demo project would pass the guard silently and could re-violate Standing Rule #1 through a different failure mode than the one that actually occurred. Worth a one-line addendum (an explicit denylist check) if this surface gets revisited.
- **`8acc3d3`/`0142` (finance disburses, never the approver)** — the maker-checker rule (`assert_may_disburse` + the `pay.approved_by = p_executed_by` refusal in `create_vendor_remittance`) is enforced at the database, `p_executed_by` is a required parameter (no default, so a forgetful call site can't silently write `NULL` again), and the caller-side value comes from `supabase.auth.getUser()` server-side, not a client-supplied field — not spoofable. `create_rent_remittance` gained the same executor requirement and its own maker-checker-adjacent lock (`for update of rc`) is intact.
- **`192cb04`/`0136`+`0137` (rejected invoice has a way back)** — the `rejected -> pending_verification` edge is the only new state-machine transition, gated to `finance_approver`/`admin` in the trigger (not just the function), clears `service_verified_at`/`performance_validated` on reopen so a correction doesn't inherit a stale verification, and requires a >=10-character reason enforced in both the trigger and the function. The self-contradictory error message bug the authors' own test suite caught (`0137`) is a genuine, correctly-diagnosed RLS-ambiguity fix (a zero-row UPDATE under RLS cannot tell "wrong status" from "no permission" apart without a second read) and discloses nothing new since the row was already readable to the caller.
- **`5317e58`/`0139` (password reset + MFA backup codes)** — new auth surface checked against the standard classes: 32-byte token, SHA-256-at-rest only (a DB read cannot be replayed as a working link), 1-hour expiry, single-use with every sibling token invalidated on use, marked used only after the password change succeeds (a failed update doesn't burn the link), anti-enumeration on both the request and the rate-limit-refusal path (same `ok()` response regardless), rate-limited per-IP and per-email on request, per-IP on confirm, and revokes all existing sessions via `admin.signOut(user, "global")` after a successful reset (the one real gap the authors found and fixed in the same commit — Supabase's `updateUserById` alone does not do this). MFA backup codes: 8-char codes from a 33-character no-ambiguous-glyph alphabet, SHA-256 hashed, single-use, rate-limited 5/10m per IP, requires an already-established AAL1 session (password already checked) to redeem, and correctly disables MFA entirely on redemption rather than attempting to fake an AAL2 assertion Supabase never issued. Both `password_resets` and `mfa_backup_codes` have RLS enabled with `revoke all from anon, authenticated` — no client path exists outside the service-role server actions.

---

## Not independently re-verified (time budget)

Per the brief's own allowance to prioritize depth on items 1-2: item 3 (vendor self-creation `2628969`, FM/PM journeys `799b2ae`/`f3e7e43`, tenant payment screen `ac98534`, bulk finance approval `21e7ed2`, role-based menu consolidation `7f980b4`, asset register 404 fix `629d493`, Day 12 security/NDPA pack `8d3ade1`) was **not independently re-verified** beyond what surfaced incidentally while tracing the item-2 findings above (e.g. the landlord-payout rate-limit call site, the `assert_may_disburse` maker-checker function). `d33aac6`'s chat-channel-parity half (WhatsApp/Telegram now notifying admin/FM the way the portal already did) and the `0138` notification-cleanup trigger were read but not exercised. Scripts (`verify-*.mjs`) were read for what they assert, never executed, per the read-only brief.
