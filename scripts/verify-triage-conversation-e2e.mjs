// The router, end to end, against the deployed webhook and the real model.
//
// The guards are proven by verify-conversational-triage. This proves the thing
// the board actually asked for: that a reply is understood as a reply.
//
// Three messages from one number, in order:
//   1. a problem                → a new ticket
//   2. "no, it's urgent…"       → NO new ticket, the priority changes
//   3. "any update?"            → NO new ticket, a status answer
//
// Usage: node scripts/verify-triage-conversation-e2e.mjs
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";
import { createClient } from "@supabase/supabase-js";

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
config({ path: path.join(rootDir, ".env.local") });

// ⚠️ The deployed app and the database must be the same world — see the longer
// note in `verify-channel-routing.mjs`, which carried the identical defect. A
// hardcoded dev host beside a Supabase client built from `.env.local` means a
// staging run posts webhooks to dev, dev writes the tickets, and staging is
// searched for them. `NEXT_PUBLIC_SITE_URL` sits in the same file as the
// database credentials, so the two cannot drift apart.
const SITE = process.env.VERIFY_SITE_URL ?? process.env.NEXT_PUBLIC_SITE_URL;
if (!SITE) {
  console.error(
    "No target. Set NEXT_PUBLIC_SITE_URL in .env.local (the deployment that belongs\n" +
    "to this database), or pass VERIFY_SITE_URL explicitly."
  );
  process.exit(1);
}
if (process.env.VERIFY_SITE_URL &&
    process.env.NEXT_PUBLIC_SITE_URL &&
    process.env.VERIFY_SITE_URL !== process.env.NEXT_PUBLIC_SITE_URL) {
  console.log(
    `  \x1b[33mNOTE\x1b[0m VERIFY_SITE_URL (${process.env.VERIFY_SITE_URL}) is not this\n` +
    `       database's own deployment (${process.env.NEXT_PUBLIC_SITE_URL}).\n`
  );
}
const APP_SECRET = process.env.WHATSAPP_APP_SECRET;
const svc = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);

let failures = 0;
const ok = (m) => console.log(`  \x1b[32mPASS\x1b[0m ${m}`);
const bad = (m) => { failures++; console.log(`  \x1b[31mFAIL\x1b[0m ${m}`); };

if (!APP_SECRET) { console.error("WHATSAPP_APP_SECRET not set locally — cannot sign."); process.exit(1); }

const { data: routes, error: rErr } = await svc
  .from("channel_routes").select("external_id, org_id, label").eq("channel", "whatsapp");
if (rErr) { console.error("db unreachable:", rErr.message); process.exit(1); }
if (!routes?.length) { console.error("No active WhatsApp route to test against."); process.exit(1); }
const route = routes[0];

const S = Date.now().toString(36).toUpperCase().slice(-5);
const SENDER = `23470000${S.slice(0, 4)}`;

async function send(text) {
  const raw = JSON.stringify({
    object: "whatsapp_business_account",
    entry: [{ changes: [{ value: {
      metadata: { display_phone_number: "0000", phone_number_id: route.external_id },
      contacts: [{ profile: { name: `Probe ${S}` } }],
      messages: [{ from: SENDER, text: { body: text } }],
    } }] }],
  });
  const sig = "sha256=" + crypto.createHmac("sha256", APP_SECRET).update(raw).digest("hex");
  const res = await fetch(`${SITE}/api/webhooks/whatsapp`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-hub-signature-256": sig },
    body: raw,
  });
  // The classifier and the router are both model calls; give the write time to land.
  await new Promise((r) => setTimeout(r, 3500));
  return res.status;
}

const countTickets = async () =>
  (await svc.from("tickets").select("id", { count: "exact", head: true })
    .eq("org_id", route.org_id).eq("channel_sender_ref", SENDER)).count ?? 0;

console.log(`Conversation end-to-end against ${SITE}`);
console.log(`Brand: ${route.label ?? route.org_id}   sender: ${SENDER}\n`);

console.log("1. A first message opens a request");
await send("Good morning, the light in the lobby has stopped working.");
let n = await countTickets();
n === 1 ? ok("one ticket created") : bad(`expected 1 ticket, found ${n}`);

const { data: t1 } = await svc.from("tickets")
  .select("id, urgency, urgency_source, category")
  .eq("org_id", route.org_id).eq("channel_sender_ref", SENDER)
  .order("created_at", { ascending: false }).limit(1).single();
console.log(`   classified as ${t1?.category} / ${t1?.urgency}`);

console.log("\n2. Correcting the priority does NOT open a second one");
await send("No please, this is actually urgent — the whole stairwell is dark and someone fell yesterday.");
n = await countTickets();
n === 1 ? ok("still one ticket — the reply was understood as a correction") : bad(`A SECOND TICKET APPEARED (${n} total)`);

const { data: t2 } = await svc.from("tickets")
  .select("urgency, urgency_source, requires_human_review").eq("id", t1.id).single();
["critical", "high"].includes(t2.urgency)
  ? ok(`priority raised to ${t2.urgency}`)
  : bad(`priority is still ${t2.urgency}`);
t2.urgency_source === "reporter"
  ? ok("recorded as reporter-set, so the dashboard shows it for what it is")
  : bad(`urgency_source is ${t2.urgency_source}`);
t2.requires_human_review === true
  ? ok("and flagged for a person to look at")
  : bad("the escalation did not flag for review");

const { data: msgs } = await svc.from("ticket_messages")
  .select("author, body").eq("ticket_id", t1.id).order("created_at");
(msgs ?? []).length > 0
  ? ok(`the exchange is on the ticket (${msgs.length} message(s))`)
  : bad("nothing was recorded on the ticket");

console.log("\n3. Asking for an update does NOT open a third");
await send("Any update on that?");
n = await countTickets();
n === 1 ? ok("still one ticket") : bad(`A THIRD TICKET APPEARED (${n} total)`);

console.log("\n4. A genuinely different problem DOES open a new one");
await send("Separately, the water pump in Block B is making a loud noise and leaking.");
n = await countTickets();
n === 2
  ? ok("a new problem gets its own ticket — merging it would have lost it")
  : bad(`expected 2 tickets, found ${n}`);

// ── Cleanup ────────────────────────────────────────────────────────────────
const { data: mine } = await svc.from("tickets").select("id")
  .eq("org_id", route.org_id).eq("channel_sender_ref", SENDER);
const ids = (mine ?? []).map((t) => t.id);
await svc.from("chat_conversations").delete().eq("org_id", route.org_id).eq("sender_ref", SENDER);
await svc.from("ticket_messages").delete().in("ticket_id", ids);
await svc.from("audit_log").delete().in("entity_id", ids).eq("action", "ticket.urgency_corrected_by_reporter");
await svc.from("tickets").delete().in("id", ids);
console.log("\n(cleaned up)");

console.log(
  failures === 0
    ? "\n\x1b[32mALL CHECKS PASSED\x1b[0m — a reply continues the request; a new problem starts its own."
    : `\n\x1b[31m${failures} CHECK(S) FAILED\x1b[0m`
);
process.exit(failures === 0 ? 0 : 1);
