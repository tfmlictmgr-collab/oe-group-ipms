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

export type SendResult = { sent: boolean; reason?: string };

type OrgReplyRoutes = {
  support_email: string | null;
  finance_email: string | null;
  it_email: string | null;
};

/** Category → the org's configured inbox, falling back to support. */
function replyToFor(category: MailCategory, routes: OrgReplyRoutes | null): string | null {
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

async function loadReplyRoutes(orgId: string | null): Promise<OrgReplyRoutes | null> {
  if (!orgId) return null;
  try {
    const { data } = await supabaseAdmin
      .from("orgs")
      .select("support_email, finance_email, it_email")
      .eq("id", orgId)
      .single();
    return (data as OrgReplyRoutes) ?? null;
  } catch {
    return null;
  }
}

export async function sendEmail(opts: {
  to: string;
  subject: string;
  text: string;
  category: MailCategory;
  /** Used to look up this org's reply addresses. */
  orgId?: string | null;
  /** Explicit override, e.g. when the org row isn't to hand. */
  replyTo?: string | null;
}): Promise<SendResult> {
  const key = process.env.RESEND_API_KEY;
  const from = process.env.RESEND_FROM;
  if (!key || !from) return { sent: false, reason: "email not configured" };

  const replyTo =
    opts.replyTo?.trim() ||
    replyToFor(opts.category, await loadReplyRoutes(opts.orgId ?? null));

  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from,
        to: opts.to,
        subject: opts.subject,
        text: opts.text,
        // Omit entirely rather than send an empty header.
        ...(replyTo ? { reply_to: replyTo } : {}),
      }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      console.error("Resend rejected the message:", res.status, detail.slice(0, 200));
      return { sent: false, reason: `provider returned ${res.status}` };
    }
    return { sent: true };
  } catch (e) {
    // Never let a mail failure break the action that triggered it.
    console.error("Email send failed:", e);
    return { sent: false, reason: "send failed" };
  }
}
