import { NextRequest, NextResponse } from "next/server";
import { renderToBuffer } from "@react-pdf/renderer";
import { createClient } from "@/lib/supabase/server";
import { getBrandTheme } from "@/lib/brands";
import { ReceiptDocument, type ReceiptData } from "@/lib/pdf/receipt";

// Receipts are generated on demand rather than stored, so a receipt can never
// disagree with the ledger it was drawn from.
//
// Authorisation is left to RLS on payment_intents: the payer sees their own,
// finance and admin see the org's, everyone else sees nothing. Using the
// caller's own client here — not the service role — is the point.
export const runtime = "nodejs";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ intentId: string }> }
) {
  const { intentId } = await params;

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return new NextResponse("Sign in required", { status: 401 });

  const { data: intent } = await supabase
    .from("payment_intents")
    .select(
      "id, org_id, purpose, amount_expected, amount_paid, currency, status, gateway, gateway_reference, paid_at, ledger_entry_id, users:payer_user_id(full_name, email)"
    )
    .eq("id", intentId)
    .maybeSingle();

  // A row invisible under RLS and a row that does not exist are answered
  // identically — the response must not confirm that a payment exists.
  if (!intent) return new NextResponse("Not found", { status: 404 });

  // Nothing has been received, so there is nothing to receipt.
  if (!intent.ledger_entry_id) {
    return new NextResponse("No payment has been received against this request yet.", {
      status: 409,
    });
  }

  const { data: org } = await supabase
    .from("orgs")
    .select(
      "name, portal_name, logo_url, theme_primary, delivery_brand, tagline, support_email, support_phone"
    )
    .eq("id", intent.org_id)
    .single();

  const { data: entry } = await supabase
    .from("ledger_entries")
    .select("description")
    .eq("id", intent.ledger_entry_id)
    .maybeSingle();

  // PostgREST types an embedded to-one join as an array; it is a single row.
  const payer = (intent.users ?? null) as unknown as
    | { full_name: string | null; email: string | null }
    | null;
  const paid = Number(intent.amount_paid ?? 0);
  const expected = Number(intent.amount_expected);

  const data: ReceiptData = {
    org: {
      name: org?.portal_name || org?.name || "Client Portal",
      logoUrl: org?.logo_url ?? null,
      // Was `org?.theme_primary ?? "#003366"` — TFML's own navy for any org
      // with nothing customised, so an OEA receipt printed in TFML's colour.
      // Falls back to THIS org's own base palette by delivery_brand instead.
      primary: getBrandTheme(org?.delivery_brand, { theme_primary: org?.theme_primary }).primary,
      supportEmail: org?.support_email ?? null,
      supportPhone: org?.support_phone ?? null,
      tagline: org?.tagline ?? null,
    },
    reference: intent.gateway_reference,
    ledgerEntryId: intent.ledger_entry_id,
    purpose: intent.purpose,
    description: entry?.description ?? null,
    payerName: payer?.full_name ?? "Account holder",
    payerEmail: payer?.email ?? null,
    amountExpected: expected,
    amountPaid: paid,
    currency: intent.currency,
    paidAt: intent.paid_at,
    gateway: intent.gateway,
    partial: paid < expected,
  };

  const buffer = await renderToBuffer(<ReceiptDocument d={data} />);

  return new NextResponse(new Uint8Array(buffer), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="receipt-${intent.gateway_reference}.pdf"`,
      // A receipt is personal and per-user; never let a shared cache hold it.
      "Cache-Control": "private, no-store",
    },
  });
}
