# Gap — no tenant-facing way to pay rent online

**Date found:** 2026-08-06 · **By:** PC2, while updating the board progress deck
**Shared for PC1 to verify & action ASAP.** Not a security/money-safety issue —
nothing is broken or unsafe — but the board deck was about to claim a tenant
capability that does not exist, and Day 9 is currently marked complete in
`PHASE1_WORKPLAN.md` without this half of it.

## What's actually there vs. what's missing

**Built (Day 9, verified):**
- `leases`, `rent_charges`, the rent roll, renewal notices, and rent demands
  raising themselves on schedule.
- Every receipt splits automatically into the landlord's share and OE Group's
  fee, and reaches the segregated ledger correctly.
- All of this is real, tested (`verify-leases-and-rent`, `verify-rent-money`,
  `verify-rent-demands`), and reachable — but only from **admin/FM/finance**
  routes: `/dashboard/leases`, `/dashboard/people/tenancy`.

**Missing:** a tenant has no screen anywhere that shows "you owe ₦X" for rent
and no way to click through to checkout. Confirmed by searching the app tree:

- No `/dashboard/my-rent`, `/dashboard/my-lease`, or equivalent route exists.
- The only tenant-facing dashboard route at all is `/dashboard/my-requests`
  (the Day 10 ticket tracker) — it has no rent content.
- `my_tenancies()` — the DB function Day 9 built specifically for "the
  tenant's own view" — is referenced **once** in the whole `app/` tree, in a
  comment (`app/dashboard/my-requests/page.tsx:25`), not actually called
  anywhere.
- `rent_charges` is never queried from any tenant-reachable page — only from
  admin actions (`app/dashboard/leases/actions.ts`) and scripts/migrations.

So today, a tenant who owes rent has to be told and collected from off-platform
even though the accounting side is fully wired to take the payment correctly.

## Why this was missed

Day 9's own status note in `PHASE1_WORKPLAN.md` is accurate about what it
built (lease admin, billing, the roll, notices) — it just never explicitly
promised or delivered the tenant-side screen, and nothing since has flagged
the gap between "the ledger can take this payment" and "a tenant can trigger
it." It surfaced now only because the board deck's Tenant/Resident lane
claims "Pay rent / lease online" as a capability, and that claim doesn't
hold up against the actual routes.

## Suggested fix

Reuse the pattern already proven for service-charge collections (Day 5): a
`my_tenancies()`-backed page (e.g. `/dashboard/my-rent`) listing the tenant's
own charges by status, with a "Pay now" link into the same checkout flow
`/pay/[reference]` already uses. The gateway integration, receipt, and ledger
posting are already built — this is a UI-and-routing task, not a new payment
path.

## Not yet done
- [ ] Confirm with PC1 whether this was silently descoped, or genuinely
      missed.
- [ ] If in scope for Phase 1, schedule it — likely fits as a fast-follow
      inside Day 9 rather than reopening Day 11's UX pass.
- [ ] Until built, do **not** mark the Tenant/Resident lane's "Pay rent /
      lease online" as delivered on the board deck (it currently correctly
      shows as upcoming).
