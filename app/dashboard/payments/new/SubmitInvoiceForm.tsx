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
  const [loading, setLoading] = useState(false);

  // Only this vendor's finished jobs. `payments_work_order_valid` refuses a
  // mismatch anyway; narrowing here means the user never composes one.
  const theirJobs = jobs.filter((j) => j.assigned_vendor_id === vendorId);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);

    const supabase = createClient();
    const { error } = await supabase.from("payments").insert({
      org_id: orgId,
      vendor_id: vendorId,
      invoice_reference: invoiceRef || null,
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
