"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input, Select, Textarea } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatNaira } from "@/lib/currency";
import { runAction, describeError } from "@/lib/run-action";
import { createBudget } from "./actions";

export type PropertyOption = { id: string; name: string; unit_count: number };

export default function BudgetForm({ properties }: { properties: PropertyOption[] }) {
  const router = useRouter();
  const [busy, setBusy] = React.useState(false);
  const [form, setForm] = React.useState({
    propertyId: properties.length === 1 ? properties[0].id : "",
    // The current year is right far more often than it is wrong, and a period
    // is easier to correct than to compose.
    period: String(new Date().getFullYear()),
    description: "",
    totalAmount: "",
  });

  const chosen = properties.find((p) => p.id === form.propertyId);
  const amount = Number(form.totalAmount);
  const amountValid = Number.isFinite(amount) && amount > 0;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const r = await runAction(
        createBudget({
          propertyId: form.propertyId,
          period: form.period,
          description: form.description,
          totalAmount: amount,
        })
      );
      toast.success("Budget created", {
        description: "Nothing is invoiced yet — review it, then generate the invoices.",
      });
      router.push(`/dashboard/sc/${r.id}`);
      router.refresh();
    } catch (err) {
      toast.error("Could not create the budget", {
        description: describeError(err),
        duration: Infinity,
        closeButton: true,
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="b-property">Property</Label>
          <Select
            id="b-property"
            required
            value={form.propertyId}
            onChange={(e) => setForm((f) => ({ ...f, propertyId: e.target.value }))}
          >
            <option value="">Choose a property…</option>
            {properties.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
                {p.unit_count === 0 ? " — no units yet" : ` — ${p.unit_count} unit${p.unit_count === 1 ? "" : "s"}`}
              </option>
            ))}
          </Select>
          {/* A budget on a property with no units cannot be apportioned, and the
              invoicing step would refuse it later. Saying so now costs nothing. */}
          {chosen?.unit_count === 0 && (
            <p className="text-xs text-warning">
              This property has no units yet. The budget will save, but it cannot be
              apportioned until units exist.
            </p>
          )}
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="b-period">Period</Label>
          <Input
            id="b-period"
            required
            value={form.period}
            onChange={(e) => setForm((f) => ({ ...f, period: e.target.value }))}
            placeholder="e.g. 2026"
          />
          <p className="text-xs text-muted-foreground">
            One budget per property per period.
          </p>
        </div>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="b-total">Total to apportion</Label>
        <Input
          id="b-total"
          required
          type="number"
          min="1"
          step="0.01"
          inputMode="decimal"
          value={form.totalAmount}
          onChange={(e) => setForm((f) => ({ ...f, totalAmount: e.target.value }))}
          placeholder="e.g. 12500000"
        />
        <p className="text-xs text-muted-foreground">
          {amountValid
            ? `${formatNaira(amount)} — split across the property's units by their apportionment factors.`
            : "The shared cost for the period, split across units by apportionment factor."}
        </p>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="b-desc">
          Description <span className="font-normal text-muted-foreground">(optional)</span>
        </Label>
        <Textarea
          id="b-desc"
          rows={2}
          value={form.description}
          onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
          placeholder="e.g. Estate maintenance, security and grounds — 2026"
        />
      </div>

      <div className="flex items-center gap-3 pt-1">
        <Button type="submit" variant="brand" disabled={busy || !amountValid}>
          {busy ? "Creating…" : "Create budget"}
        </Button>
        <p className="text-xs text-muted-foreground">
          Saved as a draft. Invoices are generated separately, on the budget itself.
        </p>
      </div>
    </form>
  );
}
