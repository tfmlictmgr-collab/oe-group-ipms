// What is this person actually doing?
//
// Until 0075 every inbound message became a new ticket. That is correct for a
// first message and wrong for every one after it: "it's worse now" opened a
// second ticket, "no that IS urgent" opened a third, and the acknowledgement's
// own invitation to "reply and we'll correct it" produced a fourth.
//
// So intake needs one decision before it classifies anything: does this message
// START something, or CONTINUE something?
//
// ── What 0075 did not cover, and 0210 does ────────────────────────────────
//
// The router had only TWO answers on a cold message — request, or noise. There
// was no way to say "this is a question", so a question about their own
// requests became a request, and a bare "1" arriving after the priority window
// had lapsed became one too. And because nothing read a REFERENCE out of the
// text, quoting one and asking after it opened a duplicate of the very ticket
// being quoted.
//
// Three changes, in the order they matter:
//   1. `list_requests` and `question` are real answers now, so a question can
//      be answered rather than logged.
//   2. Deterministic guards in front of the model for the messages that are
//      obviously nothing ("test", "ok", a stray number) — no model call, no
//      ticket, no chance of a bad guess on the cheapest possible input.
//   3. ONE model call with the whole situation in it — the open thread, the
//      recent exchange, AND what we ourselves last said. The old code had two
//      separate prompts and the cold one was blind by construction: it was
//      never shown that we had just asked the person a question.
//
// The router still cannot ACT: every intent is carried out by a guarded RPC
// that re-checks the sender owns the ticket.

import { QUICK_REPLY_OPTIONS } from "./acknowledgement";
import { completeWithFailover } from "./llm";

export type InboundIntent =
  | "new_request"
  | "follow_up"
  | "correct_priority"
  | "ask_status"
  /** They want to know what they have open — answered, never logged. */
  | "list_requests"
  /** A real question we cannot answer from their own data; a person must. */
  | "question"
  | "pleasantry"
  /** Something was said, but there is nothing in it to act on. */
  | "unclear";

export type Urgency = "critical" | "high" | "normal" | "low";

export type RoutedMessage = {
  intent: InboundIntent;
  /** Only for `correct_priority`. */
  urgency: Urgency | null;
  /** One short line explaining the read, kept for the audit trail and tuning. */
  reasoning: string;
};

export type OpenThread = {
  ticketId: string;
  reference: string;
  category: string | null;
  urgency: string | null;
  status: string | null;
  awaiting: string | null;
  messageText: string | null;
  createdAt: string;
  /** False when the ticket was found by a quoted reference and is closed. */
  isOpen?: boolean;
  /** True when this thread came from a reference the sender typed themselves. */
  fromReference?: boolean;
  /**
   * The recent back-and-forth on this ticket, oldest first (0113).
   *
   * Before this existed the router was shown only `messageText` — the line
   * that OPENED the ticket — and asked whether a new message continues it.
   * So "it's worse now" was judged against something said three days and two
   * exchanges ago, with everything in between invisible.
   */
  transcript?: { author: string; body: string; createdAt: string }[];
};

/**
 * What we last asked this sender, independent of any ticket (0210).
 *
 * ⚠️ This is the field that fixes the worst line in the live transcript. We
 * said "tell us more about it, or describe something new", they answered, and
 * we logged the answer as a new request — because nothing recorded that a
 * question was outstanding. `conversation_context` could not carry it: it
 * inner-joins `tickets`, so it returns nothing precisely when no ticket exists
 * yet, which is when we most need to know we just asked something.
 */
export type ConversationState = {
  awaiting: string | null;
  lastPrompt: string | null;
  lastTicketId: string | null;
};

/** With no open thread there is nothing to continue. */
const NEW: RoutedMessage = { intent: "new_request", urgency: null, reasoning: "nothing to continue" };

// Commands and bare greetings are a protocol, not prose. Answering them with a
// language model would be slower, cost money, and occasionally get them wrong.
// Deliberately a SHORT list of exact, unambiguous matches — a free fast-path,
// not the real greeting detector. "Good morning" and "you there?" are just as
// contentless and are NOT here; the model decides those.
const COMMANDS = new Set(["/start", "/help", "/menu", "hi", "hello", "hey"]);

/**
 * Messages with nothing in them to act on.
 *
 * ⚠️ Not a nicety — every one of these produced a real ticket in the live
 * transcript, or is one keystroke away from something that did. "This is a
 * test" became 74BB9844. The model is instructed to be conservative and prefer
 * a ticket on any doubt, which is right for a message that might be a problem
 * and wrong for one that provably is not, so these never reach it.
 *
 * Matched on the whole message, lower-cased and stripped of trailing
 * punctuation — a substring rule would swallow "the test rig is leaking".
 */
const NOISE = new Set([
  "test", "tests", "testing", "this is a test", "just testing", "test message",
  "ok", "okay", "k", "kk", "alright", "noted", "fine", "cool", "great", "nice",
  "thanks", "thank you", "thanx", "tnx", "thx", "ty",
  "?", "??", "???", ".", "..", "...",
  "👍", "🙏", "👌", "✅",
]);

function isNoise(text: string): boolean {
  const t = text.toLowerCase().replace(/[.!?,\s]+$/g, "").trim();
  return NOISE.has(t);
}

/**
 * The eight-character reference we print in every acknowledgement, found
 * anywhere in a message.
 *
 * ⚠️ Requires at least one digit AND at least one A–F letter. Without the
 * first, a date like "08112026" reads as a reference; without the second, an
 * all-hex English word does. Both restrictions cost about 2% of genuine
 * references, and a missed one simply falls back to the remembered thread —
 * whereas a false match would attach a message to a ticket that was never
 * mentioned. Cheap in one direction, expensive in the other.
 *
 * Nothing here grants access: `resolve_ticket_by_ref` (0210) still refuses a
 * ticket the sender does not own, so a guessed reference resolves to nothing.
 */
export function extractTicketRef(text: string): string | null {
  const matches = text.match(/(?:^|[^0-9A-Za-z])(?:ref[:.#\s-]*)?([0-9A-Fa-f]{8})(?![0-9A-Za-z])/g);
  if (!matches) return null;
  for (const raw of matches) {
    const candidate = (raw.match(/([0-9A-Fa-f]{8})(?![0-9A-Za-z])/)?.[1] ?? "").toUpperCase();
    if (candidate.length !== 8) continue;
    if (!/[0-9]/.test(candidate)) continue;
    if (!/[A-F]/.test(candidate)) continue;
    return candidate;
  }
  return null;
}

/**
 * A numbered reply to the acknowledgement — derived from the SAME list the
 * acknowledgement prints, so the two cannot drift. Honoured without a round trip
 * to a model: cheaper, faster, and what someone on a poor connection will send.
 */
const QUICK_REPLIES: Record<string, Urgency> = Object.fromEntries(
  QUICK_REPLY_OPTIONS.map((o) => [o.key, o.urgency])
) as Record<string, Urgency>;

const SYSTEM_PROMPT = `You route inbound messages for a Nigerian facilities and property management company (TFML and OEA). Tenants, residents, landlords and contractors write in on WhatsApp and Telegram.

Decide what the sender's NEW message is doing. Reply with ONLY a JSON object:
{"intent": "...", "urgency": "critical|high|normal|low|null", "reasoning": "one short sentence"}

intent must be exactly one of:
- "new_request"      they are reporting a problem or asking for something to be DONE, and it is not the open request described below
- "follow_up"        more information, a chase, or a change about a request already open
- "correct_priority" they are telling you the priority you assigned is wrong
- "ask_status"       they are asking where ONE specific request has got to
- "list_requests"    they are asking what requests they have, what is outstanding, or for an overview of their own requests — plural or unspecified
- "question"         they are asking for INFORMATION rather than for work to be done (how to pay, what a charge is, opening hours, who to speak to, what a process is)
- "pleasantry"       a greeting, thanks, small talk, a test message, or anything with no discernible content

Set "urgency" ONLY for correct_priority, to the priority THEY are asking for:
- critical: danger, no water/power to a whole building, flooding, security, anything unsafe
- high:     significant loss of use, worsening damage, a vulnerable occupant
- normal:   the default
- low:      cosmetic, or explicitly not urgent
Otherwise "urgency" must be null.

Rules that decide the hard cases:

1. A QUESTION ABOUT THEIR OWN REQUESTS IS NEVER A REQUEST. "Tell me about my raised requests", "what's outstanding?", "any update on my complaints?", "has this been assigned?" are "list_requests" or "ask_status" — never "new_request". Logging a question as a job is the single worst thing you can do here.

2. IF WE ASKED THEM SOMETHING, THEIR NEXT MESSAGE IS THE ANSWER. When the context below says a question is outstanding, read the message as a reply to that question first. If we asked them to say more about an open request and they describe a problem, that is "follow_up" — not a new request — unless it is plainly about a different place or a different system.

3. NOTHING IS NOT SOMETHING. "test", "ok", "thanks", "hmm", a stray number or emoji is "pleasantry". Never open a request for a message with no problem in it.

Judge in Nigerian context. "Light don go" is a power failure, not small talk. "Dey worry me" means it is troubling them. Pidgin, English and mixed messages are all normal.

Where genuine doubt remains between "new_request" and "follow_up", prefer "new_request": a wrongly merged request leaves the second problem with no ticket of its own. But that tie-break applies only to two readings that are BOTH about work to be done — it is never a reason to turn a question into a request.`;

const VALID_INTENTS: InboundIntent[] = [
  "new_request", "follow_up", "correct_priority", "ask_status",
  "list_requests", "question", "pleasantry",
];

function parse(raw: string, hasThread: boolean): RoutedMessage | null {
  try {
    const stripped = raw.trim().replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "");
    const p = JSON.parse(stripped);
    const intent = p.intent as InboundIntent;
    if (!VALID_INTENTS.includes(intent)) return null;

    // Two intents mean nothing without something to continue. A model that
    // answers "follow_up" with no open thread has misread the situation, and
    // acting on it would append to a ticket that does not exist.
    if (!hasThread && (intent === "follow_up" || intent === "correct_priority")) {
      return { intent: "new_request", urgency: null, reasoning: "continuation named, but nothing is open" };
    }

    const urgency =
      intent === "correct_priority" && ["critical", "high", "normal", "low"].includes(p.urgency)
        ? (p.urgency as Urgency)
        : null;
    // A correction that does not say what to correct it TO is not actionable;
    // treat it as a follow-up so a person reads it rather than nothing happening.
    if (intent === "correct_priority" && !urgency) {
      return { intent: "follow_up", urgency: null, reasoning: "correction with no priority given" };
    }
    return { intent, urgency, reasoning: String(p.reasoning ?? "").slice(0, 200) };
  } catch {
    return null;
  }
}

/** How the outstanding question is described to the model, in its own words. */
const AWAITING_DESCRIPTION: Record<string, string> = {
  urgency_confirmation: "We just asked them whether the priority we assigned is right.",
  describe_problem:
    "We just asked them to tell us what the problem is, or to say more about the request above. " +
    "Their message is most likely the answer to that.",
  disambiguate_ticket:
    "We just listed their open requests and asked which one they mean. " +
    "Their message is most likely naming one of them.",
};

export async function routeInboundMessage(
  messageText: string,
  thread: OpenThread | null,
  state: ConversationState | null = null
): Promise<RoutedMessage> {
  const text = messageText.trim();
  const awaiting = state?.awaiting ?? thread?.awaiting ?? null;

  // ── Deterministic, before any model call ────────────────────────────────

  // Genuinely no text. `handle-inbound.ts` intercepts this before the router is
  // called; NEW here would recreate the blank-ticket bug that guard prevents.
  if (!text) {
    return { intent: "unclear", urgency: null, reasoning: "no text content" };
  }

  // If we asked "is this the right priority?", a bare number is the answer.
  if (awaiting === "urgency_confirmation" && QUICK_REPLIES[text]) {
    return {
      intent: "correct_priority",
      urgency: QUICK_REPLIES[text],
      reasoning: "numbered reply to the priority question",
    };
  }

  // ⚠️ And if we did NOT ask, a bare number answers nothing. This is ticket
  // 1F2DBAB0 in the live transcript: a "1" sent after the previous question had
  // already been answered was read as a fresh message and logged. It is not a
  // request; it is a reply to something that is no longer on the table.
  if (/^[1-4]$/.test(text)) {
    return { intent: "unclear", urgency: null, reasoning: "a bare number with no question outstanding" };
  }

  if (COMMANDS.has(text.toLowerCase())) {
    return { intent: "pleasantry", urgency: null, reasoning: "greeting or command" };
  }

  // "This is a test" became a real ticket. It never reaches the model again.
  if (isNoise(text)) {
    return { intent: "pleasantry", urgency: null, reasoning: "no actionable content" };
  }

  // ── One model call, with everything we know in it ───────────────────────
  //
  // The old code asked two different questions from two different prompts
  // depending on whether a thread existed, and the no-thread one was never
  // shown what we had just said. There is one situation here, described once.

  const transcript = (thread?.transcript ?? [])
    .map((m) => {
      const who =
        m.author === "reporter" ? "Them" : m.author === "staff" ? "Our team" : "Us (automated)";
      return `  ${who}: ${m.body.slice(0, 300)}`;
    })
    .join("\n");

  const context = [
    thread
      ? [
          thread.fromReference
            ? `They named this request by its reference in their message (ref ${thread.reference}):`
            : `Their open request (ref ${thread.reference}, opened ${thread.createdAt}):`,
          `  category: ${thread.category ?? "unclassified"}`,
          `  priority: ${thread.urgency ?? "normal"}`,
          `  status:   ${thread.status ?? "open"}`,
          `  what they first said: ${(thread.messageText ?? "").slice(0, 400)}`,
        ].join("\n")
      : `They have NO request currently open. "follow_up" and "correct_priority" are therefore not available — but "list_requests", "question" and "pleasantry" still are.`,
    transcript ? `\nThe conversation on that request, oldest first:\n${transcript}` : "",
    // What WE last said. The single most useful line in this prompt for the
    // messages that were being misread, and the one the router never had.
    state?.lastPrompt
      ? `\nThe last thing WE said to them:\n  "${state.lastPrompt.slice(0, 400)}"`
      : "",
    awaiting && AWAITING_DESCRIPTION[awaiting] ? `\n${AWAITING_DESCRIPTION[awaiting]}` : "",
    ``,
    `Their new message: ${text.slice(0, 1000)}`,
  ]
    .filter(Boolean)
    .join("\n");

  const { value } = await completeWithFailover(
    { system: SYSTEM_PROMPT, user: context, maxTokens: 200 },
    (raw) => parse(raw, Boolean(thread))
  );

  // Falling back to a NEW REQUEST is the safe direction when both providers are
  // unreachable. A duplicate ticket is visible and closeable; a message merged
  // into the wrong thread, or dropped, is neither. That holds even now that the
  // router can say "question": guessing "question" on a message we could not
  // read would brush off a real problem, which is the one outcome that must not
  // happen quietly.
  return value ?? NEW;
}
