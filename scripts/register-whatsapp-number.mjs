// Registers a WhatsApp Cloud API number against a brand.
//
// `channel_routes.external_id` is the Meta `phone_number_id` — NOT the phone
// number itself. It decides two things:
//   • inbound  — which org a message that arrives on this number belongs to
//   • outbound — which number that org answers from
//
// So a wrong or missing entry is not cosmetic: a message either lands in the
// wrong brand's data, or is dropped, or is answered by the wrong brand.
//
// ⚠️ The API KEY is now required, not optional. It used to be that Meta issued
// one System User token per business, covering every number under it, so a
// single `WHATSAPP_ACCESS_TOKEN` env var worked for every org. That stopped
// being true the moment TFML and OEA became separate businesses on a BSP
// (360dialog): each business now has its own key, and there is no longer one
// shared credential that answers for both. Skipping the key here would leave
// this route silently falling back to whatever the env var happens to hold —
// exactly the wrong-brand-answers fault this file exists to prevent, just moved
// from the number to the token.
//
// Find the phone_number_id: on 360dialog, the channel's own API/integration
// details; on native Meta, developers.facebook.com → your app → WhatsApp →
// API Setup → "Phone number ID" beside each number. Either way it is a long
// numeric string, not the +234… number.
//
// Usage:
//   node scripts/register-whatsapp-number.mjs TFML 123456789012345 <api-key> "TFML main line"
//   node scripts/register-whatsapp-number.mjs OEA  987654321098765 <api-key> "OEA lettings line"
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

const [brandArg, phoneNumberId, apiKey, ...labelParts] = process.argv.slice(2);

async function show() {
  const { data: routes } = await svc
    .from("channel_routes")
    .select("channel, external_id, label, org_id, outbound_token")
    .eq("channel", "whatsapp");
  const { data: orgs } = await svc.from("orgs").select("id, name, portal_name, delivery_brand");
  const byId = Object.fromEntries(orgs.map((o) => [o.id, o.portal_name || o.name]));

  console.log("\nWhatsApp numbers currently registered:");
  console.table(
    (routes ?? []).map((r) => ({
      org: byId[r.org_id],
      phone_number_id: r.external_id,
      label: r.label,
      // A placeholder cannot receive or send anything.
      real: /^\d{10,}$/.test(r.external_id) ? "yes" : "NO — placeholder",
      // Per-route key, or still riding the single shared env var (pre-BSP org).
      key: r.outbound_token ? "per-route" : "env var fallback",
    }))
  );
  console.log("\nOrganisations available:");
  console.table(orgs.map((o) => ({ brand: o.delivery_brand, name: o.portal_name || o.name })));
}

if (!brandArg || brandArg === "--list") {
  await show();
  console.log(
    "\nTo register:  node scripts/register-whatsapp-number.mjs <TFML|OEA|POC> <phone_number_id> <api-key> [label]\n"
  );
  process.exit(0);
}

if (!/^\d{10,}$/.test(phoneNumberId ?? "")) {
  console.error(
    `\n"${phoneNumberId}" does not look like a Meta phone_number_id.\n` +
      "It is a long numeric id — on 360dialog, the channel's own API/integration\n" +
      "details; on native Meta, WhatsApp → API Setup. Not the +234… number.\n"
  );
  process.exit(1);
}

if (!apiKey || apiKey.trim().length < 8) {
  console.error(
    `\nNo API key given (or it's suspiciously short).\n` +
      "This is the per-business credential from your WhatsApp provider — on\n" +
      "360dialog, each channel's own API key. Required: with two businesses now\n" +
      "holding separate keys, there is no single shared token that answers for\n" +
      "both, so a route with no key of its own cannot safely send.\n"
  );
  process.exit(1);
}

const BRANDS = { TFML: "TFML", OEA: "OEA", POC: "direct" };
const brand = BRANDS[brandArg.toUpperCase()];
if (!brand) {
  console.error(`\nUnknown brand "${brandArg}". Use TFML, OEA or POC.\n`);
  process.exit(1);
}

const { data: org } = await svc
  .from("orgs").select("id, name, portal_name").eq("delivery_brand", brand).limit(1).maybeSingle();
if (!org) {
  console.error(`\nNo organisation with delivery_brand "${brand}".\n`);
  process.exit(1);
}

// One number belongs to exactly one org. Registering it elsewhere would split a
// conversation across brands, so an existing claim is reported rather than
// silently moved.
const { data: claimed } = await svc
  .from("channel_routes")
  .select("org_id, label")
  .eq("channel", "whatsapp")
  .eq("external_id", phoneNumberId)
  .maybeSingle();

if (claimed && claimed.org_id !== org.id) {
  const { data: other } = await svc
    .from("orgs").select("name, portal_name").eq("id", claimed.org_id).single();
  console.error(
    `\nThat phone_number_id is already registered to "${other.portal_name || other.name}".\n` +
      "Remove it there first — a number cannot serve two brands.\n"
  );
  process.exit(1);
}

const label = labelParts.join(" ") || `${brandArg.toUpperCase()} WhatsApp`;

// Replace this org's existing whatsapp route rather than adding a second, so
// outbound resolution stays unambiguous.
await svc.from("channel_routes").delete().eq("channel", "whatsapp").eq("org_id", org.id);

const { error } = await svc.from("channel_routes").insert({
  org_id: org.id, channel: "whatsapp", external_id: phoneNumberId, label,
  outbound_token: apiKey.trim(),
});
if (error) {
  console.error(`\nCould not register: ${error.message}\n`);
  process.exit(1);
}

console.log(`\nRegistered ${phoneNumberId} to ${org.portal_name || org.name} (${label}).`);
console.log("Messages arriving on it now belong to that org, and it is the number");
console.log("that org replies from.");
await show();
