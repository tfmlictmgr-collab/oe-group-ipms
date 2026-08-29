"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent } from "@/components/ui/card";
import { shortRef } from "@/lib/acknowledgement";
import { Paperclip, X } from "lucide-react";

/**
 * ⚠️ Kept in step with the VENDOR-side form (`my-work/SubmitInvoice.tsx`) and
 * with `0140`'s bucket, which is where these limits actually bind. That form has
 * had an upload since it was written; this one — the staff-side twin, used when
 * somebody files a paper invoice on a contractor's behalf — never did. So an
 * invoice raised here reached the approval chain with nothing attached, and the
 * auditor whose stage is a check AGAINST the evidence had none to check.
 */
const BUCKET = "invoice-attachments";
const MAX_BYTES = 5 * 1024 * 1024;
const ACCEPTED = ["application/pdf", "image/jpeg", "image/png", "image/webp"];
const ACCEPTED_LABEL = "PDF, JPG, PNG or WebP";

export default function SubmitInvoiceForm({
  orgId,
  vendors,
  jobs,
}: {
  orgId: string;
  vendors: { id: string; name: string }[];
  jobs: { id: string; summary: string | null; assigned_vendor_id: string }[];
}) {
  const router = useRouter();
  const [vendorId, setVendorId] = useState(vendors[0]?.id ?? "");
  const [ticketId, setTicketId] = useState("");
  const [amount, setAmount] = useState("");
  const [invoiceRef, setInvoiceRef] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // Only this vendor's finished jobs. `payments_work_order_valid` refuses a
  // mismatch anyway; narrowing here means the user never composes one.
  const theirJobs = jobs.filter((j) => j.assigned_vendor_id === vendorId);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);

    const supabase = createClient();

    // The bytes go up FIRST. Indexing a path the storage layer refused would
    // tell the chain an invoice is attached and hand them a 404 when they open
    // it — the same "readable by nobody" state 0217 existed to fix, reached by
    // writing the row before the file.
    let attachmentPath: string | null = null;
    if (file) {
      const ext = (file.name.split(".").pop() || "bin").toLowerCase();
      attachmentPath = `${orgId}/${crypto.randomUUID()}.${ext}`;
      const { error: upErr } = await supabase.storage
        .from(BUCKET)
        .upload(attachmentPath, file, { contentType: file.type || undefined });
      if (upErr) {
        toast.error("Could not upload the invoice", { description: upErr.message });
        setLoading(false);
        return;
      }
    }

    const { error } = await supabase.from("payments").insert({
      org_id: orgId,
      vendor_id: vendorId,
      invoice_reference: invoiceRef || null,
      invoice_attachment_path: attachmentPath,
      // The work this invoice is for. Optional, because paper invoices for
      // work predating the link are real — but the payments screen lists what
      // is missing rather than letting it go unnoticed.
      ticket_id: ticketId || null,
      amount: Number(amount),
      status: "pending_verification",
      performance_validated: false,
    });

    if (error) {
      toast.error("Could not submit invoice", { description: error.message });
      setLoading(false);
      return;
    }

    toast.success("Invoice submitted", {
      description: "It now awaits service verification.",
    });
    router.push("/dashboard/payments");
    router.refresh();
  }

  return (
    <Card>
      <CardContent className="pt-5">
        <form onSubmit={handleSubmit} className="space-y-5">
          <div className="space-y-1.5">
            <Label htmlFor="vendor">Vendor</Label>
            <Select
              id="vendor"
              value={vendorId}
              onChange={(e) => {
                setVendorId(e.target.value);
                // The selected job belonged to the previous vendor. Clearing it
                // is the only correct move -- carrying it over would compose
                // exactly the mismatch the trigger exists to refuse.
                setTicketId("");
              }}
              required
            >
              {vendors.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.name}
                </option>
              ))}
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="job">
              Work order{" "}
              <span className="font-normal text-muted-foreground">
                (optional, but recommended)
              </span>
            </Label>
            <Select
              id="job"
              value={ticketId}
              onChange={(e) => setTicketId(e.target.value)}
            >
              <option value="">Not linked to a job</option>
              {theirJobs.map((j) => (
                <option key={j.id} value={j.id}>
                  {shortRef(j.id)} — {j.summary ?? "no summary"}
                </option>
              ))}
            </Select>
            <p className="text-xs text-muted-foreground">
              {theirJobs.length === 0
                ? "This vendor has no completed jobs on record yet."
                : "Naming the job is what lets service verification check against something."}
            </p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="ref">Invoice reference</Label>
            <Input
              id="ref"
              type="text"
              value={invoiceRef}
              onChange={(e) => setInvoiceRef(e.target.value)}
              placeholder="e.g. INV-2026-0042"
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="amount">Amount (₦)</Label>
            <Input
              id="amount"
              type="number"
              min={0}
              step="0.01"
              required
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="450000"
            />
            <p className="text-xs text-muted-foreground">
              No funds move on submission — this enters the gate at service verification.
            </p>
          </div>

          {/* The evidence the chain is asked to check against. Optional here —
              a paper invoice filed on a contractor's behalf may genuinely have
              no scan yet — but the auditor's whole stage is a comparison, so
              the form says what it is for rather than offering a bare button. */}
          <div className="space-y-1.5">
            <Label htmlFor="invoice-file">
              Invoice or receipt{" "}
              <span className="font-normal text-muted-foreground">(optional)</span>
            </Label>
            {file ? (
              <div className="flex items-center justify-between gap-3 rounded-md border border-border px-3 py-2">
                <span className="flex min-w-0 items-center gap-1.5 text-sm">
                  <Paperclip className="size-3.5 shrink-0 text-muted-foreground" />
                  <span className="truncate">{file.name}</span>
                </span>
                <button
                  type="button"
                  aria-label="Remove the attachment"
                  onClick={() => { setFile(null); setFileError(null); }}
                  className="shrink-0 rounded-md p-1 hover:bg-accent"
                >
                  <X className="size-3.5" />
                </button>
              </div>
            ) : (
              <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-md border border-input px-3 py-2 text-sm hover:bg-accent">
                <Paperclip className="size-3.5" /> Attach the invoice
                <input
                  id="invoice-file"
                  type="file"
                  className="sr-only"
                  accept={`${ACCEPTED.join(",")},.pdf,.jpg,.jpeg,.png,.webp`}
                  onChange={(e) => {
                    const f = e.target.files?.[0] ?? null;
                    e.target.value = "";
                    if (!f) return;
                    // Said before a byte is sent, and said specifically — the
                    // lesson from the vendor KYC uploads, applied here.
                    const ext = (f.name.split(".").pop() ?? "").toLowerCase();
                    const typeOk = f.type
                      ? ACCEPTED.includes(f.type)
                      : ["pdf", "jpg", "jpeg", "png", "webp"].includes(ext);
                    if (!typeOk) {
                      setFileError(`That is a ${ext ? `.${ext}` : "n unrecognised"} file. Attach ${ACCEPTED_LABEL}.`);
                      return;
                    }
                    if (f.size > MAX_BYTES) {
                      setFileError(`That file is ${(f.size / 1024 / 1024).toFixed(1)} MB. The limit is 5 MB.`);
                      return;
                    }
                    setFileError(null);
                    setFile(f);
                  }}
                />
              </label>
            )}
            <p className="text-xs text-muted-foreground">
              {ACCEPTED_LABEL}, up to 5 MB. Everyone in the approval chain can
              open it — the audit review is a check against this.
            </p>
            {fileError && <p className="text-xs text-destructive">{fileError}</p>}
          </div>

          <div className="flex flex-col-reverse gap-2 pt-1 sm:flex-row sm:justify-end">
            <Button
              type="button"
              variant="ghost"
              onClick={() => router.push("/dashboard/payments")}
            >
              Cancel
            </Button>
            <Button type="submit" variant="brand" disabled={loading || !vendorId}>
              {loading ? "Submitting…" : "Submit Invoice"}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
