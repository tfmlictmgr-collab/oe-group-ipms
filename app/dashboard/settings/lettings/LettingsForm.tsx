"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { runAction, describeError } from "@/lib/run-action";
import { saveLettingsSettings, setLandlordFee } from "./actions";

export type Landlord = {
  id: string;
  name: string;
  negotiatedPct: number | null;
};

export default function LettingsForm({
  managementFeePct,
  adminFeeFlat,
  adminFeeBasis,
  renewalNoticeDays,
  rentDemandLeadDays,
  landlords,
}: {
  managementFeePct: number;
  adminFeeFlat: number;
  adminFeeBasis: "per_tenancy" | "per_demand";
  renewalNoticeDays: number[];
  rentDemandLeadDays: number;
  landlords: Landlord[];
}) {
  const router = useRouter();
  const [busy, setBusy] = React.useState(false);
  const [form, setForm] = React.useState({
    managementFeePct: String(managementFeePct),
    adminFeeFlat: String(adminFeeFlat),
    adminFeeBasis,
    renewalNoticeDays: renewalNoticeDays.join(", "),
    rentDemandLeadDays: String(rentDemandLeadDays),
  });

  const set = (k: keyof typeof form, v: string) => setForm((f) => ({ ...f, [k]: v }));

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await runAction(saveLettingsSettings(form));
      toast.success("Saved", {
        description: "This applies to demands raised from now on. Nothing already issued changes.",
      });
      router.refresh();
    } catch (err) {
      toast.error("Could not save", {
        description: describeError(err), duration: Infinity, closeButton: true,
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      <form onSubmit={save} className="space-y-5">
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="s-fee">Management fee (%)</Label>
            <Input
              id="s-fee" inputMode="decimal" value={form.managementFeePct}
              onChange={(e) => set("managementFeePct", e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              The default for every landlord. Individual landlords can carry a
              negotiated rate below.
            </p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="s-admin">Admin fee (₦, flat)</Label>
            <Input
              id="s-admin" inputMode="decimal" value={form.adminFeeFlat}
              onChange={(e) => set("adminFeeFlat", e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              Charged in full on the demand it applies to, then frozen onto that
              demand — a later change never rewrites a statement already issued.
            </p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="s-admin-basis">How often the admin fee is charged</Label>
            <select
              id="s-admin-basis"
              className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              value={form.adminFeeBasis}
              onChange={(e) => set("adminFeeBasis", e.target.value)}
            >
              <option value="per_tenancy">Once per tenancy</option>
              <option value="per_demand">On every rent demand</option>
            </select>
            <p className="text-xs text-muted-foreground">
              A renewal continues the same tenancy, so it is not charged again.
              An individual tenancy can depart from this on its own lease.
            </p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="s-notice">Renewal notices (days before expiry)</Label>
            <Input
              id="s-notice" value={form.renewalNoticeDays}
              onChange={(e) => set("renewalNoticeDays", e.target.value)}
              placeholder="90, 60, 30"
            />
            <p className="text-xs text-muted-foreground">
              A notice goes out at each of these. Commercial portfolios usually
              want longer than residential.
            </p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="s-lead">Raise rent demands (days ahead)</Label>
            <Input
              id="s-lead" inputMode="numeric" value={form.rentDemandLeadDays}
              onChange={(e) => set("rentDemandLeadDays", e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              Rent here is paid annually in advance, so a demand normally arrives
              before the period starts rather than on the day.
            </p>
          </div>
        </div>

        <div className="rounded-lg border border-border bg-muted/40 p-3 text-xs text-muted-foreground">
          Changing the fee affects demands raised <strong>from now on</strong>.
          Every rent demand already issued keeps the rate it was raised at, so a
          landlord statement you have already sent cannot change behind you.
        </div>

        <Button type="submit" variant="brand" disabled={busy}>
          {busy ? "Saving…" : "Save settings"}
        </Button>
      </form>

      <div className="space-y-3 border-t border-border pt-5">
        <div>
          <h3 className="text-sm font-medium">Negotiated landlord rates</h3>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Leave blank to use the {managementFeePct}% default. A rate set here
            applies only to that landlord&apos;s properties.
          </p>
        </div>

        {landlords.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No property owners enrolled yet.
          </p>
        ) : (
          <ul className="space-y-2">
            {landlords.map((l) => (
              <LandlordRate key={l.id} landlord={l} defaultPct={managementFeePct} />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function LandlordRate({
  landlord,
  defaultPct,
}: {
  landlord: Landlord;
  defaultPct: number;
}) {
  const router = useRouter();
  const [value, setValue] = React.useState(
    landlord.negotiatedPct === null ? "" : String(landlord.negotiatedPct)
  );
  const [busy, setBusy] = React.useState(false);
  const overridden = landlord.negotiatedPct !== null;
  const current = landlord.negotiatedPct === null ? "" : String(landlord.negotiatedPct);
  const dirty = value.trim() !== current;

  async function commit(next: string | null) {
    setBusy(true);
    try {
      await runAction(setLandlordFee(landlord.id, next));
      toast.success(
        next === null || next === ""
          ? `${landlord.name} is back on the ${defaultPct}% default`
          : `${landlord.name} is now at ${next}%`
      );
      router.refresh();
    } catch (err) {
      toast.error("Could not save that rate", { description: describeError(err) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className="flex flex-wrap items-center gap-2 rounded-lg border border-border p-2.5">
      <span className="min-w-0 flex-1 truncate text-sm">{landlord.name}</span>

      {/* The diff from the baseline, shown rather than left to be worked out —
          the same affordance the permission matrix uses for a deviation. */}
      {overridden && (
        <Badge variant="outline" className="flex-shrink-0 text-[10px]">
          default {defaultPct}%
        </Badge>
      )}

      {/* ⚠️ This saved on blur, and that was the wrong shape for money. Nothing
          on screen said the value would be kept, so someone typing a rate and
          tabbing away had to guess whether it had taken — and someone typing one
          and closing the tab lost it silently. An explicit commit, appearing
          only when there is something to commit, says what will happen. */}
      <Input
        value={value}
        disabled={busy}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") { e.preventDefault(); if (dirty) commit(value); }
          if (e.key === "Escape") setValue(current);
        }}
        placeholder={`${defaultPct}`}
        className="h-8 w-24 flex-shrink-0 text-sm"
        inputMode="decimal"
        aria-label={`Management fee for ${landlord.name}`}
      />

      {dirty && (
        <Button
          type="button" size="sm" variant="brand" disabled={busy}
          onClick={() => commit(value)}
        >
          {busy ? "Saving…" : "Save"}
        </Button>
      )}

      {overridden && !dirty && (
        <Button
          type="button" size="icon-sm" variant="ghost" disabled={busy}
          title="Reset to the organisation default"
          aria-label={`Reset ${landlord.name} to the default rate`}
          onClick={() => { setValue(""); commit(null); }}
        >
          <RotateCcw />
        </Button>
      )}
    </li>
  );
}
