// What a screen needs to show about where a payee is paid by bank transfer.
//
// Server-only, read with the service role and ALWAYS filtered to one
// organisation. Callers decide who may see it first: a page renders the account
// itself only to the desks that manage accounts (the payment officer and an
// administrator), and everyone else gets `accountSummary` — that details exist,
// never what they are.

import { supabaseAdmin } from "@/lib/supabase/admin";

export type PayoutAccountView = {
  id: string;
  bankName: string;
  accountName: string;
  last4: string;
  /** The bank said who holds it when the payee submitted. */
  confirmedByBank: boolean;
  /** Usable — confirmed by the bank or by a person who read the document. */
  verified: boolean;
  verifiedByName: string | null;
  verifiedById: string | null;
  source: string;
  addedAt: string;
  hasEvidence: boolean;
};

export type PayoutRequestView = {
  id: string;
  sentAt: string;
  expiresAt: string;
  lapsed: boolean;
  /** The contacts TYPED into the request. */
  to: string;
  /**
   * Where it was actually delivered (0296), or null for a link sent before the
   * delivery was recorded. An empty array means nothing got through on its own.
   */
  sentTo: string[] | null;
  typedPhone: string | null;
};

/** A verified account held by a payment gateway — usable for a bank transfer
 *  only once someone attaches a document showing its full number (0296). */
export type GatewayAccountView = {
  id: string;
  bankName: string;
  accountName: string;
  last4: string;
};

export type PayoutWho =
  | { party: "vendor"; vendorId: string }
  | { party: "landlord"; userId: string }
  | { party: "other"; recipientId: string };

type Row = {
  id: string;
  bank_name: string | null;
  account_name: string | null;
  account_number_last4: string | null;
  name_confirmed_by_bank: boolean;
  verified_at: string | null;
  verified_by: string | null;
  details_source: string | null;
  created_at: string;
  evidence_path: string | null;
  gateway: string;
};

async function view(row: Row | null): Promise<PayoutAccountView | null> {
  if (!row || row.gateway !== "manual") return null;
  let verifiedByName: string | null = null;
  if (row.verified_by) {
    const { data: u } = await supabaseAdmin
      .from("users").select("full_name, email").eq("id", row.verified_by).maybeSingle();
    verifiedByName = u?.full_name ?? u?.email ?? null;
  }
  return {
    id: row.id,
    bankName: row.bank_name ?? "",
    accountName: row.account_name ?? "",
    last4: row.account_number_last4 ?? "",
    confirmedByBank: row.name_confirmed_by_bank,
    verified: Boolean(row.verified_at),
    verifiedByName,
    verifiedById: row.verified_by,
    source: row.details_source ?? "",
    addedAt: row.created_at,
    hasEvidence: Boolean(row.evidence_path),
  };
}

const COLUMNS =
  "id, bank_name, account_name, account_number_last4, name_confirmed_by_bank, verified_at, verified_by, details_source, created_at, evidence_path, gateway";

/** The payee's current bank-transfer account, or null. */
export async function payoutAccountFor(orgId: string, who: PayoutWho): Promise<PayoutAccountView | null> {
  if (who.party === "other") {
    const { data } = await supabaseAdmin
      .from("payout_recipients").select(COLUMNS)
      .eq("org_id", orgId).eq("id", who.recipientId).eq("active", true).maybeSingle();
    return view(data as Row | null);
  }
  const base = supabaseAdmin
    .from("payout_recipients").select(COLUMNS)
    .eq("org_id", orgId).eq("party", who.party).eq("gateway", "manual").eq("active", true);
  const { data } = who.party === "vendor"
    ? await base.eq("vendor_id", who.vendorId).maybeSingle()
    : await base.eq("user_id", who.userId).maybeSingle();
  return view(data as Row | null);
}

/**
 * The payee's verified GATEWAY account, if any (0296). Offered to the bank-
 * transfer route when there is no bank-transfer account yet: it is the same
 * bank, name and last four, and becomes usable once a document showing its
 * full number is attached — the gateway, not this system, holds the number.
 */
export async function verifiedGatewayAccountFor(
  orgId: string,
  who: { party: "vendor"; vendorId: string } | { party: "landlord"; userId: string }
): Promise<GatewayAccountView | null> {
  const base = supabaseAdmin
    .from("payout_recipients")
    .select("id, bank_name, account_name, display_name, account_number_last4")
    .eq("org_id", orgId).eq("party", who.party).eq("active", true)
    .neq("gateway", "manual").not("verified_at", "is", null);
  const { data } = who.party === "vendor"
    ? await base.eq("vendor_id", who.vendorId).limit(1).maybeSingle()
    : await base.eq("user_id", who.userId).limit(1).maybeSingle();
  if (!data || !data.bank_name || !data.account_number_last4) return null;
  return {
    id: data.id,
    bankName: data.bank_name,
    accountName: data.account_name ?? data.display_name ?? "",
    last4: data.account_number_last4,
  };
}

/** A link that has been sent and not answered or cancelled. Lapsed ones are
 *  returned too, flagged, so the screen can offer a fresh one. */
export async function openPayoutRequestFor(
  orgId: string,
  who: { vendorId: string } | { userId: string } | { lineId: string }
): Promise<PayoutRequestView | null> {
  let q = supabaseAdmin
    .from("payout_detail_requests")
    .select("id, requested_at, expires_at, contact_email, contact_phone, link_sent_to")
    .eq("org_id", orgId)
    .is("submitted_at", null)
    .is("withdrawn_at", null)
    .order("requested_at", { ascending: false })
    .limit(1);
  if ("vendorId" in who) q = q.eq("vendor_id", who.vendorId);
  else if ("userId" in who) q = q.eq("user_id", who.userId);
  else q = q.eq("requisition_line_id", who.lineId);

  const { data } = await q.maybeSingle();
  if (!data) return null;
  return {
    id: data.id,
    sentAt: data.requested_at,
    expiresAt: data.expires_at,
    lapsed: new Date(data.expires_at).getTime() < Date.now(),
    to: [data.contact_email, data.contact_phone].filter(Boolean).join(" and "),
    sentTo: (data.link_sent_to as string[] | null) ?? null,
    typedPhone: data.contact_phone ?? null,
  };
}

/**
 * Whether an account name belongs to the person being paid.
 *
 * Deliberately loose — a trading name against a registered one, initials, word
 * order — so it WARNS rather than refuses. What it exists to catch is the
 * account in somebody else's name entirely, which is how a payment is diverted.
 */
export function namesAgree(accountName: string, payeeName: string): boolean {
  const noise = new Set([
    "ltd", "limited", "plc", "nig", "nigeria", "enterprise", "enterprises", "ventures",
    "services", "company", "co", "and", "the", "global", "int", "international", "mr", "mrs", "ms", "dr",
  ]);
  const words = (s: string) =>
    s.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((w) => w.length > 1 && !noise.has(w));
  const a = new Set(words(accountName));
  return words(payeeName).some((w) => a.has(w));
}

/**
 * Whether this organisation can pay through a gateway at all right now. Since
 * 0288 one that has not connected its own Paystack account cannot, and a
 * "Send through Paystack" button it is certain to be refused is a button that
 * reads as a broken system rather than a deliberate boundary.
 */
export async function orgGatewayUsable(orgId: string): Promise<boolean> {
  const { resolveOrgGateway } = await import("@/lib/gateway");
  try {
    await resolveOrgGateway(orgId, "NGN");
    return true;
  } catch {
    return false;
  }
}
