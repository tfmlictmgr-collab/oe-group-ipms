// One place where an inbound chat message is dealt with.
//
// WhatsApp and Telegram differ in how a message ARRIVES and how a reply is SENT.
// What happens in between — work out what they meant, do it, say what was done —
// is identical, and was duplicated across the two webhooks. Two copies of a
// routing rule is two chances for one of them to drift, which is how the
// permission baseline and the ledger resolver each went wrong earlier in this
// build.

import { supabaseAdmin } from "./supabase/admin";
import { classifyAndCreateTicket } from "./triage";
import { routeInboundMessage, type OpenThread } from "./inbound-router";
import {
  buildAcknowledgement,
  buildFollowUpAck,
  buildStatusReply,
  buildUrgencyConfirmation,
  shortRef,
} from "./acknowledgement";

export type InboundResult = {
  /** What to send back, or null when nothing should be sent. */
  reply: string | null;
  /** For logging: what we decided and what we did about it. */
  intent: string;
  ticketId: string | null;
};

async function openThread(
  orgId: string,
  channel: "whatsapp" | "telegram",
  senderRef: string
): Promise<OpenThread | null> {
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

  // The exchange so far, so the router reads a reply in context rather than
  // against the opening line alone (0113). Best-effort on purpose: if this
  // fails the router still gets everything it had before, which is a slightly
  // worse read of a follow-up — not a dropped message. Memory is an
  // improvement to lean on, never a dependency to fall over.
  let transcript: { author: string; body: string; createdAt: string }[] = [];
  const { data: messages, error: transcriptError } = await supabaseAdmin
    .rpc("conversation_transcript", { p_ticket_id: data.ticket_id, p_limit: 8 });
  if (transcriptError) {
    console.error("conversation_transcript failed for", data.ticket_id, "-", transcriptError.message);
  } else {
    transcript = (messages ?? []).map(
      (m: { author: string; body: string; created_at: string }) => ({
        author: m.author,
        body: m.body,
        createdAt: m.created_at,
      })
    );
  }

  return {
    ticketId: data.ticket_id,
    reference: data.reference,
    category: data.category,
    urgency: data.urgency,
    status: data.status,
    awaiting: data.awaiting,
    messageText: data.message_text,
    createdAt: data.created_at,
    transcript,
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
    const thread = await openThread(orgId, channel, senderRef);
    return {
      intent: "empty_content",
      ticketId: thread?.ticketId ?? null,
      reply: hasMedia
        ? "Thanks for sending that — I can see you've attached something, but I'll need a few words describing what it's about so I can log it properly. What's the issue, and where?"
        : "I didn't catch any details in that. Could you tell me briefly what needs attention, and where?",
    };
  }

  const thread = await openThread(orgId, channel, senderRef);
  const routed = await routeInboundMessage(messageText, thread);

  console.log("Routed inbound message:", {
    intent: routed.intent,
    urgency: routed.urgency,
    reasoning: routed.reasoning,
    thread: thread?.reference ?? null,
  });

  // ── They are correcting the priority we assigned ─────────────────────────
  if (routed.intent === "correct_priority" && thread && routed.urgency) {
    const { data: applied } = await supabaseAdmin.rpc("set_ticket_urgency_by_reporter", {
      p_org_id: orgId,
      p_ticket_id: thread.ticketId,
      p_sender_ref: senderRef,
      p_urgency: routed.urgency,
    });

    // The thread stays remembered, with nothing outstanding.
    await supabaseAdmin.rpc("remember_conversation", {
      p_org_id: orgId, p_channel: channel, p_sender_ref: senderRef,
      p_ticket_id: thread.ticketId, p_awaiting: null, p_hours: 24,
    });

    return {
      intent: "correct_priority",
      ticketId: thread.ticketId,
      reply: applied
        ? buildUrgencyConfirmation(thread.reference, routed.urgency)
        : // The RPC refuses when an operator has already judged it. Say so
          // plainly rather than claiming an update that did not happen.
          `Thanks — we've passed that on. ${thread.reference} keeps the priority our team set, and they'll see your note.`,
    };
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
      await supabaseAdmin.rpc("remember_conversation", {
        p_org_id: orgId, p_channel: channel, p_sender_ref: senderRef,
        p_ticket_id: thread.ticketId, p_awaiting: null, p_hours: 24,
      });
      return { intent: "follow_up", ticketId: thread.ticketId, reply: buildFollowUpAck(thread.reference) };
    }
    // The thread closed between reading it and writing to it. Falling through
    // opens a new request, which is right: they still said something.
  }

  // ── Asking where it has got to ───────────────────────────────────────────
  if (routed.intent === "ask_status" && thread) {
    return {
      intent: "ask_status",
      ticketId: thread.ticketId,
      reply: buildStatusReply({
        reference: thread.reference,
        status: thread.status,
        category: thread.category,
        urgency: thread.urgency,
      }),
    };
  }

  // ── A greeting, or a command ─────────────────────────────────────────────
  if (routed.intent === "pleasantry") {
    return {
      intent: "pleasantry",
      ticketId: thread?.ticketId ?? null,
      // Deliberately no ticket. Logging "hi" as a maintenance request is how a
      // `/start` ended up in the register.
      reply: thread
        ? `Hello. You have ${thread.reference} open — tell us more about it, or describe something new and we'll log it separately.`
        : "Hello. Tell us what needs attention — what the problem is and where — and we'll log it and come back to you with a reference.",
    };
  }

  // ── Anything else is a new request ───────────────────────────────────────
  const ticket = await classifyAndCreateTicket(
    messageText,
    senderRef,
    senderName,
    channel,
    orgId
  );

  // Remember it, and note that we have just asked about the priority — so a bare
  // "1" in the next message is understood without a model call.
  await supabaseAdmin.rpc("remember_conversation", {
    p_org_id: orgId, p_channel: channel, p_sender_ref: senderRef,
    p_ticket_id: ticket.id, p_awaiting: "urgency_confirmation", p_hours: 24,
  });

  return {
    intent: "new_request",
    ticketId: ticket.id,
    reply: buildAcknowledgement(ticket),
  };
}

export { shortRef };
