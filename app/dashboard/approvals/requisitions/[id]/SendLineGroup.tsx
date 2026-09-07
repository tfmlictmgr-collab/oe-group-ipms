"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { formatNaira } from "@/lib/approvals/chain";
import { runAction, messageOf, hintOf } from "@/lib/run-action";
import { sendRequisitionVendorLines, sendRequisitionPayeeLines, authoriseShortFund } from "@/app/dashboard/requisitions/send-actions";
import { Label } from "@/components/ui/label";

/** One "Send" button per distinct payee — settles every unsettled line naming them. */
export default function SendLineGroup({
  requisitionId,
  kind,
  targetId,
  name,
  amount,
}: {
  requisitionId: string;
  kind: "vendor" | "payee";
  targetId: string;
  name: string;
  amount: number;
}) {
  const router = useRouter();
  const [busy, setBusy] = React.useState(false);
  /**
   * The fund refusal, and the payment officer's way past it (0272).
   *
   * ⚠️ Offered ONLY after the send has actually been refused for that reason.
   * A permanent "authorise anyway" button beside every Send would turn an
   * exception to a segregation control into an ordinary option, which is the
   * opposite of what a control is for. It appears because the money was
   * genuinely short, and it carries the shortfall in its own words.
   */
  const [shortfall, setShortfall] = React.useState<string | null>(null);
  const [reason, setReason] = React.useState("");

  async function send() {
    setBusy(true);
    try {
      const r = await runAction(
        kind === "vendor"
          ? sendRequisitionVendorLines(requisitionId, targetId)
          : sendRequisitionPayeeLines(requisitionId, targetId)
      );
      if (r.status === "sent") {
        toast.success(`Sent to ${name}.`, { description: `Reference ${r.reference}.` });
      } else {
        toast.message("The transfer is pending at the gateway.", {
          description: `Reference ${r.reference}. It will settle on its own — do not send again.`,
          duration: Infinity, closeButton: true,
        });
      }
      router.refresh();
    } catch (e) {
      const msg = messageOf(e, "That could not be sent.");
      // Matched on the refusal's own words. `assert_funds_available` composes
      // them (0247/0272) and they name the building and the shortfall, so the
      // panel below can quote the reason rather than paraphrase it.
      if (/fund cannot cover this|would be left short by/i.test(msg)) {
        setShortfall(msg);
      } else {
        toast.error(msg, { description: hintOf(e) });
      }
    } finally {
      setBusy(false);
    }
  }

  async function authoriseAndSend() {
    setBusy(true);
    try {
      await runAction(authoriseShortFund("ops_requisition", requisitionId, reason));
      setShortfall(null);
      setReason("");
      toast.success("Authorised.", {
        description: "Recorded against the fund with your name and reason. It covers this one payment.",
      });
      setBusy(false);
      await send();
    } catch (e) {
      toast.error(messageOf(e, "That could not be authorised."), { description: hintOf(e) });
      setBusy(false);
    }
  }

  return (
    <div className="space-y-2 rounded-lg border px-3 py-2.5">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">{name}</p>
          <p className="text-xs text-muted-foreground">{formatNaira(amount)}</p>
        </div>
        <Button size="sm" disabled={busy} onClick={send}>
          <Send className="size-3.5" /> {busy ? "Sending…" : "Send"}
        </Button>
      </div>

      {shortfall && (
        <div className="space-y-2 rounded-md border border-warning/40 bg-warning/8 p-3">
          <p className="text-xs text-muted-foreground">{shortfall}</p>
          <div className="space-y-1.5">
            <Label htmlFor={`why-${targetId}`} className="text-xs">
              Where is the money coming from?
            </Label>
            <textarea
              id={`why-${targetId}`}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={2}
              className="w-full rounded-md border bg-background px-3 py-2 text-sm"
              placeholder="e.g. Covered from the Ikoyi block's surplus, to be reimbursed from this quarter's collection."
            />
            <p className="text-[11px] text-muted-foreground">
              ⚠️ This spends money collected for another property. It is recorded
              against the fund with your name, appears in the audit trail, and
              covers <strong>this one payment</strong> — the next one is refused
              again.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={busy || reason.trim().length < 20}
              onClick={authoriseAndSend}
            >
              {busy ? "Working…" : "Authorise and send anyway"}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => { setShortfall(null); setReason(""); }}
            >
              Leave it
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
