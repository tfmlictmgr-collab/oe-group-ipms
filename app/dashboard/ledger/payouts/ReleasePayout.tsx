"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { runAction, messageOf, hintOf } from "@/lib/run-action";
import { sendApprovedPayout } from "./actions";

/**
 * Releasing a landlord payout that has cleared the chain.
 *
 * ⚠️ This is the fourth step, and it is not an approval. `PayoutRun` raises the
 * payout (claiming the collected rent), the three chain stages authorise it, and
 * this sends it — held by finance alone, which is why an executive who may see
 * this list gets no button. Both the visibility rule here and the button are
 * courtesies: `claim_remittance_for_sending` re-checks finance authority, chain
 * completion at the current net amount, and that the sender actioned no stage of
 * it, and refuses regardless of what this component renders.
 */
export default function ReleasePayout({
  remittanceId,
  landlordName,
  disabled,
}: {
  remittanceId: string;
  landlordName: string;
  disabled?: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = React.useState(false);

  async function send() {
    setBusy(true);
    try {
      const r = await runAction(sendApprovedPayout(remittanceId));
      if (r.status === "sent") {
        toast.success(`Sent to ${landlordName}.`, {
          description: `Reference ${r.reference}.`,
        });
      } else {
        // A pending transfer is not a success and must not read like one. The
        // webhook settles it; claiming it landed would invite a re-send, and a
        // re-sent payout is money that has left twice.
        toast.message("The transfer is pending at the gateway.", {
          description: `Reference ${r.reference}. It will settle on its own — do not send again.`,
          duration: Infinity,
          closeButton: true,
        });
      }
      router.refresh();
    } catch (e) {
      toast.error(messageOf(e, "That payout could not be sent."), {
        description: hintOf(e),
        duration: Infinity,
        closeButton: true,
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Button size="sm" disabled={busy || disabled} onClick={send}>
      <Send className="size-3.5" /> {busy ? "Sending…" : "Send"}
    </Button>
  );
}
