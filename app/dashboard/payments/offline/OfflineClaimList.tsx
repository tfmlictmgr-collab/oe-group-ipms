"use client";

import * as React from "react";
import Link from "next/link";
import { FileText, Landmark, ArrowRight, Clock } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { formatMoney } from "@/lib/currency";
import {
  METHOD_LABEL, STATUS_LABEL, STATUS_TONE,
  type ClaimStatus, type OfflineMethod,
} from "@/lib/offline-payments";

export type QueueRow = {
  claim_id: string;
  reference: string;
  method: OfflineMethod;
  claimed_amount: number | string;
  confirmed_amount: number | string | null;
  currency: string;
  paid_on: string;
  status: ClaimStatus;
  payer_name: string | null;
  payer_note: string | null;
  payer_reference: string | null;
  recorded_by_name: string | null;
  recorded_at: string;
  bank_label: string | null;
  proof_path: string | null;
  proof_filename: string | null;
  what: string | null;
  line_count: number;
  stages_done: number;
  stages_total: number;
  current_stage: number | null;
  current_stage_label: string | null;
  is_my_turn: boolean;
  i_recorded_it: boolean;
  posted_at: string | null;
};

const fmtDate = (d: string | null) =>
  d ? new Date(d).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) : "—";

const TONE_VARIANT = {
  info: "info", success: "success", danger: "destructive", warning: "warning",
} as const;

/**
 * ⚠️ Every card carries what is being confirmed — the reference, who paid, what
 * it pays for, the amount, the date, the account it was paid into and whether
 * evidence is attached. Decision 24's finding, verbatim: the Approvals list said
 * "invoice attached" and offered no way to open it, and the board's rule is that
 * every touch point sees the detail AT THEIR DESK — and their desk is the queue.
 * Opening a row is for the proof itself and the trail, not for finding out what
 * the row even is.
 */
export default function OfflineClaimList({
  rows,
  initialView,
}: {
  rows: QueueRow[];
  initialView: "desk" | "all";
}) {
  const [view, setView] = React.useState<"desk" | "all">(initialView);

  const mine = rows.filter((r) => r.is_my_turn);
  const shown = view === "desk" && mine.length > 0 ? mine : rows;

  return (
    <div className="space-y-4">
      {mine.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant={view === "desk" ? "default" : "outline"}
            onClick={() => setView("desk")}
          >
            At my desk ({mine.length})
          </Button>
          <Button
            size="sm"
            variant={view === "all" ? "default" : "outline"}
            onClick={() => setView("all")}
          >
            All ({rows.length})
          </Button>
        </div>
      )}

      <div className="space-y-3">
        {shown.map((r) => {
          const amount = Number(r.confirmed_amount ?? r.claimed_amount);
          return (
            <Card key={r.claim_id} className={r.is_my_turn ? "border-primary/50" : undefined}>
              <CardContent className="space-y-3 p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0 space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-mono text-sm font-medium">{r.reference}</span>
                      <Badge variant={TONE_VARIANT[STATUS_TONE[r.status]]}>
                        {STATUS_LABEL[r.status]}
                      </Badge>
                      {r.is_my_turn && <Badge variant="warning">Waiting for you</Badge>}
                      {r.i_recorded_it && !r.is_my_turn && (
                        <Badge variant="muted">You recorded this</Badge>
                      )}
                    </div>
                    <p className="text-sm text-muted-foreground">
                      {r.payer_name ?? "Unknown payer"} · {r.what ?? "No breakdown"}
                      {r.line_count > 1 ? ` (${r.line_count} lines)` : ""}
                    </p>
                  </div>
                  <p className="text-lg font-semibold tabular-nums">
                    {formatMoney(amount, r.currency)}
                  </p>
                </div>

                <dl className="grid gap-x-6 gap-y-1 text-xs text-muted-foreground sm:grid-cols-2 lg:grid-cols-4">
                  <div>
                    <dt className="inline font-medium">Paid </dt>
                    <dd className="inline">{fmtDate(r.paid_on)} · {METHOD_LABEL[r.method]}</dd>
                  </div>
                  <div>
                    <dt className="inline font-medium">Into </dt>
                    <dd className="inline">{r.bank_label ?? "—"}</dd>
                  </div>
                  <div>
                    <dt className="inline font-medium">Their reference </dt>
                    <dd className="inline">{r.payer_reference ?? "—"}</dd>
                  </div>
                  <div>
                    <dt className="inline font-medium">Recorded by </dt>
                    <dd className="inline">{r.recorded_by_name ?? "—"}</dd>
                  </div>
                </dl>

                {r.payer_note && (
                  <p className="rounded-md bg-muted/50 p-2 text-xs italic text-muted-foreground">
                    “{r.payer_note}”
                  </p>
                )}

                <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
                  <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
                    <span className="flex items-center gap-1">
                      <FileText className="size-3.5" />
                      {r.proof_filename ?? "Proof attached"}
                    </span>
                    {r.posted_at ? (
                      <span className="flex items-center gap-1 text-emerald-600 dark:text-emerald-400">
                        <Landmark className="size-3.5" />
                        Posted to the ledger
                      </span>
                    ) : (
                      <span className="flex items-center gap-1">
                        <Clock className="size-3.5" />
                        {r.stages_done} of {r.stages_total}
                        {r.current_stage_label ? ` · ${r.current_stage_label}` : ""}
                      </span>
                    )}
                  </div>
                  <Button asChild size="sm" variant={r.is_my_turn ? "default" : "outline"}>
                    <Link href={`/dashboard/payments/offline/${r.claim_id}`}>
                      {r.is_my_turn ? "Review the evidence" : "Open"}
                      <ArrowRight className="size-4" />
                    </Link>
                  </Button>
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
