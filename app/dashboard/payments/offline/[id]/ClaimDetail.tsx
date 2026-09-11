"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  FileText, ExternalLink, Check, Undo2, X, Loader2, Landmark, CircleDot,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { formatMoney } from "@/lib/currency";
import { runAction, messageOf, hintOf } from "@/lib/run-action";
import { PURPOSE_LABEL, type AllocationPurpose } from "@/lib/offline-payments";
import { actionOfflineStage, signProof } from "../actions";

export type ClaimRow = {
  id: string;
  reference: string;
  claimed_amount: number | string;
  confirmed_amount: number | string | null;
  currency: string;
  paid_on: string;
  status: string;
  payer_note: string | null;
  payer_reference: string | null;
  proof_path: string;
  proof_filename: string | null;
  decision_reason: string | null;
  posted_at: string | null;
  created_at: string;
  recorded_by: string;
};

export type LineRow = {
  line_id: string;
  purpose: AllocationPurpose;
  what: string;
  period: string | null;
  due_date: string | null;
  charge_total: number | string | null;
  charge_outstanding: number | string | null;
  amount: number | string;
  property_name: string | null;
  unit_label: string | null;
  ledger_entry_id: string | null;
};

export type ChainRow = {
  stage_order: number;
  label: string;
  required_roles: string[];
  posts_ledger: boolean;
  decision: string | null;
  decided_by: string | null;
  decided_by_role: string | null;
  decided_at: string | null;
  reason: string | null;
  amount: number | string | null;
  superseded: boolean;
  is_current: boolean;
};

const fmtWhen = (d: string | null) =>
  d ? new Date(d).toLocaleString("en-GB", {
    day: "numeric", month: "short", year: "numeric",
    hour: "2-digit", minute: "2-digit", timeZone: "Africa/Lagos",
  }) : null;

export default function ClaimDetail({
  claim, lines, chain, payerName, recordedByName, bankLabel, viewerId, viewerRole,
}: {
  claim: ClaimRow;
  lines: LineRow[];
  chain: ChainRow[];
  payerName: string | null;
  recordedByName: string | null;
  bankLabel: string | null;
  viewerId: string;
  viewerRole: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = React.useState<string | null>(null);
  const [reason, setReason] = React.useState("");
  const [openingProof, setOpeningProof] = React.useState(false);

  // The stage waiting on somebody, and whether that somebody is this viewer.
  // Mirrors `offline_claim_queue`'s `is_my_turn` — the DATABASE still decides
  // (the trigger refuses either way); this only decides whether to offer buttons
  // that would be refused.
  const current = chain.find((s) => s.is_current);
  const iRecordedIt = claim.recorded_by === viewerId;
  const myTurn =
    !!current &&
    claim.status === "submitted" &&
    current.required_roles.includes(viewerRole) &&
    !iRecordedIt;

  const total = lines.reduce((t, l) => t + Number(l.amount), 0);

  async function openProof() {
    setOpeningProof(true);
    try {
      const r = await runAction(signProof(claim.proof_path));
      window.open(r.url, "_blank", "noopener");
    } catch (e) {
      toast.error(messageOf(e, "That proof could not be opened."), {
        description: hintOf(e), duration: Infinity, closeButton: true,
      });
    } finally {
      setOpeningProof(false);
    }
  }

  async function act(decision: "confirmed" | "returned" | "rejected") {
    if (!current) return;
    if (decision !== "confirmed" && reason.trim().length < 10) {
      toast.error("Say why, in at least 10 characters.", {
        description:
          "The person who reported this payment is told exactly what you write, and a refusal they cannot act on is a dead end.",
      });
      return;
    }
    setBusy(decision);
    try {
      const r = await runAction(
        actionOfflineStage({
          claimId: claim.id,
          stage: current.stage_order,
          decision,
          reason: decision === "confirmed" ? reason.trim() || null : reason.trim(),
        })
      );
      toast.success(
        r.posted
          ? "Confirmed and posted to the ledger."
          : decision === "confirmed"
            ? "Confirmed. It has moved to the next desk."
            : decision === "returned"
              ? "Sent back for correction."
              : "Recorded as not accepted."
      );
      setReason("");
      router.refresh();
    } catch (e) {
      toast.error(messageOf(e, "That could not be recorded."), {
        description: hintOf(e), duration: Infinity, closeButton: true,
      });
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_20rem]">
      <div className="space-y-6">
        {/* ── What it pays for ─────────────────────────────────────────── */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">What this payment is for</CardTitle>
          </CardHeader>
          <CardContent className="space-y-0 p-0">
            <div className="divide-y">
              {lines.map((l) => (
                <div key={l.line_id} className="flex flex-wrap items-baseline justify-between gap-2 px-6 py-3">
                  <div className="min-w-0">
                    <p className="text-sm font-medium">{l.what}</p>
                    <p className="text-xs text-muted-foreground">
                      {PURPOSE_LABEL[l.purpose]}
                      {l.period ? ` · ${l.period}` : ""}
                      {l.charge_total != null
                        ? ` · demand ${formatMoney(Number(l.charge_total), claim.currency)}`
                        : ""}
                      {l.ledger_entry_id ? " · posted" : ""}
                    </p>
                  </div>
                  <p className="tabular-nums text-sm font-medium">
                    {formatMoney(Number(l.amount), claim.currency)}
                  </p>
                </div>
              ))}
            </div>
            <Separator />
            <div className="flex items-baseline justify-between px-6 py-3">
              <p className="text-sm font-medium">Total</p>
              <p className="tabular-nums text-base font-semibold">
                {formatMoney(total, claim.currency)}
              </p>
            </div>
          </CardContent>
        </Card>

        {/* ── The evidence ─────────────────────────────────────────────── */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Proof of payment</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <span className="flex items-center gap-2 text-sm">
                <FileText className="size-4 text-muted-foreground" />
                {claim.proof_filename ?? "Attached document"}
              </span>
              <Button
                size="sm" variant="outline" onClick={openProof}
                disabled={openingProof} className="print:hidden"
              >
                {openingProof ? <Loader2 className="size-4 animate-spin" /> : <ExternalLink className="size-4" />}
                Open
              </Button>
            </div>
            {claim.payer_reference && (
              <p className="text-xs text-muted-foreground">
                Their bank reference: <span className="font-mono">{claim.payer_reference}</span>
              </p>
            )}
            {claim.payer_note && (
              <div className="rounded-md bg-muted/50 p-3">
                <p className="mb-1 text-xs font-medium text-muted-foreground">
                  What the payer said
                </p>
                <p className="whitespace-pre-wrap text-sm">{claim.payer_note}</p>
              </div>
            )}
          </CardContent>
        </Card>

        {/* ── The chain ────────────────────────────────────────────────── */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Confirmation</CardTitle>
          </CardHeader>
          <CardContent className="space-y-0 p-0">
            <ol className="divide-y">
              {chain.map((s, i) => (
                <li
                  key={`${s.stage_order}-${i}`}
                  className={`px-6 py-3 ${s.superseded ? "opacity-55" : ""}`}
                >
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
                        <span className={s.superseded ? "line-through" : ""}>
                          {s.stage_order}. {s.label}
                        </span>
                        {s.posts_ledger && (
                          <Badge variant="muted" className="gap-1">
                            <Landmark className="size-3" />
                            posts the ledger
                          </Badge>
                        )}
                        {s.is_current && <Badge variant="warning">Here now</Badge>}
                        {s.superseded && <Badge variant="muted">Superseded</Badge>}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {s.decision
                          ? `${s.decision === "confirmed" ? "Confirmed" : s.decision === "returned" ? "Sent back" : "Refused"} by ${s.decided_by ?? "—"} · ${fmtWhen(s.decided_at)}`
                          : `Waits on ${s.required_roles.join(" or ").replace(/_/g, " ")}`}
                      </p>
                      {s.reason && (
                        <p className="mt-1 rounded bg-muted/50 p-2 text-xs italic">“{s.reason}”</p>
                      )}
                    </div>
                    {s.decision === "confirmed" && !s.superseded && (
                      <Check className="size-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
                    )}
                    {s.decision === "rejected" && <X className="size-4 shrink-0 text-destructive" />}
                    {s.decision === "returned" && <Undo2 className="size-4 shrink-0 text-amber-600" />}
                    {!s.decision && <CircleDot className="size-4 shrink-0 text-muted-foreground" />}
                  </div>
                </li>
              ))}
            </ol>
          </CardContent>
        </Card>
      </div>

      {/* ── Side: the facts, and the actions ───────────────────────────── */}
      <div className="space-y-6">
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Details</CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="space-y-2 text-sm">
              <Fact k="Reference" v={<span className="font-mono">{claim.reference}</span>} />
              <Fact k="Payer" v={payerName ?? "Not a portal user"} />
              <Fact k="Recorded by" v={recordedByName ?? "—"} />
              <Fact k="Recorded" v={fmtWhen(claim.created_at) ?? "—"} />
              <Fact k="Paid into" v={bankLabel ?? "—"} />
              <Fact
                k="Amount reported"
                v={formatMoney(Number(claim.claimed_amount), claim.currency)}
              />
              {claim.confirmed_amount != null && (
                <Fact
                  k="Amount confirmed"
                  v={formatMoney(Number(claim.confirmed_amount), claim.currency)}
                />
              )}
              {claim.posted_at && (
                <Fact k="Posted to the ledger" v={fmtWhen(claim.posted_at) ?? "—"} />
              )}
            </dl>
          </CardContent>
        </Card>

        {claim.decision_reason && !claim.posted_at && (
          <Card className="border-amber-500/40 bg-amber-500/5">
            <CardContent className="p-4 text-sm">
              <p className="mb-1 font-medium">
                {claim.status === "rejected" ? "Why this was not accepted" : "What needs correcting"}
              </p>
              <p className="text-muted-foreground">{claim.decision_reason}</p>
            </CardContent>
          </Card>
        )}

        {myTurn && current && (
          <Card className="print:hidden">
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Your decision</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <p className="text-xs text-muted-foreground">
                {current.posts_ledger
                  ? "Confirming posts this payment to the ledger and applies it to the demands above. Check it against the account first."
                  : "Confirm only if the evidence matches the amount and the breakdown."}
              </p>
              <div>
                <Label htmlFor="reason" className="text-xs">
                  Note {current.posts_ledger ? "(optional)" : "(required to send back or refuse)"}
                </Label>
                <textarea
                  id="reason"
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  rows={3}
                  className="mt-1 w-full rounded-md border bg-background p-2 text-sm"
                  placeholder="What you checked, or what is wrong with it."
                />
              </div>
              <div className="flex flex-col gap-2">
                <Button onClick={() => act("confirmed")} disabled={!!busy}>
                  {busy === "confirmed" ? <Loader2 className="size-4 animate-spin" /> : <Check className="size-4" />}
                  {current.posts_ledger ? "Confirm and post to the ledger" : "Confirm"}
                </Button>
                <Button variant="outline" onClick={() => act("returned")} disabled={!!busy}>
                  {busy === "returned" ? <Loader2 className="size-4 animate-spin" /> : <Undo2 className="size-4" />}
                  Send back for correction
                </Button>
                <Button variant="outline" onClick={() => act("rejected")} disabled={!!busy}
                  className="text-destructive hover:text-destructive">
                  {busy === "rejected" ? <Loader2 className="size-4 animate-spin" /> : <X className="size-4" />}
                  Not accepted
                </Button>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Why there is no button, when there would otherwise be one. A control
            that silently vanishes is indistinguishable from a broken page. */}
        {!myTurn && current && iRecordedIt && (
          <Card className="print:hidden">
            <CardContent className="p-4 text-sm text-muted-foreground">
              You recorded this payment, so you cannot also confirm it. It needs a
              second pair of hands — that is what makes the record worth anything.
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}

function Fact({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-3">
      <dt className="text-muted-foreground">{k}</dt>
      <dd className="text-right font-medium">{v}</dd>
    </div>
  );
}
