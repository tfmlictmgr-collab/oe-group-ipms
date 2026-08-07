"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Receipt, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatNaira } from "@/lib/currency";
import { runAction, messageOf, hintOf } from "@/lib/run-action";
import { submitVendorInvoice } from "../tickets/[id]/vendor-actions";

export type InvoiceableJob = {
  id: string;
  label: string;
};

/**
 * A contractor raising their own invoice.
 *
 * Until now they could SEE their payments and never create one:
 * `payments_insert` admits admin/FM/regional_manager only. The amount is a
 * claim — service verification and the performance check are what turn it
 * into money, and both belong to somebody else, so this enters the B4 gate at
 * its first stage and no further.
 */
export default function SubmitInvoice({ jobs }: { jobs: InvoiceableJob[] }) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [reference, setReference] = React.useState("");
  const [amount, setAmount] = React.useState("");
  const [ticketId, setTicketId] = React.useState("");

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await runAction(
        submitVendorInvoice({
          amount: Number(amount),
          invoiceReference: reference,
          ticketId: ticketId || null,
        })
      );
      toast.success("Invoice submitted", {
        description: "It now waits on the team to verify the work.",
      });
      setOpen(false);
      setReference(""); setAmount(""); setTicketId("");
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
            <option key={j.id} value={j.id}>{j.label}</option>
          ))}
        </select>
        {jobs.length === 0 && (
          <p className="text-xs text-muted-foreground">
            You have no completed jobs waiting to be invoiced. You can still invoice for
            something else — a retainer or a scheduled service.
          </p>
        )}
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
