"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { TriangleAlert, CheckCircle2 } from "lucide-react";
import { formatNaira } from "@/lib/currency";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { runAction, describeError } from "@/lib/run-action";
import { completeRemittancePosting, type StuckRemittance } from "./actions";

// Money that left but was never recorded is the worst state this system can be
// in: the bank disagrees with the books, and nothing on screen says so. This
// card exists so that state is impossible to miss, and has a way out that never
// re-sends a transfer.
export default function StuckRemittances({ rows }: { rows: StuckRemittance[] }) {
  const router = useRouter();
  const [codes, setCodes] = React.useState<Record<string, string>>({});
  const [busy, setBusy] = React.useState<string | null>(null);

  if (rows.length === 0) return null;

  async function complete(r: StuckRemittance) {
    setBusy(r.id);
    try {
      await runAction(completeRemittancePosting(r.id, codes[r.id] ?? ""));
      toast.success("Posted to the ledger", { description: r.reference });
      router.refresh();
    } catch (e) {
      toast.error("Could not post it", {
        description: describeError(e),
        duration: Infinity,
        closeButton: true,
      });
    } finally {
      setBusy(null);
    }
  }

  return (
    <Card className="border-destructive/50">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base text-destructive">
          <TriangleAlert className="size-4" />
          {rows.length} remittance{rows.length === 1 ? "" : "s"} need attention
        </CardTitle>
        <CardDescription>
          These were instructed but never confirmed in the ledger, so the bank and
          the books currently disagree. <strong>Do not re-send them.</strong> Check
          each one in the gateway first; if it went out, record its transfer
          reference here and the ledger will catch up.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {rows.map((r) => (
          <div key={r.id} className="rounded-lg border border-border p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="min-w-0">
                <p className="font-mono text-xs">{r.reference}</p>
                <p className="text-sm">
                  <span className="font-semibold tabular-nums">{formatNaira(r.net_amount)}</span>
                  <span className="text-muted-foreground"> to a {r.party}</span>
                </p>
              </div>
              <Badge variant={r.status === "unknown" ? "destructive" : "warning"}>
                {r.status === "unknown" ? "outcome unknown" : "instructed, unconfirmed"}
              </Badge>
            </div>

            <p className="mt-2 text-xs text-muted-foreground">
              {r.status === "unknown"
                ? "The gateway could not be reached while sending. It may or may not have gone — check before doing anything."
                : "The gateway accepted it but we never recorded confirmation."}
              {r.gateway_message && (
                <span className="mt-1 block font-mono text-[0.7rem]">{r.gateway_message}</span>
              )}
            </p>

            <div className="mt-3 flex flex-wrap items-end gap-2">
              <Input
                className="w-56"
                placeholder={r.transfer_code ?? "Gateway transfer reference"}
                value={codes[r.id] ?? r.transfer_code ?? ""}
                onChange={(e) => setCodes((c) => ({ ...c, [r.id]: e.target.value }))}
              />
              <Button
                size="sm"
                variant="outline"
                disabled={busy === r.id}
                onClick={() => complete(r)}
              >
                <CheckCircle2 className="size-4" />
                {busy === r.id ? "Posting…" : "It went out — post it"}
              </Button>
            </div>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
