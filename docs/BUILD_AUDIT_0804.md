# Build Audit — 0804 (incremental) + correctness review

**Date:** 2026-08-04 · **Range:** `ac3b71e..4554531` (146 files, ~11,900 lines — Days 8.9–10: leases & rent, lease/rent notices, org/brand separation, custom domains, SC client, hierarchy fixes, analytics console — plus the WhatsApp/360dialog migration, separately documented).
**Auditors:** `build-auditor` (security/efficiency, read-only static) + `/code-review` (correctness) — PC2.

> **Shared for PC1 to verify & action.** Fix directions are **suggestions for review, not applied changes**.
> **The money-path headline:** `create_rent_remittance` can double-pay a landlord under concurrent calls (no row lock, unlike every adjacent money function) — currently masked because the permission gate meant to authorize it was never seeded, so the function is unreachable by any real user today. Both need fixing together, not just the more visible one.
> **A lot is genuinely clean this round** — RLS on leases/rent/notices, the two cron jobs, custom domains, org/brand separation, and (notably) the new analytics console all verified correctly built, including a real close of the baseline's E-1 JS-aggregation risk. See "Areas reviewed and found clean" in the full report below.

## Part B — Correctness review (`/code-review`, ac3b71e..HEAD)

| # | Sev | File:line | Finding | Fix direction |
|---|-----|-----------|---------|---------------|
| C1 | Med | `app/dashboard/my-work/page.tsx:146` | **"Open jobs" stat undercounts past the 100-row query cap**, with no disclosure — unlike the sibling "Completed" card, which is honestly labelled "of the last 100 assigned." | Add the same caveat hint, or compute open/in-progress counts from a separate, status-filtered query. |
| C2 | Low | `app/dashboard/layout.tsx:37` | **Wrong-host redirect doesn't sign out the stale session** — the client-side mismatch check in `sign-in-panel.tsx` explicitly signs out on the same class of mismatch; this server-side sibling doesn't. No data exposure (RLS still scopes correctly), but inconsistent with the documented threat model. | Add `await supabase.auth.signOut()` before the redirect, for consistency. |

---

## Part A — Security / efficiency audit (`build-auditor`)

# Stage 0804 — Incremental audit, ac3b71e..4554531

Scope: 146 files / ~11,887 insertions, Days 8.9–10 (leases & rent, lease/rent notices, org/brand separation, custom domains, SC client, hierarchy fixes, analytics console) plus the WhatsApp/360dialog migration (sanity-checked against `docs/WHATSAPP_360DIALOG_MIGRATION.md`, not re-derived).

Read-only review. Every finding below is verified against the actual migration/route/action code at HEAD `4554531`, not inferred from comments.

---

## Security

### S1 — `create_rent_remittance` aggregates and claims charges without a row lock; two concurrent calls can double-remit (Medium, CONFIRMED)

`supabase/migrations/0092d_rent_remittance_column_names.sql:41-51` (final version of the function, superseding 0092b):

```sql
select coalesce(sum(round(rc.landlord_net_amount * (rc.amount_paid / rc.amount), 2)), 0),
       array_agg(rc.id)
  into v_net, v_ids
  from rent_charges rc
  join leases l on l.id = rc.lease_id
 where rc.org_id = p_org_id
   and l.property_id = p_property_id
   and rc.amount_paid > 0
   and rc.remitted_at is null;
...
update rent_charges set remitted_at = now(), remittance_id = v_id where id = any (v_ids);
```

No `FOR UPDATE` on the `rent_charges` rows being aggregated, and the closing `UPDATE` is unconditional (doesn't re-check `remitted_at is null`). Two near-simultaneous calls for the same `(org, landlord, property)` — a finance double-click, or a client retry — both run the `SELECT` under READ COMMITTED before either commits its `UPDATE`, both see the same charges as unremitted, both `INSERT INTO remittances` a full-amount row, and both mark the charges remitted (second write is a no-op, but the *first* `remittances` row is already created and, if independently sent through `claim_remittance_for_sending` → `record_remittance_sent`, pays the landlord twice for the same collected rent).

Contrast with the two adjacent, correctly-guarded patterns in the same money path:
- `record_collection` (`0092c_fix_collection_status_enum.sql:43,71`) explicitly takes `for update` on both `payment_intents` and `rent_charges` before posting.
- `claim_remittance_for_sending` (`0041_remittance_functions.sql:134-150`) takes `for update` on the `remittances` row and gates the state transition on `status = 'queued'` — the exact "claim before you can double-send" discipline this function's aggregation step skips.

`scripts/verify-rent-money.mjs:225-231` tests only a **sequential** re-call after the first succeeds (correctly rejected, since `remitted_at` is by then set) — it does not exercise concurrent calls, so the race is untested.

**Mitigating factor (see D1 below):** this function is currently unreachable by any authenticated user due to a separate defect, so it is only callable via `service_role` today. The race is real in the code and will become live the moment the feature is wired up or the permission gap is fixed, so it belongs in the money-path review now rather than being deferred to when a UI lands.

### S2 — `rent_charges_remittance_uidx` is a vacuous constraint; the "one remittance per charge" guarantee it claims does not exist (Low, CONFIRMED)

`supabase/migrations/0092b_landlord_remittance_takes_no_second_fee.sql:98-102`:

```sql
create unique index if not exists rent_charges_remittance_uidx
  on rent_charges (id) where remitted_at is not null;

comment on column rent_charges.remitted_at is
  '... Set once — the guard against paying the same month twice.';
```

`rent_charges.id` is already the table's primary key, so it is unique regardless of the `WHERE remitted_at is not null` predicate — this index can never reject anything a plain PK wouldn't already forbid. It provides zero additional protection against the double-remittance race in S1; the actual (and, per S1, insufficient) guard is the `WHERE rc.remitted_at is null` clause in the `SELECT`. The comment overstates what is enforced — worth fixing the same day as S1, since a reader auditing this later will reasonably conclude the race is closed when it isn't.

### S3 — `has_permission('remittance.execute')` always denies: the capability is never seeded, so `create_rent_remittance` cannot currently be called by any real user (Medium, CONFIRMED — see also D1)

`0092b_landlord_remittance_takes_no_second_fee.sql:39` / `0092d_rent_remittance_column_names.sql:26`:
```sql
if auth.uid() is not null and not has_permission('remittance.execute') then
  raise exception 'you do not have permission to remit funds';
end if;
```
`has_permission()` (`0050_permission_matrix.sql:185-195`) is `coalesce((select granted from role_permissions where ...), false)` — denies when the capability has no row at all. Grepping every migration in the repo (`grep -rn "remittance.execute" supabase/migrations/`) turns up only these two `if` checks — `remittance.execute` is never inserted into `capabilities`, never granted via `role_permissions`, and never seeded by `seed_b7_permissions`. Every authenticated caller (including `admin`/`finance_approver`) is therefore permanently denied; only `service_role` (where `auth.uid() is null`, skipping the check) can call the function. This is fail-closed, not a privilege escalation — filed as Security because it's a broken authorization gate on the money path, and cross-referenced as a Disconnect (D1) because it also means the feature has no live path for a human user at all.

---

## Efficiency / Consistency

### E1 — New cron job routes compare the shared secret with `===`, not `crypto.timingSafeEqual`, unlike the rest of the codebase's webhook auth (Low, CONFIRMED)

`app/api/jobs/raise-rent-demands/route.ts:34` and `app/api/jobs/lease-notices/route.ts:36` both do:
```ts
return bearer === secret;
```
`lib/webhook-security.ts` (touched in this same diff, 75 lines) explicitly documents and implements constant-time comparison for exactly this class of secret (`hmacMatches`, `lib/webhook-security.ts:34-55`, using `crypto.timingSafeEqual` with a length-guard) — "the comparison must not short-circuit on the first differing byte." The two new job routes reintroduce the pattern that file was written to avoid. Low severity because network jitter dominates a remote timing side-channel and the secret gates a billing/notice job, not direct data access — but it's an easy, cheap fix and an inconsistency worth closing given the adjacent file's own reasoning.

---

## Disconnects

### D1 — Landlord rent remittance (`create_rent_remittance`) has no application entry point at all (Medium, CONFIRMED)

`grep -rln "create_rent_remittance" app/ components/` returns nothing — no server action, no button, nothing in `app/dashboard/leases/RentRollActions.tsx` (which offers only Activate / Bill rent / Renew) calls it. Combined with S3 (the capability that would gate it from the app layer is never seeded), landlord rent remittance is fully built at the database layer (fee-split-correct, per 0092/0092b/0092d) but is not reachable by any person today — only by a script running as `service_role` (as `scripts/verify-rent-money.mjs` does). This is consistent with `FEATURE_BACKLOG.md` G8 ("owner statement portal... a packaged owner statement view does not [exist]") but is worth stating precisely: it isn't just the *statement view* that's missing, the remittance *action* itself has no UI and, if a UI were added calling the RPC as the signed-in user, S3 means it would fail for every role until the capability is seeded.

### D2 — Settings → Lettings save is broken for every real admin: the new `orgs` columns were never added to the 0083c UPDATE column allowlist (Medium, CONFIRMED)

`0083c_orgs_update_column_allowlist.sql:28-38` replaced `orgs`'s blanket table-level `UPDATE` grant with a column allowlist for `authenticated`:
```sql
revoke update on orgs from authenticated, anon;
grant update (
  name, delivery_brand, parent_org_id, theme_primary, theme_accent, theme_logo_text,
  logo_url, portal_name, tagline, support_email, support_phone, login_headline,
  vendor_applications_open, finance_email, it_email, email_from_name, email_from_address,
  tenant_applications_open
) on orgs to authenticated;
```
Four `orgs` columns were added **after** this allowlist and never added to it:
- `management_fee_pct`, `admin_fee_flat` — `0090_leases_and_rent.sql:21,27`
- `renewal_notice_days` — `0091_rent_billing_and_roll.sql:234`
- `rent_demand_lead_days` — `0093_lease_notices.sql:60`

`app/dashboard/settings/lettings/actions.ts:68-76` (`saveLettingsSettings`) writes exactly these four columns via the caller's own (RLS-scoped, `authenticated`-role) Supabase client:
```ts
const { error } = await supabase.from("orgs").update({
  management_fee_pct: fee, admin_fee_flat: adminFee,
  renewal_notice_days: days.sort(...), rent_demand_lead_days: lead,
}).eq("id", me.org_id);
```
Postgres grants new columns no privileges by default when a table-level grant has already been replaced by an explicit column list — `grant update (col-list)` does not retroactively cover columns added later. Every one of these four columns has zero UPDATE privilege for `authenticated`, so this call should fail with a column-permission error for every admin who tries to save lettings settings (management fee, admin fee, renewal notice lead times, rent demand lead time) via the UI. `landlord_terms` (the per-landlord override table) is unaffected — it's a separate table with its own RLS write policy, not part of this allowlist.

**Why untested:** every verify script that exercises these columns (`scripts/verify-leases-and-rent.mjs:125`, `verify-rent-money.mjs:140,156`, `verify-rent-demands.mjs:73` etc.) writes through the `svc` (service-role) client, which bypasses the `authenticated`-role grant entirely — so the suite has never exercised the real admin-session write path for these columns. This is the same class of gap `docs/BUILD_JOURNAL.md:1922` describes being closed by hand for 0083c ("every real write path in the app was traced by hand ... against that allowlist") — that discipline held at the time but wasn't repeated when Days 9/10 added new `orgs` columns.

Not a security hole (fails closed, no leak) — filed as a Disconnect because it silently breaks a stated, built feature.

### D3 — The exact `delivery_brand`-is-not-unique bug PC1 just fixed for WhatsApp is still live in `scripts/register-telegram-bot.mjs` (Low, CONFIRMED, out-of-diff file)

`docs/WHATSAPP_360DIALOG_MIGRATION.md:62-77` (part of this diff) documents a real production incident: `scripts/register-whatsapp-number.mjs` looked up an org by `eq("delivery_brand", brand).limit(1)` with no `deleted_at`/uniqueness guard, and a leftover probe org sharing `delivery_brand = 'OEA'` silently received the real OEA WhatsApp API key. The doc explicitly flags: "Worth checking elsewhere: any other code that does `eq("delivery_brand", ...).limit(1)` or similar ... has the same latent risk." `scripts/register-telegram-bot.mjs:50` (unchanged by this diff, so not itself in scope, but directly responsive to the question the new doc raises) has the identical shape:
```js
const { data: org } = await svc.from("orgs")
  .select("id, name, delivery_brand").eq("delivery_brand", wantedBrand).maybeSingle();
```
No `is("deleted_at", null)`, and `.maybeSingle()` throws on >1 row rather than silently picking one (slightly safer than the WhatsApp script's old `.limit(1)`) — but still relies on `delivery_brand` behaving as a unique key, which 0085 and the WhatsApp incident have now shown twice it is not. Flagging since the diff itself raised the question; not counted against this window's line budget since the file wasn't touched.

---

## Self-caught by PC1 already (from `docs/BUILD_JOURNAL.md`, this window — not re-reported)

- **0092c** — `record_collection` used invented enum values (`'partially_paid'`, `'processing'`) that don't exist on `payment_intent_status`, silently breaking **every** collection (rent and service charge alike) until caught and fixed same-day.
- **0092d** — `create_rent_remittance` (0092b) wrote to `remittances` columns/enum values that don't exist (`user_id` instead of `recipient_id`→`payout_recipients`, `status = 'pending'` instead of `'queued'`); fixed same-day.
- **0091b** — `rent_roll`'s `security_invoker` join through `properties`/`units` returned zero rows for a tenant (no read on either table since 0056); found because a "no bad rows" suite assertion passed trivially on zero rows — fixed via a `my_tenancies()` definer function scoped to `auth.uid()`, matching the pre-existing `0003` pattern.
- **0092/0092b** — the original bug this whole thread exists to fix: `record_collection` credited the *whole* rent receipt to `landlord_payable`, including the management fee, so the ledger disagreed with the (correct) rent-roll display; and three different sources of truth existed for the management fee percentage (`payment_settings`, `orgs.management_fee_pct`+`landlord_terms`, and the frozen snapshot). Resolved by making the snapshot authoritative (0092) and giving rent its own non-double-deducting remittance path (0092b), later consolidated onto one source (`orgs`) in 0095.
- **WhatsApp/360dialog migration** — `delivery_brand`-as-unique-key bug in `scripts/register-whatsapp-number.mjs` misrouted a live API key to a leftover probe org; caught, cleaned up, script hardened to refuse and list candidates on ambiguity (see D3 above for the sibling script that still has the old shape).
- **0096** — a stale error message (`org_nodes_maintain_path`) kept citing the pre-0087 hierarchy order after 0087 changed the actual rule, so a rejected insert was told to retry with the exact arrangement that had just been refused.

---

## Areas reviewed and found clean

- **RLS on `leases`/`rent_charges`/`landlord_terms`/`lease_notices`** (0090, 0091b, 0093) — correctly scoped to tenant-own / oversight-roles / property-stakeholder-property-ids; no write policy on `rent_charges` for `authenticated` (writes only via `raise_rent_charge`, matching the documented "one writer, frozen snapshot" design).
- **`raise-rent-demands` and `lease-notices` cron routes** — fail-closed when `CRON_SECRET` unset, idempotent by DB constraint (`rent_charges_one_per_period`, `lease_notices_once` unique keys), not by trusting the job not to retry.
- **Custom domains (0089/0089b)** — matches `docs/CUSTOM_DOMAINS.md` exactly: `custom_domain` deliberately excluded from the 0083c column allowlist (verified — not present in the grant list), `set_org_domain()` gated on `caller_is_operator_admin()`, validates bare-hostname format, checks cross-org collision explicitly (belt-and-suspenders with the partial unique index), audited via `operator_actions`. `org_branding_by_host()`/`orgForCurrentHost()` used only for branding, never for authorization — host header explicitly untrusted for anything else.
- **Org/brand association (0094)** — `org_brand_associations` is read-scoped to own org (+ operator), write-restricted to operator only, and self-guards against being used as a hierarchy (`org_brand_association_is_not_a_hierarchy` trigger blocks self-association, brand-to-brand association, and operator-org association).
- **Operator-org-holds-no-client-data (0088)** — enforced by trigger on `properties`/`tickets`/`tenant_applications`/`leases`, not left as convention.
- **Hierarchy fixes (0096, 0097)** — 0096 is a string-only fix (stale error message), no behavior change. 0097's `seed_org_hierarchy()` is `service_role`-only (not granted to `authenticated`), called from `operator_provision_org()` which retains its existing `caller_is_operator_admin()` gate — no new privilege path; the 0729c/d invitation-scoping fix is untouched by this window.
- **Analytics console (0100)** — `bi_ticket_metrics`/`bi_vendor_performance`/`bi_category_performance` are plain `language sql stable` (no `security definer`) over `tickets`, so RLS narrows every query at the database — this is a genuine close of baseline E-1's JS-side-aggregation/1000-row-truncation risk, not a JS re-aggregation with a different UI. The PDF export route (`app/api/analytics/report/route.tsx`) reuses the caller's own session client (not service role) and re-checks the same `biScope()` role gate the console page uses, so the export can't be used to bypass the screen's role restriction by hitting the URL directly. `my_requests()` is definer-scoped strictly to `auth.uid()`, matching the established `my_tenancies()` pattern.
- **`0095_one_fee_source`** — correctness-only consolidation (mirrors `orgs.management_fee_pct` into legacy `payment_settings` via trigger), no access-control change.

---

## Not independently re-verified (time budget)

Per the brief's priority order, WhatsApp webhook/notify internals were sanity-checked against `docs/WHATSAPP_360DIALOG_MIGRATION.md` only (confirmed the doc's claims match the route's dual-path token/HMAC structure at a glance) rather than re-derived from scratch. `scripts/verify-*.mjs` diffs beyond rent/domains/analytics were skimmed for what they revealed (journal cross-referenced above) rather than read line-by-line.

---

## PC1 response — actioned 2026-08-04

| # | Status | What was done |
|---|--------|---------------|
| **S1** | **Fixed** (`0102`) | `create_rent_remittance` locks the charges it aggregates (`for update of rc`, ordered by id so concurrent callers queue rather than deadlock), re-checks `remitted_at is null` in the closing UPDATE, and aborts if it did not claim every row it counted. New suite `verify-remittance-race` drives two overlapping connections; **it was run against the pre-fix function first and reported "THE SAME RENT WAS REMITTED TWICE"**, so it is known to be capable of failing. |
| **S2** | **Fixed** (`0102`) | Vacuous `unique (id) where remitted_at is not null` dropped — it was on the primary key. Replaced with `rent_charges_unremitted_idx (org_id, lease_id) where remitted_at is null`, and the column comment now names the lock as the guard instead of implying an index does it. |
| **S3** | **Fixed differently — please note** (`0102`) | `remittance.execute` was **not** seeded, deliberately. Locked decision 7 lists remittance execution among the controls that are hardwired and "never appear as toggles", and `capabilities` already carries **`payment.remit`** ("Execute a transfer to a vendor or landlord") as *locked* for this exact act — a grantable `remittance.execute` would make a non-delegable control delegable and give one act two names. Instead the function was brought into line with its four siblings in 0041: **`authenticated` revoked, `service_role` only**, in-function check hardwired to `admin`/`finance_approver` as defence in depth. This unblocks a UI (a server action authorises, then calls via the service client — exactly what `executeRemittance()` does today) without creating the toggle. |
| **E1** | **Fixed** | Both cron routes now use a new `secretMatches()` in `lib/webhook-security.ts` (SHA-256 both sides, then `timingSafeEqual`, so length is not leaked either). Unit-checked across equal / differing / empty / null / length-mismatch. |
| **D2** | **Fixed** (`0102`) | The four columns added to the 0083c allowlist. Reproduced live as a signed-in OEA administrator before the fix (`management_fee_pct` refused, `portal_name` succeeded) and confirmed after. New suite **`verify-lettings-grants`** signs in as a real administrator rather than using `service_role`, asserts the exclusions (`deleted_at`, `is_platform_operator`, `slug`, `custom_domain`) still hold, and **fails if any `orgs` column is neither allowlisted nor deliberately excluded** — so the next added column must be classified rather than silently unwritable. |
| **D3** | **Fixed** | `scripts/lib/org-lookup.mjs` — one guard, used by both registration scripts: live orgs only, refuse and list candidates on ambiguity, never pick. `register-telegram-bot.mjs` also accepts a **slug**, because `POC` maps to `delivery_brand = 'direct'` and **three live orgs carry that today** (POC, SC client, platform operator) — the old `.maybeSingle()` discarded its error and reported "No organisation with delivery_brand direct" when in fact several matched. |
| **C1** | **Fixed** | `/dashboard/my-work` open/completed tiles are now counted in the database (`head: true`, still RLS-scoped) instead of derived from the 100-row list, and the list says so when it is truncated. |
| **C2** | **Fixed** | The wrong-host dashboard redirect now signs the session out before redirecting, matching `sign-in-panel.tsx`. |
| **D1** | **Open — by design, for now** | Landlord rent remittance still has no UI. S3 no longer blocks it: the pattern is a server action that checks `admin`/`finance_approver` and calls the RPC through the service client, as `executeRemittance()` already does for vendors. Scheduled with the owner-statement work (`FEATURE_BACKLOG` G8) rather than bolted on here. |

### One finding this audit did not have, introduced and closed in the same session

`verify-lettings-grants`, on its first run, read `orgs.select("*").limit(1)` to
learn the column names — an arbitrary row — and echoed those values onto the
signed-in administrator's org. It overwrote the **OEA organisation's** name,
brand, portal name and sender identity with the POC's, so `oeaportal.com` served
the wrong entity until it was restored from `audit_log.before_state`.

Recorded here because it is the same species as D3 and worth the same
generalisation: **a lookup that returns *a* row where the code assumes *the*
row.** The suite now reads the row it is about to write. `verify-email-routing`
caught the damage on the next run precisely because it asserts that a brand sends
as itself rather than asserting a fixed string.
