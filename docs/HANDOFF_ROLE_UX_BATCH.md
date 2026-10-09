# Handoff: eight-item batch (9 Oct 2026), branch feature/role-and-ux-batch

Done: **item 5** (₦/£/€ in PDF receipts and analytics report; DejaVu Sans fallback, `lib/pdf/fonts.ts`).

Migrations must start at **0323**. 0321/0322 are applied to dev+staging from another session's uncommitted files. Prod is at 0318.

## Decisions taken with the user
- Item 8 role: identifier `owner_representative`, label **"Owner Rep"**. Money sight is a toggle, **default OFF**. Raising requests is a toggle (default ON).
- Item 2 service charges: correct the inputs (budget total, shares) and re-issue unpaid invoices. Refused once money is attached (reuse `retire_service_charges_for_regenerate`, 0292).

## Findings per remaining item
1. **Vendor properties.** RLS already admits a vendor to properties with a live job (`caller_is_vendor_on_live_job`, 0269). Only UI is missing: a "Properties you are attending" card on `app/dashboard/my-work/page.tsx` (`from("properties")` as the vendor).
2. **Corrections.** `leases` UPDATE is granted on every column (incl. `status`, `rent_amount`) to `leases.write` holders through REST. Proposed: a `correct_lease_terms(..., p_reason)` path plus a trigger refusing money/term edits on non-draft leases outside it. For rent, `correct_rent_charge` (definer) refuses when `amount_paid > 0`, a pending intent exists, or the charge is ledger-posted/remitted, and recomputes the split at the snapshotted `management_fee_pct`. ⚠️ `raise_rent_charge` checks `leases.write` but **not property scope**, a gap worth closing.
3. **Allocated unit hidden.** `vacant_units_for_property` uses `unit_is_vacant` (no occupant AND no live lease), so a unit whose tenant arrived by invitation (occupant set, no lease) cannot be picked on the lease form. Needs a "lettable" list (no live tenancy) that labels the occupant and preselects them, plus a guard (trigger or `activate_lease`) refusing a lease for a different portal user than the recorded occupant.
4. **PM Client Funds.** The PM is already in `property_finance_roles()`, so RLS gives them the ledger accounts, postings and entries of their properties. `report_property_funds`, `report_collections` and `ledger_posting_balances` are SECURITY INVOKER and return property-scoped rows for them. Build a separate read-only route (e.g. `/dashboard/property-funds`) rather than opening `app/dashboard/ledger/layout.tsx`, whose tabs are org-wide.
6. **Asset quantity.** No column exists. Add `assets.quantity int not null default 1 check (>=1)` and an `ASSET_FIELDS` entry (feeds the form, CSV template and import; enforce an integer in `lib/asset-import.ts`). Show it in `AssetList`/detail. There is no asset edit page, so add an inline quantity edit on `/dashboard/assets/[id]` (under the caller's RLS).
7. **My Requisitions.** Statuses are `pending_approval`, `returned_for_correction`, `approved`, `remitted`, `rejected` (0250b). Model it on `app/dashboard/TicketList.tsx` (search, status chips, sort).
8. **Owner Rep.** Two migrations: enum values `owner_representative` and a new `property_relation` value (e.g. `representative`). ⚠️ Attaching them as `owner` would make `tenancy_schedule`/`report_collections` name them as the landlord. Then wire the role:
   - Capabilities (module "Owner Rep", ONLY_FOR the role in `MatrixEditor.tsx`): `owner_rep.properties` / `.requests_read` / `.requests_raise` / `.assets` / `.analytics` ON, `.finance` OFF. Hide general capabilities for this role and have `set_role_permission` refuse them.
   - `current_user_property_ids()` does not filter on relation (decision 8: keep one resolver). Guard each place-branch consumer for the role:
     - `properties_select`, `units_select` and `assets_select` gate on their switches.
     - Add a `tickets_select` branch gated on `requests_read`, and a `tickets_insert` clause gated on `requests_raise`.
     - `rent_charges_select`, `sc_budgets_select`, `service_charges_select`, `lease_notices_select`, `property_statement(_lines)`, `create_rent_payment_intent` and `create_service_charge_payment_intent` gate on `finance`.
     - Exclude the role from `tenant_applications_staff_select`, `application_overview` and `application_document_findings_select`. ⚠️ A `property_owner` reads applicant PII through those today, an existing exposure to flag.
   - Also update `role_rank` (~18), `b7_grants`/`b7_baseline`/`seed_b7_permissions`, `lib/roles.ts` (labels, rank, `INVITABLE_ROLES`), the nav (no Guide, no My Portfolio), `biScope`, and add a suite that enumerates every policy using the resolver.
