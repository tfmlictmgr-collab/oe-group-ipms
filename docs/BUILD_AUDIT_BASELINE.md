# Baseline Defensive Audit — OE Group IPMS (Days 0 → 6.75)

**Date:** 2026-07-28
**Auditor:** build-auditor (read-only static review)
**Scope confirmed from:** `docs/PHASE1_WORKPLAN.md` status board (Days 0–6.75 🟢 done; Day 7+ ⬜ not built), `docs/BUILD_JOURNAL.md`, `git log` (HEAD `0cc4d32`, branch `phase-1`).
**Method:** static read of `supabase/migrations/0001–0056`, `lib/`, `app/` server actions and webhook routes. No code executed; no `verify-*.mjs` run; no DB writes.

> **Shared for PC1 to verify & action.** Read-only findings from the `build-auditor`
> (produced on PC2). The "Fix direction" under each item is a **suggestion for review,
> not an applied change** — verify each against the current tree before implementing.
> Nothing is Critical or High. Top priority is **S-1** (approval threshold not enforced
> at the DB). This is a point-in-time baseline (Days 0→6.75); later stages get incremental
> audits appended. Running one-line log lives in `build-audit/FINDINGS.md` (PC2-local).

## Headline

The money path is unusually well built for this stage: double-entry ledger with DB-enforced balancing / immutability / no-overdraw / no-overpay invariants (`0027`), exactly-once collection and remittance posting under row locks (`0032`, `0041`, `0049`), server-to-server amount verification on webhooks (never trusting the payload), fail-closed webhook auth in production (`lib/webhook-security.ts`), and a payment state-machine trigger that blocks direct-PATCH gate-jumping (`0010`). Tenant/brand isolation is enforced at the DB via `current_user_org_id()` (read from the `users` table, not spoofable JWT headers) with defense-in-depth middleware. The permission matrix correctly routes the one deliberate cross-org write through a single audited `SECURITY DEFINER` function and split its write policies away from read (`0055`) after catching a real `FOR ALL`-grants-SELECT leak.

Findings below are the residue, not the norm. One Medium is the single most important: **the approval-amount threshold is the only gate control not enforced at the database.**

---

## SECURITY

### S-1 · Approval threshold is enforced only in the server action, not the DB — Medium — CONFIRMED
**Where:** `app/dashboard/payments/[id]/actions.ts:113-129` (the `approval_threshold_amount` check) vs the DB trigger `enforce_payment_transition()` in `supabase/migrations/0010_money_integrity_hardening.sql:46-53`. Column defined in `supabase/migrations/0004_payment_settings.sql:8`.

**What:** Every other stage of the B4 gate is re-checked in the database and therefore holds against a direct PostgREST call (this is the system's stated design principle — `0010` header comment, `0041` header comment). The **amount threshold is the exception.** `enforce_payment_transition()` restricts the `recommended → approved` transition to `caller_role in ('finance_approver','admin')` but never compares `payment.amount` against `payment_settings.approval_threshold_amount`. The "above the limit requires an administrator" rule lives *only* in `approvePayment()` (`actions.ts:124`).

**Scenario (CONFIRMED against code):** A `finance_approver` — who legitimately may approve up to the threshold and may also remit (`executeRemittance` accepts finance) — issues a direct PATCH against PostgREST with their own JWT:
`PATCH /rest/v1/payments?id=eq.<id>` body `{"status":"approved","approved_by":"<self>","approved_at":"..."}` on a `recommended` payment whose amount is **above** the org's `approval_threshold_amount`. `payments_update` RLS (`0012`) permits a finance_approver to update payments in-org; the trigger permits finance → approved for any amount. The payment is approved without the second (admin) sign-off the threshold is meant to force, and the same user can then remit it. The control that exists specifically to require a higher approver for large sums is bypassed.

**Why it matters:** This is a segregation-of-duties control on the largest disbursements, and it is the one gate condition the DB does not back. Workplan security call **S2** explicitly asked for `approval_threshold_amount` to be *"an enforced control rather than display-only"* at the DB layer; that half shipped in the app but not in the trigger. Requires an authenticated insider in the finance role plus a hand-crafted API call (not reachable from the UI), which is why it is Medium rather than High — but it directly contradicts the "the DB, not just the server action, enforces the gate" guarantee the rest of the money path upholds.

**Fix direction (not applied — review only):** add to `enforce_payment_transition()` on the `approved` branch: if `new.amount > (select approval_threshold_amount from payment_settings where org_id = new.org_id)` then require `caller_role = 'admin'`.

---

### S-2 · `units` insert does not verify the target property belongs to the caller's org — Low — PLAUSIBLE
**Where:** `app/dashboard/properties/actions.ts:71-115` (`saveUnit`) and `:166-214` (`commitUnitImport`); RLS `units_insert` in `supabase/migrations/0055_write_policies_do_not_grant_read.sql:57-62`.

**What:** `org_id` is stamped server-side from the caller's profile, and `units_insert` checks `org_id = current_user_org_id()` + `properties.write`/`units.assign_occupant`. Neither the action nor the policy checks that the client-supplied `property_id` is a property in the caller's org. A user holding `properties.write` could insert a unit with `org_id = <own>` but `property_id = <another org's property>`.

**Scenario:** Crafted `saveUnit` call (or CSV import) with a foreign `property_id`. The row is created. **Cross-org *reads* do not leak** — `units_select` (`0056:146-157`) and every consumer are scoped to `org_id = current_user_org_id()`, so org B never sees the foreign-org unit, and the service-charge apportionment functions resolve units by property within an org context. Impact is therefore limited to referential-integrity noise (a dangling unit pointing at a property its owner can't see) rather than a confidentiality or money leak. No code path was found that aggregates units by `property_id` without an `org_id` scope, which is why this is Low/PLAUSIBLE rather than a confirmed leak.

**Fix direction:** add `and property_id in (select id from properties where org_id = current_user_org_id())` to the `units_insert`/`units_update` `with check`, or validate the property's org in the action.

---

### Security — checked and clean (no finding)

- **Webhook secret handling / fail-closed:** `lib/webhook-security.ts` fails closed in production when a secret is missing; payment webhooks refuse (403) when the gateway is unconfigured and cannot verify (`app/api/webhooks/payments/[gateway]/route.ts:50-66`). Signatures use `crypto.timingSafeEqual` with length guard. Telegram auth moved to per-bot `channel_routes` secret (`0039`, `0047`).
- **Amount trust:** collections and remittances take the amount from our own record or a server-to-server verify call, never the webhook body (`route.ts:125-138`, `0032` header, `0041`).
- **Exactly-once / idempotency:** intent↔ledger unique index (`0032:66-67`), row-locked `record_collection` / `record_remittance_sent` return the existing entry on redelivery; `claim_remittance_for_sending` row-locks queued→sending so two clicks reach the gateway once (`0041:134-151`).
- **Ledger integrity:** balancing, immutability, no-overdraw, no-overpay all DB-enforced as deferred constraint triggers, service-role-exempt only (`0027`).
- **Tenant/brand isolation:** `current_user_org_id()`/`current_user_role()` resolve from `users` table under `SECURITY DEFINER` (`0001:153-167`); middleware strips client-supplied `x-org-id`/`x-user-role` and re-stamps from the verified token (`lib/supabase/middleware.ts:9-52`); RLS is the enforced backstop, headers are defense-in-depth only.
- **Permission matrix:** cross-org edits routed through one audited `set_role_permission()` `SECURITY DEFINER` fn that checks operator-org + admin and writes an audit row naming both orgs (`0050:208-265`); `has_permission()` denies on anything absent/unknown (fails closed); locked capabilities are never read by policy (stay hardwired); `FOR ALL` read-leak fixed by splitting write policies (`0055`). Note: the `0051`/`0052` `FOR ALL` policies on `vendors`/`properties`/`units`/`sc_budgets` are **superseded by `0055`** — see D-1.
- **Privilege escalation via invitation:** admin-role invitations blocked at both the action (`app/dashboard/people/actions.ts:60-62`) and RLS (`invitations_insert` in `0020`: `current_user_role() = 'admin' or role <> 'admin'`).
- **Account-takeover guard:** `provisionInviteAccount` refuses to reset the password of an account that has a profile or has signed in (`app/invite/[token]/actions.ts:137-155`).
- **Service-role (RLS-bypassing) call sites** in dashboard actions are each gated by an explicit role check *and* an RLS-scoped read of the target before the admin client is used (`payout-actions.ts:41-59` admin-only + RLS-read of vendor; `ledger/collections/actions.ts:200-235` finance/admin + RLS-read of intent; the remittance functions re-check the whole gate internally). No IDOR found in these paths.
- **Injection:** all DB access is via parameterized supabase-js / RPC; no string-built SQL. LLM triage (`lib/triage.ts`) keeps user text in the `user` role separate from the system prompt, constrains output to enums with a safe fallback, and writes via parameterized insert — prompt injection can at most mis-classify a single ticket, not escalate.
- **Audit coverage of money writes:** payment create/status, vendor-evaluation inserts (KPI gate), SC writes, ledger entries/accounts, permission changes, vendor-property links all audited (`0005`, `0010:76-85`, `0027:233-236`, `0050:255-263`, `0012:33-35`). `audit_log` is read-restricted to admin/finance + self (`0001:299-306`) and has no client insert path.
- **Rate limiting:** both intake webhooks and the invite-provision endpoint are limited (coarse-per-IP + per-sender), fail-open by design for the *abuse* layer while the *auth* layer fails closed — a deliberate, documented split (`lib/rate-limit.ts`).

---

## EFFICIENCY

### E-1 · Executive dashboard pulls whole tables and aggregates in JS — LONG-RUN — Medium — CONFIRMED (truncation risk PLAUSIBLE)
**Where:** `app/dashboard/bi/page.tsx:88-161`.

**What:** On every load the page selects **all** rows of `tickets`, `service_charges`, `payments`, `sc_budgets`, and `vendors`+`vendor_evaluations` (no `limit`, no `range`, no DB-side aggregation) and computes counts / collection rate / liabilities / budget utilisation in JavaScript.

**Scenario:** Fine at demo scale. At 100+ properties with thousands of tickets/charges/payments this is both slow (large payloads over the wire on a serverless cold path) and, more seriously, exposed to PostgREST's default **1000-row cap**: once any of these tables exceeds it, the aggregates silently truncate and the KPIs (collection rate, outstanding, vendor liabilities) **undercount** rather than error. Correctness, not just speed. Marked PLAUSIBLE on the exact truncation because it depends on the project's configured `max-rows` (Supabase default is 1000).

**Context:** Workplan **Day 10** already plans "materialised aggregates for speed"; this widget is the acknowledged static placeholder. Flagged so the 1000-row correctness nuance is on record for that rebuild — an aggregate that is quietly wrong is worse than a slow one.

### E-2 · Unbounded service-request list — LONG-RUN — Medium — CONFIRMED
**Where:** `app/dashboard/page.tsx:19-24`.

**What:** Selects every ticket the caller can see, ordered by `created_at desc`, with no pagination or limit, then hands the full set to a realtime `TicketList`. Same 1000-row ceiling as E-1 (older tickets silently drop off the list once the cap is hit) plus growing memory/transfer cost. TFML alone is described as 700+ staff. LONG-RUN; add `.range()`/keyset pagination before large-tenant onboarding.

### Efficiency — checked and clean

- Ledger balances are a `security_invoker` view over indexed postings, not a drifting stored total (`0027:242-287`); postings indexed by account/entry/org.
- Money resolvers are deterministic and indexed (`collection_bank_account`, `canonical_ledger_account`; `0035`, `0036`, `0049`); one active `client_funds` account per org is enforced (`0028:49-50`), so the earlier `limit 1` in `0032` is moot.
- Bank list is fetched with `next: { revalidate: 86400 }` rather than per-load (`payout-actions.ts:149`).
- No N+1 loops found in the audited server actions; the BI vendor query uses a single nested embed rather than per-vendor fetches.
- Adequate indexes on the hot lookup paths (payment_intents ref, gateway_events, role_permissions, vendor_properties, ledger_*).

---

## DISCONNECTS

### D-1 · The read-leak fix depends entirely on migration `0055` being applied — Low (deployment) — CONFIRMED
**Where:** `0051_policies_read_the_matrix.sql` / `0052_hoist_permission_checks.sql` create `vendors_write`/`properties_write`/`units_write`/`sc_budgets_write` as `FOR ALL` (which grants SELECT); `0055_write_policies_do_not_grant_read.sql` drops and splits them.

**What:** In the *current* full migration set this is correct — `0055` is the last word and the read-leak (holding `*.write` silently re-granting read past the matrix, per `0055`'s own header) is closed. The disconnect is purely operational: **any environment applied only through `0052`–`0054` reintroduces the leak.** Because Day 12's go-live runs the whole migration chain, this is not a live defect, but it is the kind of partial-apply footgun worth a note in the deployment runbook (and an argument for a smoke check that no matrix-governed table carries a `FOR ALL` policy in prod).

### D-2 · Documented open items are config gaps, not code defects — informational
Confirmed consistent between the status board and code, listed here only so they aren't mistaken for findings: management/admin fee % defaults to 0 so nothing is deducted until confirmed (`0027:293-298`, `0041:101-103`); Flutterwave FX keys unset → non-Naira collections refuse cleanly; Resend delivery webhook + Telegram BotFather tokens pending; opening balance placeholder ₦0. Gemini triage failover still absent (degrades to "needs human review", does not fail over) — scheduled Day 12, not yet due.

### Disconnects — checked and clean

- Status board (Days 0–6.75 done) matches `git log` and the migration set (through `0056`).
- Payment gate stages in `lib/payment.ts`, the server actions, and the DB triggers/functions agree on the ordering verify → performance → approve → remit (aside from S-1's threshold gap).
- No hardcoded `DEMO_ORG_ID` remains in the webhooks; channel→org routing is data-driven (`0011`, `channel-routing.ts`, whatsapp/telegram routes).

---

## Severity summary

| Sev | ID | Title | Status |
|-----|----|-------|--------|
| Medium | S-1 | Approval threshold not enforced at the DB | CONFIRMED |
| Medium | E-1 | BI dashboard whole-table JS aggregation (1000-row truncation) | CONFIRMED / PLAUSIBLE |
| Medium | E-2 | Unbounded service-request list | CONFIRMED |
| Low | S-2 | Unit insert doesn't verify property's org | PLAUSIBLE |
| Low | D-1 | Read-leak fix depends on `0055` being applied | CONFIRMED |
| Info | D-2 | Documented config open items | n/a |

No Critical or High findings at baseline.
