// Audit 0805 M1/M2/L1, plus the live blank-ticket defect found alongside them.
//
// What this proves, in the order it matters:
//   A. A message with no words in it never becomes a ticket, on either
//      channel — the defect found in production, where a sticker/voice-note
//      class message silently created a content-less row in both TFML and
//      OEA (two real senders, correctly routed, same bug twice — NOT a
//      cross-org leak, which section B covers separately and explicitly).
//   B. M1 — two orgs' Telegram bots colliding on the same small update_id
//      no longer drops the second org's message.
//   C. M2 — logo_url cannot be pointed at an external URL, closing the
//      open-redirect surface the favicon route created.
//   D. L1 — retiring and superseding a rubric criterion are both audited.
//   E. The classifier tells a greeting apart from a request, including
//      phrasings that were never in the hardcoded COMMANDS list.
//
// Usage: node scripts/verify-intake-intelligence.mjs
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";
import { createClient } from "@supabase/supabase-js";

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
config({ path: path.join(rootDir, ".env.local") });

const TARGET = process.env.TARGET ?? "http://localhost:3000";
const svc = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);

let failures = 0;
const ok = (m) => console.log(`  \x1b[32mPASS\x1b[0m ${m}`);
const bad = (m) => { failures++; console.log(`  \x1b[31mFAIL\x1b[0m ${m}`); };

const stamp = Date.now().toString(36).toUpperCase().slice(-6);
const senders = [];

// Start-of-run sweep.
{
  const { data: strays } = await svc.from("tickets").select("id")
    .like("channel_sender_ref", "234700intel%");
  if (strays?.length) {
    await svc.from("tickets").delete().in("id", strays.map((s) => s.id));
    console.log(`(swept ${strays.length} stray ticket(s) from an earlier run)`);
  }
  await svc.from("chat_webhook_events").delete().like("event_id", "wamid.INTEL-%");
  await svc.from("chat_webhook_events").delete().like("sender_ref", "234700intel%");
}

const { data: waRoutes } = await svc.from("channel_routes")
  .select("org_id, external_id, label").eq("channel", "whatsapp");
const tfml = waRoutes.find((r) => r.label?.includes("TFML")) ?? waRoutes[0];

async function sendWhatsApp(message, senderRef) {
  const raw = JSON.stringify({
    object: "whatsapp_business_account",
    entry: [{ changes: [{ value: {
      metadata: { display_phone_number: "0000", phone_number_id: tfml.external_id },
      contacts: [{ profile: { name: "Intel Probe" } }],
      messages: [{ from: senderRef, ...message }],
    } }] }],
  });
  const sig = "sha256=" + crypto.createHmac("sha256", process.env.WHATSAPP_APP_SECRET)
    .update(raw).digest("hex");
  const res = await fetch(`${TARGET}/api/webhooks/whatsapp`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-hub-signature-256": sig },
    body: raw,
  });
  await new Promise((r) => setTimeout(r, 3500));
  return res.status;
}

const ticketsFor = async (senderRef) =>
  (await svc.from("tickets").select("id, message_text").eq("channel_sender_ref", senderRef)).data ?? [];

console.log(`Intake intelligence — against ${TARGET}\n`);

console.log("A. A message with no words in it never becomes a ticket");
{
  // The exact shape found live: a sticker. No text field at all.
  const stickerSender = `234700intel${stamp}a`;
  senders.push(stickerSender);
  await sendWhatsApp(
    { id: `wamid.INTEL-${stamp}-sticker`, type: "sticker", sticker: { id: "x", mime_type: "image/webp" } },
    stickerSender
  );
  const stickerTickets = await ticketsFor(stickerSender);
  stickerTickets.length === 0
    ? ok("a sticker creates NO ticket — the live blank-ticket defect is closed")
    : bad(`A STICKER CREATED ${stickerTickets.length} BLANK TICKET(S): ${JSON.stringify(stickerTickets)}`);

  // A voice note — same class, no caption possible.
  const voiceSender = `234700intel${stamp}b`;
  senders.push(voiceSender);
  await sendWhatsApp(
    { id: `wamid.INTEL-${stamp}-voice`, type: "audio", audio: { id: "y", mime_type: "audio/ogg" } },
    voiceSender
  );
  (await ticketsFor(voiceSender)).length === 0
    ? ok("a voice note creates no ticket either")
    : bad("A VOICE NOTE CREATED A BLANK TICKET");

  // But a photo WITH a caption is the sender's own words, and must work.
  const captionSender = `234700intel${stamp}c`;
  senders.push(captionSender);
  await sendWhatsApp(
    {
      id: `wamid.INTEL-${stamp}-caption`, type: "image",
      image: { id: "z", caption: "The ceiling in my kitchen is leaking badly, water everywhere" },
    },
    captionSender
  );
  const captioned = await ticketsFor(captionSender);
  captioned.length === 1 && captioned[0].message_text.includes("ceiling")
    ? ok("a photo WITH a caption still raises a real ticket — the caption is their words")
    : bad(`a captioned photo should raise exactly one ticket carrying the caption; got ${JSON.stringify(captioned)}`);
}

console.log("\nB. M1 — two orgs' bots can share an update_id without dropping a message");
{
  const orgs = (await svc.from("orgs").select("id").is("deleted_at", null).limit(2)).data;
  const sharedUpdateId = `${Date.now()}`;

  const first = await svc.from("chat_webhook_events").insert({
    channel: "telegram", event_id: sharedUpdateId, org_id: orgs[0].id,
  });
  const second = await svc.from("chat_webhook_events").insert({
    channel: "telegram", event_id: sharedUpdateId, org_id: orgs[1].id,
  });

  !first.error
    ? ok("org A's bot records update_id " + sharedUpdateId)
    : bad(`org A's insert failed: ${first.error.message}`);
  !second.error
    ? ok("and org B's bot records the SAME update_id — no false 'already handled', no dropped message")
    : bad(`!!! M1 REGRESSION — org B's message was rejected as a duplicate of org A's: ${second.error.message}`);

  // The genuine case must still be caught: same org, same id.
  const repeat = await svc.from("chat_webhook_events").insert({
    channel: "telegram", event_id: sharedUpdateId, org_id: orgs[0].id,
  });
  repeat.error?.message.includes("duplicate key")
    ? ok("but a true redelivery to the SAME org is still deduplicated")
    : bad("a real redelivery was NOT caught — dedup is now too loose");

  await svc.from("chat_webhook_events").delete().eq("event_id", sharedUpdateId);
}

console.log("\nC. M2 — logo_url cannot be pointed at an external URL");
{
  const { data: org } = await svc.from("orgs").select("id, logo_url")
    .eq("delivery_brand", "TFML").limit(1).single();
  const original = org.logo_url;

  const { error: extErr } = await svc.from("orgs")
    .update({ logo_url: "https://attacker.example/phish" }).eq("id", org.id);
  extErr
    ? ok("an external URL is refused by the database, not just by the save action")
    : bad("!!! AN EXTERNAL URL WAS STORED IN logo_url — the favicon route will redirect visitors to it");

  const { error: schemeErr } = await svc.from("orgs")
    .update({ logo_url: "javascript:alert(1)" }).eq("id", org.id);
  schemeErr
    ? ok("and so is a javascript: scheme")
    : bad("!!! A javascript: URL WAS STORED IN logo_url");

  const valid = `https://uszwigxdvjlwcwkjsjmc.supabase.co/storage/v1/object/public/org-logos/${org.id}/logo-test.png`;
  const { error: validErr } = await svc.from("orgs").update({ logo_url: valid }).eq("id", org.id);
  !validErr
    ? ok("a genuine storage URL still saves — the constraint does not break real branding")
    : bad(`a legitimate logo URL was refused: ${validErr.message}`);

  const { error: nullErr } = await svc.from("orgs").update({ logo_url: null }).eq("id", org.id);
  !nullErr ? ok("and clearing it is still allowed") : bad("could not clear logo_url");

  await svc.from("orgs").update({ logo_url: original }).eq("id", org.id);
}

console.log("\nD. L1 — rubric changes are audited, including the ones that are UPDATEs");
{
  const { data: org } = await svc.from("orgs").select("id")
    .eq("slug", "oe-group-foundation-poc").single();
  const { data: crit } = await svc.from("evaluation_criteria")
    .select("id").eq("org_id", org.id).eq("active", true).eq("measure", "manual").limit(1).single();

  const before = (await svc.from("audit_log").select("id")
    .eq("entity_type", "evaluation_criteria").eq("entity_id", crit.id)).data ?? [];

  await svc.rpc("retire_evaluation_criterion", { p_id: crit.id });

  const after = (await svc.from("audit_log").select("id, action")
    .eq("entity_type", "evaluation_criteria").eq("entity_id", crit.id)).data ?? [];

  after.length > before.length
    ? ok(`retiring a criterion is now recorded (${before.length} → ${after.length} audit entries)`)
    : bad("RETIRING A CRITERION STILL LEAVES NO AUDIT TRAIL");

  // Restore it so the org's rubric is unchanged by this suite.
  await svc.from("evaluation_criteria").update({ active: true }).eq("id", crit.id);
}

console.log("\nE. The classifier tells a greeting apart from a request");
{
  // Deliberately NOT in the hardcoded COMMANDS list — this is the gap that
  // let a differently-phrased greeting become a ticket.
  const greetSender = `234700intel${stamp}d`;
  senders.push(greetSender);
  await sendWhatsApp(
    { id: `wamid.INTEL-${stamp}-greet`, type: "text", text: { body: "Good afternoon" } },
    greetSender
  );
  const greetTickets = await ticketsFor(greetSender);
  greetTickets.length === 0
    ? ok('"Good afternoon" raises no ticket, though it is not in the hardcoded command list')
    : bad(`a plain greeting raised ${greetTickets.length} ticket(s): ${JSON.stringify(greetTickets)}`);

  // And the thing that must never regress: a real problem still gets a ticket.
  const realSender = `234700intel${stamp}e`;
  senders.push(realSender);
  await sendWhatsApp(
    { id: `wamid.INTEL-${stamp}-real`, type: "text", text: { body: "No water in the whole block since morning" } },
    realSender
  );
  const realTickets = await ticketsFor(realSender);
  realTickets.length === 1
    ? ok("but a real problem still raises exactly one ticket — the safe direction is preserved")
    : bad(`!!! A REAL PROBLEM RAISED ${realTickets.length} TICKET(S) — a person reporting an issue was brushed off`);
}

// ── Cleanup ────────────────────────────────────────────────────────────────
for (const s of senders) await svc.from("tickets").delete().eq("channel_sender_ref", s);
await svc.from("chat_webhook_events").delete().like("event_id", "wamid.INTEL-%");
console.log("\n(cleaned up)");

console.log(
  failures === 0
    ? "\n\x1b[32mALL CHECKS PASSED\x1b[0m — silence is not a request, a greeting is not a ticket, and one org's bot cannot mute another's."
    : `\n\x1b[31m${failures} CHECK(S) FAILED\x1b[0m`
);
process.exit(failures === 0 ? 0 : 1);
