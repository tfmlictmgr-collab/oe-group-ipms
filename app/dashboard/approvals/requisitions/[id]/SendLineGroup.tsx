"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { formatNaira } from "@/lib/approvals/chain";
import { runAction, messageOf, hintOf } from "@/lib/run-action";
import { sendRequisitionVendorLines, sendRequisitionPayeeLines } from "@/app/dashboard/requisitions/send-actions";

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
      toast.error(messageOf(e, "That could not be sent."), { description: hintOf(e) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2.5">
      <div className="min-w-0">
        <p className="truncate text-sm font-medium">{name}</p>
        <p className="text-xs text-muted-foreground">{formatNaira(amount)}</p>
      </div>
      <Button size="sm" disabled={busy} onClick={send}>
        <Send className="size-3.5" /> {busy ? "Sending…" : "Send"}
      </Button>
    </div>
  );
}
