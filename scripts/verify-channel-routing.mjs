// Proves Day 2 per-org inbound routing END TO END against the deployed dev app:
// a signed WhatsApp payload is routed to an org purely by its phone_number_id,
// a signed Telegram update by its secret token, an unknown identity is dropped,
// and a bad token is rejected. Each created ticket is then read back from the
// dev DB and its org asserted — so this exercises the real handler + real DB.
//
// Usage: node scripts/verify-channel-routing.mjs
//   TARGET env overrides the base URL (default: the dev deployment).
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";
import { createClient } from "@supabase/supabase-js";

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
config({ path: path.join(rootDir, ".env.local") });

const TARGET = process.env.TARGET ?? "https://oe-group-ipms-dev.vercel.app";
const APP_SECRET = process.env.WHATSAPP_APP_SECRET;
const TG_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET;
const svc = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);

let failures = 0;
const ok = (m) => console.log(`  \x1b[32mPASS\x1b[0m ${m}`);
const bad = (m) => { failures++; console.log(`  \x1b[31mFAIL\x1b[0m ${m}`); };

// org_id → readable brand, so assertions read cleanly.
const { data: orgs } = await svc.from("orgs").select("id, name, delivery_brand");
const brandOf = (id) => orgs?.find((o) => o.id === id)?.delivery_brand ?? "??";

function waPayload(phoneNumberId, sender, text) {
  return {
    object: "whatsapp_business_account",
    entry: [{
      changes: [{
        value: {
          messaging_product: "whatsapp",
          metadata: { display_phone_number: "0000", phone_number_id: phoneNumberId },
          contacts: [{ profile: { name: "Routing Test" }, wa_id: sender }],
          messages: [{ from: sender, id: "wamid.test", type: "text", text: { body: text } }],
        },
      }],
    }],
  };
}

async function postWhatsApp(phoneNumberId, sender, text) {
  const raw = JSON.stringify(waPayload(phoneNumberId, sender, text));
  const sig = "sha256=" + crypto.createHmac("sha256", APP_SECRET).update(raw).digest("hex");
  const res = await fetch(`${TARGET}/api/webhooks/whatsapp`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-hub-signature-256": sig },
    body: raw,
  });
  return res.status;
}

async function ticketOrgFor(sender) {
  const { data } = await svc
    .from("tickets").select("org_id").eq("channel_sender_ref", sender)
    .order("created_at", { ascending: false }).limit(1).maybeSingle();
  return data?.org_id ?? null;
}

const stamp = Date.now();
console.log(`Channel routing E2E against ${TARGET}\n`);

console.log("A. WhatsApp routes by phone_number_id → correct org");
{
  const sender = `+234TFML${stamp}`;
  const status = await postWhatsApp("TFML_WA_TEST_1000", sender, "Broken generator at the plant room");
  const org = await ticketOrgFor(sender);
  if (status === 200 && org && brandOf(org) === "TFML") ok(`TFML number → ticket in TFML org (${brandOf(org)})`);
  else bad(`TFML number → status ${status}, org ${org ? brandOf(org) : "none"}`);
}
{
  const sender = `+234OEA${stamp}`;
  const status = await postWhatsApp("OEA_WA_TEST_2000", sender, "Rent statement query for my unit");
  const org = await ticketOrgFor(sender);
  if (status === 200 && org && brandOf(org) === "OEA") ok(`OEA number → ticket in OEA org (${brandOf(org)})`);
  else bad(`OEA number → status ${status}, org ${org ? brandOf(org) : "none"}`);
}

console.log("\nB. Brand isolation: neither ticket crossed into the other org");
{
  const tfmlOrg = orgs.find((o) => o.delivery_brand === "TFML")?.id;
  const oeaOrg = orgs.find((o) => o.delivery_brand === "OEA")?.id;
  const tfmlTicketOrg = await ticketOrgFor(`+234TFML${stamp}`);
  const oeaTicketOrg = await ticketOrgFor(`+234OEA${stamp}`);
  if (tfmlTicketOrg === tfmlOrg && oeaTicketOrg === oeaOrg && tfmlOrg !== oeaOrg)
    ok("TFML ticket ≠ OEA ticket org — disjoint");
  else bad("cross-brand leak: tickets not in their own orgs");
}

console.log("\nC. Unknown WhatsApp number is DROPPED (no ticket, still 200 to Meta)");
{
  const sender = `+234UNK${stamp}`;
  const status = await postWhatsApp("UNREGISTERED_NUMBER_999", sender, "should be dropped");
  const org = await ticketOrgFor(sender);
  if (status === 200 && org === null) ok("unrouted number → 200 and no ticket created");
  else bad(`unrouted number → status ${status}, ticket org ${org ? brandOf(org) : "none"}`);
}

console.log("\nD. WhatsApp forged signature is rejected (403), unaffected by routing");
{
  const raw = JSON.stringify(waPayload("TFML_WA_TEST_1000", "+234BAD", "forged"));
  const res = await fetch(`${TARGET}/api/webhooks/whatsapp`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-hub-signature-256": "sha256=deadbeef" },
    body: raw,
  });
  if (res.status === 403) ok("bad signature → 403");
  else bad(`bad signature → ${res.status}`);
}

console.log("\nE. Telegram: valid secret token routes; bad token is rejected");
{
  const chatId = `9${stamp}`.slice(0, 9);
  const raw = JSON.stringify({ update_id: 1, message: { message_id: 1, chat: { id: Number(chatId) }, from: { first_name: "TgTest" }, text: "Water leak in the lobby" } });
  const good = await fetch(`${TARGET}/api/webhooks/telegram`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": TG_SECRET },
    body: raw,
  });
  const org = await ticketOrgFor(chatId);
  if (good.status === 200 && org && brandOf(org) === "direct") ok(`valid token → ticket in POC org (${brandOf(org)})`);
  else bad(`valid token → status ${good.status}, org ${org ? brandOf(org) : "none"}`);

  const badRes = await fetch(`${TARGET}/api/webhooks/telegram`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": "wrong-token-xyz" },
    body: JSON.stringify({ update_id: 2, message: { message_id: 2, chat: { id: 111 }, text: "forged" } }),
  });
  if (badRes.status === 403) ok("wrong token → 403");
  else bad(`wrong token → ${badRes.status}`);
}

console.log(
  failures === 0
    ? "\n\x1b[32mALL CHECKS PASSED\x1b[0m — inbound messages route to the right org; unknown/forged are refused."
    : `\n\x1b[31m${failures} CHECK(S) FAILED\x1b[0m`
);
process.exit(failures === 0 ? 0 : 1);
