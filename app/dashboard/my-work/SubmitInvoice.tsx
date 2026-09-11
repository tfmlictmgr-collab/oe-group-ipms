"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import Link from "next/link";
import { Receipt, Loader2, Paperclip, X, TriangleAlert } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatNaira } from "@/lib/currency";
import { runAction, messageOf, hintOf } from "@/lib/run-action";
import { submitVendorInvoice } from "../tickets/[id]/vendor-actions";

export type InvoiceableJob = {
  id: string;
  label: string;
  /** Whether this vendor has attached their own photo/video of the finished work. */
  hasEvidence: boolean;
};

const BUCKET = "invoice-attachments";
const ACCEPTED = ["image/jpeg", "image/png", "image/webp", "image/heic", "application/pdf"];
const MAX_BYTES = 2 * 1024 * 1024; // 2 MB

const prettySize = (bytes: number) =>
  bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;

/**
 * A contractor raising their own invoice.
 *
 * Until now they could SEE their payments and never create one:
 * `payments_insert` admits admin/FM/regional_manager only. The amount is a
 * claim — service verification and the performance check are what turn it
 * into money, and both belong to somebody else, so this enters the B4 gate at
 * its first stage and no further.
 */
export default function SubmitInvoice({ jobs, orgId }: { jobs: InvoiceableJob[]; orgId: string }) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [reference, setReference] = React.useState("");
  const [amount, setAmount] = React.useState("");
  const [ticketId, setTicketId] = React.useState("");
  const [file, setFile] = React.useState<File | null>(null);
  const selected = jobs.find((j) => j.id === ticketId) ?? null;
  const fileRef = React.useRef<HTMLInputElement>(null);

  function pickFile(f: File | undefined) {
    if (!f) return;
    if (!ACCEPTED.includes(f.type)) {
      toast.error("Unsupported file type", {
        description: "Attach a photo (JPEG, PNG, WebP, HEIC) or a PDF of the signed invoice.",
      });
      return;
    }
    if (f.size > MAX_BYTES) {
      toast.error("File too large", {
        description: `The invoice scan must be under 2 MB — this one is ${prettySize(f.size)}.`,
      });
      return;
    }
    setFile(f);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      // Uploaded first, straight from the browser — routing a 2 MB file
      // through the server action would buy nothing (same reasoning
      // TicketMedia already follows for work-order evidence). The path is
      // only recorded against real money once submitVendorInvoice's own
      // checks pass; a refusal there removes this object again.
      let attachmentPath: string | null = null;
      if (file) {
        const supabase = createClient();
        const ext = file.name.split(".").pop()?.toLowerCase() || "bin";
        attachmentPath = `${orgId}/${crypto.randomUUID()}.${ext}`;
        const { error: upErr } = await supabase.storage
          .from(BUCKET)
          .upload(attachmentPath, file, { contentType: file.type });
        if (upErr) throw new Error(`Could not upload the invoice scan: ${upErr.message}`);
      }

      await runAction(
        submitVendorInvoice({
          amount: Number(amount),
          invoiceReference: reference,
          ticketId: ticketId || null,
          attachmentPath,
        })
      );
      toast.success("Invoice submitted", {
        description: "It now waits on the team to verify the work.",
      });
      setOpen(false);
      setReference(""); setAmount(""); setTicketId(""); setFile(null);
      router.refresh();
    } catch (err) {
      toast.error(messageOf(err, "That invoice could not be submitted."), {
        description: hintOf(err), duration: Infinity, closeButton: true,
      });
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <Button variant="outline" onClick={() => setOpen(true)}>
        <Receipt /> Submit an invoice
      </Button>
    );
  }

  return (
    <form onSubmit={submit} className="space-y-4 rounded-lg border border-border bg-card p-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="inv-ref">Your invoice reference</Label>
          <Input
            id="inv-ref" value={reference} onChange={(e) => setReference(e.target.value)}
            placeholder="e.g. INV-2026-014" required minLength={3}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="inv-amt">Amount (₦)</Label>
          <Input
            id="inv-amt" type="number" min="1" step="0.01" value={amount}
            onChange={(e) => setAmount(e.target.value)} placeholder="180000" required
          />
        </div>
      </div>

      <div className="space-y-2">
        <Label htmlFor="inv-job">For which job?</Label>
        <select
          id="inv-job" value={ticketId} onChange={(e) => setTicketId(e.target.value)}
          className="h-10 w-full rounded-md border border-input bg-card px-3 text-sm"
        >
          {/* Only completed jobs are offered — the function refuses an
              unfinished one, and offering it here would be a form that exists
              to be rejected. */}
          <option value="">Not for a specific job</option>
          {jobs.map((j) => (
            <option key={j.id} value={j.id}>
              {j.hasEvidence ? j.label : `${j.label} — needs a photo`}
            </option>
          ))}
        </select>
        {jobs.length === 0 && (
          <p className="text-xs text-muted-foreground">
            You have no completed jobs waiting to be invoiced. You can still invoice for
            something else — a retainer or a scheduled service.
          </p>
        )}
        {/* A prompt, not a gate (0162). Nothing here refuses the invoice —
            it points out that the job has no photo yet, which is the thing the
            verifier will ask for next. */}
        {selected && !selected.hasEvidence && (
          <p className="flex items-start gap-2 rounded-lg border border-border bg-muted/40 px-3 py-2 text-xs">
            <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
            <span className="text-muted-foreground">
              This job has no photo or video attached yet. Adding one helps
              whoever verifies the work approve it faster.{" "}
              <Link href={`/dashboard/tickets/${selected.id}`} className="underline underline-offset-2">
                Open the job
              </Link>
            </span>
          </p>
        )}
      </div>

      <div className="space-y-2">
        <Label htmlFor="inv-file">
          Signed paper invoice{" "}
          <span className="font-normal text-muted-foreground">(optional)</span>
        </Label>
        <input
          ref={fileRef}
          id="inv-file"
          type="file"
          accept={ACCEPTED.join(",")}
          className="sr-only"
          onChange={(e) => {
            pickFile(e.target.files?.[0]);
            e.target.value = "";
          }}
        />
        {file ? (
          <div className="flex items-center gap-2 rounded-md border border-border bg-muted/40 px-3 py-2 text-sm">
            <Paperclip className="size-4 flex-shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate">{file.name}</span>
            <span className="flex-shrink-0 text-xs text-muted-foreground">{prettySize(file.size)}</span>
            <button
              type="button"
              onClick={() => setFile(null)}
              aria-label="Remove attachment"
              className="flex-shrink-0 text-muted-foreground hover:text-destructive"
            >
              <X className="size-4" />
            </button>
          </div>
        ) : (
          <Button type="button" variant="outline" size="sm" onClick={() => fileRef.current?.click()}>
            <Paperclip /> Attach a photo or PDF
          </Button>
        )}
        <p className="text-xs text-muted-foreground">
          A photo or scan of the signed paper invoice, if you have one. Up to 2 MB.
        </p>
      </div>

      {Number(amount) > 0 && (
        <p className="text-sm text-muted-foreground">
          Submitting <strong className="text-foreground">{formatNaira(Number(amount))}</strong>{" "}
          — this enters verification, it is not a payment yet.
        </p>
      )}

      <div className="flex gap-2">
        <Button type="submit" variant="brand" disabled={busy}>
          {busy ? <Loader2 className="animate-spin" /> : <Receipt />}
          {busy ? "Submitting…" : "Submit invoice"}
        </Button>
        <Button type="button" variant="ghost" onClick={() => setOpen(false)} disabled={busy}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
