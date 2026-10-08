// The conversational layer of the help assistant. Pure functions, no model, no
// I/O - so each behaviour can be tested offline and none of it spends the free
// allowance. The model is only asked to word an answer; WHAT kind of turn this
// is (a greeting, a thank-you, a request to simplify, a vague question that
// needs a clarifying question) is decided here, deterministically.
import type { Chunk } from "@/lib/help-bot";
import { tokens } from "@/lib/help-bot";

export type Style = "simpler" | "shorter" | "detail" | "next" | "again";

export type Turn =
  | { kind: "greeting" }
  | { kind: "thanks" }
  | { kind: "bye" }
  | { kind: "identity" }
  | { kind: "refine"; style: Style };

const WORDS = (q: string) => q.trim().split(/\s+/).filter(Boolean).length;

/** What sort of turn this is, when it is not simply a question about the work. */
export function classifyTurn(q: string): Turn | null {
  const t = q.trim().toLowerCase().replace(/[!.?,]+$/g, "");
  if (/^(hi|hello|hey|hiya|howdy|good\s+(morning|afternoon|evening)|greetings|yo|sup)(\s+(there|team|assistant|bot))?$/.test(t)) return { kind: "greeting" };
  if (/^(how are you|how('?s| is) it going|what'?s up)/.test(t)) return { kind: "greeting" };
  if (/^(thanks?|thank you|thanks a lot|many thanks|cheers|great|perfect|ok(ay)?|got it|nice|cool|awesome|brilliant|that helps|helpful)(\s+(so much|a lot|very much))?$/.test(t)) return { kind: "thanks" };
  if (/^(bye|goodbye|see you|that'?s all|nothing else|no thanks?|i'?m done)$/.test(t)) return { kind: "bye" };
  if (/^(who are you|what are you|what can you do|what do you do|help|help me|what can i ask( you)?|how do you work|are you (a )?(bot|ai|human|real))$/.test(t)) return { kind: "identity" };

  // Refinements are short by nature. A long sentence that happens to contain
  // "summary" is a question about the work, not a request to reword.
  if (WORDS(t) <= 9) {
    if (/(simpl|easier|plain(er)?\b|eli5|layman|i (don'?t|do not) (understand|get)|not clear|unclear|confus|too (complicated|technical|long))/.test(t)) return { kind: "refine", style: "simpler" };
    if (/(shorter|brief|summar|tl;?dr|in short|quick(er)? version|just the steps)/.test(t)) return { kind: "refine", style: "shorter" };
    if (/(more detail|elaborate|explain (that )?(more|further)|expand|in depth|detailed|tell me more|more info)/.test(t)) return { kind: "refine", style: "detail" };
    if (/(what('?s| is)? next|then what|what then|after that|what happens (next|after)|next step)/.test(t)) return { kind: "refine", style: "next" };
    if (/(again|repeat|say that|come again|pardon)/.test(t)) return { kind: "refine", style: "again" };
  }
  return null;
}

export const STYLE_INSTRUCTION: Record<Style, string> = {
  simpler:
    "The person did not follow your last answer. Re-explain it in plain, simple words with short sentences, as if to someone brand new. Same facts, nothing added.",
  shorter: "Give only the essential steps, in at most 4 short lines.",
  detail:
    "Expand your last answer: for each step say what to check and what the person should see when it has worked. Use ONLY the reference; if it does not say, do not invent it.",
  next:
    "Say what happens after the last step and who takes over, using ONLY the reference. If the reference does not say, say so and suggest asking the administrator.",
  again: "Say your last answer again in the same steps.",
};

function hourInLagos(now = new Date()): number {
  return Number(new Intl.DateTimeFormat("en-GB", { hour: "numeric", hour12: false, timeZone: "Africa/Lagos" }).format(now)) % 24;
}

export function salutation(now = new Date()): string {
  const h = hourInLagos(now);
  return h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening";
}

export function replyFor(turn: Turn, roleLabel: string, now = new Date()): string {
  switch (turn.kind) {
    case "greeting":
      return `${salutation(now)}! I'm the help assistant for ${roleLabel}. I can walk you through your work step by step. Pick one below, or ask in your own words.`;
    case "thanks":
      return "You're welcome. Ask me anything else about your work, any time.";
    case "bye":
      return "Goodbye. I'm here whenever you need a step explained.";
    case "identity":
      return (
        `I'm the help assistant for ${roleLabel}. I explain how to do your own work in this system, step by step, ` +
        "using your role's guide. I can't see your data or do anything for you, and for anything outside your role the " +
        "right person to ask is your administrator. Try one of these:"
      );
    case "refine":
      return "";
  }
}

/** A short follow-up ("how are they invited then?", "and for a vendor?") means
 * little alone. Read it together with what the person just asked. */
export function withContext(question: string, previousUserQuestions: string[]): string {
  const prev = previousUserQuestions[previousUserQuestions.length - 1];
  if (!prev) return question;
  const words = WORDS(question);
  const pronoun = /\b(they|them|it|that|those|this|these|then|also|too|instead|else)\b/i.test(question);
  const lead = /^(and|but|so|what about|how about|ok(ay)? and)\b/i.test(question.trim());
  if (words <= 4 || lead || (pronoun && words <= 8)) return `${prev} ${question}`;
  return question;
}

export type Clarification = { ask: string; choices: { label: string; question: string }[] };

/** When one wording fits several curated answers about equally ("how do I
 * onboard someone?"), ask which, rather than guess and be wrong. */
export function needsClarification(hits: { chunk: Chunk; score: number }[]): Clarification | null {
  const grouped = hits.filter((h) => h.chunk.group);
  if (grouped.length < 2) return null;
  const top = grouped[0];
  if (hits[0].chunk.id !== top.chunk.id) return null; // something non-grouped is clearly better
  const tied = grouped.filter((h) => h.chunk.group!.ask === top.chunk.group!.ask && h.score >= top.score * 0.75);
  if (tied.length < 2) return null;
  return {
    ask: top.chunk.group!.ask,
    choices: tied.slice(0, 4).map((h) => ({ label: h.chunk.group!.label, question: h.chunk.title })),
  };
}

export { tokens };
