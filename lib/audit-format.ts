// Turning an audit row into something a person can read.
//
// 📌 12 Sept 2026. The trail showed an action CODE ("payment_approval.decision"),
// an actor or the word "System", and a column diff — accurate, and legible only
// to whoever wrote the migration. Asked for directly: "make the audit trail a
// little more descriptive, and include the fields in the attached snapshot"
// (the old AURA desktop log: a subject, an action written as a sentence, the
// user, the project). So each row now says, in words, what happened, who did
// it, which property it concerns and what it is about.
//
// Pure — no database, no React — so the page, a CSV and a suite read the same
// words. The page resolves names and places; this decides what they say.

import { formatMoney } from "@/lib/currency";

export type AuditEntry = {
  id: string;
  actor_id: string | null;
  action: string;
  entity_type: string | null;
  entity_id: string | null;
  before_state: Record<string, unknown> | null;
  after_state: Record<string, unknown> | null;
  created_at: string;
};

// ── Filters and subjects ────────────────────────────────────────────────────

export type AuditFilter = {
  key: string;
  label: string;
  /** The entity types this filter covers. */
  types?: string[];
  /** Or specific actions, for a subject that cuts across tables. */
  actions?: string[];
};

const DOCUMENT_ACTIONS = [
  "payment.attachment", "ops_requisition.attachment", "ops_requisition_line.attachment",
  "application.document_added", "application.document_removed", "application.document_replaced",
  "vendor_document.write", "ticket.evidence", "remittance.bank_transfer_recorded",
];

/**
 * The subjects the trail is filtered by, in the order they are offered. Each
 * row's own subject is the first of these it belongs to — so the badge on a
 * row and the filter that finds it can never disagree.
 */
export const ENTITY_FILTERS: AuditFilter[] = [
  { key: "all", label: "All" },
  { key: "security", label: "Sign-ins & accounts", types: ["user", "users", "invitations", "invitation", "role_permission", "channel_consents"] },
  { key: "approvals", label: "Approvals", types: ["payment_approvals", "payment_approval"] },
  { key: "payments", label: "Payments", types: ["payments", "payment_intents", "offline_payment_claims", "offline_payment_allocations", "offline_payment_confirmations"] },
  { key: "payouts", label: "Payouts & bank", types: ["remittances", "manual_remittance_records", "payout_recipients", "payout_detail_requests", "bank_accounts", "bank_statement_lines", "reconciliations"] },
  { key: "requisitions", label: "Requisitions", types: ["ops_requisitions", "ops_requisition_lines"] },
  { key: "documents", label: "Documents", actions: DOCUMENT_ACTIONS },
  { key: "requests", label: "Requests", types: ["tickets", "ticket", "ticket_attachments"] },
  { key: "tenancies", label: "Tenancies & rent", types: ["leases", "lease", "rent_charges", "tenancy_offers", "tenant_applications", "units", "landlord_terms"] },
  { key: "budgets", label: "Service charges", types: ["sc_budgets", "service_charges", "sc_budget_shares"] },
  { key: "vendors", label: "Vendors", types: ["vendors", "vendor_users", "vendor_registrations", "vendor_evaluations", "vendor_applications", "vendor_properties", "vendor_introductions", "evaluation_criteria"] },
  { key: "ledger", label: "Ledger", types: ["ledger_entries", "ledger_accounts"] },
  { key: "settings", label: "Settings & places", types: ["payment_settings", "orgs", "org", "channel_routes", "org_nodes", "property", "properties", "property_stakeholders", "assets", "asset"] },
  { key: "notifications", label: "Messages sent", types: ["notifications"] },
];

/** Old addresses keep working — the screenshot this was asked from used one. */
const FILTER_ALIASES: Record<string, string> = {
  payment_approvals: "approvals",
  ops_requisitions: "requisitions",
  tickets: "requests",
  sc_budgets: "budgets",
  payment_settings: "settings",
};

export function filterFor(key: string | undefined): AuditFilter {
  const k = key ? FILTER_ALIASES[key] ?? key : "all";
  return ENTITY_FILTERS.find((f) => f.key === k) ?? ENTITY_FILTERS[0];
}

export function subjectOf(e: AuditEntry): string {
  if (e.action.startsWith("session.")) return "Sign-ins & accounts";
  for (const f of ENTITY_FILTERS) {
    if (f.key === "all") continue;
    if (f.actions?.includes(e.action)) return f.label;
    if (f.types && e.entity_type && f.types.includes(e.entity_type)) return f.label;
  }
  return "Other";
}

// ── Who did it ──────────────────────────────────────────────────────────────

/** Columns on a row that name the person who acted, most specific first. */
const ACTOR_FIELDS = [
  "actor_id", "recorded_by", "sent_by", "confirmed_by", "decided_by", "reviewed_by",
  "verified_by", "approved_by", "requested_by", "raised_by", "assigned_by",
  "submitted_by", "issued_by", "uploaded_by", "set_by", "invited_by", "created_by",
];

/**
 * Who a row is about, acting.
 *
 * ⚠️ `audit_log.actor_id` is `auth.uid()` at the moment of the write, and a
 * write made by the server on somebody's behalf — the payment officer releasing
 * money, a payee answering a link, a scheduled job — carries none. The page
 * used to call all of those "System", including 1,306 approval decisions whose
 * own row names exactly who decided. When the trail has no actor, the RECORD
 * is asked, and the page says the name came from the record.
 */
export function attributedActor(e: AuditEntry): { id: string | null; fromRecord: boolean } {
  if (e.actor_id) return { id: e.actor_id, fromRecord: false };
  const s = { ...(e.before_state ?? {}), ...(e.after_state ?? {}) } as Record<string, unknown>;
  for (const f of ACTOR_FIELDS) {
    const v = s[f];
    if (typeof v === "string" && /^[0-9a-f-]{36}$/i.test(v)) return { id: v, fromRecord: true };
  }
  return { id: null, fromRecord: false };
}

/** What wrote a row that names no person at all — said, rather than "System". */
export function automaticSource(e: AuditEntry): string {
  const a = e.action;
  if (a === "notification.attempt") return "Messaging service";
  if (a.startsWith("collection.") || a === "payment.status_change") return "Payment processing";
  if (a === "ledger.entry" || a === "ledger.account") return "Ledger posting";
  if (a.startsWith("remittance.")) return "Payout processing";
  if (a === "rent.write") return "Rent billing";
  if (a === "bank_statement.line" || a === "reconciliation.run") return "Bank reconciliation";
  if (a.startsWith("ticket.escalated")) return "Scheduled check";
  return "Automatic";
}

/**
 * ⚠️ An account that exists only to exercise the system. `probe*` accounts are
 * created by the verification suites; every `@oegroup.test` address is a
 * seeded demo login. The trail is immutable and must stay so — nothing here
 * rewrites a row — so a row they wrote is LABELLED instead, and a real
 * auditor is never left to decide whether a decision was a real one.
 */
export function actorKind(email: string | null | undefined): "test" | "demo" | null {
  if (!email) return null;
  const e = email.toLowerCase();
  if (e.startsWith("probe") && e.endsWith("@oegroup.test")) return "test";
  if (e.endsWith("@oegroup.test")) return "demo";
  return null;
}

// ── What happened ───────────────────────────────────────────────────────────

const h = (s: unknown) =>
  String(s ?? "").replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());
const low = (s: unknown) => String(s ?? "").replace(/_/g, " ");
const ref = (s: Record<string, unknown>) =>
  (s.reference ?? s.invoice_reference ?? s.gateway_reference ?? null) as string | null;
const money = (n: unknown, currency?: unknown) =>
  n == null || n === "" ? null : formatMoney(n as number, (currency as string) ?? "NGN");

const PAYABLE: Record<string, string> = {
  vendor_payment: "a vendor payment",
  ops_requisition: "a requisition",
  landlord_payout: "a landlord payout",
};

const ENTITY_NOUN: Record<string, string> = {
  payments: "vendor invoice", payment_intents: "collection", tickets: "service request",
  ops_requisitions: "requisition", ops_requisition_lines: "requisition line", remittances: "payout",
  payout_recipients: "payment account", leases: "tenancy", rent_charges: "rent demand",
  vendors: "vendor", vendor_users: "vendor login", vendor_registrations: "vendor registration",
  vendor_documents: "vendor document", tenant_applications: "tenancy application",
  tenancy_offers: "tenancy offer", properties: "property", property: "property",
  property_stakeholders: "property attachment", org_nodes: "place in the property tree",
  assets: "asset", units: "unit", invitations: "invitation", bank_accounts: "bank account",
  service_charges: "service charge", sc_budgets: "service-charge budget", orgs: "organisation settings",
  role_permission: "permission", ledger_entries: "ledger entry", ledger_accounts: "ledger account",
  offline_payment_claims: "reported bank payment", evaluation_criteria: "evaluation criterion",
  landlord_terms: "landlord's terms", channel_routes: "messaging number", channel_consents: "messaging consent",
};

/** "Chrome on Windows", from a user-agent string. */
export function summariseDevice(ua: unknown): string | null {
  if (typeof ua !== "string" || !ua) return null;
  const browser =
    /Edg\//.test(ua) ? "Edge" : /OPR\//.test(ua) ? "Opera" : /Firefox\//.test(ua) ? "Firefox"
    : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : "a browser";
  const os =
    /iPhone|iPad/.test(ua) ? "iPhone or iPad" : /Android/.test(ua) ? "Android"
    : /Windows/.test(ua) ? "Windows" : /Mac OS X/.test(ua) ? "a Mac" : /Linux/.test(ua) ? "Linux" : null;
  return os ? `${browser} on ${os}` : browser;
}

function attachmentVerb(before: unknown, after: unknown): string {
  if (!before && after) return "Attached";
  if (before && !after) return "Removed";
  return "Replaced";
}

/** One sentence, in plain words, saying what happened. */
export function describeEntry(e: AuditEntry, names: (id: unknown) => string | null = () => null): string {
  const b = (e.before_state ?? {}) as Record<string, unknown>;
  const a = (e.after_state ?? {}) as Record<string, unknown>;
  const isInsert = !e.before_state && Boolean(e.after_state);
  const isDelete = Boolean(e.before_state) && !e.after_state;

  switch (e.action) {
    case "session.signed_in": {
      const d = summariseDevice(a.device);
      return `Signed in${d ? ` from ${d}` : ""}`;
    }
    case "session.signed_out":
      return "Signed out";

    case "payment_approval.decision": {
      const decision = String(a.decision ?? "");
      const verb = decision === "returned" ? "Sent back" : decision === "rejected" ? "Refused" : "Approved";
      const what = PAYABLE[String(a.payable_type)] ?? "a payment";
      const amt = money(a.amount);
      const why = a.reason ? ` — “${String(a.reason).slice(0, 90)}”` : "";
      return `${verb} stage ${a.stage_order ?? "?"} of ${what}${amt ? ` for ${amt}` : ""}${why}`;
    }
    case "payment_approval.superseded":
      return `An earlier stage ${a.stage_order ?? "?"} decision stopped counting because the figures changed`;

    case "payment.created":
      return `Submitted invoice ${a.invoice_reference ?? ""} for ${money(a.amount) ?? "an amount"}`.replace("  ", " ");
    case "payment.status_change":
      return `Vendor invoice ${a.invoice_reference ?? ""} moved from ${low(b.status)} to ${low(a.status)}`.replace("  ", " ");
    case "payment.attachment":
      return `${attachmentVerb(b.invoice_attachment_path, a.invoice_attachment_path)} the invoice document on ${a.invoice_reference ?? "a vendor invoice"}`;

    case "ops_requisition.raised":
      return `Raised requisition ${a.reference ?? ""} for ${money(a.total_amount) ?? "an amount"}`.replace("  ", " ");
    case "ops_requisition.status_change":
      return `Requisition ${a.reference ?? ""} moved from ${low(b.status)} to ${low(a.status)}`.replace("  ", " ");
    case "ops_requisition.attachment":
      return `${attachmentVerb(b.invoice_attachment_path, a.invoice_attachment_path)} the invoice on requisition ${a.reference ?? ""}`.trim();
    case "ops_requisition_line.attachment":
      return `${attachmentVerb(b.attachment_path, a.attachment_path)} a document on a requisition line — ${String(a.description ?? "").slice(0, 60)}`;

    case "application.document_added":
    case "application.document_removed":
    case "application.document_replaced": {
      const verb = e.action.endsWith("added") ? "Added" : e.action.endsWith("removed") ? "Removed" : "Replaced";
      const kb = Number(a.size_bytes ?? 0) / 1024;
      return `${verb} a ${low(a.kind) || "supporting"} document on a tenancy application${kb ? ` (${kb >= 1024 ? `${(kb / 1024).toFixed(1)} MB` : `${Math.round(kb)} KB`})` : ""}`;
    }

    case "remittance.write": {
      const amt = money(a.net_amount, a.currency);
      if (isInsert) return `Raised payout ${a.reference ?? ""} for ${amt ?? "an amount"}`.replace("  ", " ");
      if (b.status !== a.status) {
        const how = a.gateway === "manual" ? " by bank transfer" : a.gateway === "paystack" ? " through Paystack" : "";
        return `Payout ${a.reference ?? ""} ${a.status === "sent" ? `was sent${how}` : `moved from ${low(b.status)} to ${low(a.status)}`}`.replace("  ", " ");
      }
      if (b.recipient_id !== a.recipient_id) return `Payout ${a.reference ?? ""} was pointed at the payee's other account`;
      return `Updated payout ${a.reference ?? ""}`.trim();
    }
    case "remittance.bank_transfer_recorded":
      return `Recorded a bank transfer of ${money(a.amount, a.currency) ?? "an amount"} to ${a.payee_account_name ?? a.payee_name ?? "the payee"} (${a.payee_bank_name ?? "their bank"} ending ${a.payee_account_last4 ?? "????"}), bank reference ${a.bank_reference ?? "—"}`;

    case "payout_recipient.write": {
      const who = a.display_name ?? b.display_name ?? "a payee";
      const where = `${a.bank_name ?? "their bank"} ending ${a.account_number_last4 ?? "????"}`;
      if (isInsert) {
        return a.gateway === "manual"
          ? `Added a bank-transfer account for ${who} — ${where}${a.verified_at ? ", name confirmed by the bank" : ", waiting for its document to be checked"}`
          : `Registered a Paystack recipient for ${who} — ${where}`;
      }
      if (!b.verified_at && a.verified_at) return `Confirmed ${who}'s bank details against their document`;
      if (b.active && !a.active) return `Replaced ${who}'s bank details with newer ones`;
      return `Updated ${who}'s payment account`;
    }
    case "payout_request.write": {
      const who = a.payee_name ?? "a payee";
      if (isInsert) return `Asked ${who} for their bank details, by a one-time link`;
      if (!b.submitted_at && a.submitted_at) return `${who} sent their bank details`;
      if (!b.withdrawn_at && a.withdrawn_at) return `Cancelled the bank-details link sent to ${who}`;
      return `Updated the bank-details request for ${who}`;
    }

    case "ticket.status_change":
      return `Service request moved from ${low(b.status)} to ${low(a.status)}`;
    case "ticket.assignment": {
      const to = a.assigned_vendor_id ? "a contractor" : a.assigned_to_user_id ? names(a.assigned_to_user_id) ?? "a member of staff" : null;
      return to ? `Assigned a service request to ${to}` : "Took a service request off whoever held it";
    }
    case "ticket.evidence":
      return isDelete ? "Removed a photo or document from a service request" : "Attached a photo or document to a service request";

    case "notification.attempt": {
      const ch = a.channel === "whatsapp" ? "A WhatsApp message" : a.channel === "sms" ? "A text message"
        : a.channel === "email" ? "An email" : a.channel === "telegram" ? "A Telegram message" : "A message";
      const st = a.status === "sent" ? "was sent" : a.status === "failed" ? "could not be delivered" : "was skipped";
      return `${ch} ${st}`;
    }

    case "collection.offline_claim":
      return isInsert
        ? `Reported a bank payment of ${money(a.claimed_amount, a.currency) ?? "an amount"} (${a.reference ?? "no reference"})`
        : `A reported bank payment ${a.reference ?? ""} moved from ${low(b.status)} to ${low(a.status)}`.replace("  ", " ");
    case "collection.offline_confirmation":
      return `Stage ${a.stage_order ?? "?"} ${low(a.decision) || "decided"} a reported bank payment`;
    case "collection.intent":
      return isInsert
        ? `Raised a ${low(a.purpose)} collection of ${money(a.amount_expected, a.currency) ?? "an amount"}`
        : `A ${low(a.purpose)} collection moved from ${low(b.status)} to ${low(a.status)}`;

    case "member.password_reset_requested":
    case "member.password_reset_sent":
      return `Sent ${a.full_name ?? a.email ?? "a member"} a password reset link`;
    case "member.email_released":
      return `Freed the address ${b.email ?? "an address"} — the sign-in is closed and the address can be invited again`;
    case "operator.suspend_user":
      return `Suspended ${a.full_name ?? a.email ?? "an account"}`;
    case "operator.unsuspend_user":
      return `Restored ${a.full_name ?? a.email ?? "an account"}`;

    case "permission.set":
      return `Turned ${a.granted ? "on" : "off"} “${low(a.capability)}” for ${low(a.role)}`;
    case "payment_chain.shape_changed":
      return `Changed the approval chain from ${low(b.approval_chain_shape) || "the brand default"} to ${low(a.approval_chain_shape) || "the brand default"}`;
    case "payment_settings.update": {
      const parts: string[] = [];
      if (a.min_performance_score != null) parts.push(`performance gate ${a.min_performance_score}`);
      if (a.approval_threshold_amount != null) parts.push(`approval limit ${money(a.approval_threshold_amount)}`);
      return `Changed payment settings${parts.length ? ` — ${parts.join(", ")}` : ""}`;
    }
    case "lease.ended":
      return "Ended a tenancy";
    case "unit.occupant_change":
      return a.occupant_user_id ? `Recorded ${names(a.occupant_user_id) ?? "a tenant"} as living in ${a.label ?? "a unit"}` : `Recorded ${a.label ?? "a unit"} as empty`;
    case "funds.override_authorised":
      return "Authorised one payment a property's fund could not cover";
  }

  // Everything else: a plain statement from the table and the columns that moved.
  const noun = ENTITY_NOUN[e.entity_type ?? ""] ?? low(e.entity_type ?? "record");
  const label = ref(a) ?? ref(b) ?? (a.name as string | undefined) ?? (a.label as string | undefined) ?? null;
  if (isInsert) return `Created a ${noun}${label ? ` — ${label}` : ""}`;
  if (isDelete) return `Removed a ${noun}${label ? ` — ${label}` : ""}`;
  if (b.status !== undefined && b.status !== a.status) {
    return `${h(noun)}${label ? ` ${label}` : ""} moved from ${low(b.status)} to ${low(a.status)}`;
  }
  const changed = Object.keys(a).filter(
    (k) => !["updated_at", "created_at"].includes(k) && JSON.stringify(b[k]) !== JSON.stringify(a[k])
  );
  return `Updated a ${noun}${label ? ` — ${label}` : ""}${changed.length ? ` (${changed.slice(0, 4).map(low).join(", ")}${changed.length > 4 ? "…" : ""})` : ""}`;
}

// Pinned locale/timezone — see the note in lib/ticket-format.ts.
export function formatAuditTime(iso: string): string {
  return new Date(iso).toLocaleString("en-GB", {
    timeZone: "Africa/Lagos",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}
