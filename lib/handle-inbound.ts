// One place where an inbound chat message is dealt with.
//
// WhatsApp and Telegram differ in how a message ARRIVES and how a reply is SENT.
// What happens in between — work out what they meant, do it, say what was done —
// is identical, and was duplicated across the two webhooks. Two copies of a
// routing rule is two chances for one of them to drift, which is how the
// permission baseline and the ledger resolver each went wrong earlier in this
// build.
//
// ── One rule this file now keeps, that it did not before (0210) ────────────
//
// **Every reply we send is remembered.** The router was blind to our own half
// of the conversation, so we could ask a question and then read the answer as
// if we had never asked it — which is exactly what happened live on 28 Aug:
// "tell us more about it, or describe something new" was answered with "It's
// about a broken ceiling in my room", and we opened a second ticket. Every
// branch below therefore ends by writing what we said and what we are waiting
// for, through `remember_conversation_state`. A branch that returns a reply
// without recording it is a bug, not a shortcut.

import { supabaseAdmin } from "./supabase/admin";
import { classifyAndCreateTicket } from "./triage";
import {
  routeInboundMessage,
  extractTicketRef,
  type OpenThread,
  type ConversationState,
} from "./inbound-router";
import { notifyRoleWithCascade } from "./role-notify";
import { FM_PM } from "@/lib/roles";
import {
  buildAcknowledgement,
  buildFollowUpAck,
  buildStatusReply,
  buildUrgencyConfirmation,
  buildRequestListReply,
  buildNoOpenRequestsReply,
  buildEnquiryAck,
  buildUnclearReply,
  shortRef,
} from "./acknowledgement";

export type InboundResult = {
  /** What to send back, or null when nothing should be sent. */
  reply: string | null;
  /** For logging: what we decided and what we did about it. */
  intent: string;
  ticketId: string | null;
};

type Awaiting = "urgency_confirmation" | "describe_problem" | "disambiguate_ticket" | null;

/** What we last asked this sender, whether or not a ticket exists (0210). */
async function conversationState(
  orgId: string,
  channel: "whatsapp" | "telegram",
  senderRef: string
): Promise<ConversationState | null> {
  const { data, error } = await supabaseAdmin
    .rpc("conversation_state", {
      p_org_id: orgId,
      p_channel: channel,
      p_sender_ref: senderRef,
    })
    .maybeSingle<{ awaiting: string | null; last_prompt: string | null; last_ticket_id: string | null }>();

  if (error) {
    console.error("conversation_state failed for", channel, senderRef, "-", error.message);
    return null;
  }
  if (!data) return null;
  return {
    awaiting: data.awaiting,
    lastPrompt: data.last_prompt,
    lastTicketId: data.last_ticket_id,
  };
}

/** The recent exchange on a ticket, best-effort (0113). */
async function transcriptFor(ticketId: string) {
  const { data, error } = await supabaseAdmin
    .rpc("conversation_transcript", { p_ticket_id: ticketId, p_limit: 8 });
  if (error) {
    // Best-effort on purpose: a failure here is a slightly worse read of a
    // follow-up, not a dropped message. Memory is an improvement to lean on,
    // never a dependency to fall over.
    console.error("conversation_transcript failed for", ticketId, "-", error.message);
    return [];
  }
  return (data ?? []).map((m: { author: string; body: string; created_at: string }) => ({
    author: m.author,
    body: m.body,
    createdAt: m.created_at,
  }));
}

/**
 * Which request this message is about.
 *
 * ⚠️ A reference the sender TYPED beats the one we happened to remember. The
 * remembered thread is "whatever they last talked about, within 24 hours"; a
 * quoted reference is the person telling us directly, and it was previously
 * ignored outright — "1F2DBAB0 … what's the stats now?" opened a new ticket
 * naming an existing one. `resolve_ticket_by_ref` refuses a ticket that is not
 * theirs, so a guessed or mistyped reference resolves to nothing and we fall
 * back to memory.
 */
async function openThread(
  orgId: string,
  channel: "whatsapp" | "telegram",
  senderRef: string,
  messageText: string
): Promise<OpenThread | null> {
  const ref = extractTicketRef(messageText);
  if (ref) {
    const { data, error } = await supabaseAdmin
      .rpc("resolve_ticket_by_ref", { p_org_id: orgId, p_sender_ref: senderRef, p_ref: ref })
      .maybeSingle<{
        ticket_id: string; reference: string; category: string | null; urgency: string | null;
        status: string | null; message_text: string | null; created_at: string; is_open: boolean;
      }>();
    if (error) {
      console.error("resolve_ticket_by_ref failed for", ref, "-", error.message);
    } else if (data) {
      return {
        ticketId: data.ticket_id,
        reference: data.reference,
        category: data.category,
        urgency: data.urgency,
        status: data.status,
        awaiting: null,
        messageText: data.message_text,
        createdAt: data.created_at,
        isOpen: data.is_open,
        fromReference: true,
        transcript: await transcriptFor(data.ticket_id),
      };
    }
  }

  const { data, error } = await supabaseAdmin
    .rpc("conversation_context", {
      p_org_id: orgId,
      p_channel: channel,
      p_sender_ref: senderRef,
    })
    .maybeSingle<{
      ticket_id: string;
      reference: string;
      category: string | null;
      urgency: string | null;
      status: string | null;
      awaiting: string | null;
      message_text: string | null;
      created_at: string;
    }>();

  // An ERROR and an EMPTY RESULT are not the same thing, and treating them alike
  // meant a transient failure silently opened a duplicate ticket with nothing to
  // explain it. Intake still proceeds — a new request is the safe direction — but
  // the failure is now visible.
  if (error) {
    console.error("conversation_context failed for", channel, senderRef, "-", error.message);
    return null;
  }
  if (!data) return null;

  return {
    ticketId: data.ticket_id,
    reference: data.reference,
    category: data.category,
    urgency: data.urgency,
    status: data.status,
    awaiting: data.awaiting,
    messageText: data.message_text,
    createdAt: data.created_at,
    isOpen: true,
    fromReference: false,
    transcript: await transcriptFor(data.ticket_id),
  };
}

export async function handleInboundMessage(opts: {
  orgId: string;
  channel: "whatsapp" | "telegram";
  senderRef: string;
  senderName: string | null;
  messageText: string;
  /** True for a sticker, photo, voice note, location pin etc. with no
   * caption — informs the reply's wording only; nothing here can attach the
   * media itself, since there is no inbound-media storage pipeline. */
  hasMedia?: boolean;
}): Promise<InboundResult> {
  const { orgId, channel, senderRef, senderName, messageText, hasMedia } = opts;

  /**
   * Say something, and remember that we said it.
   *
   * The single most important line in this file. Without it the router sees
   * only the reporter's half of the conversation and reads an answer to our own
   * question as an opening statement.
   */
  const say = async (
    intent: string,
    ticketId: string | null,
    reply: string,
    awaiting: Awaiting
  ): Promise<InboundResult> => {
    const { error } = await supabaseAdmin.rpc("remember_conversation_state", {
      p_org_id: orgId,
      p_channel: channel,
      p_sender_ref: senderRef,
      p_ticket_id: ticketId,
      p_awaiting: awaiting,
      p_last_prompt: reply.slice(0, 1000),
      p_hours: 24,
    });
    // Never fail a reply over bookkeeping — the person is waiting on the
    // answer, and a lost memory costs one slightly worse routing decision.
    if (error) console.error("remember_conversation_state failed:", error.message);
    return { intent, ticketId, reply };
  };

  // ── Nothing to route on at all ────────────────────────────────────────────
  //
  // A sticker, a bare photo, a voice note, a location pin, a thumbs-up
  // reaction that slipped through routing — any of these arrives as an empty
  // `messageText`, and used to be classified and inserted exactly like real
  // prose: `classifyMessage("")` guesses "general", `requires_human_review:
  // true`, and a ticket is created that says nothing about what is wrong or
  // where. Staff cannot act on it, and the reporter never finds out why
  // nothing happened — this is what created the blank tickets found live in
  // both TFML and OEA (two different real senders, two genuinely separate
  // sends, each correctly routed to its own org — not a cross-org leak, but
  // the same silent-blank-ticket defect happening twice).
  //
  // Checked BEFORE opening a thread or calling the router at all: an empty
  // message has nothing for either of those to work with, and guessing
  // "follow-up" or "new request" from nothing is how the blank row got in.
  if (!messageText.trim()) {
    const state = await conversationState(orgId, channel, senderRef);
    return say(
      "empty_content",
      state?.lastTicketId ?? null,
      hasMedia
        ? "Thanks for sending that — I can see you've attached something, but I'll need a few words describing what it's about so I can log it properly. What's the issue, and where?"
        : "I didn't catch any details in that. Could you tell me briefly what needs attention, and where?",
      // We have now asked them a question. Recording that is what stops their
      // answer being read as a brand-new report.
      "describe_problem"
    );
  }

  const [state, thread] = await Promise.all([
    conversationState(orgId, channel, senderRef),
    openThread(orgId, channel, senderRef, messageText),
  ]);
  const routed = await routeInboundMessage(messageText, thread, state);

  console.log("Routed inbound message:", {
    intent: routed.intent,
    urgency: routed.urgency,
    reasoning: routed.reasoning,
    thread: thread?.reference ?? null,
    byReference: thread?.fromReference ?? false,
    awaiting: state?.awaiting ?? null,
  });

  // ── They are correcting the priority we assigned ─────────────────────────
  if (routed.intent === "correct_priority" && thread && routed.urgency) {
    const { data: applied } = await supabaseAdmin.rpc("set_ticket_urgency_by_reporter", {
      p_org_id: orgId,
      p_ticket_id: thread.ticketId,
      p_sender_ref: senderRef,
      p_urgency: routed.urgency,
    });

    return say(
      "correct_priority",
      thread.ticketId,
      applied
        ? buildUrgencyConfirmation(thread.reference, routed.urgency)
        : // The RPC refuses when an operator has already judged it, or when the
          // ticket has closed. Say so plainly rather than claiming an update
          // that did not happen.
          `Thanks — we've passed that on. ${thread.reference} keeps the priority our team set, and they'll see your note.`,
      null
    );
  }

  // ── More information about the same problem ──────────────────────────────
  if (routed.intent === "follow_up" && thread) {
    const { data: added } = await supabaseAdmin.rpc("append_reporter_message", {
      p_org_id: orgId,
      p_ticket_id: thread.ticketId,
      p_sender_ref: senderRef,
      p_body: messageText,
    });

    if (added) {
      return say("follow_up", thread.ticketId, buildFollowUpAck(thread.reference), null);
    }
    // The thread closed between reading it and writing to it. Falling through
    // opens a new request, which is right: they still said something.
  }

  // ── Asking where one specific request has got to ─────────────────────────
  if (routed.intent === "ask_status" && thread) {
    return say(
      "ask_status",
      thread.ticketId,
      buildStatusReply({
        reference: thread.reference,
        status: thread.status,
        category: thread.category,
        urgency: thread.urgency,
      }),
      null
    );
  }

  // ── Asking what they have open at all ────────────────────────────────────
  //
  // The intent that did not exist, and the reason "Tell me about my raised
  // requests" became ticket 8E147AA6. `ask_status` lands here too when we have
  // no particular thread in mind — they asked about a request, so answer with
  // the ones they have rather than opening another.
  if (routed.intent === "list_requests" || routed.intent === "ask_status") {
    const { data: rows, error } = await supabaseAdmin.rpc("sender_open_requests", {
      p_org_id: orgId,
      p_sender_ref: senderRef,
      p_limit: 5,
    });

    if (error) {
      console.error("sender_open_requests failed:", error.message);
      // ⚠️ Do NOT fall through to opening a ticket. They asked a question; a
      // database hiccup is not a reason to answer it with a work order.
      return say(
        "list_requests_failed",
        null,
        "Sorry — I couldn't look that up just now. Please try again shortly, or tell me what needs attention and I'll log it.",
        null
      );
    }

    const list = (rows ?? []) as {
      ticket_id: string; reference: string; category: string | null;
      urgency: string | null; status: string | null; summary: string | null;
    }[];

    if (list.length === 0) {
      return say("list_requests", null, buildNoOpenRequestsReply(), "describe_problem");
    }

    return say(
      "list_requests",
      // The most recent becomes the remembered thread, so "add this to it"
      // lands somewhere sensible — but we have just asked WHICH one, so the
      // router is told to expect them to name it.
      list[0].ticket_id,
      buildRequestListReply(list),
      list.length === 1 ? null : "disambiguate_ticket"
    );
  }

  // ── A greeting, or a command ─────────────────────────────────────────────
  if (routed.intent === "pleasantry") {
    // Deliberately no ticket. Logging "hi" as a maintenance request is how a
    // `/start` ended up in the register.
    const openThreadRef = thread?.isOpen === false ? null : thread;
    return say(
      "pleasantry",
      openThreadRef?.ticketId ?? null,
      openThreadRef
        ? `Hello. You have ${openThreadRef.reference} open — tell us more about it, or describe something new and we'll log it separately.`
        : "Hello. Tell us what needs attention — what the problem is and where — and we'll log it and come back to you with a reference.",
      // We just invited them to say more. Their next message is the answer to
      // that invitation, and recording it is the whole fix for ticket 237A9C51.
      "describe_problem"
    );
  }

  // ── Something was said, but there is nothing in it to act on ─────────────
  if (routed.intent === "unclear") {
    const openThreadRef = thread?.isOpen === false ? null : thread;
    return say(
      "unclear",
      openThreadRef?.ticketId ?? null,
      buildUnclearReply(Boolean(openThreadRef)),
      "describe_problem"
    );
  }

  // ── A question we cannot answer from their own records ───────────────────
  //
  // It still reaches a person — nothing is dropped, which is the standing rule
  // for anything this system is unsure about. What changes is that it is
  // acknowledged AS a question rather than dressed up as a maintenance job with
  // a priority, and it is not offered the 1–4 escalation menu, which makes no
  // sense for "how do I pay my rent?".
  //
  // ⚠️ The bot does not attempt an answer of its own. A2.4 keeps judgement with
  // people, and a confidently wrong reply about a service charge or a tenancy is
  // worse than a slower correct one from someone who can actually look.
  const ticket = await classifyAndCreateTicket(
    messageText,
    senderRef,
    senderName,
    channel,
    orgId
  );
  const isQuestion = routed.intent === "question";

  // Parity with the portal form (`app/dashboard/new/actions.ts`), which has
  // notified admin/FM on a new request since 0122 — the chat channels never
  // gained the equivalent, so a request arriving on WhatsApp/Telegram/SMS was
  // visible only to whoever happened to open the dashboard, never pushed to
  // anyone. Same audience, same in-app write, now also the B8 external
  // cascade per each recipient's own registered channels. Best-effort: a
  // notification failure must never undo the ticket or the reply already
  // promised to the reporter.
  try {
    await notifyRoleWithCascade({
      orgId,
      roles: ["admin", ...FM_PM],
      kind: "request",
      title: isQuestion
        ? `Question from a ${channel} sender — ${shortRef(ticket.id)}`
        : `New ${ticket.urgency} request — ${shortRef(ticket.id)}`,
      body: ticket.summary ?? messageText.slice(0, 140),
      link: `/dashboard/tickets/${ticket.id}`,
      entityType: "ticket",
      entityId: ticket.id,
    });
  } catch (e) {
    console.error("Could not notify admin/FM of new chat request:", e);
  }

  return say(
    isQuestion ? "question" : "new_request",
    ticket.id,
    isQuestion ? buildEnquiryAck(shortRef(ticket.id)) : buildAcknowledgement(ticket),
    // A question is not offered a priority menu, so a bare number afterwards
    // answers nothing — leaving `awaiting` null is what makes the router treat
    // it as unclear rather than as an escalation.
    isQuestion ? null : "urgency_confirmation"
  );
}

export { shortRef };
