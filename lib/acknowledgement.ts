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

  lines.push(
    "",
    "If the category or priority looks wrong, reply and we'll correct it."
  );

  return lines.join("\n");
}
