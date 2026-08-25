"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input, Select, Textarea } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { runAction, describeError } from "@/lib/run-action";
import { createLease, vacantUnitsFor } from "../actions";

type Option = { id: string; label: string };

/**
 * Recording a tenancy.
 *
 * ⚠️ Defaults to **annual rent, paid in advance** — because that is how the
 * Nigerian market lets. A form defaulting to monthly would be quietly wrong for
 * almost every tenancy typed into it, and the person typing would have to
 * correct it every single time.
 */
export default function LeaseForm({
  properties,
  tenants,
}: {
  properties: Option[];
  tenants: Option[];
}) {
  const router = useRouter();
  const [busy, setBusy] = React.useState(false);
  const [units, setUnits] = React.useState<Option[]>([]);
  const [loadingUnits, setLoadingUnits] = React.useState(false);

  const today = new Date().toISOString().slice(0, 10);
  const inAYear = (() => {
    const d = new Date();
    d.setFullYear(d.getFullYear() + 1);
    return d.toISOString().slice(0, 10);
  })();

  const [form, setForm] = React.useState({
    propertyId: "",
    unitId: "",
    tenantUserId: "",
    startDate: today,
    endDate: inAYear,
    rentAmount: "",
    rentFrequency: "annual" as "annual" | "quarterly" | "monthly",
    escalationPct: "0",
    // "" means follow the org default (decision 14's default-plus-override,
    // reused for the admin fee by 0181). An empty string rather than a repeat
    // of the org's current value, so a later change to the default still
    // reaches every lease that never departed from it.
    adminFeeBasis: "" as "" | "per_tenancy" | "per_demand",
    depositAmount: "",
    notes: "",
  });

  const set = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) =>
    setForm((f) => ({ ...f, [k]: v }));

  // Only units with no live tenancy are offered. The database refuses a double
  // let regardless; not offering it is how someone avoids discovering that
  // after typing the whole form.
  async function onProperty(propertyId: string) {
    set("propertyId", propertyId);
    set("unitId", "");
    setUnits([]);
    if (!propertyId) return;
    setLoadingUnits(true);
    try {
      const r = await runAction(vacantUnitsFor(propertyId));
      setUnits(r.units.map((u) => ({ id: u.id, label: u.label })));
    } catch (err) {
      toast.error("Could not load units", { description: describeError(err) });
    } finally {
      setLoadingUnits(false);
    }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const r = await runAction(createLease(form));
      toast.success("Tenancy recorded", {
        description: "It starts as a draft — activate it to occupy the unit.",
      });
      router.push(`/dashboard/leases?created=${r.id}`);
      router.refresh();
    } catch (err) {
      toast.error("Could not record that tenancy", {
        description: describeError(err), duration: Infinity, closeButton: true,
      });
    } finally {
      setBusy(false);
    }
  }

  const ready =
    form.propertyId && form.unitId && form.rentAmount.trim() && form.startDate && form.endDate;

  return (
    <form onSubmit={submit} className="space-y-5">
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="l-property">Property</Label>
          <Select
            id="l-property" required value={form.propertyId}
            onChange={(e) => onProperty(e.target.value)}
          >
            <option value="">Choose a property…</option>
            {properties.map((p) => (
              <option key={p.id} value={p.id}>{p.label}</option>
            ))}
          </Select>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="l-unit">Unit</Label>
          <Select
            id="l-unit" required value={form.unitId}
            disabled={!form.propertyId || loadingUnits}
            onChange={(e) => set("unitId", e.target.value)}
          >
            <option value="">
              {!form.propertyId
                ? "Choose a property first"
                : loadingUnits
                  ? "Loading…"
                  : units.length === 0
                    ? "No vacant units"
                    : "Choose a unit…"}
            </option>
            {units.map((u) => (
              <option key={u.id} value={u.id}>{u.label}</option>
            ))}
          </Select>
          {form.propertyId && !loadingUnits && units.length === 0 && (
            <p className="text-xs text-muted-foreground">
              Every unit here already has a live tenancy. End one first, or add a
              unit to the property.
            </p>
          )}
        </div>

        <div className="space-y-1.5 sm:col-span-2">
          <Label htmlFor="l-tenant">
            Tenant <span className="font-normal text-muted-foreground">(optional)</span>
          </Label>
          <Select
            id="l-tenant" value={form.tenantUserId}
            onChange={(e) => set("tenantUserId", e.target.value)}
          >
            <option value="">Assign later</option>
            {tenants.map((t) => (
              <option key={t.id} value={t.id}>{t.label}</option>
            ))}
          </Select>
          <p className="text-xs text-muted-foreground">
            An approved applicant is enrolled as a tenant automatically. Leave
            this blank if the paperwork is ahead of the account.
          </p>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="l-start">Starts</Label>
          <Input
            id="l-start" type="date" required value={form.startDate}
            onChange={(e) => set("startDate", e.target.value)}
          />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="l-end">Ends</Label>
          <Input
            id="l-end" type="date" required value={form.endDate}
            onChange={(e) => set("endDate", e.target.value)}
          />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="l-rent">Rent</Label>
          <Input
            id="l-rent" required inputMode="decimal" value={form.rentAmount}
            onChange={(e) => set("rentAmount", e.target.value)}
            placeholder="5,000,000"
          />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="l-freq">Billed</Label>
          <Select
            id="l-freq" value={form.rentFrequency}
            onChange={(e) => set("rentFrequency", e.target.value as typeof form.rentFrequency)}
          >
            <option value="annual">Annually, in advance</option>
            <option value="quarterly">Quarterly</option>
            <option value="monthly">Monthly</option>
          </Select>
          <p className="text-xs text-muted-foreground">
            Annual in advance is the norm here; the others are for commercial
            lettings that agree otherwise.
          </p>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="l-esc">
            Escalation at renewal <span className="font-normal text-muted-foreground">(%)</span>
          </Label>
          <Input
            id="l-esc" inputMode="decimal" value={form.escalationPct}
            onChange={(e) => set("escalationPct", e.target.value)}
            placeholder="0"
          />
          <p className="text-xs text-muted-foreground">
            Applied when the tenancy renews — never to the term you are creating.
          </p>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="l-adminfee">
            Admin fee <span className="font-normal text-muted-foreground">(this tenancy)</span>
          </Label>
          <Select
            id="l-adminfee" value={form.adminFeeBasis}
            onChange={(e) => set("adminFeeBasis", e.target.value as typeof form.adminFeeBasis)}
          >
            <option value="">Follow the organisation default</option>
            <option value="per_tenancy">Once, on the first demand</option>
            <option value="per_demand">On every rent demand</option>
          </Select>
          <p className="text-xs text-muted-foreground">
            Leave on the default unless this letting was negotiated otherwise.
            The amount is set in Settings → Lettings; this is only how often it
            is charged.
          </p>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="l-dep">
            Deposit <span className="font-normal text-muted-foreground">(optional)</span>
          </Label>
          <Input
            id="l-dep" inputMode="decimal" value={form.depositAmount}
            onChange={(e) => set("depositAmount", e.target.value)}
            placeholder="0"
          />
        </div>

        <div className="space-y-1.5 sm:col-span-2">
          <Label htmlFor="l-notes">
            Notes <span className="font-normal text-muted-foreground">(optional)</span>
          </Label>
          <Textarea
            id="l-notes" rows={3} value={form.notes}
            onChange={(e) => set("notes", e.target.value)}
            placeholder="Anything the next person handling this tenancy should know."
          />
        </div>
      </div>

      <div className="flex gap-2">
        <Button type="submit" variant="brand" disabled={busy || !ready}>
          {busy ? "Recording…" : "Record tenancy"}
        </Button>
        <Button type="button" variant="ghost" onClick={() => router.back()}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
