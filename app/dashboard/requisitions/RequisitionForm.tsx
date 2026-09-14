"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Plus, X, Loader2, ReceiptText, Paperclip } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { messageOf, hintOf } from "@/lib/run-action";
import { formatNaira } from "@/lib/currency";
import { raiseRequisition } from "./actions";

const BUCKET = "invoice-attachments";
const ACCEPTED = ["image/jpeg", "image/png", "image/webp", "image/heic", "application/pdf"];
const MAX_BYTES = 2 * 1024 * 1024;

type Line = { description: string; amount: string; vendorId: string };
const emptyLine = (): Line => ({ description: "", amount: "", vendorId: "" });

/**
 * Raising an FM/PM ops requisition.
 *
 * One submission creates the requisition and every line together
 * (`raise_ops_requisition`, 0170) — a line with no vendor is legitimate and is
 * where the "add a payee's bank details" step happens next, on the
 * requisition's own page, because that needs a real line id to attach to.
 */
export default function RequisitionForm({
  vendors,
  ticketId,
  ticketLabel,
  orgId,
}: {
  vendors: { id: string; name: string }[];
  ticketId?: string | null;
  ticketLabel?: string | null;
  orgId: string;
}) {
  const router = useRouter();
  const [reference, setReference] = React.useState("");
  const [description, setDescription] = React.useState("");
  const [lines, setLines] = React.useState<Line[]>([emptyLine()]);
  const [file, setFile] = React.useState<File | null>(null);
  const [busy, setBusy] = React.useState(false);
  const fileRef = React.useRef<HTMLInputElement>(null);

  const total = lines.reduce((a, l) => a + (Number(l.amount) || 0), 0);

  function setLine(i: number, patch: Partial<Line>) {
    setLines((ls) => ls.map((l, idx) => (idx === i ? { ...l, ...patch } : l)));
  }
  function addLine() {
    setLines((ls) => [...ls, emptyLine()]);
  }
  function removeLine(i: number) {
    setLines((ls) => (ls.length > 1 ? ls.filter((_, idx) => idx !== i) : ls));
  }

  function pickFile(f: File | undefined) {
    if (!f) return;
    if (!ACCEPTED.includes(f.type)) {
      toast.error("Unsupported file type", {
        description: "Attach a photo (JPEG, PNG, WebP, HEIC) or a PDF.",
      });
      return;
    }
    if (f.size > MAX_BYTES) {
      toast.error("File too large", { description: "Documents must be under 2 MB." });
      return;
    }
    setFile(f);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (reference.trim().length < 3) {
      toast.error("Give the requisition a reference of your own.");
      return;
    }
    const bad = lines.findIndex(
      (l) => l.description.trim().length < 3 || !(Number(l.amount) > 0)
    );
    if (bad !== -1) {
      toast.error(`Line ${bad + 1} needs a description and a positive amount.`);
      return;
    }

    setBusy(true);
    try {
      let attachmentPath: string | null = null;
      if (file) {
        const supabase = createClient();
        const ext = file.name.split(".").pop() || "bin";
        const path = `${orgId}/${crypto.randomUUID()}.${ext}`;
        const { error: upErr } = await supabase.storage.from(BUCKET).upload(path, file, {
          contentType: file.type,
        });
        if (upErr) {
          toast.error("Could not attach the document", { description: upErr.message });
          setBusy(false);
          return;
        }
        attachmentPath = path;
      }

      const res = await raiseRequisition({
        reference: reference.trim(),
        description: description.trim(),
        ticketId: ticketId || null,
        attachmentPath,
        lines: lines.map((l) => ({
          description: l.description.trim(),
          amount: Number(l.amount),
          vendorId: l.vendorId || null,
        })),
      });
      if (!res.ok) {
        toast.error(res.message, { description: res.hint ?? undefined });
        setBusy(false);
        return;
      }

      toast.success("Requisition raised.", {
        description: "It now needs sign-off before anything can be paid.",
      });
      router.push(`/dashboard/approvals/requisitions/${res.data.id}`);
    } catch (e) {
      toast.error(messageOf(e, "That requisition could not be raised."), {
        description: hintOf(e),
      });
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-6">
      {ticketLabel && (
        <p className="flex items-center gap-2 rounded-lg border border-info/40 bg-info/8 px-3 py-2 text-sm text-muted-foreground">
          <ReceiptText className="size-4 shrink-0 text-info" />
          For the job: <span className="font-medium text-foreground">{ticketLabel}</span>
        </p>
      )}

      <div className="space-y-1.5">
        <Label htmlFor="req-ref">Your reference</Label>
        <Input
          id="req-ref" value={reference} onChange={(e) => setReference(e.target.value)}
          placeholder="e.g. your own PO or memo number" autoComplete="off"
        />
        <p className="text-xs text-muted-foreground">
          Your own filing label, so you can reconcile this later. The system also
          gives it a reference of its own that everyone can search by.
        </p>
      </div>

      {/* ⚠️ A label is not an explanation. Before this, four people in a row
          decided whether to release money with nothing to go on but the cost
          lines and — where there was one — the linked job card's summary. A
          standalone requisition (materials with no single job behind it, which
          0170 explicitly allows) simply read "Standalone requisition". */}
      <div className="space-y-1.5">
        <Label htmlFor="req-desc">
          What is this for?{" "}
          <span className="font-normal text-muted-foreground">(optional)</span>
        </Label>
        <textarea
          id="req-desc"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={3}
          className="w-full rounded-md border bg-background px-3 py-2 text-sm"
          placeholder="e.g. Replacement filters and coolant for the standby generator, ahead of the 500-hour service."
        />
        <p className="text-xs text-muted-foreground">
          Read by everyone in the approval chain — the audit review, the
          Managing Partner and the payment approver all see it.
        </p>
      </div>

      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <Label>Cost lines</Label>
          <Button type="button" variant="outline" size="sm" onClick={addLine}>
            <Plus className="size-3.5" /> Add a line
          </Button>
        </div>

        {lines.map((line, i) => (
          <div key={i} className="grid grid-cols-1 gap-2 rounded-lg border p-3 sm:grid-cols-[1fr_140px_1fr_auto]">
            <div className="space-y-1">
              <Label htmlFor={`line-desc-${i}`} className="text-xs">Description</Label>
              <Input
                id={`line-desc-${i}`} value={line.description}
                onChange={(e) => setLine(i, { description: e.target.value })}
                placeholder="What was this for?"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor={`line-amt-${i}`} className="text-xs">Amount (₦)</Label>
              <Input
                id={`line-amt-${i}`} type="number" min="0" step="0.01" value={line.amount}
                onChange={(e) => setLine(i, { amount: e.target.value })}
                placeholder="0.00"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor={`line-vendor-${i}`} className="text-xs">Vendor (optional)</Label>
              <Select
                id={`line-vendor-${i}`} value={line.vendorId}
                onChange={(e) => setLine(i, { vendorId: e.target.value })}
              >
                <option value="">No vendor — pay a bank account instead</option>
                {vendors.map((v) => (
                  <option key={v.id} value={v.id}>{v.name}</option>
                ))}
              </Select>
            </div>
            <div className="flex items-end">
              <Button
                type="button" variant="ghost" size="icon" onClick={() => removeLine(i)}
                disabled={lines.length === 1} aria-label="Remove line"
              >
                <X className="size-4" />
              </Button>
            </div>
          </div>
        ))}

        <p className="text-xs text-muted-foreground">
          A line without a vendor still needs somewhere to pay — you&rsquo;ll add
          verified bank details for it on the next screen. A line with neither
          is fine too: it is recorded, and nothing is sent for it.
        </p>
      </div>

      <div className="space-y-2">
        <Label htmlFor="req-file">Supporting document (optional)</Label>
        <input
          ref={fileRef} id="req-file" type="file" accept={ACCEPTED.join(",")}
          className="hidden" onChange={(e) => pickFile(e.target.files?.[0])}
        />
        <div className="flex items-center gap-2">
          <Button type="button" variant="outline" size="sm" onClick={() => fileRef.current?.click()}>
            <Paperclip className="size-3.5" /> {file ? "Replace file" : "Attach a document"}
          </Button>
          {file && (
            <span className="text-xs text-muted-foreground">
              {file.name}
              <button type="button" className="ml-2 underline" onClick={() => setFile(null)}>
                remove
              </button>
            </span>
          )}
        </div>
      </div>

      <div className="flex items-center justify-between border-t pt-4">
        <p className="text-sm text-muted-foreground">
          Total: <span className="font-semibold text-foreground tabular-nums">{formatNaira(total)}</span>
        </p>
        <Button type="submit" variant="brand" disabled={busy}>
          {busy ? <Loader2 className="size-4 animate-spin" /> : null}
          {busy ? "Raising…" : "Raise requisition"}
        </Button>
      </div>
    </form>
  );
}
