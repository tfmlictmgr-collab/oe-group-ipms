// Intake that can hold a conversation.
//
// The defect underneath the board's request: every inbound message created a new
// ticket. "It's worse now" opened a second one; the acknowledgement's own
// invitation to "reply and we'll correct it" opened a third.
//
// The claims that matter — all about the GUARDS, because the routing itself is a
// model call and the guards are what make it safe to act on:
//   • only the person who raised a ticket can re-prioritise it
//   • a reporter cannot overrule a priority an operator has set
//   • a self-declared escalation flags for human review rather than driving
//     dispatch on its own
//   • a follow-up joins the thread instead of opening a second ticket
//   • nothing crosses an org boundary, and nothing touches a closed ticket
//   • conversation context expires, so a message weeks later starts fresh
//   • the correction is on the audit trail
//
// Usage: node scripts/verify-conversational-triage.mjs
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";
import { createClient } from "@supabase/supabase-js";

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
config({ path: path.join(rootDir, ".env.local") });

const URL_ = process.env.NEXT_PUBLIC_SUPABASE_URL;
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const PW = "OEGroupDemo2026!";

let failures = 0;
const ok = (m) => console.log(`  \x1b[32mPASS\x1b[0m ${m}`);
const bad = (m) => { failures++; console.log(`  \x1b[31mFAIL\x1b[0m ${m}`); };

const svc = createClient(URL_, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

const orgRes = await svc.from("orgs").select("id, delivery_brand").is("deleted_at", null);
if (orgRes.error) { console.error("db unreachable:", orgRes.error.message); process.exit(1); }
const poc = orgRes.data.find((o) => o.delivery_brand === "direct");
const tfml = orgRes.data.find((o) => o.delivery_brand === "TFML");

const S = Date.now().toString(36).toUpperCase().slice(-5);
const SENDER = `23480000${S.slice(0, 4)}`;
const OTHER = `23481111${S.slice(0, 4)}`;
const made = [];

const mkTicket = async (org, sender, urgency = "normal", status = "open") => {
  const { data, error } = await svc.from("tickets").insert({
    org_id: org, channel: "whatsapp", channel_sender_ref: sender,
    message_text: `PROBE-${S} the lobby light is out`,
    category: "maintenance", urgency, status,
  }).select("id, urgency, urgency_source").single();
  if (error) throw new Error(error.message);
  made.push(data.id);
  return data;
};

console.log("Conversational triage\n");

console.log("A. Only the person who raised it may re-prioritise it");
{
  const t = await mkTicket(poc.id, SENDER);

  const { data: byStranger } = await svc.rpc("set_ticket_urgency_by_reporter", {
    p_org_id: poc.id, p_ticket_id: t.id, p_sender_ref: OTHER, p_urgency: "critical",
  });
  byStranger === false
    ? ok("a different number cannot change someone else's priority")
    : bad("A STRANGER RE-PRIORITISED SOMEONE ELSE'S TICKET");

  const { data: byOwner } = await svc.rpc("set_ticket_urgency_by_reporter", {
    p_org_id: poc.id, p_ticket_id: t.id, p_sender_ref: SENDER, p_urgency: "critical",
  });
  byOwner === true ? ok("the reporter can") : bad("the reporter could not correct their own priority");

  const { data: after } = await svc.from("tickets")
    .select("urgency, urgency_source, requires_human_review, urgency_changed_at")
    .eq("id", t.id).single();

  after.urgency === "critical" && after.urgency_source === "reporter"
    ? ok("and it is recorded as reporter-set, not as the AI's assessment")
    : bad(`urgency=${after.urgency} source=${after.urgency_source}`);
  after.requires_human_review === true
    ? ok("a self-declared escalation flags for human review rather than driving dispatch alone")
    : bad("AN ESCALATION TO CRITICAL DID NOT FLAG FOR REVIEW");
  after.urgency_changed_at ? ok("with a timestamp") : bad("no urgency_changed_at recorded");
}

console.log("\nB. A reporter cannot overrule an operator");
{
  const t = await mkTicket(poc.id, SENDER, "low");
  // An operator has since judged it.
  await svc.from("tickets").update({ urgency: "low", urgency_source: "staff" }).eq("id", t.id);

  const { data: applied } = await svc.rpc("set_ticket_urgency_by_reporter", {
    p_org_id: poc.id, p_ticket_id: t.id, p_sender_ref: SENDER, p_urgency: "critical",
  });
  applied === false
    ? ok("refused once a human has set the priority")
    : bad("A REPORTER OVERRODE AN OPERATOR'S JUDGEMENT");

  const { data: after } = await svc.from("tickets").select("urgency, urgency_source").eq("id", t.id).single();
  after.urgency === "low" && after.urgency_source === "staff"
    ? ok("and the operator's decision stands")
    : bad(`the ticket moved to ${after.urgency}/${after.urgency_source}`);

  // Their opinion is not thrown away, though.
  const { data: msgs } = await svc.from("ticket_messages")
    .select("body").eq("ticket_id", t.id);
  (msgs ?? []).some((m) => m.body.includes("not applied"))
    ? ok("their request is still recorded on the thread, so nothing is lost silently")
    : bad("the refused request left no trace");
}

console.log("\nC. A follow-up joins the thread instead of opening a second ticket");
{
  const t = await mkTicket(poc.id, SENDER);
  const before = (await svc.from("tickets").select("id", { count: "exact", head: true })
    .eq("org_id", poc.id).eq("channel_sender_ref", SENDER)).count;

  const { data: added } = await svc.rpc("append_reporter_message", {
    p_org_id: poc.id, p_ticket_id: t.id, p_sender_ref: SENDER,
    p_body: `PROBE-${S} it is worse now, water is coming through`,
  });
  added === true ? ok("the follow-up was accepted") : bad("the follow-up was refused");

  const after = (await svc.from("tickets").select("id", { count: "exact", head: true })
    .eq("org_id", poc.id).eq("channel_sender_ref", SENDER)).count;
  after === before
    ? ok(`no new ticket was created (${before} before, ${after} after)`)
    : bad(`A SECOND TICKET APPEARED: ${before} → ${after}`);

  const { data: msgs } = await svc.from("ticket_messages").select("body, author").eq("ticket_id", t.id);
  (msgs ?? []).some((m) => m.author === "reporter" && m.body.includes("worse now"))
    ? ok("and the words they actually used are on the ticket")
    : bad("the follow-up text is not on the ticket");

  const { data: flagged } = await svc.from("tickets").select("requires_human_review").eq("id", t.id).single();
  flagged.requires_human_review === true
    ? ok("the ticket is flagged so whoever is working it sees that it moved")
    : bad("a follow-up did not flag the ticket");
}

console.log("\nD. Nothing crosses an org boundary, or touches a closed ticket");
{
  const t = await mkTicket(poc.id, SENDER);
  const { data: crossOrg } = await svc.rpc("set_ticket_urgency_by_reporter", {
    p_org_id: tfml.id, p_ticket_id: t.id, p_sender_ref: SENDER, p_urgency: "critical",
  });
  crossOrg === false
    ? ok("a POC ticket cannot be re-prioritised as if it were TFML's")
    : bad("CROSS-ORG PRIORITY CHANGE SUCCEEDED");

  const closed = await mkTicket(poc.id, SENDER, "normal", "closed");
  const { data: onClosed } = await svc.rpc("append_reporter_message", {
    p_org_id: poc.id, p_ticket_id: closed.id, p_sender_ref: SENDER, p_body: "still broken",
  });
  onClosed === false
    ? ok("a closed ticket cannot be reopened by replying to it")
    : bad("A CLOSED TICKET ACCEPTED A FOLLOW-UP");

  const { data: badUrgency } = await svc.rpc("set_ticket_urgency_by_reporter", {
    p_org_id: poc.id, p_ticket_id: t.id, p_sender_ref: SENDER, p_urgency: "catastrophic",
  });
  badUrgency === false ? ok("an unknown priority is refused") : bad("an invalid priority was accepted");
}

console.log("\nE. Conversation context, and its expiry");
{
  const t = await mkTicket(poc.id, SENDER);
  await svc.rpc("remember_conversation", {
    p_org_id: poc.id, p_channel: "whatsapp", p_sender_ref: SENDER,
    p_ticket_id: t.id, p_awaiting: "urgency_confirmation", p_hours: 24,
  });

  const { data: ctx } = await svc.rpc("conversation_context", {
    p_org_id: poc.id, p_channel: "whatsapp", p_sender_ref: SENDER,
  }).maybeSingle();
  ctx?.ticket_id === t.id
    ? ok(`the router is given the open thread (ref ${ctx.reference})`)
    : bad("no conversation context returned");
  ctx?.awaiting === "urgency_confirmation"
    ? ok("including that we just asked about the priority, so a bare '1' means something")
    : bad("the awaiting state was not carried");

  // Expire it in the past — a message weeks later must start fresh.
  await svc.from("chat_conversations")
    .update({ expires_at: new Date(Date.now() - 1000).toISOString() })
    .eq("org_id", poc.id).eq("channel", "whatsapp").eq("sender_ref", SENDER);
  const { data: stale } = await svc.rpc("conversation_context", {
    p_org_id: poc.id, p_channel: "whatsapp", p_sender_ref: SENDER,
  }).maybeSingle();
  !stale
    ? ok("once the window passes there is no thread, so the next message is a new request")
    : bad("AN EXPIRED CONVERSATION WAS STILL OFFERED AS CONTEXT");

  // A resolved ticket must also drop out of context.
  await svc.rpc("remember_conversation", {
    p_org_id: poc.id, p_channel: "whatsapp", p_sender_ref: SENDER,
    p_ticket_id: t.id, p_awaiting: null, p_hours: 24,
  });
  await svc.from("tickets").update({ status: "resolved" }).eq("id", t.id);
  const { data: resolved } = await svc.rpc("conversation_context", {
    p_org_id: poc.id, p_channel: "whatsapp", p_sender_ref: SENDER,
  }).maybeSingle();
  !resolved
    ? ok("and a resolved request is not offered either")
    : bad("a resolved ticket was still the open thread");
}

console.log("\nF. The correction is on the audit trail");
{
  const { data: entries } = await svc.from("audit_log")
    .select("action, entity_id, before_state, after_state")
    .eq("action", "ticket.urgency_corrected_by_reporter")
    .in("entity_id", made);
  (entries ?? []).length >= 1
    ? ok(`${entries.length} correction(s) recorded, with before and after`)
    : bad("NO AUDIT ENTRY FOR A REPORTER PRIORITY CHANGE");
  (entries ?? []).every((e) => e.before_state?.urgency && e.after_state?.urgency)
    ? ok("each one says what it was and what it became")
    : bad("an audit entry is missing its before/after state");
}

console.log("\nG. Staff can read the thread; a stranger cannot");
{
  const c = createClient(URL_, ANON);
  await c.auth.signInWithPassword({ email: "demo@oegroup.test", password: PW });
  const { data: seen } = await c.from("ticket_messages").select("id").in("ticket_id", made);
  (seen ?? []).length > 0
    ? ok(`an administrator reads the conversation (${seen.length} message(s))`)
    : bad("an administrator cannot read ticket messages");
  await c.auth.signOut();

  const v = createClient(URL_, ANON);
  await v.auth.signInWithPassword({ email: "vendor@oegroup.test", password: PW });
  const { data: vendorSees } = await v.from("ticket_messages").select("id").in("ticket_id", made);
  (vendorSees ?? []).length === 0
    ? ok("a vendor with no claim on these tickets reads none of it")
    : bad(`A VENDOR READ ${vendorSees.length} MESSAGE(S)`);
  await v.auth.signOut();

  const anon = createClient(URL_, ANON);
  const { data: anonSees } = await anon.from("ticket_messages").select("id");
  (anonSees ?? []).length === 0
    ? ok("and an anonymous caller reads nothing at all")
    : bad("ANONYMOUS READ TICKET MESSAGES");
}

// ── Cleanup ────────────────────────────────────────────────────────────────
await svc.from("chat_conversations").delete().eq("org_id", poc.id).eq("sender_ref", SENDER);
await svc.from("ticket_messages").delete().in("ticket_id", made);
await svc.from("audit_log").delete().eq("action", "ticket.urgency_corrected_by_reporter").in("entity_id", made);
await svc.from("tickets").delete().in("id", made);
console.log("\n(cleaned up)");

console.log(
  failures === 0
    ? "\n\x1b[32mALL CHECKS PASSED\x1b[0m — a reply continues the conversation, and only the person who started it can steer it."
    : `\n\x1b[31m${failures} CHECK(S) FAILED\x1b[0m`
);
process.exit(failures === 0 ? 0 : 1);
