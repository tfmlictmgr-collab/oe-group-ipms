"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { CheckCircle2, Clock, XCircle, FileText, ArrowRight } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { formatNaira } from "@/lib/currency";
import { runAction, describeError } from "@/lib/run-action";
import { offerDate, payableOnAcceptance, termLabel, termLines, type OfferTerms } from "@/lib/tenancy-offer";
import { withdrawOffer, reissueOffer, type OfferInput } from "./actions";
import OfferTermsFields, { offerIsReady } from "./OfferTerms";

/**
 * The offer, on the reviewer's side of it (0263).
 *
 * ⚠️ The acceptance link is NOT shown here and cannot be. Only the token's hash
 * is stored, exactly as with an invitation or an application resume link — so
 * the only copy of the link that ever existed is the one in the applicant's
 * email. When that send fails, the honest remedy is to withdraw the offer and
 * issue a corrected one, which mints a new token and sends again. Showing a
 * "resend" button that could not actually resend the same link would be worse
 * than the absence of one.
 */

export type OfferRow = {
  id: string;
  state: "issued" | "accepted" | "declined" | "withdrawn" | "lapsed";
  rent_amount: string;
  service_charge_amount: string;
  deposit_amount: string;
  other_charges_amount: string;
  other_charges_label: string | null;
  term_months: number;
  commences_on: string;
  expires_on: string;
  conditions: string | null;
  issued_at: string;
  responded_at: string | null;
  decline_reason: string | null;
  withdrawn_reason: string | null;
};

export default function OfferPanel({
  offer,
  applicationId,
  applicantEmail,
  applicantName,
  orgId,
  canApprove,
  leaseHref,
}: {
  offer: OfferRow;
  applicationId: string;
  applicantEmail: string;
  applicantName: string;
  orgId: string;
  canApprove: boolean;
  /** Prefilled from this offer, so the tenancy is recorded from what was agreed. */
  leaseHref: string | null;
}) {
  const router = useRouter();
  const [busy, setBusy] = React.useState<string | null>(null);
  const [mode, setMode] = React.useState<"idle" | "withdrawing" | "reissuing">("idle");
  const [reason, setReason] = React.useState("");
  const [terms, setTerms] = React.useState<OfferInput>(() => ({
    rentAmount: String(offer.rent_amount ?? ""),
    serviceChargeAmount: String(offer.service_charge_amount ?? ""),
    depositAmount: String(offer.deposit_amount ?? ""),
    otherChargesAmount: String(offer.other_charges_amount ?? ""),
    otherChargesLabel: offer.other_charges_label ?? "",
    termMonths: String(offer.term_months ?? 12),
    commencesOn: offer.commences_on,
    expiresOn: offer.expires_on,
    conditions: offer.conditions ?? "",
  }));

  const shown: OfferTerms = {
    rentAmount: Number(offer.rent_amount),
    serviceChargeAmount: Number(offer.service_charge_amount),
    depositAmount: Number(offer.deposit_amount),
    otherChargesAmount: Number(offer.other_charges_amount),
    otherChargesLabel: offer.other_charges_label,
    termMonths: offer.term_months,
    commencesOn: offer.commences_on,
    expiresOn: offer.expires_on,
    conditions: offer.conditions,
  };

  async function doWithdraw() {
    setBusy("withdraw");
    try {
      await runAction(withdrawOffer(offer.id, applicationId, reason));
      toast.success("Offer withdrawn", {
        description: "Its acceptance link stops working immediately. Make a corrected offer below.",
      });
      setReason("");
      setMode("idle");
      router.refresh();
    } catch (err) {
      toast.error("Could not withdraw that offer", { description: describeError(err) });
    } finally {
      setBusy(null);
    }
  }

  async function doReissue() {
    setBusy("reissue");
    try {
      const r = await runAction(reissueOffer(applicationId, applicantEmail, applicantName, orgId, terms));
      if (r.emailed) {
        toast.success("Offer sent", { description: `A new offer letter has gone to ${applicantEmail}.` });
      } else {
        toast.warning("Offer recorded — but the letter was not sent", {
          description: "The acceptance link exists only in that email. Check the mail settings and re-issue.",
          duration: Infinity, closeButton: true,
        });
      }
      setMode("idle");
      router.refresh();
    } catch (err) {
      toast.error("Could not make that offer", {
        description: describeError(err), duration: Infinity, closeButton: true,
      });
    } finally {
      setBusy(null);
    }
  }

  const badge = {
    issued: <Badge variant="warning">Awaiting the applicant</Badge>,
    accepted: <Badge variant="success">Accepted</Badge>,
    declined: <Badge variant="outline">Declined</Badge>,
    lapsed: <Badge variant="outline">Lapsed</Badge>,
    withdrawn: <Badge variant="outline">Withdrawn</Badge>,
  }[offer.state];

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-center gap-2">
          <FileText className="size-4 text-brand" />
          <CardTitle className="text-base">Offer of tenancy</CardTitle>
          {badge}
        </div>
        <CardDescription>
          Sent to {applicantEmail} on {offerDate(offer.issued_at)}. The applicant
          accepts or declines through their own link — the acceptance link is not
          held here, only its hash.
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-4">
        <dl className="space-y-1.5 rounded-lg border border-border bg-muted/30 p-3 text-sm">
          <Row label="Term">
            {termLabel(shown.termMonths)}, commencing {offerDate(shown.commencesOn)}
          </Row>
          {termLines(shown).map((l) => (
            <Row key={l.label} label={l.label}>{l.value}</Row>
          ))}
          <div className="flex items-baseline justify-between gap-4 border-t border-border pt-2">
            <dt className="font-medium">Payable to accept</dt>
            <dd className="font-semibold tabular-nums">{formatNaira(payableOnAcceptance(shown))}</dd>
          </div>
          {offer.state === "issued" && (
            <Row label="Open until">{offerDate(shown.expiresOn)}</Row>
          )}
        </dl>

        {shown.conditions && (
          <p className="whitespace-pre-wrap rounded-lg border border-border p-3 text-sm">
            {shown.conditions}
          </p>
        )}

        {/* ── Where it got to ─────────────────────────────────────────────── */}
        {offer.state === "accepted" && (
          <div className="flex items-start gap-2 rounded-lg border border-success/40 bg-success/5 p-3 text-sm">
            <CheckCircle2 className="mt-0.5 size-4 flex-shrink-0 text-success" />
            <div className="space-y-2">
              <p>
                <span className="font-medium">Accepted on {offerDate(offer.responded_at)}.</span>{" "}
                The applicant has been emailed a link to set up their tenant
                account. Recording the tenancy is what starts billing it.
              </p>
              {leaseHref && (
                <Button asChild size="sm" variant="brand">
                  <Link href={leaseHref}>
                    Record the tenancy <ArrowRight className="size-4" />
                  </Link>
                </Button>
              )}
            </div>
          </div>
        )}

        {offer.state === "declined" && (
          <div className="flex items-start gap-2 rounded-lg border border-border bg-muted/40 p-3 text-sm">
            <XCircle className="mt-0.5 size-4 flex-shrink-0 text-muted-foreground" />
            <p>
              <span className="font-medium">Declined on {offerDate(offer.responded_at)}.</span>{" "}
              {offer.decline_reason
                ? `They said: “${offer.decline_reason}”`
                : "They gave no reason, which they are not obliged to."}{" "}
              The unit is free again.
            </p>
          </div>
        )}

        {offer.state === "lapsed" && (
          <div className="flex items-start gap-2 rounded-lg border border-warning/40 bg-warning/5 p-3 text-sm">
            <Clock className="mt-0.5 size-4 flex-shrink-0 text-warning" />
            <p>
              This offer was open until {offerDate(shown.expiresOn)} and was not
              answered, so it can no longer be accepted. Make a fresh offer below
              if the unit is still available.
            </p>
          </div>
        )}

        {offer.state === "withdrawn" && offer.withdrawn_reason && (
          <p className="rounded-lg border border-border bg-muted/40 p-3 text-sm">
            Withdrawn: {offer.withdrawn_reason}
          </p>
        )}

        {/* ── What the reviewer can still do ──────────────────────────────── */}
        {canApprove && mode === "idle" && (
          <div className="flex flex-wrap gap-2">
            {offer.state === "issued" && (
              <Button type="button" size="sm" variant="outline" onClick={() => setMode("withdrawing")}>
                Withdraw this offer
              </Button>
            )}
            {["declined", "lapsed", "withdrawn"].includes(offer.state) && (
              <Button type="button" size="sm" variant="outline" onClick={() => setMode("reissuing")}>
                Make a new offer
              </Button>
            )}
          </div>
        )}

        {mode === "withdrawing" && (
          <div className="space-y-2 rounded-lg border border-border p-3">
            <Label htmlFor="withdraw-reason">Why is it being withdrawn?</Label>
            <Textarea
              id="withdraw-reason" rows={2} value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="The rent was entered incorrectly; the unit has been relet; the terms changed…"
            />
            <p className="text-xs text-muted-foreground">
              It goes on the record, and the applicant&rsquo;s link stops working
              at once. At least 10 characters.
            </p>
            <div className="flex flex-wrap gap-2">
              <Button
                type="button" size="sm" variant="destructive"
                disabled={busy !== null || reason.trim().length < 10}
                onClick={doWithdraw}
              >
                {busy === "withdraw" ? "Withdrawing…" : "Withdraw"}
              </Button>
              <Button type="button" size="sm" variant="ghost" disabled={busy !== null} onClick={() => setMode("idle")}>
                Cancel
              </Button>
            </div>
          </div>
        )}

        {mode === "reissuing" && (
          <div className="space-y-4 rounded-lg border border-border p-4">
            <p className="text-sm text-muted-foreground">
              A new offer letter goes to {applicantEmail} with a fresh acceptance
              link. The previous one stays on the record.
            </p>
            <OfferTermsFields value={terms} onChange={setTerms} disabled={busy !== null} />
            <div className="flex flex-wrap gap-2">
              <Button
                type="button" size="sm" variant="brand"
                disabled={busy !== null || !offerIsReady(terms)}
                onClick={doReissue}
              >
                {busy === "reissue" ? "Sending…" : "Send this offer"}
              </Button>
              <Button type="button" size="sm" variant="ghost" disabled={busy !== null} onClick={() => setMode("idle")}>
                Cancel
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-4">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="text-right font-medium">{children}</dd>
    </div>
  );
}
