// What is this person actually doing?
//
// Until now every inbound message became a new ticket. That is correct for a
// first message and wrong for every one after it: "it's worse now" opened a
// second ticket, "no that IS urgent" opened a third, and the acknowledgement's
// own invitation to "reply and we'll correct it" produced a fourth.
//
// So intake needs one decision before it classifies anything: does this message
// START something, or CONTINUE something?
//
// The router is deliberately narrow. It picks one of five intents and, for a
// correction, one priority. It does not decide anything about the request itself
// — the existing classifier still does that — and it cannot act: every intent is
// carried out by a guarded RPC that re-checks the sender owns the ticket.

import { QUICK_REPLY_OPTIONS } from "./acknowledgement";
import { completeWithFailover } from "./llm";

export type InboundIntent =
  | "new_request"
  | "follow_up"
  | "correct_priority"
  | "ask_status"
  | "pleasantry";

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
  /**
   * The recent back-and-forth on this ticket, oldest first (0113).
   *
   * Before this existed the router was shown only `messageText` — the line
   * that OPENED the ticket — and asked whether a new message continues it.
   * So "it's worse now" was judged against something said three days and two
   * exchanges ago, with everything in between invisible. That is the single
   * biggest reason a reply got misread.
   */
  transcript?: { author: string; body: string; createdAt: string }[];
};

/**
 * With no open thread there is nothing to continue, so the answer is fixed and
 * no model call is made for the OBVIOUS cases below. Everything else on a
 * first contact still gets a real classification pass — see
 * `classifyFirstContact()`.
 */
const NEW: RoutedMessage = { intent: "new_request", urgency: null, reasoning: "no open thread" };

// Commands are a protocol, not prose. Answering them with a language model would
// be slower, cost money, and occasionally get them wrong. Deliberately a SHORT
// list of exact, unambiguous matches — this is a free fast-path, not the real
// greeting detector. "Good morning", "you there?" and "test" are all just as
// contentless as "hi" and none of them are in this list; they reach
// `classifyFirstContact()` instead, which is what actually tells a pleasantry
// apart from a request rather than pattern-matching a handful of strings.
const COMMANDS = new Set(["/start", "/help", "/menu", "hi", "hello", "hey"]);

const FIRST_CONTACT_SYSTEM_PROMPT = `You triage the FIRST message from someone contacting a Nigerian facilities and property management company on WhatsApp, Telegram or the portal.

Decide whether this message describes an actual problem, question or request that needs staff action, or whether it has no actionable content at all.

Reply with ONLY a JSON object:
{"intent": "new_request" | "pleasantry", "reasoning": "one short sentence"}

"new_request" — describes something wrong, asks a real question, or clearly wants something done, fixed, booked or answered (maintenance, billing, a complaint, an enquiry — anything actionable, however short).
"pleasantry" — a greeting, thanks, small talk, a test message ("test", "??", a single emoji, "you there?"), or anything else with no discernible request in it.

Judge in Nigerian context. "Light don go" is a power failure, not small talk. Pidgin,
English and mixed messages are all normal.

Be conservative: if a message COULD plausibly be describing a problem, prefer
"new_request". A person with a real issue must never be brushed off as small
talk — the cost of wrongly asking "pleasantry" to try again is much higher than
the cost of a slightly premature ticket.`;

function parseFirstContact(raw: string): RoutedMessage | null {
  try {
    const stripped = raw.trim().replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "");
    const p = JSON.parse(stripped);
    if (p.intent !== "new_request" && p.intent !== "pleasantry") return null;
    return {
      intent: p.intent,
      urgency: null,
      reasoning: String(p.reasoning ?? "").slice(0, 200),
    };
  } catch {
    return null;
  }
}

/**
 * Is a first-contact message actually a request, or just noise?
 *
 * Kept separate from the main router's model call: the with-thread prompt
 * assumes an open request already exists and asks a five-way question
 * (new/follow-up/correction/status/pleasantry) — none of that context exists
 * yet on a first message, and asking it anyway would just confuse the model.
 * This asks the one question that actually applies here: request, or not.
 */
async function classifyFirstContact(text: string): Promise<RoutedMessage> {
  const { value } = await completeWithFailover(
    { system: FIRST_CONTACT_SYSTEM_PROMPT, user: text.slice(0, 1000), maxTokens: 120 },
    parseFirstContact
  );
  // Same safe direction as the main router: on any doubt, a request. A
  // duplicate or premature ticket is visible and closeable; a real problem
  // brushed off as small talk is not. That holds whether the doubt came from
  // an ambiguous message or from both providers being unreachable.
  return value ?? NEW;
}

/**
 * A numbered reply to the acknowledgement — derived from the SAME list the
 * acknowledgement prints, so the two cannot drift. Honoured without a round trip
 * to a model: cheaper, faster, and what someone on a poor connection will send.
 */
const QUICK_REPLIES: Record<string, Urgency> = Object.fromEntries(
  QUICK_REPLY_OPTIONS.map((o) => [o.key, o.urgency])
) as Record<string, Urgency>;

const SYSTEM_PROMPT = `You route inbound messages for a Nigerian facilities and property management company.

The sender has ONE open request already. Decide what their new message is doing.

Reply with ONLY a JSON object:
{"intent": "...", "urgency": "critical|high|normal|low|null", "reasoning": "one short sentence"}

intent must be exactly one of:
- "new_request"      a DIFFERENT problem, unrelated to the open one
- "follow_up"        more information, a chase, or a change about the SAME problem
- "correct_priority" they are telling you the priority is wrong
- "ask_status"       they are asking where their request has got to
- "pleasantry"       a greeting, thanks, or something with no request in it

Set "urgency" ONLY for correct_priority, to the priority THEY are asking for:
- critical: danger, no water/power to a whole building, flooding, security, anything unsafe
- high:     significant loss of use, worsening damage, a vulnerable occupant
- normal:   the default
- low:      cosmetic, or explicitly not urgent
Otherwise "urgency" must be null.

Judge in Nigerian context. "Light don go" is a power failure. "Dey worry me" means it is
troubling them. Pidgin, English and mixed messages are all normal.

Be conservative: if a message could be a new problem or a follow-up, prefer "follow_up"
only when it clearly refers to the same thing. A wrongly merged request is worse than a
duplicate, because the second problem then has no ticket of its own.`;

function parse(raw: string): RoutedMessage | null {
  try {
    const stripped = raw.trim().replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "");
    const p = JSON.parse(stripped);
    const intent = p.intent as InboundIntent;
    if (!["new_request", "follow_up", "correct_priority", "ask_status", "pleasantry"].includes(intent)) {
      return null;
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

export async function routeInboundMessage(
  messageText: string,
  thread: OpenThread | null
): Promise<RoutedMessage> {
  const text = messageText.trim();

  if (!thread) {
    // A bare greeting with nothing open is not a request. Logging "hi" as a
    // maintenance ticket is how the demo ended up with a `/start` ticket.
    if (COMMANDS.has(text.toLowerCase())) {
      return { intent: "pleasantry", urgency: null, reasoning: "greeting or command, nothing open" };
    }
    // Genuinely no text at all (handle-inbound.ts intercepts this before the
    // router is even called — see the empty-content branch there — so this
    // is a defensive fallback, not the primary guard). NEW would recreate
    // exactly the blank-ticket bug that guard exists to prevent.
    if (!text) return { intent: "pleasantry", urgency: null, reasoning: "no text content" };
    // Everything else on a first contact — "good morning", "you there?",
    // "test", a stray "?" — used to fall straight through to NEW with no
    // classification at all, because it wasn't an exact match in COMMANDS.
    // That is how a greeting a person happened to phrase differently became
    // a ticket. Ask the model the one question that matters here: is this
    // actually describing something, or is it noise.
    return await classifyFirstContact(text);
  }

  // If we asked "is this the right priority?", a bare number is the answer.
  if (thread.awaiting === "urgency_confirmation" && QUICK_REPLIES[text]) {
    return {
      intent: "correct_priority",
      urgency: QUICK_REPLIES[text],
      reasoning: "numbered reply to the priority question",
    };
  }
  if (COMMANDS.has(text.toLowerCase())) {
    return { intent: "pleasantry", urgency: null, reasoning: "greeting or command" };
  }

  // The conversation so far, when there is one (0113). Labelled by speaker so
  // the model can tell the reporter's own words from what we told them —
  // without that, our own acknowledgement reads as something the tenant said.
  const transcript = (thread.transcript ?? [])
    .map((m) => {
      const who =
        m.author === "reporter" ? "Them" : m.author === "staff" ? "Our team" : "Us (automated)";
      return `  ${who}: ${m.body.slice(0, 300)}`;
    })
    .join("\n");

  const context = [
    `Their open request (ref ${thread.reference}, opened ${thread.createdAt}):`,
    `  category: ${thread.category ?? "unclassified"}`,
    `  priority: ${thread.urgency ?? "normal"}`,
    `  status:   ${thread.status ?? "open"}`,
    `  what they first said: ${(thread.messageText ?? "").slice(0, 400)}`,
    transcript ? `\nThe conversation since, oldest first:\n${transcript}` : "",
    thread.awaiting === "urgency_confirmation"
      ? `\nWe just asked them whether that priority is right.`
      : "",
    ``,
    `Their new message: ${text.slice(0, 1000)}`,
  ]
    .filter(Boolean)
    .join("\n");

  const { value } = await completeWithFailover(
    { system: SYSTEM_PROMPT, user: context, maxTokens: 200 },
    parse
  );
  // Falling back to a NEW REQUEST is the safe direction. A duplicate ticket is
  // visible and closeable; a message merged into the wrong thread, or dropped,
  // is neither.
  return value ?? NEW;
}
