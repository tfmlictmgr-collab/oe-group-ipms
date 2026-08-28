// Builds the inbound-channel acknowledgement message.
//
// Convention: echo back what the system understood — reference, category and
// priority — so the sender can correct a misclassification immediately rather
// than discovering it later. Priority is stated plainly and the message invites
// correction; it deliberately does not promise a response time, since no SLA is
// committed for the POC.

/**
 * The numbered quick replies, defined ONCE.
 *
 * The acknowledgement prints these and the inbound router honours them. They were
 * two lists that had to agree — reorder or relabel one and someone tapping "1"
 * for "can wait" would have their request raised to critical. That is the same
 * shape as the INVITABLE_ROLES bug already fixed in this build: two lists that
 * must agree will eventually disagree.
 */
export const QUICK_REPLY_OPTIONS = [
  { key: "1", urgency: "critical", label: "Urgent — unsafe, or nothing works" },
  { key: "2", urgency: "high", label: "High — significant problem" },
  { key: "3", urgency: "normal", label: "Normal" },
  { key: "4", urgency: "low", label: "Low — can wait" },
] as const;

const PRIORITY_LABELS: Record<string, string> = {
  critical: "Critical",
  high: "High",
  normal: "Normal",
  low: "Low",
};

// Module scope, not inside the one function that used to own it: three
// different replies now read a status back, and three copies of this map is
// three chances for one of them to say something the others do not.
const STATUS_LABELS: Record<string, string> = {
  open: "Open — logged, waiting to be picked up",
  in_progress: "In progress — someone is on it",
  resolved: "Resolved",
  closed: "Closed",
};

const CATEGORY_LABELS: Record<string, string> = {
  maintenance: "Maintenance",
  billing: "Billing",
  vendor: "Vendor",
  complaint: "Complaint",
  general: "General",
};

/** Short human-quotable reference — a full UUID is unusable in a chat message. */
export function shortRef(id: string): string {
  return id.replace(/-/g, "").slice(0, 8).toUpperCase();
}

export function buildAcknowledgement(ticket: {
  id: string;
  category: string | null;
  urgency: string | null;
  requires_human_review?: boolean | null;
}): string {
  const category = CATEGORY_LABELS[ticket.category ?? ""] ?? "General";
  const priority = PRIORITY_LABELS[ticket.urgency ?? ""] ?? "Normal";

  const lines = [
    "Thanks — your request has been logged.",
    "",
    `Ref: ${shortRef(ticket.id)}`,
    `Category: ${category}`,
    `Priority: ${priority}`,
  ];

  if (ticket.urgency === "critical") {
    lines.push("", "This has been flagged as urgent and escalated to our team.");
  }

  // The invitation to correct it is a real offer — these numbers are honoured by
  // the router without a round trip to a model, which matters on a poor
  // connection and is what someone will actually send.
  //
  // ⚠️ But the FULL menu is now shown only when the guess is worth checking:
  // the classifier was unsure, or it escalated on its own. Printing four
  // numbered options after every single message trains people to reply with
  // bare digits, and a bare digit arriving after the question has lapsed is
  // exactly how ticket 1F2DBAB0 came to exist in the live transcript. A
  // confident normal-priority guess gets one line instead. Both paths still set
  // `awaiting = 'urgency_confirmation'`, so a number sent in reply to either is
  // understood.
  const worthChecking =
    ticket.requires_human_review === true ||
    ticket.urgency === "critical" ||
    ticket.urgency === "high";

  if (worthChecking) {
    lines.push(
      "",
      "Is that priority right? Reply:",
      ...QUICK_REPLY_OPTIONS.map((o) => `${o.key} ${o.label}`),
      "",
      "Or just tell us more and we'll add it to this request."
    );
  } else {
    lines.push(
      "",
      "Tell us more and we'll add it to this request, or reply 1 if it is actually urgent."
    );
  }

  return lines.join("\n");
}

/**
 * What this person has open, in answer to a question about it.
 *
 * The whole point of 0210: "Tell me about my raised requests" used to become a
 * request. It now gets an answer, and the answer is their own data read back —
 * not a judgement, not advice, nothing a model composed.
 */
export function buildRequestListReply(
  rows: {
    reference: string;
    category: string | null;
    urgency: string | null;
    status: string | null;
    summary: string | null;
  }[]
): string {
  if (rows.length === 0) return buildNoOpenRequestsReply();

  const lines = [
    rows.length === 1
      ? "You have one request open:"
      : `You have ${rows.length} requests open:`,
    "",
  ];

  for (const r of rows) {
    lines.push(
      `${r.reference} — ${STATUS_LABELS[r.status ?? ""] ?? "Open"}`,
      `${CATEGORY_LABELS[r.category ?? ""] ?? "General"} · ${PRIORITY_LABELS[r.urgency ?? ""] ?? "Normal"} priority`
    );
    if (r.summary) lines.push(r.summary.slice(0, 120));
    lines.push("");
  }

  lines.push(
    rows.length === 1
      ? "Reply with anything you want added to it, or describe something new and we'll log it separately."
      : "Quote a reference to add to that one, or describe something new and we'll log it separately."
  );

  return lines.join("\n");
}

/** They asked what they have open, and the answer is nothing. */
export function buildNoOpenRequestsReply(): string {
  return [
    "You have nothing open with us at the moment.",
    "",
    "If something needs attention, tell me what the problem is and where, and I'll log it.",
  ].join("\n");
}

/**
 * A question we cannot answer from their own records.
 *
 * ⚠️ It still reaches a person — nothing is dropped — but it is acknowledged
 * as a QUESTION, not dressed up as a maintenance job with a priority. The bot
 * deliberately does not attempt an answer: A2.4 and decision 10 keep judgement
 * with people, and a confidently wrong reply about a service charge or a
 * tenancy is worse than a slower correct one.
 */
export function buildEnquiryAck(reference: string): string {
  return [
    "Thanks — I've passed your question to the team and they'll come back to you.",
    "",
    `Ref: ${reference}`,
    "",
    "If something also needs fixing, tell me what and where and I'll log that separately.",
  ].join("\n");
}

/** Something was said, but there is nothing in it to act on. */
export function buildUnclearReply(hasOpen: boolean): string {
  return hasOpen
    ? "Sorry — I'm not sure what that refers to. Tell me what you'd like added, or ask me what you have open."
    : "Sorry — I didn't catch that. Tell me what needs attention and where, and I'll log it.";
}

/** Confirmation that the reporter's correction was applied. */
export function buildUrgencyConfirmation(reference: string, urgency: string): string {
  const priority = PRIORITY_LABELS[urgency] ?? "Normal";
  const lines = [`Updated — ${reference} is now ${priority} priority.`];
  if (urgency === "critical" || urgency === "high") {
    lines.push("", "We've flagged it for someone to look at.");
  }
  return lines.join("\n");
}

/** Confirmation that a follow-up joined the existing request rather than starting a new one. */
export function buildFollowUpAck(reference: string): string {
  return `Added to ${reference}. The team working on it will see it.`;
}

/** A status answer. States where it is, and still promises no timing — no SLA is committed. */
export function buildStatusReply(t: {
  reference: string;
  status: string | null;
  category: string | null;
  urgency: string | null;
}): string {
  return [
    `${t.reference} — ${STATUS_LABELS[t.status ?? ""] ?? "Open"}`,
    `Category: ${CATEGORY_LABELS[t.category ?? ""] ?? "General"}`,
    `Priority: ${PRIORITY_LABELS[t.urgency ?? ""] ?? "Normal"}`,
  ].join("\n");
}
