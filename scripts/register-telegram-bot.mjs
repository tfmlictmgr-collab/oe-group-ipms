// Registers one Telegram bot to one brand, end to end.
//
//   node scripts/register-telegram-bot.mjs TFML 8123456789:AA...token
//   node scripts/register-telegram-bot.mjs OEA  8987654321:BB...token
//   node scripts/register-telegram-bot.mjs oe-group-foundation-poc <token>
//
// TFML and OEA are brands; anything else is read as an organisation SLUG, which
// is the only unique identifier an org has (0085). `POC` still works and maps to
// delivery_brand 'direct' — but three live orgs carry that, so it will refuse
// and list them rather than pick one.
//
// What it does:
//   1. generates a fresh per-bot SECRET (the routing key AND the webhook's
//      authentication — see 0011/0039)
//   2. stores the route: which org this bot belongs to, plus the bot token
//      replies are sent with (0047)
//   3. calls Telegram's setWebhook so the bot points at our endpoint with that
//      secret attached
//   4. reads it back and confirms Telegram agrees
//
// The token is a CREDENTIAL. Pass it as an argument and it stays out of the
// repo; it is written only to channel_routes, which is service-role-only.
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";
import { createClient } from "@supabase/supabase-js";

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
config({ path: path.join(rootDir, ".env.local") });

const [brandArg, botToken] = process.argv.slice(2);

if (!brandArg || !botToken) {
  console.error(
    "Usage: node scripts/register-telegram-bot.mjs <TFML|OEA|POC> <bot-token>\n" +
    "Get the token from @BotFather → /newbot (or /token for an existing one)."
  );
  process.exit(1);
}
if (!/^\d+:[\w-]{30,}$/.test(botToken)) {
  console.error("That does not look like a Telegram bot token (expected 123456:AA...).");
  process.exit(1);
}

const SITE = process.env.NEXT_PUBLIC_SITE_URL ?? "https://oe-group-ipms-dev.vercel.app";
const svc = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);

// ⚠️ Audit 0804 D3. This resolved the org with
// `eq("delivery_brand", brand).maybeSingle()`, destructuring only `data` —
// which fails in two ways at once. `delivery_brand` is not unique, so on more
// than one match PostgREST returns an error and null data; the ignored error
// then surfaced as "No organisation with delivery_brand X", announcing that
// none exists at the moment several do. And a RETIRED probe fixture counted as
// a match, which is exactly how a live WhatsApp key ended up on a stray org.
//
// `POC` is the sharp case and it is live today: the POC, the SC client and the
// platform operator all carry `delivery_brand = 'direct'`. So a slug is
// accepted too, and it is the only way to name one of those three.
import { requireOrgForBrand, liveOrgBySlug } from "./lib/org-lookup.mjs";

const wantedBrand = brandArg.toUpperCase() === "POC" ? "direct" : brandArg.toUpperCase();
let org;
if (["TFML", "OEA", "direct"].includes(wantedBrand)) {
  org = await requireOrgForBrand(svc, wantedBrand);
} else {
  // Anything else is treated as a slug — `oe-group-foundation-poc`, `sc-client`.
  const { org: bySlug, error } = await liveOrgBySlug(svc, brandArg);
  if (!bySlug) {
    console.error(`\n${error}\nPass TFML, OEA, or an organisation's slug.\n`);
    process.exit(1);
  }
  org = bySlug;
}

// Confirm the token really is the bot it claims, before anything is stored.
const meRes = await fetch(`https://api.telegram.org/bot${botToken}/getMe`);
const me = await meRes.json();
if (!me.ok) {
  console.error(`Telegram rejected that token: ${me.description ?? meRes.status}`);
  process.exit(1);
}
console.log(`Bot: @${me.result.username} (${me.result.first_name})`);
console.log(`Org: ${org.name}\n`);

// A new secret each time. Rotating it invalidates the old webhook registration,
// which is the point: a leaked secret is a forged-intake risk (0039).
const secret = crypto.randomBytes(24).toString("hex");

// Supersede any existing Telegram route for this org rather than accumulating
// stale ones — a second live secret is a second way in.
const { error: clearErr } = await svc
  .from("channel_routes").delete().eq("org_id", org.id).eq("channel", "telegram");
if (clearErr) {
  console.error(`Could not clear the previous route: ${clearErr.message}`);
  process.exit(1);
}

const { error: insErr } = await svc.from("channel_routes").insert({
  org_id: org.id,
  channel: "telegram",
  external_id: secret,
  outbound_token: botToken,
  label: `${org.name} — @${me.result.username}`,
});
if (insErr) {
  console.error(`Could not store the route: ${insErr.message}`);
  process.exit(1);
}
console.log("✓ route stored (secret + bot token)");

const hookRes = await fetch(`https://api.telegram.org/bot${botToken}/setWebhook`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    url: `${SITE}/api/webhooks/telegram`,
    secret_token: secret,
    allowed_updates: ["message", "callback_query"],   // callback_query = the buttons
    drop_pending_updates: true,
  }),
});
const hook = await hookRes.json();
if (!hook.ok) {
  console.error(`✗ setWebhook failed: ${hook.description ?? hookRes.status}`);
  console.error("  The route is stored but Telegram will not deliver. Re-run once resolved.");
  process.exit(1);
}
console.log(`✓ webhook set → ${SITE}/api/webhooks/telegram`);

// Read it back. setWebhook returning ok is Telegram accepting the request, not
// proof of the resulting state.
const infoRes = await fetch(`https://api.telegram.org/bot${botToken}/getWebhookInfo`);
const info = await infoRes.json();
const live = info?.result;
console.log(
  live?.url === `${SITE}/api/webhooks/telegram`
    ? `✓ confirmed by Telegram (pending: ${live.pending_update_count ?? 0})`
    : `✗ Telegram reports a different URL: ${live?.url ?? "none"}`
);
if (live?.last_error_message) {
  console.log(`  last delivery error: ${live.last_error_message}`);
}

console.log(
  `\nDone. Message @${me.result.username} and the reply comes from ${org.name} — ` +
  `and only from it.`
);
