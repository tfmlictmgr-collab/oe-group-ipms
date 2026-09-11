// The live WhatsApp transcript of 8–28 Aug 2026, turned into a regression lock.
//
// Every message below was sent by a real person to the OEA number, and every
// one of the failures below actually happened. The suite exists because the
// same defect wore four different costumes and each one looked like a one-off:
//
//   "Tell me about my raised requests"  → became ticket 8E147AA6
//   "1F2DBAB0 … what's the stats now?"  → became ticket AE1B818E
//   "This is a test"                    → became ticket 74BB9844
//   a bare "1" with nothing pending     → became ticket 1F2DBAB0
//   an answer to our own question       → became ticket 237A9C51
//
// Section G is the one that must never be weakened: a real problem still opens
// a ticket. Every fix here narrows what counts as a request, and the failure
// mode of narrowing too far is a person reporting a leak and being told
// "noted" — silent, and much worse than a duplicate.
//
// Usage: node scripts/verify-conversational-intelligence.mjs
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";
import { createClient } from "@supabase/supabase-js";

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
config({ path: path.join(rootDir, ".env.local") });

// ⚠️ The deployed app and the database must be the same world. A hardcoded host
// beside a Supabase client built from `.env.local` means a staging run posts
// webhooks to dev, dev writes the tickets, and staging is searched for them —
// the mistake `verify-channel-routing.mjs` documents at length.
const SITE = process.env.VERIFY_SITE_URL ?? process.env.NEXT_PUBLIC_SITE_URL;
if (!SITE) {
  console.error(
    "No target. Set NEXT_PUBLIC_SITE_URL in .env.local (the deployment that belongs\n" +
    "to this database), or pass VERIFY_SITE_URL explicitly."
  );
  process.exit(1);
}
const APP_SECRET = process.env.WHATSAPP_APP_SECRET;
if (!APP_SECRET) {
  console.error("WHATSAPP_APP_SECRET not set locally — cannot sign a webhook.");
  process.exit(1);
}

const svc = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);

let failures = 0;
let degraded = 0;
const ok = (m) => console.log(`  \x1b[32mPASS\x1b[0m ${m}`);
const bad = (m) => { failures++; console.log(`  \x1b[31mFAIL\x1b[0m ${m}`); };
const warn = (m) => { degraded++; console.log(`  \x1b[33mNOTE\x1b[0m ${m}`); };

const { data: routes, error: rErr } = await svc
  .from("channel_routes").select("external_id, org_id, label").eq("channel", "whatsapp");
if (rErr) { console.error("db unreachable:", rErr.message); process.exit(1); }
if (!routes?.length) { console.error("No WhatsApp route to test against."); process.exit(1); }
const route = routes[0];

const S = Date.now().toString(36).toUpperCase().slice(-5);
const senders = new Set();

async function send(text, sender) {
  senders.add(sender);
  const raw = JSON.stringify({
    object: "whatsapp_business_account",
    entry: [{ changes: [{ value: {
      metadata: { display_phone_number: "0000", phone_number_id: route.external_id },
      contacts: [{ profile: { name: `Convo ${S}` } }],
      messages: [{ id: `wamid.CONVO-${S}-${crypto.randomUUID()}`, type: "text", from: sender, text: { body: text } }],
    } }] }],
  });
  const sig = "sha256=" + crypto.createHmac("sha256", APP_SECRET).update(raw).digest("hex");
  await fetch(`${SITE}/api/webhooks/whatsapp`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-hub-signature-256": sig },
    body: raw,
  });
  // Router and classifier are both model calls; give the write time to land.
  await new Promise((r) => setTimeout(r, 4000));
}

const ticketsFor = async (sender) =>
  (await svc.from("tickets")
    .select("id, message_text, category, urgency, classified_by, created_at")
    .eq("org_id", route.org_id).eq("channel_sender_ref", sender)
    .order("created_at")).data ?? [];

const messagesOn = async (ticketId) =>
  (await svc.from("ticket_messages").select("author, body")
    .eq("ticket_id", ticketId).order("created_at")).data ?? [];

let n = 0;
const nextSender = () => `234700convo${S}${(n++).toString(36)}`;

// ⚠️ Ticket counts alone cannot tell a healthy primary from a dead one caught
// by the fallback. Every check here can pass on Gemini; a green run is not by
// itself evidence the primary is alive (28 Aug 2026, exactly that).
function checkProvider(label, row) {
  if (!row) return;
  if (row.classified_by === "anthropic") ok(`${label} classified by the primary (anthropic)`);
  else if (row.classified_by === "gemini")
    warn(`${label} classified by the FALLBACK (gemini) — check Settings → AI & Classification`);
  else bad(`${label} classified by "${row.classified_by ?? "null"}" — both providers were unreachable`);
}

console.log(`Conversational intelligence — against ${SITE}`);
console.log(`Brand: ${route.label ?? route.org_id}\n`);

// ── A ──────────────────────────────────────────────────────────────────────
console.log("A. A question about their own requests is ANSWERED, not logged");
{
  const s = nextSender();
  // First, something real to have open — otherwise "what do I have?" is
  // trivially answered with "nothing" and proves less than it looks.
  await send("The tap in my kitchen has been dripping since yesterday.", s);
  const afterFirst = await ticketsFor(s);
  afterFirst.length === 1
    ? ok("a real problem opens one request")
    : bad(`expected 1 ticket after the problem, found ${afterFirst.length}`);
  checkProvider("the opening problem", afterFirst[0]);

  // ⚠️ THE headline case. This exact sentence became ticket 8E147AA6.
  await send("Tell me about my raised requests", s);
  const afterQuestion = await ticketsFor(s);
  afterQuestion.length === 1
    ? ok('"Tell me about my raised requests" raised NO ticket — 8E147AA6 cannot recur')
    : bad(`!!! A QUESTION BECAME A REQUEST: ${afterQuestion.length} tickets, ${JSON.stringify(afterQuestion.map((t) => t.message_text))}`);

  await send("what's outstanding on my side?", s);
  (await ticketsFor(s)).length === 1
    ? ok("and neither did a differently-phrased one")
    : bad("a rephrased question still became a request");
}

// ── B ──────────────────────────────────────────────────────────────────────
console.log("\nB. An answer to OUR question continues the thread");
{
  const s = nextSender();
  await send("Hello", s);
  const afterGreeting = await ticketsFor(s);
  afterGreeting.length === 0
    ? ok('"Hello" raises nothing, and we ask them what is wrong')
    : bad(`a greeting raised ${afterGreeting.length} ticket(s)`);

  // We asked "tell us what needs attention". This is the answer, and it must
  // open exactly ONE request — not zero (brushed off) and not two.
  await send("My ceiling is broken in the back room", s);
  const afterAnswer = await ticketsFor(s);
  afterAnswer.length === 1
    ? ok("their answer opens exactly one request")
    : bad(`the answer to our question produced ${afterAnswer.length} ticket(s)`);

  // Now the 237A9C51 shape: we acknowledge and invite more, they say more.
  await send("It's also affecting the wall beside it now", s);
  const afterMore = await ticketsFor(s);
  if (afterMore.length === 1) {
    ok("saying more about it does NOT open a second — 237A9C51 cannot recur");
    const msgs = await messagesOn(afterMore[0].id);
    msgs.some((m) => m.author === "reporter" && m.body.includes("wall"))
      ? ok("and the extra detail is recorded on the request itself")
      : bad("the follow-up was accepted but never written to the ticket");
  } else {
    bad(`!!! AN ANSWER TO OUR OWN QUESTION BECAME A NEW TICKET (${afterMore.length} total)`);
  }
}

// ── C ──────────────────────────────────────────────────────────────────────
console.log("\nC. A quoted reference finds the request it names");
{
  const s = nextSender();
  await send("The generator in Block C keeps cutting out.", s);
  const [t] = await ticketsFor(s);
  if (!t) {
    bad("could not open a request to quote back");
  } else {
    const ref = t.id.replace(/-/g, "").slice(0, 8).toUpperCase();
    // The AE1B818E shape, verbatim in structure.
    await send(`${ref} what's the status now?`, s);
    const after = await ticketsFor(s);
    after.length === 1
      ? ok(`quoting ${ref} answers about ${ref} — AE1B818E cannot recur`)
      : bad(`!!! QUOTING A REFERENCE OPENED A NEW TICKET (${after.length} total)`);

    // Lower case and a "ref:" prefix are the same reference.
    await send(`ref: ${ref.toLowerCase()} any update?`, s);
    (await ticketsFor(s)).length === 1
      ? ok("and so does a lower-case, prefixed one")
      : bad("a lower-case reference was not recognised");
  }
}

// ── D ──────────────────────────────────────────────────────────────────────
console.log("\nD. A reference is a hint, never an authority");
{
  const owner = nextSender();
  await send("The lift in Block A is stuck between floors.", owner);
  const [theirs] = await ticketsFor(owner);

  if (!theirs) {
    bad("could not open a request to attempt to reach");
  } else {
    const ref = theirs.id.replace(/-/g, "").slice(0, 8).toUpperCase();
    // ⚠️ The security half of section C. Knowing a reference must not be
    // enough to read or alter someone else's request.
    const { data: stolen } = await svc.rpc("resolve_ticket_by_ref", {
      p_org_id: route.org_id,
      p_sender_ref: "2347000000000",
      p_ref: ref,
    });
    (stolen ?? []).length === 0
      ? ok("a stranger quoting a real reference resolves to nothing")
      : bad(`!!! ANOTHER SENDER READ TICKET ${ref} BY QUOTING ITS REFERENCE`);

    const { data: mine } = await svc.rpc("resolve_ticket_by_ref", {
      p_org_id: route.org_id, p_sender_ref: owner, p_ref: ref,
    });
    (mine ?? []).length === 1
      ? ok("while the person who raised it still reaches their own")
      : bad("the owner could not resolve their own reference — the guard is too tight");
  }

  // And the other org must not be reachable at all.
  const { data: otherOrg } = await svc.from("orgs").select("id")
    .neq("id", route.org_id).is("deleted_at", null).limit(1).single();
  if (otherOrg && theirs) {
    const ref = theirs.id.replace(/-/g, "").slice(0, 8).toUpperCase();
    const { data: crossed } = await svc.rpc("resolve_ticket_by_ref", {
      p_org_id: otherOrg.id, p_sender_ref: owner, p_ref: ref,
    });
    (crossed ?? []).length === 0
      ? ok("and the same reference resolves to nothing in another organisation")
      : bad("!!! A REFERENCE CROSSED AN ORGANISATION BOUNDARY");
  }
}

// ── E ──────────────────────────────────────────────────────────────────────
console.log("\nE. Nothing is not something");
{
  const s = nextSender();
  await send("This is a test", s);
  (await ticketsFor(s)).length === 0
    ? ok('"This is a test" raises no ticket — 74BB9844 cannot recur')
    : bad('!!! "This is a test" BECAME A REQUEST');

  await send("ok", s);
  (await ticketsFor(s)).length === 0
    ? ok('"ok" raises no ticket')
    : bad('"ok" became a request');

  // The 1F2DBAB0 shape: a bare number with no question outstanding.
  const s2 = nextSender();
  await send("1", s2);
  (await ticketsFor(s2)).length === 0
    ? ok('a bare "1" with nothing pending raises no ticket — 1F2DBAB0 cannot recur')
    : bad('!!! A BARE "1" BECAME A REQUEST');
}

// ── F ──────────────────────────────────────────────────────────────────────
console.log("\nF. But a number IS honoured when we asked for one");
{
  const s = nextSender();
  // A critical-sounding report gets the full priority menu, which is what sets
  // `awaiting` and makes the next bare number meaningful.
  await send("There is water pouring through the ceiling and the sockets are wet.", s);
  const [t] = await ticketsFor(s);
  if (!t) {
    bad("the urgent report did not open a request");
  } else {
    await send("4", s);
    const after = await ticketsFor(s);
    after.length === 1
      ? ok("a numbered reply to our own question opens no ticket")
      : bad(`a numbered reply opened ${after.length - 1} extra ticket(s)`);

    const { data: updated } = await svc.from("tickets")
      .select("urgency, urgency_source").eq("id", t.id).single();
    updated.urgency === "low" && updated.urgency_source === "reporter"
      ? ok("and it actually changes the priority, recorded as the reporter's")
      : warn(`priority is ${updated.urgency}/${updated.urgency_source} — expected low/reporter (an operator may have judged it first)`);
  }
}

// ── G ──────────────────────────────────────────────────────────────────────
console.log("\nG. The thing that must never regress: a real problem still gets a ticket");
{
  for (const [label, text] of [
    ["a plain fault", "No water in the whole block since morning"],
    ["pidgin", "Light don go for the whole compound since yesterday night"],
    ["terse", "AC not working"],
    ["a question-shaped request", "Can you send someone to fix my toilet?"],
  ]) {
    const s = nextSender();
    await send(text, s);
    const t = await ticketsFor(s);
    t.length === 1
      ? ok(`${label}: "${text.slice(0, 40)}…" → one request`)
      : bad(`!!! ${label.toUpperCase()} RAISED ${t.length} TICKET(S) — a real problem was brushed off or duplicated`);
    if (t.length === 1) checkProvider(label, t[0]);
  }
}

// ── H ──────────────────────────────────────────────────────────────────────
console.log("\nH. The new state is actually stored, and cannot hold anything else");
{
  const s = nextSender();
  await svc.rpc("remember_conversation_state", {
    p_org_id: route.org_id, p_channel: "whatsapp", p_sender_ref: s,
    p_ticket_id: null, p_awaiting: "describe_problem",
    p_last_prompt: "What needs attention, and where?", p_hours: 1,
  });
  const { data: state } = await svc.rpc("conversation_state", {
    p_org_id: route.org_id, p_channel: "whatsapp", p_sender_ref: s,
  }).maybeSingle();
  state?.awaiting === "describe_problem" && state?.last_prompt?.includes("attention")
    ? ok("an outstanding question is readable with NO ticket attached")
    : bad(`conversation_state returned ${JSON.stringify(state)} — the state 237A9C51 needed is not there`);

  const { error: badState } = await svc.from("chat_conversations")
    .update({ awaiting: "whatever_i_like" })
    .eq("org_id", route.org_id).eq("sender_ref", s);
  badState
    ? ok("and the column still refuses a value nothing handles")
    : bad("chat_conversations.awaiting accepted an unknown state — the check constraint is gone");

  // The old entry point must keep working: a verify script and 0114 both name it.
  const { error: legacyErr } = await svc.rpc("remember_conversation", {
    p_org_id: route.org_id, p_channel: "whatsapp", p_sender_ref: s,
    p_ticket_id: null, p_awaiting: "urgency_confirmation", p_hours: 1,
  });
  !legacyErr
    ? ok("remember_conversation still answers on its original signature")
    : bad(`remember_conversation broke: ${legacyErr.message}`);

  await svc.from("chat_conversations").delete()
    .eq("org_id", route.org_id).eq("sender_ref", s);
}

// ── I ──────────────────────────────────────────────────────────────────────
console.log("\nI. The new functions are not reachable from a browser session");
{
  const anon = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    { auth: { persistSession: false } }
  );
  for (const [fn, args] of [
    ["sender_open_requests", { p_org_id: route.org_id, p_sender_ref: "234700000", p_limit: 5 }],
    ["resolve_ticket_by_ref", { p_org_id: route.org_id, p_sender_ref: "234700000", p_ref: "AAAA1111" }],
    ["conversation_state", { p_org_id: route.org_id, p_channel: "whatsapp", p_sender_ref: "234700000" }],
    ["remember_conversation_state", { p_org_id: route.org_id, p_channel: "whatsapp", p_sender_ref: "x", p_ticket_id: null, p_awaiting: null, p_last_prompt: "x", p_hours: 1 }],
  ]) {
    const { error } = await anon.rpc(fn, args);
    error
      ? ok(`${fn} — refused anonymously, like every other webhook RPC`)
      : bad(`!!! ${fn} IS CALLABLE ANONYMOUSLY — anyone could read a sender's requests`);
  }
}

// ── Cleanup ────────────────────────────────────────────────────────────────
for (const s of senders) {
  const { data: mine } = await svc.from("tickets").select("id")
    .eq("org_id", route.org_id).eq("channel_sender_ref", s);
  const ids = (mine ?? []).map((t) => t.id);
  await svc.from("chat_conversations").delete().eq("org_id", route.org_id).eq("sender_ref", s);
  if (ids.length) {
    await svc.from("ticket_messages").delete().in("ticket_id", ids);
    await svc.from("audit_log").delete().in("entity_id", ids)
      .eq("action", "ticket.urgency_corrected_by_reporter");
    await svc.from("notifications").delete().in("entity_id", ids);
    await svc.from("tickets").delete().in("id", ids);
  }
}
await svc.from("chat_webhook_events").delete().like("event_id", `wamid.CONVO-${S}-%`);
console.log("\n(cleaned up)");

if (failures === 0 && degraded > 0) {
  console.log(
    `\n\x1b[33mALL CHECKS PASSED, WITH ${degraded} NOTE(S)\x1b[0m — ` +
    `every check here can pass on the fallback model alone; a healthy primary is ` +
    `not something a green run guarantees by itself.`
  );
} else {
  console.log(
    failures === 0
      ? "\n\x1b[32mALL CHECKS PASSED\x1b[0m — a question is answered, an answer continues the thread, a reference finds its own request, and a real problem still gets a ticket."
      : `\n\x1b[31m${failures} CHECK(S) FAILED\x1b[0m`
  );
}
process.exit(failures === 0 ? 0 : 1);
