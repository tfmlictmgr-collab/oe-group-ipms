import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { getSessionProfile } from "@/lib/auth";
import { formatMoney } from "@/lib/currency";
import { PageHeader } from "@/components/patterns/page-header";
import { PrintButton } from "@/components/patterns/print-button";
import { PrintMasthead } from "@/components/patterns/print-masthead";
import { StatusBadge } from "@/components/patterns/status-badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import OpenConfirmation from "./OpenConfirmation";

// A remittance advice — one payment out, whole (0289).
//
// The page the payee is linked to when they are told they have been paid, and
// the page finance, oversight and audit open to see how a payment left. One
// page for all of them, read through the caller's own session:
// `remittances_select` decides who reaches it, and a payee reaches only their
// own. Printable, because this is what a landlord or a contractor files.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function longDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-GB", {
    timeZone: "Africa/Lagos", day: "numeric", month: "long", year: "numeric",
  });
}

export default async function RemittanceAdvicePage({ params }: { params: Promise<{ id: string }> }) {
  const session = await getSessionProfile();
  if (!session?.profile || !session.org) redirect("/login");
  const { id } = await params;
  if (!UUID.test(id)) notFound();

  const supabase = await createClient();
  const { data: r } = await supabase
    .from("remittances")
    .select(
      "id, party, reference, gross_amount, management_fee, admin_fee, net_amount, currency, status, gateway, transfer_code, sent_at, created_at, period, payment_id, requisition_id, " +
      "payout_recipients(display_name, bank_name, account_name, account_number_last4), properties(name)"
    )
    .eq("id", id)
    .maybeSingle<{
      id: string; party: string; reference: string; gross_amount: number; management_fee: number;
      admin_fee: number; net_amount: number; currency: string; status: string; gateway: string;
      transfer_code: string | null; sent_at: string | null; created_at: string; period: string | null;
      payment_id: string | null; requisition_id: string | null;
      payout_recipients: { display_name: string; bank_name: string | null; account_name: string | null; account_number_last4: string | null } | null;
      properties: { name: string } | null;
    }>();
  if (!r) notFound();

  const [{ data: manual }, { data: payment }, { data: req }] = await Promise.all([
    supabase.from("manual_remittance_records")
      .select("transferred_on, bank_reference, note, payee_name, payee_bank_name, payee_account_name, payee_account_last4, proof_filename, recorded_at, paid_from_bank_account_id")
      .eq("remittance_id", id).maybeSingle(),
    r.payment_id
      ? supabase.from("payments").select("invoice_reference").eq("id", r.payment_id).maybeSingle()
      : Promise.resolve({ data: null }),
    r.requisition_id
      ? supabase.from("ops_requisitions").select("reference").eq("id", r.requisition_id).maybeSingle()
      : Promise.resolve({ data: null }),
  ]);

  // Which of our accounts it left — readable by oversight, not by the payee,
  // which is the right way round: the payee needs to know it was sent, not
  // our account details.
  const bankId = (manual as { paid_from_bank_account_id?: string } | null)?.paid_from_bank_account_id;
  const { data: bank } = bankId
    ? await supabase.from("bank_accounts").select("label, bank_name, account_number_last4").eq("id", bankId).maybeSingle()
    : { data: null };

  const acct = r.payout_recipients;
  const payee = (manual as { payee_name?: string } | null)?.payee_name ?? acct?.display_name ?? "—";
  const accountLine = manual
    ? `${manual.payee_bank_name} · ${manual.payee_account_name} · ending ${manual.payee_account_last4}`
    : acct
      ? `${acct.bank_name ?? "Bank on file"} · ${acct.account_name ?? acct.display_name} · ending ${acct.account_number_last4 ?? "—"}`
      : "—";

  const settles = r.payment_id
    ? `Invoice ${(payment as { invoice_reference?: string } | null)?.invoice_reference ?? "—"}`
    : r.requisition_id
      ? `Requisition ${(req as { reference?: string } | null)?.reference ?? "—"}`
      : r.party === "landlord"
        ? `Rent collected${r.properties?.name ? ` for ${r.properties.name}` : ""}${r.period ? ` · ${r.period}` : ""}`
        : "—";

  const method = r.gateway === "manual" ? "Bank transfer" : r.gateway === "paystack" ? "Paystack transfer" : r.gateway;
  const fees = Number(r.management_fee) + Number(r.admin_fee);
  const staff = session.profile.role !== "vendor" && session.profile.role !== "property_owner";

  return (
    <div className="printable mx-auto max-w-3xl space-y-6">
      <PrintMasthead
        org={session.org.name}
        title="Remittance advice"
        subtitle={`${payee} · ${r.reference}`}
        by={session.profile.full_name || session.profile.email || undefined}
      />

      <div data-print="screen-only">
        <PageHeader
          title="Remittance advice"
          description={`${payee} · ${r.reference}`}
          actions={
            <div className="flex items-center gap-2">
              <PrintButton label="Print" />
              <Button asChild variant="ghost" size="sm">
                <Link href={staff ? "/dashboard/ledger" : "/dashboard"}>
                  <ArrowLeft /> Back
                </Link>
              </Button>
            </div>
          }
        />
      </div>

      <Card>
        <CardContent className="space-y-5 pt-5">
          <div className="flex flex-wrap items-end justify-between gap-4">
            <div>
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Amount sent</p>
              <p className="text-3xl font-semibold tabular-nums">{formatMoney(r.net_amount, r.currency)}</p>
              {fees > 0 && (
                <p className="text-xs text-muted-foreground">
                  {formatMoney(r.gross_amount, r.currency)} collected, less {formatMoney(fees, r.currency)} in fees
                </p>
              )}
            </div>
            <StatusBadge
              status={r.status === "sent" ? "paid" : r.status}
              label={r.status === "sent" ? "Sent" : undefined}
            />
          </div>

          <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
            <Row label="Paid to">{payee}</Row>
            <Row label="Into">{accountLine}</Row>
            <Row label="For">{settles}</Row>
            <Row label="Method">{method}</Row>
            <Row label="Date sent">{longDate(manual?.transferred_on ?? r.sent_at)}</Row>
            <Row label="Transfer reference">{manual?.bank_reference ?? r.transfer_code ?? "—"}</Row>
            <Row label="Our reference">{r.reference}</Row>
            {bank && (
              <Row label="Paid from">
                {bank.label}{bank.bank_name ? ` · ${bank.bank_name}` : ""}{bank.account_number_last4 ? ` · ending ${bank.account_number_last4}` : ""}
              </Row>
            )}
          </dl>
        </CardContent>
      </Card>

      {manual && staff && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">The bank transfer, as recorded</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <p className="text-muted-foreground">
              Recorded on {longDate(manual.recorded_at)} by the payment officer, with the bank&apos;s own
              confirmation attached{manual.proof_filename ? ` (${manual.proof_filename})` : ""}.
            </p>
            {manual.note && <p className="whitespace-pre-wrap rounded-md bg-muted/50 p-3">{manual.note}</p>}
            <div data-print="screen-only">
              <OpenConfirmation remittanceId={r.id} />
            </div>
          </CardContent>
        </Card>
      )}

      {!staff && (
        <p className="text-xs text-muted-foreground" data-print="screen-only">
          If this payment has not reached your account within one working day, reply to the message that
          told you about it and quote the transfer reference.
        </p>
      )}
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="break-words font-medium">{children}</dd>
    </div>
  );
}
