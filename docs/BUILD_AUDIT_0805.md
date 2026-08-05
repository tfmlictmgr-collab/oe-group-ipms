# Build Audit — 0805 (incremental) + correctness review

**Date:** 2026-08-05 · **Range:** `4554531..ed042b4` (88 files, ~8,100 insertions — Flutterwave multi-currency, work-order media, dual-source vendor evaluation, chat-webhook dedup, Day 11 UX pass, plus PC2's executive-oversight/SC-budget/favicon work).
**Auditors:** `build-auditor` (security/efficiency, read-only static) + `/code-review` (correctness) — PC2.

> **Shared for PC1 to verify & action.** Fix directions are **suggestions for review, not applied changes**.
> **Two HIGHs, both worth fixing before this goes further:**
> 1. **Work-order media storage RLS is org-scoped, not ticket-scoped** — contradicts the migration's own stated design; any authenticated org member can read any other ticket's private photos directly via Supabase Storage, bypassing the correctly-built table policy entirely.
> 2. **The new vendor-evaluation composite score never reaches the payment gate or BI** — both still read the legacy generated column, which the dual-source design now structurally undercounts (each half-row coalesces its missing dimensions to zero). A vendor with genuinely excellent work can be auto-rejected by the KPI gate reading data the new schema didn't intend it to read.
> **The 0804 fixes are all genuinely closed** — S1 (double-remit race) verified with a real concurrent-connection test, not a rubber stamp; S3 closed differently than expected (a sounder fix than originally suggested) — see below. D1 remains open by disclosed, deliberate deferral, not a miss.
> **Flutterwave — the money-path headline of this window — came back clean**, the most thoroughly checked area: currency segregation, idempotent posting, and amount/currency trust all hold.

## Part B — Correctness review (`/code-review`, 4554531..HEAD)

| # | Sev | File:line | Finding | Fix direction |
|---|-----|-----------|---------|---------------|
| C1 | Med | `app/dashboard/sc/actions.ts:58` (PC2's own code) | **`createBudget`'s duplicate-period guard is a read-then-insert race** — `sc_budgets` has no unique constraint on `(property_id, period)`. Two concurrent submits create two budgets; both invoiced → every unit billed twice. Same class as 0804-S1; the codebase already solves it correctly one table over (`rent_charges_one_per_period`). | Add `unique (property_id, period)` to `sc_budgets`. |
| C2 | Med | `app/dashboard/tickets/[id]/media-actions.ts:69` | **`getMediaUrl` signs a client-supplied path against org-wide storage RLS**, not the ticket-scoped row policy it claims to inherit — the same root cause as audit's H1 below, found independently from the correctness angle. | Resolve the path through `ticket_attachments` (RLS-scoped) by attachment id; sign only what that returns. |
| C3 | Low | `app/dashboard/tickets/[id]/media-actions.ts:112` | **`removeAttachment` ignores the storage-removal error** — reports success while the file may still be in the bucket, the exact "stranded file" outcome its sibling function works to prevent. | Log/surface the storage error instead of discarding it. |

---

## Part A — Security / efficiency audit (`build-auditor`)

# Stage 0805 — Incremental audit, 4554531..ed042b4

Scope: 88 files / ~8,099 insertions, 516 deletions. Flutterwave multi-currency collections, work-order photo/video evidence, dual-source vendor evaluation rubric, chat-webhook dedup, Day 11 UX pass (confirmation dialogs, loading states, accessibility), PC2's own work (executive-oversight read-widening, SC budget creation, chart rework, per-org favicon), plus verification of the six 0804 fixes landed in `e8dabdf`/`0102`.

Read-only review. Every finding below is verified against the actual migration/route/action code at HEAD `ed042b4`, not inferred from comments or commit messages.

---

## Prior fixes verified (0804)

### 0804-S1 — `create_rent_remittance` double-remit race — **CLOSED**

`supabase/migrations/0102_rent_remittance_lock_and_gate.sql:98-162`. The aggregation now locks candidate `rent_charges` rows in a subquery (`for update of rc`, ordered by `id` so concurrent callers queue rather than deadlock) before summing; the closing `UPDATE` re-checks `remitted_at is null` and the function raises if `GET DIAGNOSTICS ... row_count` doesn't match the number of rows it aggregated. All three parts of the fix the migration's own comment promises are actually present in the SQL.

Verified as a real fix, not a paper one: `scripts/verify-remittance-race.mjs` drives two genuinely overlapping Postgres connections (`pg` client, not `supabase-js`) — `A: begin; call; ` blocks `B: call` for 2.5s, confirming the lock is held, then asserts exactly one `remittances` row exists after both resolve. The suite's own comment records that it was run against the pre-fix function first and reported "THE SAME RENT WAS REMITTED TWICE," and explicitly flags its own "did B block" check as weak/diagnostic-only, resting the real assertion on the post-hoc row count — a well-reasoned test, not a rubber stamp.

### 0804-S2 — vacuous `rent_charges_remittance_uidx` — **CLOSED**

`0102_rent_remittance_lock_and_gate.sql:178-197`. The unique-on-primary-key index is dropped and replaced with a genuinely useful partial index (`rent_charges_unremitted_idx (org_id, lease_id) where remitted_at is null`); the column comment on `remitted_at` is corrected to name the `for update` lock (not an index) as the actual guard.

### 0804-S3 — `remittance.execute` capability never seeded — **CLOSED, by a different (reasoned) fix, not by seeding the capability**

`0102_rent_remittance_lock_and_gate.sql:40-66,168-176`. `remittance.execute` was deliberately **not** added to `capabilities` — the migration's comment cites locked decision 7 (remittance execution is one of the controls that must never become a toggle) and notes `payment.remit` already exists, locked, for this exact act; adding a second, delegable name for the same act was rejected as the wrong fix. Instead: `authenticated` is revoked outright (`create_rent_remittance` is now `service_role`-only, matching its four siblings in `0041`), and the in-function check is rewritten to name `admin`/`finance_approver` directly rather than a capability that doesn't exist, as defence in depth. `scripts/verify-remittance-race.mjs` section C confirms both halves live: an admin's own session is refused at the grant (not the capability check), and `capabilities` still has no `remittance.execute` row. This is a sound resolution — the underlying "can a real user call this at all" question is answered differently than the 0804 report envisioned, but correctly.

### 0804-D1 — landlord remittance has no application entry point — **STILL OPEN, acknowledged and deferred by design**

Confirmed unchanged: `grep -rln "create_rent_remittance" app/ components/` still returns nothing. `app/dashboard/leases/RentRollActions.tsx` still offers only Activate / Bill rent / Renew (unchanged in this diff). This is not a regression — `docs/BUILD_AUDIT_0804.md`'s own PC1-response table records it explicitly as "Open — by design, for now... scheduled with the owner-statement work (FEATURE_BACKLOG G8) rather than bolted on here," and S3's fix means a UI, when built, has an unblocked path (service-role server action pattern, as `executeRemittance()` already demonstrates for vendor payments). Recorded here for completeness per the audit brief; not re-raised as a new finding since it was already disclosed and deliberately deferred.

### 0804-D2 — Settings → Lettings save broken (missing column grants) — **CLOSED**

`0102_rent_remittance_lock_and_gate.sql:217-222` grants `UPDATE` on the four missing columns to `authenticated`. `scripts/verify-lettings-grants.mjs` genuinely exercises the `authenticated`-role path, not `service_role`: it signs in as `oea.admin@oegroup.test` via `signInWithPassword` (lines 40-52) and writes through that session's own client (line 66, `admin.from("orgs").update(...)`), snapshotting and restoring the org's real values rather than inventing demo data. Section C additionally asserts every column on `orgs` is classified as either allowed or deliberately excluded, so a future column left unclassified fails the suite rather than silently repeating D2. This is a real, non-service-role test of the exact gap that was missed the first time.

### 0804-D3 — `register-telegram-bot.mjs` `delivery_brand`-as-unique-key — **CLOSED**

`scripts/lib/org-lookup.mjs` (new, shared by both registration scripts): `liveOrgForBrand()`/`requireOrgForBrand()` filter to live orgs (`deleted_at is null`), refuse and list candidates on any ambiguity rather than picking, and never silently select one. `register-telegram-bot.mjs` now additionally accepts an org **slug** (the one genuinely unique identifier, 0085) because `delivery_brand = 'direct'` is shared by three live orgs today (POC, SC client, platform operator) — confirmed in the script's own comment and usage string.

### 0804-E1 — cron routes compared secrets with `===` — **CLOSED**

`lib/webhook-security.ts:73-78` adds `secretMatches()` (SHA-256 both sides, then `crypto.timingSafeEqual`, so length isn't leaked either). Both `app/api/jobs/raise-rent-demands/route.ts:34` and `app/api/jobs/lease-notices/route.ts:34` now call it instead of `===`.

**Summary: S1/S2/S3/D2/D3/E1 all genuinely closed, with real (not superficial) test coverage in every case I checked. D1 remains open, but by disclosed, deliberate deferral — not a missed fix.**

---

## New findings (0805)

### H1 — Work-order media: storage-object RLS is org-scoped, not ticket-scoped — contradicts the migration's own stated design and lets any authenticated org member read any other ticket's private photos (High, CONFIRMED)

`supabase/migrations/0106_work_order_media.sql` opens with an explicit design principle for the **table** policy: "Visibility FOLLOWS THE TICKET. It is not re-derived" (lines 9-24), and `ticket_attachments_select` (lines 53-57) correctly implements this via `exists (select 1 from tickets t where t.id = ticket_attachments.ticket_id)` — Postgres evaluates that subquery as the caller, so every clause of `tickets_select` (sender/assignee/vendor/property-scoping/triage) applies automatically.

The **storage** policy for the same feature does not follow this design — it re-derives a different, much broader rule:

```sql
create policy "work order media readable within the org" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'work-order-media'
    and (storage.foldername(name))[1]::uuid = current_user_org_id()
  );
```
(`0106_work_order_media.sql:133-138`) — org membership only, with no reference to `ticket_attachments` or `tickets` at all. Storage objects are the actual bytes; this policy, not `ticket_attachments_select`, is what gates `list()` and `createSignedUrl()`.

The application's own `getMediaUrl()` server action compounds this — it takes a caller-supplied path with **zero DB check**:

```ts
// app/dashboard/tickets/[id]/media-actions.ts:69-75
export async function getMediaUrl(storagePath: string): Promise<ActionResult<{ url: string }>> {
  const supabase = await createClient();
  const { data, error } = await supabase.storage.from(BUCKET).createSignedUrl(storagePath, 300);
  ...
}
```
Its own comment reasons: "the row they got the path from was itself gated by the ticket — a signed URL is a convenience for the browser, not the security boundary." That reasoning only holds if the caller can *only ever* obtain a `storagePath` through a ticket they can already see. They cannot be relied on to: the storage bucket's own SELECT policy has no ticket check, so a path does not need to come from a legitimately-read `ticket_attachments` row at all.

**Concrete scenario.** Upload paths are `{orgId}/{ticketId}/{uuid}.{ext}` (`TicketMedia.tsx:81`). Any authenticated user in the org — a tenant rating their own unrelated ticket, a vendor with no assignment on the job in question, any staff role — can, using the same `NEXT_PUBLIC_SUPABASE_ANON_KEY` and their own session JWT that ships in every page's client bundle (no app code needed — direct Supabase Storage REST calls, or `supabase.storage.from('work-order-media').list(orgId)` from the browser console), enumerate every ticket ID that has evidence in the org, list the filenames under each, and call `createSignedUrl()` for any of them — all without ever passing through `tickets_select` or `ticket_attachments_select`. This is exactly the class of leak the migration's header comment is written to prevent, but the storage layer — which is what actually protects the bytes — does not implement it. Given the feature's stated purpose ("a work-order photo routinely shows the inside of somebody's home," line 107), this is a real, low-effort cross-ticket privacy leak reachable by tenants and vendors, not just staff.

**Untested:** `scripts/verify-work-order-media.mjs` section A thoroughly proves the `ticket_attachments` *table* policy is ticket-scoped (own tenant sees it, unrelated tenant/FM does not) — but the suite never once calls `.storage.from(...)` for anything beyond `svc.storage.getBucket()` (bucket-config check, line 285). There is no test anywhere in the suite that exercises `storage.objects` SELECT from an unrelated authenticated user's session, so this gap has no coverage in either direction.

Compare: `application-documents` (0062) uses the identical org-only storage-read shape ("staff read their org documents") — but that bucket's *audience* is staff reviewers, a materially different threat model from a ticket's audience (which explicitly includes the individual tenant and vendor the job belongs to, and nobody else). This migration is new, wrote extensive reasoning for exactly the risk it left open at the storage layer, and is where the brief specifically asked me to check.

### H2 — Vendor evaluation composite score does not reach the payment gate or BI it was built to feed (High, CONFIRMED)

`vendor_evaluations.composite_score` is a `GENERATED ALWAYS AS ... STORED` column, unchanged since `0001`:
```sql
composite_score numeric(6,3) generated always as (
  coalesce(quality_score, 0) * 0.30 + coalesce(response_score, 0) * 0.20 +
  coalesce(completion_score, 0) * 0.20 + coalesce(satisfaction_score, 0) * 0.20 +
  coalesce(compliance_score, 0) * 0.10
) stored,
```
This formula was written for the old model: **one row, all five dimensions filled in at once.** `0104_vendor_evaluation_rubric.sql`'s new dual-source design instead writes **two separate half-populated rows per ticket** — `submit_vendor_evaluation()` (lines 425-483) sets `satisfaction_score` alone on the tenant's row, and `quality_score`/`compliance_score`/`response_score`/`completion_score` (never `satisfaction_score`) on the FM/PM's row. Because the generated column coalesces every *missing* dimension to zero rather than leaving the composite unset, each half-row's own `composite_score` is a structurally undercounted number, not a partial-but-honest one: an FM/PM row with a perfect 100 in all four of its dimensions still generates `composite_score = 80` (30+20+20+0+10); a tenant row with perfect satisfaction generates `composite_score = 20`.

The migration itself gets this right where it matters — `vendor_evaluation_tickets` (lines 502-537) computes the correct combined figure and **only populates it once both `fm.id` and `tn.id` exist** (line 526), exactly the "never estimated from a partial pair" discipline the comment describes. `app/dashboard/vendors/[id]/page.tsx` (updated in this diff) correctly reads from this view, and `averageComposite()` correctly filters out the `null`s for pending pairs — the vendor's own scorecard page is right.

But two consumers were not repointed at the new view, and both still read the raw, now-corrupted `vendor_evaluations.composite_score` directly:

- **The payment gate itself** — `app/dashboard/payments/[id]/actions.ts:62-68` (`runPerformanceCheck`, **not touched by this diff**):
  ```ts
  const { data: evals } = await supabase.from("vendor_evaluations").select("composite_score").eq("vendor_id", payment.vendor_id);
  const avg = averageComposite(evals ?? []);
  const passed = avg != null && avg >= threshold;
  ```
  This averages every row for the vendor — legacy full rows (correct) mixed with the new half-rows (each capped at 80 or 20) — and gates whether the vendor gets paid (default threshold 70) on the result.
- **Executive/BI vendor performance** — `bi_vendor_scores` (`0061_bi_aggregates_in_the_database.sql:53-61`, **not touched by this diff**): `round(avg(e.composite_score)::numeric, 1)` over the same raw table, consumed by `app/dashboard/bi/page.tsx`.

**Concrete scenario:** a vendor completes a job with genuinely excellent work — FM/PM gives full marks on quality and compliance, on-time response and completion (composite via the correct view: 100); the tenant separately gives full marks on satisfaction (also 100 via the view). The two *raw* rows behind that pair generate `composite_score` of 80 and 20 respectively. `runPerformanceCheck` averages the vendor's raw rows — for a vendor with only new-style evaluations, this pulls the average toward roughly (80+20)/2 = 50 per completed pair, well under the 70 default threshold, and the payment for genuinely excellent work is auto-rejected (`status = 'rejected'`) by a KPI gate reading data the new schema never intended it to read. The reverse failure mode also exists (a vendor with only one-sided fm_pm-only evaluations sitting at a deceptively-plausible-looking ~80 cap, never actually assessed on satisfaction) — either way, the number the payment gate and the BI dashboard now compute is not the number the feature that superseded the free-typed form was built to produce, and nothing in this diff updated either consumer to read `vendor_evaluation_tickets` instead. The brief for this feature explicitly states it "FEEDS THE PAYMENT GATE" — as shipped, the gate is not fed by it; it drinks from an upstream table that Day 11 changed the meaning of underneath it.

### M1 — Chat webhook dedup key is not scoped per bot/org; Telegram `update_id` collisions across different orgs silently drop messages (Medium, CONFIRMED)

`supabase/migrations/0105_chat_webhook_dedup.sql:30`:
```sql
create unique index chat_webhook_events_dedupe_uidx on chat_webhook_events (channel, event_id);
```
`org_id` is a column on the same table and is populated on every insert (`app/api/webhooks/telegram/route.ts:59`, `app/api/webhooks/whatsapp/route.ts:131`) but is **not part of the unique key**. For WhatsApp this is harmless — `message.id` (the `wamid`) is globally unique across the whole WhatsApp network, per Meta's own ID scheme, so `(channel, event_id)` alone can never collide across orgs. For Telegram it is not harmless: `update_id` is a small, **per-bot** sequential integer assigned independently by each bot's own Telegram session — two different orgs' bots (this codebase already runs several, per `scripts/register-telegram-bot.mjs`'s own comment about TFML/OEA/POC all being live) will routinely reach the same `update_id` value, especially at low-to-moderate traffic where both sequences sit in similar small ranges.

`app/api/webhooks/telegram/route.ts:57-68` treats any unique-key violation on this table as "already handled" and returns 200 without ever calling `handleInboundMessage`:
```ts
const { error: dupErr } = await supabaseAdmin.from("chat_webhook_events").insert({
  channel: "telegram", event_id: String(payload.update_id), org_id: route.orgId,
});
if (dupErr) {
  if (dupErr.message.includes("duplicate key")) {
    console.log("Duplicate Telegram delivery, already handled:", payload.update_id);
    return new NextResponse("OK", { status: 200 });
  }
  ...
}
```
**Concrete scenario:** Org A's Telegram bot processes `update_id = 42` for a real tenant message on day one. Weeks later, Org B's (different, unrelated) Telegram bot independently reaches `update_id = 42` in its own sequence when a tenant of Org B sends their first-ever message. The insert for Org B collides with Org A's already-recorded row (`('telegram', '42')` is already taken), the handler logs "Duplicate Telegram delivery, already handled: 42" and returns 200 — Org B's tenant's message is silently dropped: no ticket, no classification, no reply, and the log line gives no indication this was a false positive rather than a real Telegram redelivery. This directly undermines the fix's own stated purpose (the docstring's own worked example is a message that was *not* deduplicated and sent six times) by introducing the opposite failure in a different channel: a message deduplicated when it should not have been.

Fix direction (not applied, per the read-only brief): include `org_id` in the unique index (`(channel, event_id, org_id)`), or route Telegram's index off `(channel, org_id, event_id)` specifically since org identity is already resolved and attached before the insert.

### M2 — `app/favicon.ico/route.ts` is a new, unauthenticated public redirect off `orgs.logo_url`, which has no database-level format constraint — a pre-existing gap this route newly exposes as an open-redirect surface (Medium, PLAUSIBLE — not demonstrated end-to-end)

`app/favicon.ico/route.ts:31` (new, `db97bc1`/`d40536a`):
```ts
export async function GET(request: NextRequest) {
  const org = await orgForCurrentHost();
  const target = org?.logo_url ?? new URL("/favicon-default.png", request.url).toString();
  return NextResponse.redirect(target, { status: 307 });
}
```
This is a public, unauthenticated `GET` — any visitor to an org's bound custom domain (`tfmlportal.com`, `oeaportal.com`) triggers it just by the browser's automatic favicon request. `orgs.logo_url` is a plain `text` column with no `CHECK` constraint anywhere it is declared (`0015_org_branding_assets.sql:7`, echoed in `0046`/`0085`/`0089`/`0089b`) — nothing at the database layer restricts its shape. The one validation that exists is entirely in the application layer, in `saveLogoUrl()` (`app/dashboard/settings/actions.ts:72-91`), which correctly restricts a saved value to the org's own Supabase storage prefix:
```ts
const prefix = `${base}/storage/v1/object/public/org-logos/${orgId}/`;
if (!base || !url.startsWith(prefix)) { return fail(...); }
```
But `logo_url` is also one of the columns in the `0083c` `authenticated` UPDATE allowlist (`grant update (..., logo_url, ...) on orgs to authenticated`) — the same table-level grant this build's own "the database is the boundary, the UI is a courtesy" philosophy (stated repeatedly elsewhere, e.g. `0103`'s opening-balance currency check) says should not be trusted to app-layer validation alone. An admin of their own org, using their own session's Supabase client directly (e.g. from the browser console) rather than the `saveLogoUrl` action, can set `logo_url` to any external URL — `supabase.from('orgs').update({ logo_url: 'https://attacker.example/x' }).eq('id', myOrgId)` is accepted at the database layer with no format check. Before this window, the only consequence was an `<img src>` on that org's own branding pages. `favicon.ico/route.ts` turns the same value into a public, unauthenticated, **trusted-domain redirect** — every visitor (including prospective tenants browsing the public portal, not just signed-in admins) who requests `<their-custom-domain>/favicon.ico` is redirected to whatever URL is stored there.

This is a real gap traced through the code, not demonstrated by an actual write against the running database (out of scope per the read-only brief). It requires an admin-level actor to originate the malicious value (self-inflicted in the narrow case, but it then affects every visitor of that org's legitimate domain, which is the concerning part — a trusted-domain open redirect is a standard phishing primitive precisely because the initial click is on a domain the victim already trusts). The root cause (no DB-level constraint on `logo_url`) predates this window; this new route is what turns it into a live redirect surface.

### L1 — `retire_evaluation_criterion()` leaves no audit trail — no `audit_log` entry, no `updated_at`/`updated_by` on the row itself (Low, CONFIRMED)

`0104_vendor_evaluation_rubric.sql:99-100` attaches `audit_evaluation_criteria` only to `after insert`. Creating a criterion (`ensure_default_evaluation_criteria`) and editing one (`edit_evaluation_criterion`, which works by inserting a new superseding row) both fire it. `retire_evaluation_criterion()` (lines 161-181) does a bare `update evaluation_criteria set active = false where id = p_id` — no insert, so no audit trigger fires — and `evaluation_criteria` has no `updated_at`/`updated_by` columns at all. The row persists (nothing is deleted), so *that* a criterion was retired is discoverable by reading the table, but **who retired it and when** is not recorded anywhere queryable. Minor: the rubric is non-sensitive checklist wording, not money or access control, and the table's append-mostly shape means nothing is silently lost — but it's a narrower audit guarantee than the migration's own stated ethos ("same ethos as the ledger... corrections are reversing entries, never edits") implies for the rest of the feature.

---

## Areas reviewed and found clean

- **Flutterwave / multi-currency ledger (0103)** — the money-path headline of this window, and the most thoroughly checked. Per-currency chart of accounts (`ledger_accounts.currency`, format-checked); `bank_accounts_one_client_funds_per_currency_uidx` correctly changed from one-per-org to one-per-(org,currency); both resolver functions (`canonical_ledger_account`, `collection_bank_account`) take an explicit currency parameter defaulting to `'NGN'` so every pre-existing 1-argument caller is unaffected (confirmed via `grep`, and the migration's own comment records the ambiguous-overload failure this avoided); `client_funds_position`/`ledger_account_balances` now group by `(org, currency)` instead of `org` alone, closing the "sum Naira and Dollars together" risk the migration's own comment identifies as the sharpest edge of the whole change; `record_opening_balance` now refuses cross-currency allocation lines at the DB layer, not just in the UI picker. The webhook route (`app/api/webhooks/payments/[gateway]/route.ts`, unchanged this window) verifies Flutterwave's `verif-hash` in constant time, resolves the intent by our own reference (never the payload), takes the amount from a server-to-server `verifyTransaction()` call (never the payload), and posts via `record_collection`'s existing `ledger_entry_id`-is-null idempotency guard — exactly-once posting is preserved across currencies. No path found where a service charge or rent charge (Naira-only by design, decision 15) can be raised in a foreign currency — the FX collection form (`CollectionsClient.tsx`) is a separate ad-hoc ("other") flow with its own currency picker; the service-charge/rent `raise()` path never passes a currency and defaults to NGN. `FlutterwaveAdapter.transfer()`/`createRecipient()` both hard-refuse (B3: collections-only), so no FX payout path exists to get wrong.
- **`app/dashboard/settings/CurrencyAccountsManager.tsx` / `bank-actions.ts`** — admin-gated, idempotent currency enablement, currency fixed at account creation (cannot be edited into orphaning historical postings), ledger account resolved server-side via `canonical_ledger_account` rather than a `.limit(1)` pick.
- **Vendor evaluation write path (0104)** — cannot be forged: `evaluation_responses` has no INSERT policy at all (write only through `submit_vendor_evaluation()`), which computes every `points_awarded` from a fixed response-type→fraction mapping and raises on any value outside `met/partial/not_met`, `yes/no`, `1`-`5` — a client can propose a response *value*, never a point total. Standing to evaluate is checked inside the same SECURITY DEFINER function (tenant = the ticket's own `sender_id`; fm_pm = oversight role or an FM/PM scoped to that vendor) — a vendor cannot evaluate itself (vendor is in neither role set). Dual-source requirement is enforced at the DB (the view), not just the UI. SLA scoring uses the criterion version active *at ticket resolution*, with a documented, deliberate fallback to the earliest version for tickets that resolved before any rubric existed — read the reasoning and agree with it.
- **PC2's own work, `bd3fcb1`** — the executive-role nav widening (`isStaff`, `seesAudit`, `seesAssets`, `seesLedger`) is read-only and verified to match pre-existing DB grants, not a new escalation: `executive` was already in `oversight_roles()` (`0072a_oversight_read_policies.sql:15`, predates this window) and already covered by `biScope()`/`enforce_payment_transition()`; the nav change is UI catching up to policy that already existed, exactly as the commit message claims — checked, not just trusted. `sc/actions.ts`'s `createBudget()` runs under the caller's own session (RLS-enforced `sc.manage` check via `sc_budgets_insert`), not service role — no escalation.
- **Day 11 UX pass (`7896f49`, `ed042b4`)** — `AlertDialog` confirmation on `approvePayment`/`executeRemittance` is purely a client-side UX layer in front of the same, unchanged server actions; `amount`/`vendorName` are passed only for display copy (React-escaped, no injection surface) and play no role in authorization. No scoping regression found in the touched files.
- **`gateway_events`/`payment_intents` dedup (pre-existing, payments)** — re-confirmed as still correctly org-agnostic-safe: Paystack/Flutterwave references are globally unique by construction (our own `newPaymentReference()` generator), unlike Telegram's `update_id` — see M1, which is specific to the new chat table, not this one.

---

## Not independently re-verified (time budget)

`scripts/verify-fx-collections.mjs` and `scripts/verify-vendor-evaluation.mjs` were read for what they assert (both informed the findings above) but not executed (read-only brief; local env may hit the dev DB). The full accessibility-audit portion of `ed042b4` ("an accessibility audit that found real failures") was not re-derived from scratch — it is UI/a11y, not an auth or money-path surface, and out of this pass's priority order. `AnalyticsCharts.tsx`/`Charts.tsx` visual/data-viz correctness (chart type choice, axis scaling, color contrast) was taken on the commit message's own validator numbers rather than independently recomputed — those are presentation-correctness claims, not access-control ones.
