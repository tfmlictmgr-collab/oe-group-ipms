import { redirect, notFound } from "next/navigation";
import Link from "next/link";
import { ArrowLeft, Receipt } from "lucide-react";
import { getSessionProfile } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { formatMoney } from "@/lib/currency";
import { PageHeader } from "@/components/patterns/page-header";
import { PrintButton } from "@/components/patterns/print-button";
import { PrintMasthead } from "@/components/patterns/print-masthead";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { METHOD_LABEL, STATUS_LABEL, STATUS_TONE } from "@/lib/offline-payments";
import ClaimDetail, { type ClaimRow, type LineRow, type ChainRow } from "./ClaimDetail";

// One payment, whole — and the printable "transaction details" the board asked
// for, at every point in its life.
//
// ⚠️ This page IS the printable document, rather than a second @react-pdf
// renderer. `PrintButton`'s own note states the house rule: what a reader needs
// from a screen like this is the figures they are already looking at, and a
// separate PDF is a second copy of the report that can disagree with the first.
// The receipt stays on @react-pdf because it is a document SENT to someone; this
// is a screen a person prints, and it is the same screen for the payer, the
// auditor, the executive and the Payment Officer — so nobody is printing a
// different account of the same payment.
//
// Access is `may_read_offline_claim` throughout: the claim row comes back under
// RLS, and both readers gate on the same predicate. Nothing here re-decides it.

export const dynamic = "force-dynamic";

export default async function OfflineClaimPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await getSessionProfile();
  if (!session) redirect("/login");
  const { id } = await params;

  const supabase = await createClient();

  const [{ data: claim }, { data: lines }, { data: chain }] = await Promise.all([
    supabase
      .from("offline_payment_claims")
      .select(
        "id, reference, method, claimed_amount, confirmed_amount, currency, paid_on, status, payer_note, payer_reference, proof_path, proof_filename, decision_reason, posted_at, created_at, payer_user_id, recorded_by, destination_bank_account_id, matched_statement_line_id"
      )
      .eq("id", id)
      .maybeSingle(),
    supabase.rpc("offline_claim_lines", { p_claim_id: id }),
    supabase.rpc("offline_claim_chain", { p_claim_id: id }),
  ]);

  // A row invisible under RLS and a row that does not exist answer identically.
  if (!claim) notFound();

  const [{ data: bank }, { data: people }, { data: intentIds }] = await Promise.all([
    supabase
      .from("bank_accounts")
      .select("label, bank_name, account_name")
      .eq("id", claim.destination_bank_account_id)
      .maybeSingle(),
    supabase
      .from("users")
      .select("id, full_name, email")
      .in("id", [claim.payer_user_id, claim.recorded_by].filter(Boolean) as string[]),
    // The receipt lives against the intent each line posted (0253). Only present
    // once the Payment Officer has actually posted it.
    supabase
      .from("offline_payment_allocations")
      .select("intent_id")
      .eq("claim_id", id)
      .not("intent_id", "is", null),
  ]);

  const named = (uid: string | null) =>
    people?.find((p) => p.id === uid)?.full_name ?? null;

  const amount = Number(claim.confirmed_amount ?? claim.claimed_amount);
  const status = claim.status as keyof typeof STATUS_LABEL;
  const TONE = { info: "info", success: "success", danger: "destructive", warning: "warning" } as const;

  const isMine =
    claim.payer_user_id === session.profile?.id || claim.recorded_by === session.profile?.id;

  return (
    <div className="space-y-6">
      <PrintMasthead
        org={session.org?.name ?? "OE Group"}
        title={`Payment ${claim.reference}`}
        subtitle={
          claim.posted_at
            ? `Confirmed and posted — ${formatMoney(amount, claim.currency)}`
            : `Reported ${formatMoney(amount, claim.currency)} — pending confirmation. NOT A RECEIPT.`
        }
        by={session.profile?.full_name ?? undefined}
      />

      <div className="print:hidden">
        <Button asChild variant="ghost" size="sm">
          <Link href={isMine ? "/dashboard/my-rent" : "/dashboard/payments/offline"}>
            <ArrowLeft className="size-4" />
            {isMine ? "Back to My Rent" : "Back to off-platform payments"}
          </Link>
        </Button>
      </div>

      <PageHeader
        title={
          <span className="flex flex-wrap items-center gap-2">
            <span className="font-mono">{claim.reference}</span>
            <Badge variant={TONE[STATUS_TONE[status]]}>{STATUS_LABEL[status]}</Badge>
          </span>
        }
        description={
          <>
            {formatMoney(amount, claim.currency)} ·{" "}
            {METHOD_LABEL[claim.method as keyof typeof METHOD_LABEL]} on{" "}
            {new Date(claim.paid_on).toLocaleDateString("en-GB", {
              day: "numeric", month: "long", year: "numeric",
            })}
            {bank?.label ? ` · into ${bank.label}` : ""}
          </>
        }
        actions={
          <div className="flex flex-wrap items-center gap-2 print:hidden">
            <PrintButton label="Print details" />
            {claim.posted_at && intentIds?.[0]?.intent_id && (
              <Button asChild size="sm" variant="outline">
                <a href={`/api/receipts/${intentIds[0].intent_id}`} target="_blank" rel="noopener">
                  <Receipt className="size-4" />
                  Receipt
                </a>
              </Button>
            )}
          </div>
        }
      />

      {/* ⚠️ Stated on the page as well as the print masthead. A person holding a
          printout of a payment that has NOT been confirmed must not be able to
          mistake it for a receipt — that is the whole distinction this feature
          rests on, and it is the one a hurried reader will get wrong. */}
      {!claim.posted_at && (
        <Card className="border-amber-500/40 bg-amber-500/5">
          <CardContent className="p-4 text-sm">
            <p className="font-medium">This is not a receipt.</p>
            <p className="text-muted-foreground">
              It records what was reported. The payment is applied to the account
              only after the audit, executive and Payment Officer desks have each
              confirmed it against our bank account — a receipt is issued then.
            </p>
          </CardContent>
        </Card>
      )}

      <ClaimDetail
        claim={claim as unknown as ClaimRow}
        lines={(lines ?? []) as LineRow[]}
        chain={(chain ?? []) as ChainRow[]}
        payerName={named(claim.payer_user_id)}
        recordedByName={named(claim.recorded_by)}
        bankLabel={
          bank ? [bank.label, bank.bank_name, bank.account_name].filter(Boolean).join(" · ") : null
        }
        viewerId={session.profile?.id ?? ""}
        viewerRole={session.profile?.role ?? ""}
      />
    </div>
  );
}
