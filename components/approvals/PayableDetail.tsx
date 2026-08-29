import Link from "next/link";
import { FileText, Paperclip, Wrench } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { formatNaira } from "@/lib/approvals/chain";

/**
 * What the chain is being asked to approve, shown ON THE QUEUE.
 *
 * ⚠️ Why this exists. `0217` made a requisition's invoice READABLE by the chain
 * and the detail page renders it — but the Approvals queue only gained the words
 * "invoice attached" in the subtitle. So the auditor, whose entire stage is a
 * check of the invoice against the job card, was looking at a card that told
 * them evidence existed and gave them no way to see it, and the same was true of
 * the Managing Partner, the payment approver and the payment officer behind
 * them. Reported from the demo in exactly those terms.
 *
 * The board's rule (decision 23): *every touch point in the approval chain must
 * see those details when it gets to their desk*. Their desk is this queue. A
 * link to somewhere else is not the same as seeing it — it is one more thing to
 * click before a decision that was supposed to be informed by evidence.
 *
 * 📌 Deliberately READ-ONLY and deliberately not a second source of truth: every
 * value here is already on the row RLS admitted, and the invoice URL is signed
 * server-side from a path read off that row. Nothing here decides anything; the
 * decision is still `StageActions` against the database's own rules.
 */

export type JobCard = {
  id: string;
  summary: string | null;
  category: string | null;
  urgency: string | null;
  property_or_unit: string | null;
} | null;

export type PayableLine = {
  id: string;
  description: string;
  amount: number | string;
  payee: string | null;
};

export type PayableDetailData = {
  /** "Requisition PO-10001" / "Invoice INV-88" — what the thing is called. */
  reference: string | null;
  raisedBy: string | null;
  raisedAt: string | null;
  jobCard: JobCard;
  lines: PayableLine[];
  invoiceUrl: string | null;
  invoiceIsImage: boolean;
  /** True when a path is on file but no URL could be signed — say so rather
   *  than render nothing, which reads as "no invoice was ever attached". */
  invoiceUnavailable: boolean;
};

export default function PayableDetail({ data }: { data: PayableDetailData }) {
  const { reference, raisedBy, raisedAt, jobCard, lines, invoiceUrl, invoiceIsImage } = data;

  const when = raisedAt
    ? new Date(raisedAt).toLocaleDateString("en-NG", {
        day: "numeric", month: "short", year: "numeric",
      })
    : null;

  const linesTotal = lines.reduce((a, l) => a + Number(l.amount), 0);

  return (
    <div className="rounded-md border border-border bg-muted/30 p-3 text-sm">
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        What you are approving
      </p>

      <div className="mt-1.5 space-y-0.5 text-xs text-muted-foreground">
        {reference && (
          <p>
            <span className="font-medium text-foreground">{reference}</span>
            {raisedBy ? ` · raised by ${raisedBy}` : ""}
            {when ? ` · ${when}` : ""}
          </p>
        )}
        {!reference && (raisedBy || when) && (
          <p>
            {raisedBy ? `Raised by ${raisedBy}` : "Raised"}
            {when ? ` · ${when}` : ""}
          </p>
        )}
      </div>

      {/* The job card the money is claimed against. The auditor's stage is a
          comparison, and it cannot be made against one half. */}
      {jobCard && (
        <div className="mt-2.5 rounded-md border border-border bg-card p-2.5">
          <p className="flex items-start gap-1.5 text-xs">
            <Wrench className="mt-0.5 size-3 shrink-0 text-muted-foreground" />
            <Link
              href={`/dashboard/tickets/${jobCard.id}`}
              className="font-medium hover:underline"
            >
              {jobCard.summary ?? "the job card"}
            </Link>
          </p>
          <div className="mt-1 flex flex-wrap gap-1">
            {jobCard.category && (
              <Badge variant="outline" className="text-[10px] capitalize">{jobCard.category}</Badge>
            )}
            {jobCard.urgency && (
              <Badge variant="muted" className="text-[10px] capitalize">{jobCard.urgency}</Badge>
            )}
            {jobCard.property_or_unit && (
              <Badge variant="muted" className="text-[10px]">{jobCard.property_or_unit}</Badge>
            )}
          </div>
        </div>
      )}

      {/* What the money is actually for, line by line. */}
      {lines.length > 0 && (
        <ul className="mt-2.5 space-y-1">
          {lines.map((l) => (
            <li key={l.id} className="flex items-baseline justify-between gap-3 text-xs">
              <span className="min-w-0 flex-1 truncate">
                {l.description}
                {l.payee && (
                  <span className="text-muted-foreground"> · {l.payee}</span>
                )}
              </span>
              <span className="shrink-0 tabular-nums">{formatNaira(Number(l.amount))}</span>
            </li>
          ))}
          {lines.length > 1 && (
            <li className="flex items-baseline justify-between gap-3 border-t border-border pt-1 text-xs font-medium">
              <span>Total</span>
              <span className="tabular-nums">{formatNaira(linesTotal)}</span>
            </li>
          )}
        </ul>
      )}

      {/* The evidence. `0217` is what made this readable at all. */}
      <div className="mt-2.5">
        {invoiceUrl ? (
          <>
            <Link
              href={invoiceUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 rounded-md border border-input px-2.5 py-1.5 text-xs font-medium hover:bg-accent"
            >
              <FileText className="size-3.5" /> Open the invoice
            </Link>
            {invoiceIsImage && (
              // Shown, not merely linked — an auditor comparing a figure against
              // a scan should not have to leave the decision to see it.
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={invoiceUrl}
                alt="The attached invoice"
                className="mt-2 max-h-64 w-auto rounded-md border border-border object-contain"
              />
            )}
          </>
        ) : data.invoiceUnavailable ? (
          <p className="flex items-center gap-1.5 text-xs text-warning">
            <Paperclip className="size-3" />
            An invoice is on file but could not be opened — tell whoever raised this.
          </p>
        ) : (
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Paperclip className="size-3" /> No invoice attached.
          </p>
        )}
      </div>
    </div>
  );
}
