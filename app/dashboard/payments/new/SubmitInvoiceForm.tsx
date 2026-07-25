"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent } from "@/components/ui/card";

export default function SubmitInvoiceForm({
  orgId,
  vendors,
}: {
  orgId: string;
  vendors: { id: string; name: string }[];
}) {
  const router = useRouter();
  const [vendorId, setVendorId] = useState(vendors[0]?.id ?? "");
  const [amount, setAmount] = useState("");
  const [invoiceRef, setInvoiceRef] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);

    const supabase = createClient();
    const { error } = await supabase.from("payments").insert({
      org_id: orgId,
      vendor_id: vendorId,
      invoice_reference: invoiceRef || null,
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
              onChange={(e) => setVendorId(e.target.value)}
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
