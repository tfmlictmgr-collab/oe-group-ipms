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
- [x] Confirm with PC1 whether this was silently descoped, or genuinely
      missed. → **Genuinely missed**, not descoped. Built 2026-08-06.
- [x] If in scope for Phase 1, schedule it. → Built as a Day 9 fast-follow,
      exactly as suggested.
- [x] Until built, do **not** mark "Pay rent / lease online" as delivered.
      → **Now deliverable**, see below.

---

## PC1 response — built 2026-08-06 (`0110`)

**The finding was accurate in every particular**, including that
`my_tenancies()` existed and was called nowhere. Built along the suggested
lines — reusing the proven collection path rather than adding a second one.

**What shipped**
- `/dashboard/my-rent` — a tenant's own rent, per demand: the period, the
  flat, what is owed, what has been paid, and a **Pay now** button that opens
  the same checkout the service-charge flow already uses. A live link is
  surfaced as **Continue payment** rather than silently attempting a second.
- `my_rent_charges()` (`0110`) — the per-charge companion to `my_tenancies()`.
  Both are `SECURITY DEFINER` on `auth.uid()` for the same stated reason: a
  tenant has no read on `properties`/`units`, so the flat's name is
  denormalised rather than granting access to the register it lives in.
- `payMyRent()` — a thin server action. It passes **no amount**; the RPC
  computes the outstanding balance from the demand itself, so a tampered
  request cannot change what is charged.
- Nav entry, tenant-only.

**⚠️ A real defect found while building on it — worth reading**

`create_rent_payment_intent` (0092) is `SECURITY DEFINER`, granted to
`authenticated`, and checked only that the demand belonged to the caller's
**organisation**. It never checked that the caller was the tenant on the
lease. Any authenticated member of the org — another tenant, a vendor, ops
staff — could open a payment link against somebody else's rent.

The sharp end is not the payment (paying a stranger's rent is a strange
attack). It is the function's **own one-live-intent guard** three lines
below: *"a payment link is already open for this rent demand"*. Opening an
intent on another tenant's demand **locks that tenant out of paying their own
rent**, with nothing in the app to explain why — a denial of service on
someone else's obligation, from any account in the org.

Fixed in `0110`: the demand's own tenant, an oversight role, or an FM/PM
scoped to the property. The org check remains as the outer boundary; this is
the inner one it never had. Service-role callers (the scheduled demand job,
which has no session) are unaffected.

**Proven, not asserted.** `scripts/verify-tenant-rent-payment.mjs` section G
reinstalls the pre-fix function via a direct `pg` connection, confirms an
unrelated tenant **did** open a link on another tenant's rent, then restores
the fix and confirms the refusal returns. 13 checks; the full loop was also
exercised in the browser end to end — tenant pays → ledger balances to zero,
₦2,160,000 held for the landlord and ₦240,000 recognised as fee income on a
₦2,400,000 demand at 10%.

**A second, smaller trap recorded for whoever touches this next:** migration
`0092`'s file still reads `status in ('pending','processing')`, but
`processing` is not a value of `payment_intent_status` — `0092c` replaced the
function to say `status = 'pending'` and the file was never corrected.
Rewriting the function from the file (as this work nearly did) reintroduces a
guard that throws `invalid input value for enum` instead of guarding
anything. `0110` was written from the **live** `pg_proc.prosrc`, not the
migration file, and says so in a comment.
