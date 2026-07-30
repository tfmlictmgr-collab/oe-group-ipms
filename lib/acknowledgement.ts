// Builds the inbound-channel acknowledgement message.
//
// Convention: echo back what the system understood — reference, category and
// priority — so the sender can correct a misclassification immediately rather
// than discovering it later. Priority is stated plainly and the message invites
// correction; it deliberately does not promise a response time, since no SLA is
// committed for the POC.

const PRIORITY_LABELS: Record<string, string> = {
  critical: "Critical",
  high: "High",
  normal: "Normal",
  low: "Low",
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

  // The invitation to correct it is now a real offer. These numbers are honoured
  // by the router without a round trip to a model — which matters on a poor
  // connection, and is what someone will actually send. Before this, replying to
  // that invitation opened a second ticket.
  lines.push(
    "",
    "Is that priority right? Reply:",
    "1 Urgent — unsafe, or nothing works",
    "2 High — significant problem",
    "3 Normal",
    "4 Low — can wait",
    "",
    "Or just tell us more and we'll add it to this request."
  );

  return lines.join("\n");
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
  const STATUS_LABELS: Record<string, string> = {
    open: "Open — logged, waiting to be picked up",
    in_progress: "In progress — someone is on it",
    resolved: "Resolved",
    closed: "Closed",
  };
  return [
    `${t.reference} — ${STATUS_LABELS[t.status ?? ""] ?? "Open"}`,
    `Category: ${CATEGORY_LABELS[t.category ?? ""] ?? "General"}`,
    `Priority: ${PRIORITY_LABELS[t.urgency ?? ""] ?? "Normal"}`,
  ].join("\n");
}
