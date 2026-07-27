import { supabaseAdmin } from "@/lib/supabase/admin";

// Single outbound-mail path. Every email the system sends goes through here so
// the From/Reply-To policy is decided in one place rather than re-derived at
// each call site.
//
// Sending policy:
//   From:     a dedicated subdomain (notify.<brand>) — isolates the sending
//             reputation of app mail from the organisation's real business mail.
//             That subdomain is deliberately NOT a mailbox.
//   Reply-To: a real, monitored inbox on the organisation's root domain, chosen
//             by category. Without this, a landlord querying a remittance advice
//             or a tenant disputing an invoice would be replying into a void —
//             which loses genuine disputes and reads as evasive.
//
// A missing Resend key degrades rather than breaks: callers treat `sent: false`
// as "share the link another way", never as an error.

export type MailCategory =
  | "account"    // invitations, sign-up, vendor applications
  | "finance"    // invoices, statements, remittance advice
  | "operations" // job/notice updates
  | "it";        // system + technical notices

/**
 * `sent` means the PROVIDER ACCEPTED the message — not that it arrived. Nothing
 * observable at this point can tell us the latter, so no caller should phrase it
 * as delivery. The outcome lands later, on the provider webhook, against
 * `deliveryId`.
 */
export type SendResult = {
  sent: boolean;
  reason?: string;
  /** Our email_deliveries row, for callers that want to show its status. */
  deliveryId?: string;
  /** The provider's message id — how its webhook correlates back to us. */
  providerMessageId?: string;
};

type OrgMailIdentity = {
  name: string | null;
  support_email: string | null;
  finance_email: string | null;
  it_email: string | null;
  email_from_name: string | null;
  email_from_address: string | null;
};

/**
 * The From header for this org, as `Display Name <address>`. Returns null when
 * the org has no sender configured, so the caller can decline rather than send
 * under someone else's brand.
 */
function senderFor(identity: OrgMailIdentity | null): string | null {
  const address = identity?.email_from_address?.trim();
  if (!address) return null;
  const name = identity?.email_from_name?.trim();
  // Quote the display name so a comma or period in a brand name can't break the
  // header into two addresses.
  return name ? `"${name.replace(/"/g, "")}" <${address}>` : address;
}

/** Category → the org's configured inbox, falling back to support. */
function replyToFor(category: MailCategory, routes: OrgMailIdentity | null): string | null {
  if (!routes) return null;
  const chosen =
    category === "finance"
      ? routes.finance_email
      : category === "it"
        ? routes.it_email
        : routes.support_email;
  // Fall back to support rather than sending an unreplyable email.
  return (chosen || routes.support_email || null)?.trim() || null;
}

async function loadMailIdentity(orgId: string | null): Promise<OrgMailIdentity | null> {
  if (!orgId) return null;
  try {
    const { data } = await supabaseAdmin
      .from("orgs")
      .select("name, support_email, finance_email, it_email, email_from_name, email_from_address")
      .eq("id", orgId)
      .single();
    return (data as OrgMailIdentity) ?? null;
  } catch {
    return null;
  }
}

/** What recipients should understand themselves to be dealing with. */
export type MailContext = { brandName: string };

/**
 * Copy may be a plain string, or a function of the brand context. Use the
 * function form whenever the wording names the organisation — a recipient of a
 * TFML property must read "TFML Nigeria", never the holding entity (B1).
 */
type Copy = string | ((ctx: MailContext) => string);

export async function sendEmail(opts: {
  to: string;
  subject: Copy;
  text: Copy;
  category: MailCategory;
  /** Used to look up this org's reply addresses. */
  orgId?: string | null;
  /** Explicit override, e.g. when the org row isn't to hand. */
  replyTo?: string | null;
  /** What this email is about, so a bounce can be shown beside it. */
  entityType?: string | null;
  entityId?: string | null;
}): Promise<SendResult> {
  const key = process.env.RESEND_API_KEY;
  const envFrom = process.env.RESEND_FROM?.trim() || null;
  if (!key) return { sent: false, reason: "email not configured" };

  const identity = await loadMailIdentity(opts.orgId ?? null);

  // The client-facing BRAND sends the mail, never the holding entity (B1). Fall
  // back to the env default only for orgs with no sender configured — if that is
  // also unset there is nothing safe to send as, so we decline rather than send
  // under the wrong brand.
  const from = senderFor(identity) ?? envFrom;
  if (!from) return { sent: false, reason: "no sender identity configured for this organisation" };

  const replyTo = opts.replyTo?.trim() || replyToFor(opts.category, identity);

  // The sender display name IS the client-facing brand, so it is the right
  // thing to put in the copy too. Falls back to the org's own name.
  const ctx: MailContext = {
    brandName:
      identity?.email_from_name?.trim() || identity?.name?.trim() || "the portal",
  };
  const subject = typeof opts.subject === "function" ? opts.subject(ctx) : opts.subject;
  const text = typeof opts.text === "function" ? opts.text(ctx) : opts.text;

  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from,
        to: opts.to,
        subject,
        text,
        // Omit entirely rather than send an empty header.
        ...(replyTo ? { reply_to: replyTo } : {}),
      }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      console.error("Resend rejected the message:", res.status, detail.slice(0, 200));
      await recordDelivery({
        orgId: opts.orgId ?? null, to: opts.to, category: opts.category, subject,
        entityType: opts.entityType ?? null, entityId: opts.entityId ?? null,
        providerMessageId: null, status: "failed",
        detail: `provider returned ${res.status}: ${detail.slice(0, 300)}`,
      });
      return { sent: false, reason: `provider returned ${res.status}` };
    }

    // Keep the provider's id. Without it a bounce webhook cannot be tied back to
    // anything, which is exactly how "we told them it was emailed" became
    // unfalsifiable.
    const body = (await res.json().catch(() => ({}))) as { id?: string };
    const deliveryId = await recordDelivery({
      orgId: opts.orgId ?? null, to: opts.to, category: opts.category, subject,
      entityType: opts.entityType ?? null, entityId: opts.entityId ?? null,
      providerMessageId: body.id ?? null, status: "accepted", detail: null,
    });

    return { sent: true, deliveryId, providerMessageId: body.id };
  } catch (e) {
    // Never let a mail failure break the action that triggered it.
    console.error("Email send failed:", e);
    await recordDelivery({
      orgId: opts.orgId ?? null, to: opts.to, category: opts.category, subject,
      entityType: opts.entityType ?? null, entityId: opts.entityId ?? null,
      providerMessageId: null, status: "failed",
      detail: e instanceof Error ? e.message.slice(0, 300) : "send failed",
    });
    return { sent: false, reason: "send failed" };
  }
}

/** Best-effort. A missing delivery record must never fail the send it describes. */
async function recordDelivery(row: {
  orgId: string | null;
  to: string;
  category: MailCategory;
  subject: string;
  entityType: string | null;
  entityId: string | null;
  providerMessageId: string | null;
  status: "accepted" | "failed";
  detail: string | null;
}): Promise<string | undefined> {
  try {
    const { data, error } = await supabaseAdmin
      .from("email_deliveries")
      .insert({
        org_id: row.orgId,
        to_email: row.to,
        category: row.category,
        subject: row.subject.slice(0, 300),
        entity_type: row.entityType,
        entity_id: row.entityId,
        provider_message_id: row.providerMessageId,
        status: row.status,
        detail: row.detail,
        resolved_at: row.status === "failed" ? new Date().toISOString() : null,
      })
      .select("id")
      .single();
    if (error) {
      console.error("could not record email delivery:", error.message);
      return undefined;
    }
    return data.id as string;
  } catch (e) {
    console.error("could not record email delivery:", e);
    return undefined;
  }
}
