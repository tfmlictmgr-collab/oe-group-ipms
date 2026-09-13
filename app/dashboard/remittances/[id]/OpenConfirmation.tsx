"use client";

import * as React from "react";
import { toast } from "sonner";
import { FileText } from "lucide-react";
import { Button } from "@/components/ui/button";
import { openTransferConfirmation } from "@/lib/payout-actions";

/** Opens the bank's confirmation — a five-minute link, signed under the
 *  viewer's own session so the storage policy decides who may read it. */
export default function OpenConfirmation({ remittanceId }: { remittanceId: string }) {
  const [busy, setBusy] = React.useState(false);
  return (
    <Button
      size="sm"
      variant="outline"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        try {
          const r = await openTransferConfirmation(remittanceId);
          if (!r.ok) toast.error(r.message, { description: r.hint });
          else window.open(r.data.url, "_blank", "noopener");
        } finally {
          setBusy(false);
        }
      }}
    >
      <FileText className="size-3.5" /> {busy ? "Opening…" : "Open the bank's confirmation"}
    </Button>
  );
}
