# WhatsApp on 360dialog — migration notes for PC1

**Date:** 2026-08-04 · **By:** PC2, in coordination with the account owner
**Commit:** `2e04690` (already on `phase-1`, deployed + verified live on `oe-group-ipms-dev`)

> **Shared for PC1 to be aware of and verify.** This changes how both live
> WhatsApp channels are wired — read this before touching `lib/notify.ts`,
> `lib/webhook-security.ts`, `app/api/webhooks/whatsapp/route.ts`, or
> `scripts/register-whatsapp-number.mjs`.

## What changed, in one line
TFML and OEA moved off native Meta WhatsApp Cloud API onto **360dialog** (as
direct clients, not partners), and the numbers were swapped in the process:

| Org | Number | Business identity |
|---|---|---|
| TFML | `+234 703 689 1329` | "Total Facilities Management Limited" — verified via 360dialog's PLBV route |
| OEA | `+234 708 471 4148` | "OEA Support" |

## Why the webhook auth had to change (this is the important part)
Direct 360dialog clients get **no signature at all** — not 360dialog's own
`x-360dialog-signature` (that requires Partner-tier / a Platform Secret we
don't have access to), and not Meta's `X-Hub-Signature-256` either. Confirmed
against 360dialog's own docs before building anything.

Without a signature, the old design broke at the root: inbound routing trusted
`metadata.phone_number_id` **from the request body**, safe only because that
body was previously HMAC-verified as genuinely Meta's. With no signature, any
unsigned POST claiming any `phone_number_id` would have routed "correctly."

**Fix:** a per-channel secret token embedded in each channel's webhook URL
(`?token=...`), which is **both the auth proof and the routing key** — the
exact pattern already proven for Telegram (`channel_routes.external_id` as
the per-bot secret, 0011/0047). Not a new mechanism, the existing one applied
where WhatsApp now needs it too. Unknown token → `403`, matching Telegram's
convention (not the old "unknown phone_number_id → silent 200 drop," which is
still what happens on the fallback HMAC path for a hypothetical still-native
number).

## What changed, concretely
- **`app/api/webhooks/whatsapp/route.ts`** — dual-path: `?token=` present →
  route + authenticate via `channel_routes` (skip signature entirely); absent
  → fall back to the old HMAC + phone_number_id path (kept for a
  natively-registered Meta number, if one is ever added back).
- **`lib/webhook-security.ts`** — new `verifyWhatsAppInbound()`, tries
  `x-360dialog-signature` then `X-Hub-Signature-256`, fails closed in prod if
  neither is present. (Currently dormant for both live channels — they go
  through the token path instead — but ready if a Platform Secret is ever
  enabled or a native number is added.)
- **`lib/notify.ts`** — sends now go to `waba-v2.360dialog.io/messages` with
  `D360-API-KEY` header, not `graph.facebook.com` with `Authorization: Bearer`.
  No `phone_number_id` in the URL anymore — the per-route API key alone
  identifies the sending channel. `whatsappSenderForOrg()` now resolves the
  token from `channel_routes` (via `channel_sender_for_org`, same as
  Telegram) instead of a single shared `WHATSAPP_ACCESS_TOKEN` env var — that
  var stopped being valid the moment TFML and OEA became separate 360dialog
  businesses with separate keys.
- **`scripts/register-whatsapp-number.mjs`** — now registers by **webhook
  token**, not `phone_number_id`. Usage:
  `node scripts/register-whatsapp-number.mjs <TFML|OEA> <webhook-token> <api-key> [label]`

## ⚠️ A real bug this surfaced — worth generalising the fix
`delivery_brand` is **not unique**. The script's org lookup was
`eq("delivery_brand", brand).limit(1)` with no ordering or uniqueness check —
and a leftover, never-retired probe fixture (`PROBEOP-Brand-7I1EB`) shared
`delivery_brand = 'OEA'` with the real `OEA Portal` org. On first run, this
silently attached OEA's live API key to the **wrong org** — the real org's
route was untouched, the probe org got a working key it should never have had.
Caught, cleaned up (probe org retired, correct row re-registered), and the
script now **refuses and lists candidates** instead of guessing when more than
one org matches a brand.

**Worth checking elsewhere:** any other code that does `eq("delivery_brand",
...).limit(1)` or similar without `is("deleted_at", null)` + a uniqueness
guard has the same latent risk. This is the same species of bug 0085 already
found for org slugs ("delivery_brand is not a unique key and was being used as
one") — this is a second, independent instance of it.

## Environment / config notes for PC1
- **`WHATSAPP_ACCESS_TOKEN`** (the old shared env var) is no longer consulted
  for either live channel — both resolve per-route now. Safe to leave set (it's
  the fallback for a channel with no `outbound_token`) or remove once confident
  nothing still depends on it.
- **`WHATSAPP_360D_SIGNING_SECRET`** — referenced in `verifyWhatsAppInbound()`
  for the (currently unused) 360dialog-signature path. Not set, not needed
  right now — only matters if Partner-tier access is ever obtained.
- Both channels' 360dialog webhook URLs are set to
  `https://oe-group-ipms-dev.vercel.app/api/webhooks/whatsapp?token=<per-channel token>`.
  **At go-live these need updating to the production host**, same tokens or
  freshly rotated ones.

## Verified live
Round-trip tested against real 360dialog traffic on `oe-group-ipms-dev`:
message to each number → ticket created in the correct org → reply arrives
**from the same number that was messaged**, no cross-brand leak.
