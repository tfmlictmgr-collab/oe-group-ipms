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

import Anthropic from "@anthropic-ai/sdk";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

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
};

/**
 * With no open thread there is nothing to continue, so the answer is fixed and
 * no model call is made. Most first messages take this path.
 */
const NEW: RoutedMessage = { intent: "new_request", urgency: null, reasoning: "no open thread" };

// Commands are a protocol, not prose. Answering them with a language model would
// be slower, cost money, and occasionally get them wrong.
const COMMANDS = new Set(["/start", "/help", "/menu", "hi", "hello", "hey"]);

/**
 * A numbered reply to the acknowledgement. The message we send offers exactly
 * these, so they are worth honouring without a round trip — and they are what
 * someone on a poor connection will actually send.
 */
const QUICK_REPLIES: Record<string, Urgency> = {
  "1": "critical",
  "2": "high",
  "3": "normal",
  "4": "low",
};

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
    return NEW;
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

  const context = [
    `Their open request (ref ${thread.reference}, opened ${thread.createdAt}):`,
    `  category: ${thread.category ?? "unclassified"}`,
    `  priority: ${thread.urgency ?? "normal"}`,
    `  status:   ${thread.status ?? "open"}`,
    `  what they said: ${(thread.messageText ?? "").slice(0, 400)}`,
    thread.awaiting === "urgency_confirmation"
      ? `We just asked them whether that priority is right.`
      : "",
    ``,
    `Their new message: ${text.slice(0, 1000)}`,
  ].join("\n");

  try {
    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 200,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: context }],
    });
    const block = response.content.find((b) => b.type === "text");
    // Falling back to a NEW REQUEST is the safe direction. A duplicate ticket is
    // visible and closeable; a message merged into the wrong thread, or dropped,
    // is neither.
    return (block && parse(block.text)) ?? NEW;
  } catch (error) {
    console.error("Inbound routing failed, treating as a new request:", error);
    return NEW;
  }
}
