// Registers a WhatsApp channel against a brand.
//
// `channel_routes.external_id` decides two things:
//   • inbound  — which org a message that arrives on this channel belongs to
//   • outbound — which channel that org answers from
//
// So a wrong or missing entry is not cosmetic: a message either lands in the
// wrong brand's data, or is dropped, or is answered by the wrong brand.
//
// ⚠️ `external_id` is a WEBHOOK TOKEN, not the Meta phone_number_id.
//
// TFML and OEA run through 360dialog as direct clients, who do not get a
// Platform Secret and therefore send no signature of any kind — not
// 360dialog's own `x-360dialog-signature`, and not Meta's `X-Hub-Signature-256`.
// Without a signature, the request body cannot be trusted for routing: any
// unsigned POST claiming any phone_number_id would route correctly if that
// field were still the key. The fix is the one this codebase already uses for
// Telegram — a per-channel secret that is BOTH the route key and the proof the
// request is genuine, embedded in the webhook URL each channel is configured
// with in the 360dialog Hub (`…/api/webhooks/whatsapp?token=<this value>`). A
// token matching no row is forged or unregistered → the endpoint rejects it.
//
// Generate one per channel — high-entropy, e.g. `openssl rand -hex 24` — never
// reuse a token across TFML and OEA: a shared token means a single leak
// compromises both brands' inbound trust instead of one.
//
// ⚠️ The API KEY is required for the same reason the token is per-channel. It
// used to be that Meta issued one System User token per business, covering
// every number under it, so a single `WHATSAPP_ACCESS_TOKEN` env var worked
// for every org. That stopped being true the moment TFML and OEA became
// separate businesses on 360dialog: each business now has its own key, and
// there is no longer one shared credential that answers for both.
//
// Usage:
//   node scripts/register-whatsapp-number.mjs TFML <webhook-token> <api-key> "TFML Support — +234 703 689 1329"
//   node scripts/register-whatsapp-number.mjs OEA  <webhook-token> <api-key> "OEA Support — +234 708 471 4148"
//   node scripts/register-whatsapp-number.mjs --list
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";
import { createClient } from "@supabase/supabase-js";

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
config({ path: path.join(rootDir, ".env.local") });

const svc = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);

const [brandArg, webhookToken, apiKey, ...labelParts] = process.argv.slice(2);

async function show() {
  const { data: routes } = await svc
    .from("channel_routes")
    .select("channel, external_id, label, org_id, outbound_token")
    .eq("channel", "whatsapp");
  const { data: orgs } = await svc.from("orgs").select("id, name, portal_name, delivery_brand");
  const byId = Object.fromEntries(orgs.map((o) => [o.id, o.portal_name || o.name]));

  console.log("\nWhatsApp channels currently registered:");
  console.table(
    (routes ?? []).map((r) => ({
      org: byId[r.org_id],
      // Only the token's shape, never the value — this table is meant to be
      // safe to paste into a chat or a ticket.
      webhook_token: `${r.external_id.slice(0, 6)}…(${r.external_id.length} chars)`,
      label: r.label,
      key: r.outbound_token ? "per-route" : "MISSING — cannot send",
    }))
  );
  console.log("\nOrganisations available:");
  console.table(orgs.map((o) => ({ brand: o.delivery_brand, name: o.portal_name || o.name })));
}

if (!brandArg || brandArg === "--list") {
  await show();
  console.log(
    "\nTo register:  node scripts/register-whatsapp-number.mjs <TFML|OEA|POC> <webhook-token> <api-key> [label]\n"
  );
  process.exit(0);
}

if (!webhookToken || webhookToken.trim().length < 20) {
  console.error(
    `\nNo webhook token given (or it's suspiciously short).\n` +
      "Generate one yourself — e.g. `openssl rand -hex 24` — and use the SAME\n" +
      "value in this command and in the channel's webhook URL on 360dialog\n" +
      "(…/api/webhooks/whatsapp?token=<this value>). A different token per\n" +
      "channel, always: one shared token means a single leak compromises both\n" +
      "brands' inbound trust instead of one.\n"
  );
  process.exit(1);
}

if (!apiKey || apiKey.trim().length < 8) {
  console.error(
    `\nNo API key given (or it's suspiciously short).\n` +
      "This is the per-channel credential from 360dialog (Direct API Access →\n" +
      "Generate API key). Required: with two businesses now holding separate\n" +
      "keys, there is no single shared token that answers for both, so a route\n" +
      "with no key of its own cannot safely send.\n"
  );
  process.exit(1);
}

const BRANDS = { TFML: "TFML", OEA: "OEA", POC: "direct" };
const brand = BRANDS[brandArg.toUpperCase()];
if (!brand) {
  console.error(`\nUnknown brand "${brandArg}". Use TFML, OEA or POC.\n`);
  process.exit(1);
}

// ⚠️ `delivery_brand` is NOT a unique key (0085 already learned this the hard
// way for org slugs) — leftover probe/test fixtures can and do share a brand
// with the real org. `.limit(1)` with no ORDER BY let Postgres pick either one,
// and it has silently picked the wrong one before: a brand's WhatsApp key was
// once attached to a stray "PROBEOP-Brand-…" fixture instead of the real org,
// leaving the real org's route untouched and the key live on an org nobody
// uses. Refuse rather than guess when there is more than one candidate.
const { data: candidates } = await svc
  .from("orgs").select("id, name, portal_name, created_at")
  .eq("delivery_brand", brand).is("deleted_at", null);

if (!candidates?.length) {
  console.error(`\nNo organisation with delivery_brand "${brand}".\n`);
  process.exit(1);
}
if (candidates.length > 1) {
  console.error(
    `\nAmbiguous: ${candidates.length} organisations share delivery_brand "${brand}".\n` +
    "Refusing to guess which one gets the key. Candidates:\n"
  );
  console.table(candidates.map((c) => ({ id: c.id, name: c.name, created_at: c.created_at })));
  console.error(
    "\nRetire the stray one(s) first (the operator launcher, or a targeted\n" +
    "`update orgs set deleted_at = now() where id = '<id>'`), then re-run.\n"
  );
  process.exit(1);
}
const org = candidates[0];

// One token belongs to exactly one org. Registering it elsewhere would split a
// conversation across brands, so an existing claim is reported rather than
// silently moved.
const { data: claimed } = await svc
  .from("channel_routes")
  .select("org_id, label")
  .eq("channel", "whatsapp")
  .eq("external_id", webhookToken.trim())
  .maybeSingle();

if (claimed && claimed.org_id !== org.id) {
  const { data: other } = await svc
    .from("orgs").select("name, portal_name").eq("id", claimed.org_id).single();
  console.error(
    `\nThat webhook token is already registered to "${other.portal_name || other.name}".\n` +
      "Remove it there first, or generate a fresh token for this channel —\n" +
      "a token cannot serve two brands.\n"
  );
  process.exit(1);
}

const label = labelParts.join(" ") || `${brandArg.toUpperCase()} WhatsApp`;

// Replace this org's existing whatsapp route rather than adding a second, so
// outbound resolution stays unambiguous.
await svc.from("channel_routes").delete().eq("channel", "whatsapp").eq("org_id", org.id);

const { error } = await svc.from("channel_routes").insert({
  org_id: org.id, channel: "whatsapp", external_id: webhookToken.trim(), label,
  outbound_token: apiKey.trim(),
});
if (error) {
  console.error(`\nCould not register: ${error.message}\n`);
  process.exit(1);
}

console.log(`\nRegistered a WhatsApp channel to ${org.portal_name || org.name} (${label}).`);
console.log("Messages arriving via that token now belong to that org, and it is");
console.log("the channel that org replies through.");
console.log(
  "\nMake sure the 360dialog channel's webhook URL carries this SAME token:\n" +
  "  …/api/webhooks/whatsapp?token=<the value you just registered>\n"
);
await show();
