// Telling a payee — in the organisation's own name, on the channels they use.
//
// Server-only. Every message here leaves through the per-organisation senders
// decision 47 put in place: `sendEmail` resolves this organisation's own From
// and reply address, `sendCascade` its own WhatsApp number, and every link is
// to this organisation's own portal (`portalOrigin`). Nothing here may name
// another organisation, and nothing here falls back to a shared identity.
//
// Every function swallows its own failures. A payment that has been recorded
// must never be reported as failed because a mail provider was down — the
// officer would record it again, and a second record of one transfer is worse
// than a late email.

import { supabaseAdmin } from "@/lib/supabase/admin";
import { sendEmail } from "@/lib/email";
import { sendCascade } from "@/lib/cascade";
import { portalOrigin } from "@/lib/portal-origin";
import { formatMoney } from "@/lib/currency";
import { payoutDetailsUrl } from "@/lib/payout-evidence";

type Party = "vendor" | "landlord" | "other";

type Reach = {
  name: string;
  /** Portal users to tell in the bell as well. */
  userIds: string[];
  email: string | null;
  phone: string | null;
};

function longDate(iso: string | null | undefined): string {
  if (!iso) return "";
  return new Date(iso).toLocaleDateString("en-GB", {
    timeZone: "Africa/Lagos", day: "numeric", month: "long", year: "numeric",
  });
}

function firstName(name: string): string {
  const first = name.trim().split(/\s+/)[0] ?? "";
  // A company is greeted by its name, not by the first word of it.
  return /\b(ltd|limited|plc|enterprises?|ventures|services|company|co|nig)\b/i.test(name) ? name : first || name;
}

/**
 * Who a payee is and how to reach them — from their OWN record where one
 * exists, so a warning that an account changed goes to the address on file,
 * not to whatever somebody typed when they asked for the details.
 */
async function reachFor(p: {
  party: Party;
  vendor_id: string | null;
  user_id: string | null;
  display_name: string;
  contact_email: string | null;
  contact_phone: string | null;
}): Promise<Reach> {
  if (p.party === "vendor" && p.vendor_id) {
    const [{ data: v }, { data: people }] = await Promise.all([
      supabaseAdmin.from("vendors")
        .select("name, contact_email, contact_phone, user_id").eq("id", p.vendor_id).maybeSingle(),
      supabaseAdmin.from("vendor_users")
        .select("user_id").eq("vendor_id", p.vendor_id).eq("is_owner", true),
    ]);
    const ids = new Set<string>((people ?? []).map((x) => x.user_id as string));
    if (v?.user_id) ids.add(v.user_id);
    return {
      name: v?.name ?? p.display_name,
      userIds: Array.from(ids),
      email: v?.contact_email ?? p.contact_email,
      phone: v?.contact_phone ?? p.contact_phone,
    };
  }
  if (p.party === "landlord" && p.user_id) {
    const { data: u } = await supabaseAdmin.from("users")
      .select("full_name, email, phone, deactivated_at").eq("id", p.user_id).maybeSingle();
    return {
      name: u?.full_name ?? p.display_name,
      userIds: u && !u.deactivated_at ? [p.user_id] : [],
      email: u?.email ?? p.contact_email,
      phone: u?.phone ?? p.contact_phone,
    };
  }
  return { name: p.display_name, userIds: [], email: p.contact_email, phone: p.contact_phone };
}

/** Email, then WhatsApp/SMS, then the bell — each best-effort. Returns where it went. */
async function tell(opts: {
  orgId: string;
  reach: Reach;
  subject: (brand: string) => string;
  body: (brand: string) => string;
  /** The short form for WhatsApp and SMS. */
  short: string;
  bell?: { title: string; body: string; link: string; entityType: string | null; entityId: string | null };
  entityType: string;
  entityId: string | null;
}): Promise<string[]> {
  const sentTo: string[] = [];

  if (opts.reach.email) {
    try {
      const r = await sendEmail({
        to: opts.reach.email,
        orgId: opts.orgId,
        category: "finance",
        subject: (ctx) => opts.subject(ctx.brandName),
        text: (ctx) => opts.body(ctx.brandName),
        entityType: opts.entityType,
        entityId: opts.entityId,
      });
      if (r.sent) sentTo.push(`email to ${opts.reach.email}`);
    } catch (e) {
      console.error("payout email failed:", e instanceof Error ? e.message : e);
    }
  }

  if (opts.reach.phone) {
    try {
      // No email here — it has just gone out above, with a proper subject.
      const c = await sendCascade({
        orgId: opts.orgId,
        entityType: "payment",
        entityId: null,
        message: opts.short,
        whatsapp: opts.reach.phone,
        recipientUserId: opts.reach.userIds[0] ?? null,
        phone: opts.reach.phone,
      });
      if (c.delivered) sentTo.push(`a message to ${opts.reach.phone}`);
    } catch (e) {
      console.error("payout message failed:", e instanceof Error ? e.message : e);
    }
  }

  if (opts.bell) {
    for (const uid of opts.reach.userIds) {
      try {
        await supabaseAdmin.rpc("notify_user", {
          p_user_id: uid,
          p_kind: "payment",
          p_title: opts.bell.title,
          p_body: opts.bell.body,
          p_link: opts.bell.link,
          p_entity_type: opts.bell.entityType,
          p_entity_id: opts.bell.entityId,
        });
      } catch { /* the email and the message still carry it */ }
    }
  }

  return sentTo;
}

/**
 * The live person in this organisation this number belongs to, if any — the
 * payee's own record first (their vendor login, or the landlord themselves),
 * then anyone else in the organisation. Compared on the last ten digits, so
 * "+234 806…", "2348 06…" and "0806…" are one number.
 */
async function personForNumber(
  orgId: string,
  phone: string | null,
  vendorId: string | null,
  userId: string | null
): Promise<string | null> {
  const want = (phone ?? "").replace(/\D/g, "").slice(-10);
  if (want.length < 10) return null;

  const candidates: string[] = [];
  if (userId) candidates.push(userId);
  if (vendorId) {
    const { data: people } = await supabaseAdmin
      .from("vendor_users").select("user_id").eq("vendor_id", vendorId);
    for (const p of people ?? []) candidates.push(p.user_id as string);
  }

  const { data: users } = await supabaseAdmin
    .from("users").select("id, phone")
    .eq("org_id", orgId).is("deactivated_at", null).not("phone", "is", null);
  const matches = (users ?? []).filter(
    (u) => (u.phone ?? "").replace(/\D/g, "").slice(-10) === want
  );
  const own = matches.find((u) => candidates.includes(u.id));
  return (own ?? (matches.length === 1 ? matches[0] : null))?.id ?? null;
}

/** The one-time link, to the payee. */
export async function sendPayoutDetailsLink(opts: {
  requestId: string;
  token: string;
}): Promise<{ link: string; sentTo: string[] }> {
  const { data: q } = await supabaseAdmin
    .from("payout_detail_requests")
    .select("id, org_id, party, vendor_id, user_id, payee_name, purpose, contact_email, contact_phone, expires_at")
    .eq("id", opts.requestId)
    .single();
  if (!q) return { link: "", sentTo: [] };

  const origin = await portalOrigin(q.org_id, "message");
  const link = payoutDetailsUrl(origin, opts.token);
  const until = longDate(q.expires_at);

  // To the contact the requester gave — this is the one message that has to
  // reach the payee wherever they are. The account-change warning after they
  // submit goes to the contact on their OWN record.
  // ⚠️ 14 Sept 2026. WhatsApp's consent gate (0148) is recorded against a
  // PERSON, and this message went out with nobody attached — so it was skipped
  // as "not a portal user" even when the number typed was a portal user's own,
  // one who receives this organisation's WhatsApp messages every day. The
  // number is matched to a live person in THIS organisation, and the gate then
  // asks whether they agreed, for that exact number. A stranger's number still
  // finds nobody and is still skipped — that is the rule working.
  const personId = await personForNumber(q.org_id, q.contact_phone, q.vendor_id, q.user_id);
  const reach: Reach = {
    name: q.payee_name,
    userIds: personId ? [personId] : [],
    email: q.contact_email,
    phone: q.contact_phone,
  };

  const sentTo = await tell({
    orgId: q.org_id,
    reach,
    entityType: "payout_request",
    entityId: q.id,
    subject: (brand) => `${brand} — where should we pay you?`,
    body: (brand) =>
      [
        `Dear ${firstName(q.payee_name)},`,
        "",
        `${brand} would like to pay you for: ${q.purpose}.`,
        "",
        "To do that we need the bank account you would like the money paid into. Please give it to us on this secure page:",
        "",
        link,
        "",
        "You will be asked for your bank, your account number, and a document that shows your account name and number — a bank letter, a statement, or a screenshot from your banking app.",
        "",
        "We keep your bank, your account name and the last four digits of your account number. We will never ask for your PIN, your password or a one-time code, and nobody from us will ask you to send money to receive a payment.",
        "",
        `This link is for you alone and works until ${until}. If you were not expecting a payment from us, you can ignore this message.`,
        "",
        brand,
      ].join("\n"),
    short:
      `We would like to pay you for: ${q.purpose}. Please give us the bank account to pay into, ` +
      `on this secure page (works until ${until}): ${link} — we will never ask for your PIN or a one-time code.`,
  });

  return { link, sentTo };
}

/**
 * A new place a payee is paid. Sent to the contact on their OWN record — the
 * standard defence against somebody quietly redirecting a contractor's money:
 * the real payee hears about it before any payment goes there.
 */
export async function notifyPayoutAccountAdded(recipientId: string): Promise<void> {
  try {
    const { data: a } = await supabaseAdmin
      .from("payout_recipients")
      .select("id, org_id, party, vendor_id, user_id, display_name, bank_name, account_name, account_number_last4, contact_email, contact_phone")
      .eq("id", recipientId)
      .single();
    if (!a) return;
    const reach = await reachFor(a as Parameters<typeof reachFor>[0]);
    const what = `${a.bank_name} account ending ${a.account_number_last4}, in the name ${a.account_name}`;
    await tell({
      orgId: a.org_id,
      reach,
      entityType: "payout_account",
      entityId: a.id,
      subject: (brand) => `${brand} — your payment account has been updated`,
      body: (brand) =>
        [
          `Dear ${firstName(reach.name)},`,
          "",
          `The ${what}, is now where ${brand} will pay you when we pay by bank transfer.`,
          "",
          "If you gave us these details, there is nothing for you to do.",
          "",
          `If you did NOT, contact ${brand} straight away, before any payment is made — reply to this email.`,
          "",
          brand,
        ].join("\n"),
      short: `Your payment account with us is now the ${what}. If you did not give us these details, contact us straight away.`,
      bell: {
        title: "Your payment account was updated",
        body: `We will pay you into the ${what}. If this was not you, contact us straight away.`,
        link: "/dashboard",
        entityType: null,
        entityId: null,
      },
    });
  } catch (e) {
    console.error("could not send the account-change notice:", e instanceof Error ? e.message : e);
  }
}

/** The person who asked, told that the payee has answered. */
export async function notifyRequesterSubmitted(requestId: string): Promise<void> {
  try {
    const { data: q } = await supabaseAdmin
      .from("payout_detail_requests")
      .select("id, requested_by, party, vendor_id, payee_name, requisition_line_id, recipient_id")
      .eq("id", requestId)
      .single();
    if (!q) return;

    let link = "/dashboard/ledger/payouts";
    if (q.party === "vendor" && q.vendor_id) link = `/dashboard/vendors/${q.vendor_id}`;
    if (q.party === "other" && q.requisition_line_id) {
      const { data: line } = await supabaseAdmin
        .from("ops_requisition_lines").select("requisition_id").eq("id", q.requisition_line_id).maybeSingle();
      if (line) link = `/dashboard/approvals/requisitions/${line.requisition_id}`;
    }

    const { data: acct } = await supabaseAdmin
      .from("payout_recipients").select("verified_at").eq("id", q.recipient_id).maybeSingle();

    await supabaseAdmin.rpc("notify_user", {
      p_user_id: q.requested_by,
      p_kind: "payment",
      p_title: `${q.payee_name} sent their bank details`,
      p_body: acct?.verified_at
        ? "Their bank confirmed the account name, so they can be paid by bank transfer now."
        : "Their bank could not confirm the name automatically — open their document and confirm it before paying.",
      p_link: link,
      p_entity_type: null,
      p_entity_id: null,
    });
  } catch { /* the page shows it regardless */ }
}

/** The payee, told that the money has gone. */
export async function notifyPayeePaid(remittanceId: string): Promise<string[]> {
  try {
    const { data: r } = await supabaseAdmin
      .from("remittances")
      .select("id, org_id, reference, net_amount, currency, party, payment_id, requisition_id, property_id, period, payout_recipients(party, vendor_id, user_id, display_name, bank_name, account_number_last4, contact_email, contact_phone), properties(name)")
      .eq("id", remittanceId)
      .single();
    if (!r) return [];

    const { data: m } = await supabaseAdmin
      .from("manual_remittance_records")
      .select("transferred_on, bank_reference, payee_bank_name, payee_account_last4")
      .eq("remittance_id", remittanceId)
      .maybeSingle();

    const acct = r.payout_recipients as unknown as {
      party: Party; vendor_id: string | null; user_id: string | null; display_name: string;
      bank_name: string | null; account_number_last4: string | null;
      contact_email: string | null; contact_phone: string | null;
    };
    const property = (r.properties as unknown as { name?: string } | null)?.name ?? null;

    let what = "work you did for us";
    if (r.payment_id) {
      const { data: p } = await supabaseAdmin
        .from("payments").select("invoice_reference").eq("id", r.payment_id).maybeSingle();
      what = p?.invoice_reference ? `your invoice ${p.invoice_reference}` : "your invoice";
    } else if (r.requisition_id) {
      const { data: q } = await supabaseAdmin
        .from("ops_requisitions").select("reference").eq("id", r.requisition_id).maybeSingle();
      what = q?.reference ? `requisition ${q.reference}` : "work on a requisition";
    } else if (r.party === "landlord") {
      what = `rent collected${property ? ` for ${property}` : ""}${r.period ? ` (${r.period})` : ""}, net of our fees`;
    }

    const amount = formatMoney(r.net_amount, r.currency);
    const bank = m?.payee_bank_name ?? acct.bank_name ?? "your bank";
    const last4 = m?.payee_account_last4 ?? acct.account_number_last4 ?? "";
    const when = m?.transferred_on ? longDate(m.transferred_on) : longDate(new Date().toISOString());
    const quote = m?.bank_reference ?? r.reference;
    const reach = await reachFor({ ...acct, party: acct.party });

    const origin = await portalOrigin(r.org_id, "message");
    const advice = `${origin}/dashboard/remittances/${r.id}`;

    return await tell({
      orgId: r.org_id,
      reach,
      entityType: "remittance",
      entityId: r.id,
      subject: (brand) => `Payment sent — ${amount} from ${brand}`,
      body: (brand) =>
        [
          `Dear ${firstName(reach.name)},`,
          "",
          `${brand} has sent you ${amount} for ${what}.`,
          "",
          `Paid into: ${bank}, account ending ${last4}`,
          `Date sent: ${when}`,
          `Transfer reference: ${quote}`,
          `Our reference: ${r.reference}`,
          "",
          "Bank transfers usually arrive the same day. If it has not reached you within one working day, reply to this email and quote the transfer reference above.",
          ...(reach.userIds.length ? ["", `The full remittance advice is in your portal: ${advice}`] : []),
          "",
          brand,
        ].join("\n"),
      short: `${amount} has been sent to your ${bank} account ending ${last4} on ${when}, for ${what}. Transfer reference: ${quote}.`,
      bell: {
        title: `Payment sent — ${amount}`,
        body: `Into your ${bank} account ending ${last4}, for ${what}.`,
        link: `/dashboard/remittances/${r.id}`,
        entityType: "remittance",
        entityId: r.id,
      },
    });
  } catch (e) {
    console.error("could not tell the payee they were paid:", e instanceof Error ? e.message : e);
    return [];
  }
}
