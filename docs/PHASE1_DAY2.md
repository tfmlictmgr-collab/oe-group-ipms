# Phase 1 — Day 2: Brand isolation + per-org channel routing (DONE)

**Goal (from `PHASE1_WORKPLAN.md`):** each brand is isolated on the way *in*, not
just at rest — and the money side is scoped to an FM's properties (S5).

Delivered in three verified layers.

## 1. Per-org inbound channel routing — kills the `DEMO_ORG_ID` hardcode
`channel_routes` table (migration 0011) maps an inbound identity → one org:
- **WhatsApp** routes by `value.metadata.phone_number_id` (payload is already
  HMAC-verified as Meta's).
- **Telegram** routes by the per-bot `x-telegram-bot-api-secret-token`, which
  doubles as auth: a token matching no route is a forged/unknown bot → 403.

Unknown identity → **drop (200)**, never a default-org fallback (that silent
default was the collapse, and for money messages a cross-brand leak). Routes are
service-role-provisioned only (no self-serve write) so one brand can't hijack
another's number; every route change is audited.

**Verified E2E on the live dev URL** (`scripts/verify-channel-routing.mjs`): a
TFML-number payload → TFML org, an OEA-number payload → OEA org, disjoint, an
unregistered number dropped with no ticket, forged signature 403, Telegram
valid/invalid token routes/rejects.

## 2. JWT org claims + brand middleware (B1 layer 4)
`org_id` + `delivery_brand` + `role` are stamped into `app_metadata`, so they
ride in the **signed** JWT (admin-only writable — unforgeable). Middleware reads
the claim from the verified token and stamps trusted `x-org-id` /
`x-delivery-brand` / `x-user-role` request headers **after stripping any the
client sent**. `orgContext()` reads them server-side. RLS stays the enforced
backstop; this is defense-in-depth + the API-middleware layer.

**Verified** (`scripts/verify-jwt-claims.mjs`): signed-token claims match the
DB for POC/TFML/OEA, cross-brand claims are distinct, and a spoofed `x-org-id`
is overwritten by the claim / stripped when unauthenticated.

## 3. S5 — property-scope the money side for FMs
Explicit `vendor_properties` association (migration 0012) +
`current_user_scoped_vendor_ids()`. `payments` and `vendor_evaluations` SELECT
(and FM payment UPDATE) are now scoped to vendors on a property the FM manages.
Admin/finance still see all; a vendor sees only its own; the vendor **directory**
stays org-visible so FMs can still assign work.

**Verified** (`scripts/verify-access-matrix.mjs`): FM sees **2 of 3** payments
(the ₦620k SecureGuard payout on Victoria Court is hidden) and 9 of 15
evaluations, both strictly < admin; finance sees all 3; the 0010 payment gate
still blocks direct-API bypass after the rewrite.

## What still needs YOU (not blocking Day 3)
- **Real OEA channel:** routing is proven with placeholder WhatsApp identities.
  When OEA gets its own WhatsApp number / Telegram bot, add a `channel_routes`
  row (service-role) mapping its `phone_number_id` / secret token → the OEA org,
  and point that number's webhook at the dev URL.
- **DNS/domain routing** stays deferred per the "no urls" reconciliation — brand
  separation is at the org/data layer on one domain, which is what's built.

**Day 2 complete.** Migrations 0011–0012 applied to dev; all verifiers green;
deployed to https://oe-group-ipms-dev.vercel.app. Demo untouched.
