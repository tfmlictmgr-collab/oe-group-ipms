# Tenancy/Lease/Sales Schedule, Portfolio Replication & Money-Chain Controls
### Build Spec v1 · 5 September 2026 · grounded in source (migrations through `0246`) + `private/MANAGEMENT PORTFOLIO.xlsx`
**Classification: Board Confidential · TFML + OEA**

> ## STATUS — built and **applied to dev and staging**, 5 Sept 2026
>
> `verify-portfolio-and-controls.mjs`: **40 checks, all passing** on staging, against real data —
> including `OSBORNE 0001: needs 21000, fund holds 405927.73, short 0`, the exact requisition
> that produced the reported refusal, and `an administrator reads 20 of 20 tenancies on the
> schedule · 19 name their landlord · 15 carry the fee at the rate that applied`.
>
> Regression suites re-run green on staging: `verify-permissions`, `verify-regional-authority`,
> `verify-money-function-grants`, `verify-access-matrix`, `verify-request-visibility`,
> `verify-oea-payment-chain`, `verify-collections`, `verify-ledger`, `verify-leases-and-rent`.
>
> Two suites needed honest amendment rather than a pass: `verify-regional-authority` asserted
> decision 26's "the regional manager alone", which decision 29 supersedes (the load-bearing
> half — the facilities manager holds neither — was split out and kept); `verify-ledger`
> matched the refusal's prose, which `0247` rewrote.
>
> ### One extra migration the suite forced
> `0255` — `verify-portfolio-and-controls` failed on its first run against dev with
> *"the FACILITIES manager holds leases.write"*. `0249` re-propagated only `property_manager`,
> copying `0246`'s pattern — but `0246` only ADDED to one role, whereas `0249` makes a claim
> about two, and re-propagating only the winner left the loser as `0090` had seeded it. That is
> `0185`'s lesson repeated: written against the diff rather than against the rule. `0255`
> re-propagates **every** row nobody deliberately moved, and asserts zero drift on the way out.
> Dev carried 6 such rows; staging carried none — which is the point.
>
> ### Four follow-ups closed, 5 Sept 2026
>
> **1 · The 62 postings-less ledger entries — investigated and corrected.** Not a money-path
> defect: verification debris. 62 `payment_intent` entries whose intent had been deleted (the
> reference format `verify-tenant-rent-payment.mjs` mints), and 14 `ops_requisition` entries for
> ₦0.00 `REQ-…-DISBURSE` probe fixtures. They survived because two correct guards left a gap
> between them — `block_ledger_mutation` permits service-role deletes (or no suite could tidy up),
> and `assert_entry_balanced` exempted the empty case outright, unable to tell "the entry went and
> its postings with it" from "the postings were deleted and the entry left behind". `0256` removes
> the debris and closes the gap; `0257` withdraws the half of `0256` that went too far.
> ⚠️ `0256` also added a check requiring an entry to have postings by COMMIT — which `verify-ledger`
> immediately failed, because a **manual journal entry** through the API is necessarily two
> transactions. It was hardening against something that had never happened (the debris was entirely
> deletion-side) and it removed a good path rather than narrowing a bad one. Withdrawn in `0257`.
> Both worlds now carry **0** postings-less entries on live orgs, and the suites that used to leave
> them can no longer do so.
>
> **2 · What demo activity reveals the audit trail.** Nothing was needed — it had already fired.
> 13 `payment_approval.decision` rows landed on staging at 04:23 when `verify-oea-payment-chain`
> ran; the portfolio suite had simply run *before* it. The four actions and what triggers each:
> `payment_approval.decision` (approve, refuse or send back at any stage) · `payment_approval.superseded`
> (a send-back retiring the rung below, or an amount change) · `ops_requisition.raised` (Raise a
> requisition) · `ops_requisition.status_change` (approved / refused / returned / remitted), plus
> `payment.resubmitted_after_return` when a raiser resends. 📌 The suite now tells **silence from
> failure**: an empty trail is only a FAIL if a decision was recorded *after* `0251`'s `applied_at`
> and left no audit row. It was previously a hard FAIL on any empty trail, which is wrong on a
> freshly-migrated world and is why dev went red.
>
> **3 · The standard is ISO 41001 §7.5.** Board-confirmed. Every reference repointed —
> `CLAUDE.md` decision 34, this document, and `0251`'s header (prose only; that migration did
> nothing about either standard). The three remaining mentions of 41016 are the correction itself
> explaining why it is not the basis.
>
> **4 · `records.export` enabled for the administrator, the property manager, the regional manager and the payment approver**, on **TFML and OEA**,
> through `set_role_permission` as a signed-in operator administrator — so `set_by` and the audit
> row name a person rather than "platform (service role)". Verified as the users themselves, on both worlds:
> admin `true`, PM `true`, RM `true`, payment approver `true`, **facilities manager `false`**,
> **payment officer `false`**.
> The B7 baseline is untouched and still OFF for every role, so this is a badged,
> one-click-revocable deviation, not a reversal of `0239`.
> ⚠️ The **payment officer** is admitted by the ROUTE's role gate but holds no capability, so they
> meet an accurate refusal naming the switch rather than a flat 403 — the two-gate layering working.
> That is deliberate and not an oversight: they RELEASE money, and pulling a tenant roster out of
> the platform is a different act that stays separately granted. The **payment approver** — the
> senior accounting desk, which holds everything the officer holds except disbursement — does have it.
> ⚠️ Deliberately **not** enabled for *OE Group — Foundation POC* or *Service Charge Client*:
> turning on bulk PII export for a client organisation is that client's decision, which is `0239`'s
> own framing ("only when asked"). Say the word and it is one command.
> 📌 This broke the suite's own assertion, which tested the *effective* permission and would have
> made a legitimate operator decision look like a regression. It now asserts the **baseline** via
> `b7_grants` and separately checks that anything granted has a **person** behind it — a grant with
> `set_by` null would be drift and still fails.
>
> ## Original plan status (superseded by the above)
>
> | Migration | Decision | Dry-run against live staging schema + data |
> |---|---|---|
> | `0247_the_service_charge_fund_belongs_to_a_property` | 27 | ✅ clean; reallocation verified, the reported ₦21,000 requisition now `sufficient: true` |
> | `0248_a_chain_may_be_one_stage_and_only_the_operator_says_so` | 28 | ✅ clean; every org unchanged, `single_stage` resolves to one rung |
> | `0249_the_property_manager_administers_the_money_on_their_own_buildings` | 29 | ✅ clean; PM gains both, FM gains neither, RM unchanged |
> | `0250a_a_payment_can_be_sent_back` | 30 | ✅ enum value, alone (cannot share a transaction with its use) |
> | `0250b_a_refusal_returns_the_payment_to_the_desk_before_it` | 30 | ✅ clean |
> | `0251_the_audit_trail_records_the_chain_and_the_requisition` | 34 | ✅ clean |
> | `0252_a_property_is_created_with_at_least_one_unit` | 31 | ✅ clean |
> | `0253_a_receipt_needs_somewhere_to_go` | 33 | ✅ clean |
> | `0254_the_tenancy_schedule_is_generated_not_typed` | 35 | ✅ clean; joins reproduce the workbook against real rows |
>
> App layer: `npx tsc --noEmit` clean, `next lint` 0 errors, `next build` compiles with `/dashboard/schedule` in the route table. `verify-training-guide` is down to 3 pre-existing failures (vendor introductions, `0165`/`0238` — untouched here).
>
> **Owed:** applying the set, and running `scripts/verify-portfolio-and-controls.mjs` against the world it is applied to. `.env.local` currently points at **staging**, which is the world the reported screenshots came from — so where to apply is the board's call, not a default.
>
> **How this document works.** It is written in the same decision-then-implementation style as `CLAUDE.md` so it can be executed across multiple build turns without re-deriving context, and folded into `CLAUDE.md` as numbered decisions once built and verified (continuing the numbering after decision 26). Every claim about current behaviour below was read directly from the migrations/components named — nothing in "current state" is inferred. Four items were board-level judgement calls in tension with existing decisions (7, 2); the user's answers are recorded as the ratified position for each. Migrations should be numbered `0247` onward.

---

## PART A — Ratified decisions

### 27. The client-funds ledger segregates by property, not by org, and its errors say so in plain language
**Current state (confirmed defect):** `ledger_accounts` seeds exactly one row per org per purpose (`ensure_default_ledger_accounts()`, `0169`), so account `2000` ("Service charge funds held") is a single org-wide pooled balance. `canonical_ledger_account(org_id, purpose)` (`0036`) resolves it by `(org_id, purpose)` only — never by property. Every property's SC collections credit the same balance; every property's vendor payables (2200) and ops-requisition payables (2400) debit it. `assert_funds_available()` (`0027:163-170`) raises *"account 2000 would be overpaid by ₦X — a counterparty cannot be paid more than is owed to them"* when the pool is over-committed **org-wide** — so Property A's fully-owed, fully-collected-for requisition can be blocked by Property B's shortfall. This also contradicts decision 2's own words ("a segregated client-funds account, an in-app segregated ledger") and decision 25's warning about rent vs. SC never being combined — the ledger already combines every *property's* SC fund into one number.

**Ratified fix — segregate per property:**
- `ledger_accounts` gains a nullable `property_id uuid references properties(id)`. `2000` (service-charge fund), and any future pooled-liability purpose, becomes **one row per property** rather than one row per org; `2200`/`2400` (vendor/requisition payable) stay per-counterparty as today (they were never the problem).
- `canonical_ledger_account(org_id, purpose, property_id default null)` gains the property parameter; every call site that posts against `service_charge_fund` (`recognise_vendor_payable`, `recognise_requisition_payable`, `record_collection`, the SC invoice-generation path) must pass the requisition's/invoice's own `property_id` through. An `org_id`-only call for a property-scoped purpose is now an error, not a silent fallback to a pooled row — a NULL `property_id` reaching a property-scoped ledger lookup is exactly the "meaning-bearing NULL" decision 8 already forbids for `assets.unit_id`.
- `client_funds_position` and every SC/reconciliation report gain a per-property breakdown alongside the existing org total (the org total becomes `sum(property rows)`, never a separately-tracked number — same "one truth" principle as decision 25's rent-vs-SC split).
- **Migration path:** existing pooled 2000 balances cannot be un-mixed retroactively with certainty. Write a one-time reconciliation migration that (a) creates a per-property 2000 row for every property with SC activity, (b) attributes each historical posting to its property from the SC invoice/requisition it originated from (both already carry `property_id` transitively), and (c) where a historical posting cannot be attributed (e.g. a manual journal entry with no property link), routes it to a per-org "unattributed / legacy" property-less row that is flagged in the reconciliation UI and frozen from new postings — visible, not silently absorbed.
- **Clearer error, regardless of account.** `assert_funds_available()`'s message is rewritten to name what actually happened, per account class:
  - Pooled/property-fund shortfall: *"Property {name}'s service-charge fund holds ₦X but this payment needs ₦Y — ₦(Y-X) short. Collect more, or raise this against a different property."*
  - True counterparty overpayment (2200/2400, unchanged class): *"{Vendor/payee name} is only owed ₦X, and this payment is ₦Y — check the invoice/requisition amount."*
  These are two different failure modes today collapsed into one confusing sentence; they get two different messages.
- **Verification:** extend `scripts/verify-...` with a new `verify-client-funds-segregation.mjs` — raise SC collections and a requisition on Property A only, exhaust its fund, then prove a fully-funded requisition on Property B still succeeds (the actual repro of the bug in the screenshot) and that the new error names the right property.

### 28. A single-stage payment chain exists, and only the OE Group operator can turn it on for an org
**Current state:** `payment_chain_stages(org_id)` (`0211`) is the one source of truth every chain function reads from; it currently resolves to exactly two 3-stage shapes (`standard` and `oea`) keyed off the locked `orgs.delivery_brand`. Decision 7 explicitly forbids org-admin control of payment approval; decision 23 went further and removed `delivery_brand` from the very allowlist an org admin can write, specifically because it had become a control. Neither this doc nor the user's request reopens either rule.

**Ratified fix — operator-governed, not org-governed:**
- New column `orgs.approval_chain_shape` (`'standard' | 'oea' | 'single_stage'`), defaulting to the brand-derived value it has today, and — like `delivery_brand` — **absent from every `authenticated` UPDATE allowlist**. It is set only by a new `SECURITY DEFINER` function `operator_set_approval_chain(org_id, shape)`, gated on `caller_is_operator_admin()` exactly like `operator_provision_org`/`operator_org_directory`, and surfaced as a control on the **operator** portal only (`/orgs/[id]` operator detail view), never on the org's own Settings page.
- `payment_chain_stages()` gains a third shape: `single_stage` → one row, `stage_order = 1`, `required_roles = ['payment_approver','executive']` (co-holds unchanged per decision 9), `tier_resolved = true`.
- `apply_chain_outcome_to_payment()` currently hardcodes `if new.stage_order = 3` twice (`0173:42,66`) to mean "final stage → flip to approved." This becomes `if new.stage_order = (select max(stage_order) from payment_chain_stages(payable_org_id))` — the one code change needed; every other consumer (`enforce_approval_rules`, `is_cleared_for_disbursement`, `chain_cleared_before`, `assert_chain_cleared`) already resolves the stage list dynamically and needs no change.
- `lib/approvals/chain.ts`'s `CHAIN_SHAPES` display mirror gains the third shape so the Approvals UI renders a single "Payment approval" row instead of three, for orgs on it.
- **Every capability this doc grants that's bounded to "property manager / regional manager can raise, finance approves" (decisions 29–30 below) works identically whichever shape an org is on** — they operate above the chain, not inside it.
- **Verification:** `verify-oea-payment-chain.mjs` gains a single-stage-shape section; a new negative test proves `set_role_permission`/any org-admin-writable path cannot change `approval_chain_shape` (the same anon/authenticated-grant regression class `0204`/`0209`/`0210` kept catching).

### 29. `property_manager` and `regional_manager` can create and edit service charges, leases & rent, and raise client-fund collections on their own properties — `facility_manager` is unchanged
**Current state:** Only `regional_manager` holds `sc.manage` and `leases.write` (`b7_grants`, `0246`); `property_manager` and `facility_manager` share one arm granting neither. Neither role can post to the ledger directly today (no such capability exists — ledger writes are function-gated, not capability-gated), so nothing here changes ledger/disbursement authority.

**Ratified fix:**
- `b7_grants()` gains `property_manager` to the existing `regional_manager` arms for `sc.manage` and `leases.write` **only** — `facility_manager` is deliberately left out of both, a genuine divergence between the two decision-18 peer roles, recorded here as intentional (TFML's FM stays maintenance-scoped; OEA's PM and the cross-brand RM gain the lettings/finance-adjacent authority that matches what they're actually asked to run day to day).
- Both `sc_budgets_insert/update/delete` and `service_charges_insert/update` (decision 26's place-bounded clause: `has_permission('sc.manage') and property_id in (select current_user_property_ids())`) already work unchanged for a newly-granted `property_manager` — the place clause was written generically, so this is a capability-table change only, no policy rewrite.
- **"Raise/request client-fund collections"** for these two roles means: create a `payment_intent`/service-charge invoice against a property they hold (via the existing `raisePaymentRequest`/SC invoicing paths), and **read** the property's own Client Funds report (balances, collections, reconciliation status) scoped through `current_user_property_ids()` — not `ledger_accounts`/`ledger_postings` direct access, not `bank_accounts`, not disbursement. This is deliberately narrower than `oversight_roles()` (decision 16/23's rule that disbursement and ledger posting stay finance-only is untouched).
- New capability read surface: a property-scoped **Client Funds** view (see decision 33) becomes reachable to `property_manager`/`regional_manager` for their own properties, gated the same way `sc_budgets_select`/`leases_select` already are (`current_user_property_ids()`), not by adding them to `oversight_roles()`.
- **Verification:** extend `verify-regional-authority.mjs` with the mirrored `property_manager` cases, and add a negative test that `facility_manager` still gets `sc.manage`/`leases.write` = false, and that neither role can reach `ledger_accounts`/`bank_accounts`/disbursement.

### 30. A rejection returns to the stage before it, not to the void
**Current state:** `apply_chain_outcome_to_payment()` (`0173`) sets the whole payable to `status = 'rejected'` regardless of which stage rejected it — there is no per-stage "send back" logic anywhere for `ops_requisitions`, and for vendor `payments` only `finance_approver`/`admin` can manually reopen a rejected invoice, which restarts the **entire** verification gate from `pending_verification`, discarding whatever stage 1/2 had already cleared.

**Ratified fix — stage-aware return, prior approvals kept as superseded history, not silently reused:**
- New payable status `returned_for_correction` (alongside `pending_verification`/`pending_approval`/`rejected`/`approved`/`remitted`), distinct from a terminal `rejected` — a terminal reject (e.g. the raiser withdraws, or a stage decides the request itself is invalid, not merely incorrect) remains available as a separate action.
- On a "send back" decision at stage *N* (N > 1): the payable's status becomes `returned_for_correction`, `payment_approvals.superseded_at` is stamped on the row at stage *N-1* (and only that row — earlier stages, if any, stay intact and are **not** re-required), and a new pending stage `N-1` row is created addressed to whoever decided that stage last time (the auditor, on an MP/executive return; the PM/FM/RM raiser, on... — see below for stage 1).
- On a "send back" at stage 1 (the audit/first sign-off stage): there is no stage 0 in the chain — "sent back" here means returned to the **original raiser** (the ticket's `sender_id`/the ops-requisition's `raised_by`), who edits and resubmits, which re-creates a fresh stage-1 row (the raiser is not a chain stage, so nothing is "superseded" at their level — the whole `payment_approvals` set for that attempt is superseded and a new attempt begins, exactly like today's resubmit-from-scratch, but now that is the stage-1 case specifically rather than the universal one).
- Corrected item re-climbs the chain **from the returned stage forward only** — a stage-2 return that gets corrected and resubmitted does not force the original stage-1 approver to re-approve; their decision stands, dated, on the trail.
- **The trail stays whole.** `getChainState()` (`lib/approvals/chain.ts:338-448`) already keeps every non-superseded-into-invisibility row queryable regardless of downstream movement (decision-19-era design) — extend it to render superseded rows too, labelled "superseded — corrected and resent," so a viewer sees the *history* of a back-and-forth, not just its current state. This directly answers "approvers should still be able to view the movement, it should not disappear."
- **After payment, the full record stays.** Once `remitted`, the payable already falls out of the *queue* (by design, decision 19/23) but its `payment_approvals` trail, before/after audit rows, and remittance record remain reachable from the payable's own detail page — this doc's decision 35 (below) makes sure that trail is also visible from the Audit Trail page itself, not only the payable's own screen.
- `ops_requisitions` needs the same status column and the same trigger logic as `payments` — today it has none of the reopen path `payments` at least has.
- **Verification:** new `verify-payment-chain-return.mjs` — reject at each of the three stages (both chain shapes), assert the correct addressee gets the returned item, assert earlier-stage approvals are preserved (not re-demanded) on a stage-2/3 return, assert the trail shows every superseded attempt.

---

## PART B — The Excel portfolio, replicated as a live, editable schedule

### What `MANAGEMENT PORTFOLIO.xlsx` actually is
18 sheets. 13 are **property ledgers** — one sheet per neighbourhood/location (Maitama, Wuse, Durumi, Gwarinpa, Kubwa/Dawaki, Karu/Jikwoyi/Kurudu, Asokoro, Lugbe, Citec, Lokogoma, plus `MKH`/`Sheet3`/`Sheet4`), each holding **one or more landlord blocks** (`LANDLORD:` / `PROPERTY ADDRESS:` / `PROPERTY DESCRIPTION:`), each followed by a tenant table. Column shape varies per sheet but is drawn from one consistent set: `S/N · Name of Tenant · Phone · Tenancy Period · Rent p.a. · Service Charge · Amount Paid · Size/Shop No./Floor · Mgt Fee @ N% · Outstanding · Remark`. The mgmt-fee **percentage is set per property** (5% / 7% / 7.5% / 10% observed) — this is decision 14's landlord-override, already schema-supported, just never populated for these real properties. `Remark` free text distinguishes **collected vs. remitted** ("paid and not yet remitted" vs "paid and remitted") — exactly the `rent_roll` collected/net split from decisions 28/29, just kept by hand today. `ENGR ARAH` is a cross-property rent-review sheet for one landlord: **sitting rent vs. proposed rent review** side by side — a renewal-negotiation view that doesn't exist in the product yet. `Sheet1` is a service-charge budget line-item template (item/quantity/frequency/rate/annualised amount) — the exact shape `sc_budgets` line items already take. `Sheet2` tracks **partial payments over time** for one tenant (date + amount per instalment) — an instalment/receipt history the product needs to show per rent charge, not just a single paid/unpaid flag.

### The feature: an auto-generated, editable Tenancy/Lease/Sales Schedule
This is **not** a new source of truth — it is a reporting-and-quick-edit surface over `leases`, `rent_charges`, `payments`, `properties`, `units`, and `landlord`/`property_owner` records that already exist, matching the existing pattern of `landlord_statement`/`property_statement`/`my_rent_charges` (decision 25). Concretely:

- **New route:** `/dashboard/schedule` (or a tab on the existing Records section), reachable to `admin`, `executive`, `regional_manager`, `property_manager` (decision 29), and read-only to `payment_approver`/`payment_audit_approver`/`finance_approver` for reporting — never to `facility_manager` (no lettings authority) or tenants/owners (they keep their own scoped statements).
- **Rows:** one per lease/tenancy, columns mirroring the Excel's consistent set — property (address + description), owner/landlord, unit/size/floor/shop no., tenant name + phone, tenancy period (start/end, computed from `leases`), rent p.a., service charge (from the property's `sc_budgets`, if any), amount paid to date (`sum(payments)` against the lease's `rent_charges`), outstanding (`rent charge − paid`), management fee % (the property's effective rate — org default or landlord override, decision 14) and computed fee amount, status (translating collected-vs-remitted into the existing `rent_roll` `management_fees`/`landlord_net` split, plus lease status: active/expiring/expired/terminated per decision 22's `end_tenancy`), and a free-text remark field mapped onto `leases.notes`.
- **Editable inline:** the remark/notes field, the tenancy period (subject to `leases_write`'s existing guards), and — for a property with no vacant unit — an inline "add a unit" action, closing the dead end in decision 32 below. Rent/fee/paid amounts are **derived, never hand-typed** here (typing a "paid" total by hand is exactly the manually-maintained-spreadsheet problem this feature replaces) — corrections to money figures go through the existing collection/payment/adjustment paths, not this grid.
- **Rent-review view (from `ENGR ARAH`):** for a lease approaching its renewal window (decision 15's 90/60/30-day notice thresholds), the schedule surfaces a "current rent vs. proposed renewal rent" pair, sourced from `leases.escalation_pct`/a new optional `proposed_rent` field a PM/RM can enter ahead of the renewal notice — not an automated escalation (matches decision 21's "no automatic work-order raising" restraint: the register states a number, a person still negotiates and confirms it).
- **Instalment history (from `Sheet2`):** the tenancy detail view (decision 25's per-tenant statement page, `/dashboard/leases/<id>`) already lists receipts joined through the charge — extend it to show a running instalment table (date, amount, running balance) rather than a single paid/outstanding figure, which is what the Excel is doing by hand.
- **Grouping, sorting, search:** three category views (by Property, by Owner/Landlord, by Tenant) over the same underlying rows, each sortable by newest/oldest (tenancy start or last-payment date), and by property id/tenant name/owner name; a text search box matching tenant/owner/property/unit. This is the same `haystack` + `sortKey` pattern already proven on the Approvals board (Part A's approvals-sort defect is fixed there directly; this new page is built with the fix already in place, i.e. **no `.limit(100)` truncation before sort/search** — paginate properly instead).
- **Print & download:** a per-view PDF (via the existing `@react-pdf/renderer` pattern used for statements/receipts) and a CSV export, both **filterable by the same criteria as the on-screen view** before generating — by single owner, single tenant, single property, or a date range — never an unfiltered dump-everything button. This directly answers "can printing be done based on specific criteria instead of printing everything." Gated by the existing `records.export` capability (decision 26 already fixed this to default `false` for everyone; grant it explicitly to `property_manager`/`regional_manager` for their own scope and to `finance_approver`/`payment_approver`/`admin`/`executive` org-wide, mirroring `oversight_roles()`).
- **Downloadable lists:** the plain Tenants list, Properties list, and Owners list (decision 29/33's audiences) each get the same CSV download, individually — not only the combined schedule.

**Verification:** new `verify-tenancy-schedule.mjs` — property/owner/tenant grouping returns the right rows under RLS for each role, sort/search has no truncation, print/export respects the selected filter and denies an unauthorized role, and a property with zero units surfaces the inline add-unit action instead of a dead end.

---

## PART C — The remaining reported defects (no board-level ambiguity — straightforward fixes)

### 31. Adding a unit is compulsory when adding a property; a lease form can add one inline
**Current state:** `PropertyForm.tsx` labels units "(optional)" and the only submit guard is the property name; `saveProperty` never checks unit count; if `saveUnit` fails the property is still saved anyway. Separately, `LeaseForm.tsx`'s unit picker, when a property has zero vacant units, prints inert text — *"add a unit to the property"* — with nothing clickable.
**Fix:**
- `PropertyForm.tsx`: remove "(optional)"; require at least one unit row (type + count) before submit is enabled; `saveProperty`'s server action rejects a zero-unit submission outright (not just a client-side disabled button — the current non-transactional "property saved, units failed silently" path is also closed: unit creation becomes part of the same transaction, or the property row is rolled back on unit failure).
- `LeaseForm.tsx`: the "no vacant units" state gains an inline "+ Add a unit" control that opens the same unit-creation fields `PropertyForm` uses (type/count/space), calls `create_units`/`saveUnit`, and repopulates the vacant-units dropdown on success — no navigation away from the tenancy form.

### 32. Approved tenancy applications get their own permanent list
**Current state:** `/dashboard/people/tenancy` and its badge count both filter to `status in ('submitted','under_review','info_requested')` — the instant an application is `approved` or `rejected` it vanishes from every view; no "approved" list exists anywhere.
**Fix:** add an **"Approved Tenant Applications"** tab alongside "Tenancy Applications" (`SubNav.tsx`), querying `application_overview` filtered to `status = 'approved'`, sorted newest/oldest, searchable by applicant/property — reachable to the same reviewers (`property_manager`, `regional_manager`, `admin`, per decision 11's per-property review). A parallel "Rejected" filter is worth the same one-line query, included here since the pattern is identical and the gap is the same.

### 33. Client Funds Collections states whose money it is, splits by audience, and its export respects a filter
**Current state:** one screen, one combined `payment_intents` table mixing `service_charge`/`rent`/`deposit` (tenant-origin) with `"other"` (vendor/generic-client, explicitly called out in the UI copy itself) and no owner-vs-tenant separation; no print/export exists at all on this page today.
**Fix:**
- Add a segmented control/tabs: **Tenants** (service charge, rent, deposit collections) / **Owners & Vendors** (the "other"/international-payment card, landlord-side receipts) / **All**. Same underlying `payment_intents` table, filtered by `purpose`/counterparty type — no schema change needed, this is a query-and-UI split.
- Add filtered print/export here too (same mechanism as Part B's schedule export): by tenant, by owner, by property, by date range, before generating — never the whole table.
- **Receipt email:** confirmed no email is ever sent today — the webhook handler posts to the ledger and stops; the only receipt artifact is an authenticated, on-demand PDF at `/api/receipts/[intentId]`. Add an actual email send (Resend, matching the B8/B3 stack already used for invitations and application notices) on successful webhook confirmation, to the payer's stored email, carrying either the PDF as an attachment or a link to the authenticated receipt route — a payer without a portal login (a one-off collection) needs the attachment, not just the link.

### 34. Sticky table headers
**Current state:** `components/ui/table.tsx`'s `TableHeader`/`TableHead` use no `sticky` positioning anywhere in the app; confirmed by grep, the string "sticky" appears once, unrelated, in the app chrome.
**Fix:** add `sticky top-0 z-10` (with the existing background token, so it doesn't go transparent over scrolled rows) to `TableHeader` in the shared primitive — one change, inherited by every dashboard list page (Approvals, Rent Roll, Applications, Collections, People, the new Schedule) rather than fixed per-page.

### 35. The Audit Trail shows the payment chain's own decisions and the ops-requisition lifecycle
**Current state:** `audit_log` reliably captures `payments`/`remittances` status transitions and ~60 tables' config/master-data writes, generically, via `log_audit()`. It has **no trigger at all** on `payment_approvals` (so no individual stage-1/stage-2/stage-3 decision — including every reject — appears on `/dashboard/audit`) and **no trigger at all** on `ops_requisitions` (so a requisition's entire raise → review → approve/reject/return lifecycle is invisible there too). This is precisely the gap that makes "who approved this and when" — the one thing an auditor opens this page for — absent for the record type that matters most.

**The standard is ISO 41001 §7.5 — board-confirmed, 5 Sept 2026.** The request named ISO/TR 41016:2024. Checked rather than accepted: that TR is *"Facility management — Overview of available technologies"*, a catalogue of FM technology categories. It does not specify what an audit trail must capture, so it could not be the basis of a record-keeping control. The board has confirmed the intended reference is **ISO 41001**, whose **§7.5 Documented information** governs the creation, control, retention and protection-from-alteration of records — which this schema already satisfies structurally (`audit_log` insert-only, `prevent_audit_mutation` refusing UPDATE and DELETE, `actor_id` + timestamp + before/after diff on every row). All references have been repointed accordingly.

**Fix:**
- Add `audit_payment_approvals` (insert + update, calling `log_audit('payment_approval.<action>')`) and `audit_ops_requisitions` (insert + status-change) triggers, mirroring the existing `audit_payments`/`audit_remittance` pattern exactly.
- Add both to `ENTITY_FILTERS` (`lib/audit-format.ts`) so they're selectable on the Audit Trail page, and to the audit page's role-scoping (already keyed off `oversight_roles()`/`request_read_all_roles()` — no new access-control work, just new rows flowing through the existing pipe).
- Every reject/return/re-approve introduced by decision 30 flows through this same trigger automatically once it exists — no extra wiring needed for the new stage-aware states.

**Verification:** extend `verify-request-visibility.mjs` or add `verify-audit-completeness.mjs` — raise a requisition, move it through reject/return/approve/remit, and assert every transition appears on `/dashboard/audit` with the correct actor and before/after state.

---

## PART D — Training manual updates
`lib/guides/content.ts` (`ROLE_GUIDES`) and `lib/guides/processes.ts` (process walkthroughs), rendered at `/dashboard/guide` and verified by `scripts/verify-training-guide.mjs`, need new/updated sections for:
- `property_manager`/`regional_manager`: the new SC/lease/collection-raising rights (decision 29) and the new Schedule page (Part B).
- Everyone in the payment chain: the stage-aware return flow (decision 30) — what "returned for correction" means and who it lands on.
- Whoever raises requisitions: the per-property fund segregation (decision 27) — why a requisition can be short even when the org overall looks funded, and the new clearer error text.
- Reviewers: the new Approved Tenant Applications tab (Part C.32).
- Finance/reception staff: the Client Funds tenant/owner split and the (new) receipt email behaviour (Part C.33).
- The operator-only chain-shape control (decision 28) documented in the **operator** guide only, not the org-admin guide (it isn't org-admin-reachable).

---

## PART E — Build order
1. **Migrations `0247`+**: ledger per-property segregation (27) → chain shape column + function (28) → B7 capability grants (29) → payment_approvals/ops_requisitions status + trigger additions for return-routing (30) and audit triggers (35) → unit-compulsory constraint (31).
2. **Server actions / RPC call-site updates**: every `canonical_ledger_account` caller now passes `property_id`; new `operator_set_approval_chain`; new reject-vs-return actions on the approvals actions file; `raise_ops_requisition`/lease/property actions updated for the transactional unit requirement.
3. **UI**: Approvals reject/return controls + trail rendering of superseded stages; Schedule page (Part B); Applications approved/rejected tabs; Collections tenant/owner split + export; sticky table header (one-line, do this early, it's free); inline add-unit in Record Tenancy.
4. **Verification**: the six new/extended `verify-*.mjs` scripts named above, plus a full re-run of `verify-oea-payment-chain`, `verify-regional-authority`, `verify-request-visibility`, `verify-vendor-self-service` (money/access suites this touches indirectly).
5. **Docs**: fold the ratified decisions into `CLAUDE.md` as decisions 27–35 once built and green, exactly as every prior decision in this document was.

`[next: build]`
