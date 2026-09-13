"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Landmark, FileText, Paperclip, Loader2, TriangleAlert, ShieldCheck } from "lucide-react";
import {
  AlertDialog, AlertDialogContent, AlertDialogHeader, AlertDialogTitle, AlertDialogDescription,
  AlertDialogFooter, AlertDialogCancel,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatMoney } from "@/lib/currency";
import { createClient } from "@/lib/supabase/client";
import {
  PAYOUT_BUCKET, PAYOUT_EVIDENCE_RULES, payoutEvidenceProblem, payoutEvidenceType, safeFileName,
} from "@/lib/payout-evidence-rules";
import {
  bankTransferTarget, payByBankTransfer, openPayoutEvidence,
  type BankTransferPayable, type BankTransferTarget,
} from "@/lib/payout-actions";
import { authoriseShortFund } from "@/app/dashboard/requisitions/send-actions";

function todayInLagos(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Lagos" }).format(new Date());
}

/**
 * Recording a payment made by hand from the organisation's bank (0289).
 *
 * The order on the form is the order of the job: who is being paid and where
 * (with their document, to read the account number off), then what the bank
 * said when the transfer went, then the bank's confirmation. The database
 * checks all of it again — the approval chain, that the sender approved no
 * stage, and that whoever confirmed the payee's account is not the one paying
 * it — and records nothing unless every part holds.
 */
export default function RecordBankTransfer({
  payableType,
  payableId,
  targetId,
  orgId,
  payeeName,
  label = "Record a bank transfer",
  size = "sm",
  variant = "outline",
  path,
}: {
  payableType: BankTransferPayable;
  payableId: string;
  targetId?: string;
  orgId: string;
  payeeName: string;
  label?: string;
  size?: "sm" | "default";
  variant?: "outline" | "brand" | "ghost";
  path: string;
}) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [target, setTarget] = React.useState<BankTransferTarget | null>(null);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [transferredOn, setTransferredOn] = React.useState(todayInLagos());
  const [bankReference, setBankReference] = React.useState("");
  const [note, setNote] = React.useState("");
  const [file, setFile] = React.useState<File | null>(null);
  const [fileProblem, setFileProblem] = React.useState<string | null>(null);
  const [acknowledged, setAcknowledged] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [shortfall, setShortfall] = React.useState<string | null>(null);
  const [overrideReason, setOverrideReason] = React.useState("");

  React.useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setTarget(null);
    setLoadError(null);
    void bankTransferTarget({ payableType, payableId, targetId: targetId ?? null }).then((r) => {
      if (cancelled) return;
      if (r.ok) setTarget(r.data);
      else setLoadError(r.message);
    });
    return () => { cancelled = true; };
  }, [open, payableType, payableId, targetId]);

  const account = target?.account ?? null;
  const usable = Boolean(account?.verified) && !target?.confirmedByMe;
  const ready =
    usable && Boolean(file) && !fileProblem && bankReference.trim().length >= 4 &&
    Boolean(transferredOn) && (target?.nameMatches || acknowledged);

  async function openDocument() {
    if (!account) return;
    const r = await openPayoutEvidence(account.id);
    if (!r.ok) toast.error(r.message, { description: r.hint });
    else window.open(r.data.url, "_blank", "noopener");
  }

  async function record() {
    if (!file || !ready) return;
    setBusy(true);
    try {
      // Into this payment's own folder — the database refuses a confirmation
      // filed anywhere else. `upsert: false` because the bucket has no update
      // policy, and an upsert against it fails with a misleading error (0281).
      const proofPath = `${orgId}/transfers/${payableId}/${crypto.randomUUID()}-${safeFileName(file.name)}`;
      const supabase = createClient();
      const { error: upErr } = await supabase.storage
        .from(PAYOUT_BUCKET)
        .upload(proofPath, file, { contentType: payoutEvidenceType(file), upsert: false });
      if (upErr) {
        toast.error("The confirmation did not upload.", { description: "Check your connection and try again. Nothing has been recorded." });
        return;
      }

      const r = await payByBankTransfer({
        payableType, payableId, targetId: targetId ?? null,
        transferredOn, bankReference, proofPath, proofFilename: file.name,
        note: note || null, acknowledgedNameDifference: acknowledged, path,
      });
      if (!r.ok) {
        if (/fund cannot cover this|would be left short by/i.test(r.message) && payableType !== "landlord_payout") {
          setShortfall(r.message);
        } else {
          toast.error(r.message, { description: r.hint, duration: Infinity, closeButton: true });
        }
        return;
      }
      toast.success(`Recorded — ${formatMoney(target!.amount, target!.currency)} to ${target!.payeeName}.`, {
        description: r.data.told.length ? `They have been told, by ${r.data.told.join(" and ")}.` : "It is on the ledger. They could not be messaged automatically.",
      });
      setOpen(false);
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  async function authoriseAndRecord() {
    setBusy(true);
    try {
      const r = await authoriseShortFund(
        payableType === "vendor_payment" ? "vendor_payment" : "ops_requisition",
        payableId,
        overrideReason
      );
      if (!r.ok) {
        toast.error(r.message, { description: r.hint });
        return;
      }
      setShortfall(null);
      setOverrideReason("");
    } finally {
      setBusy(false);
    }
    await record();
  }

  return (
    <>
      <Button size={size} variant={variant} onClick={() => setOpen(true)}>
        <Landmark className="size-3.5" /> {label}
      </Button>

      <AlertDialog open={open} onOpenChange={(o) => !busy && setOpen(o)}>
        <AlertDialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-lg">
          <AlertDialogHeader>
            <AlertDialogTitle>Record a bank transfer</AlertDialogTitle>
            <AlertDialogDescription>
              For a payment you have made by hand from the organisation&apos;s bank. {payeeName} is
              told once it is recorded.
            </AlertDialogDescription>
          </AlertDialogHeader>

          {loadError && <p className="text-sm text-destructive">{loadError}</p>}
          {!target && !loadError && (
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" /> Loading…
            </p>
          )}

          {target && (
            <div className="space-y-4 text-sm">
              <div className="flex items-baseline justify-between gap-3 rounded-md bg-muted/50 px-3 py-2">
                <span className="text-muted-foreground">Amount</span>
                <span className="text-lg font-semibold tabular-nums">{formatMoney(target.amount, target.currency)}</span>
              </div>

              {/* ── Where it goes ─────────────────────────────────────────── */}
              {!account ? (
                <div className="rounded-md border border-warning/40 bg-warning/8 p-3">
                  <p className="font-medium">{target.payeeName} has no bank-transfer account yet.</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Ask them for their bank details first — they get a secure link and send a document
                    showing their account.
                  </p>
                  <Button asChild size="sm" variant="outline" className="mt-2">
                    <Link href={target.setupHref}>Set it up</Link>
                  </Button>
                </div>
              ) : (
                <div className="space-y-2 rounded-md border border-border p-3">
                  <p className="text-xs uppercase tracking-wide text-muted-foreground">Pay into</p>
                  <p className="text-base font-semibold">{account.accountName}</p>
                  <p className="text-muted-foreground">{account.bankName} · account ending {account.last4}</p>
                  <Button size="sm" variant="outline" onClick={openDocument}>
                    <FileText className="size-3.5" /> Open their document for the full number
                  </Button>

                  {!account.verified && (
                    <p className="flex items-start gap-1.5 text-xs text-warning">
                      <TriangleAlert className="mt-0.5 size-3.5 flex-shrink-0" />
                      Nobody has checked this document yet. It has to be confirmed before it can be paid.
                    </p>
                  )}
                  {target.confirmedByMe && (
                    <p className="flex items-start gap-1.5 text-xs text-warning">
                      <TriangleAlert className="mt-0.5 size-3.5 flex-shrink-0" />
                      You confirmed this account yourself, so someone else must make and record this
                      transfer.
                    </p>
                  )}
                  {usable && !target.nameMatches && (
                    <label className="flex items-start gap-2 rounded-md bg-warning/10 p-2 text-xs">
                      <input
                        type="checkbox"
                        className="mt-0.5 size-4"
                        checked={acknowledged}
                        onChange={(e) => setAcknowledged(e.target.checked)}
                      />
                      <span>
                        The account name does not look like <strong>{target.payeeName}</strong>. I have
                        opened their document and checked this is their account.
                      </span>
                    </label>
                  )}
                </div>
              )}

              {target.paidFrom && (
                <p className="text-xs text-muted-foreground">
                  Paid from {target.paidFrom.label}
                  {target.paidFrom.bankName ? ` · ${target.paidFrom.bankName}` : ""}
                  {target.paidFrom.last4 ? ` · ending ${target.paidFrom.last4}` : ""} — the organisation&apos;s
                  client-funds account, the only one a payout may leave.
                </p>
              )}

              {/* ── What the bank said ────────────────────────────────────── */}
              {usable && (
                <>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <div className="space-y-1.5">
                      <Label htmlFor={`bt-date-${payableId}`}>Date you made the transfer</Label>
                      <Input
                        id={`bt-date-${payableId}`}
                        type="date"
                        max={todayInLagos()}
                        value={transferredOn}
                        onChange={(e) => setTransferredOn(e.target.value)}
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor={`bt-ref-${payableId}`}>Transfer reference</Label>
                      <Input
                        id={`bt-ref-${payableId}`}
                        value={bankReference}
                        onChange={(e) => setBankReference(e.target.value)}
                        placeholder="Session ID or reference"
                      />
                    </div>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    The reference your bank showed when the transfer went — {target.payeeName} can quote it to
                    their own bank if the money has not arrived.
                  </p>

                  <div className="space-y-1.5">
                    <Label htmlFor={`bt-file-${payableId}`}>Your bank&apos;s confirmation</Label>
                    <p className="text-xs text-muted-foreground">
                      A screenshot or PDF of the transfer receipt. {PAYOUT_EVIDENCE_RULES}
                    </p>
                    <label
                      htmlFor={`bt-file-${payableId}`}
                      className="flex cursor-pointer items-center gap-2 rounded-md border border-dashed border-border px-3 py-2.5 hover:bg-muted/40"
                    >
                      <Paperclip className="size-4 text-muted-foreground" />
                      <span className="truncate">{file ? file.name : "Choose the confirmation"}</span>
                    </label>
                    <input
                      id={`bt-file-${payableId}`}
                      type="file"
                      accept="application/pdf,image/*"
                      className="sr-only"
                      onChange={(e) => {
                        const f = e.target.files?.[0] ?? null;
                        setFile(f);
                        setFileProblem(f ? payoutEvidenceProblem({ size: f.size, type: f.type, name: f.name }) : null);
                      }}
                    />
                    {fileProblem && <p className="text-xs text-destructive">{fileProblem}</p>}
                  </div>

                  <div className="space-y-1.5">
                    <Label htmlFor={`bt-note-${payableId}`}>
                      Note <span className="font-normal text-muted-foreground">(optional)</span>
                    </Label>
                    <textarea
                      id={`bt-note-${payableId}`}
                      value={note}
                      onChange={(e) => setNote(e.target.value)}
                      rows={2}
                      maxLength={500}
                      className="w-full rounded-md border bg-background px-3 py-2 text-sm"
                      placeholder="Anything whoever reads this later should know"
                    />
                  </div>
                </>
              )}

              {shortfall && (
                <div className="space-y-2 rounded-md border border-warning/40 bg-warning/8 p-3">
                  <p className="text-xs text-muted-foreground">{shortfall}</p>
                  <Label htmlFor={`bt-why-${payableId}`} className="text-xs">Where is the money coming from?</Label>
                  <textarea
                    id={`bt-why-${payableId}`}
                    value={overrideReason}
                    onChange={(e) => setOverrideReason(e.target.value)}
                    rows={2}
                    className="w-full rounded-md border bg-background px-3 py-2 text-sm"
                    placeholder="e.g. Covered from the Ikoyi block's surplus, to be reimbursed from this quarter's collection."
                  />
                  <p className="text-[11px] text-muted-foreground">
                    This spends money collected for another property. It is recorded against the fund with
                    your name and covers this one payment only.
                  </p>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy || overrideReason.trim().length < 20}
                    onClick={authoriseAndRecord}
                  >
                    Authorise and record anyway
                  </Button>
                </div>
              )}
            </div>
          )}

          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
            <Button variant="brand" disabled={!ready || busy} onClick={record}>
              {busy ? <Loader2 className="size-4 animate-spin" /> : <ShieldCheck className="size-4" />}
              {busy ? "Recording…" : "Record the transfer"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
