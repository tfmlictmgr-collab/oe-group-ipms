"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/**
 * The reporting period.
 *
 * Pushed into the URL rather than held in state so a finance lead can bookmark
 * or send "the Q1 P&L" as a link — a report you cannot point someone at is half
 * a report.
 */
export default function PeriodPicker({ from, to }: { from: string; to: string }) {
  const router = useRouter();
  const [f, setF] = React.useState(from);
  const [t, setT] = React.useState(to);

  const apply = () =>
    router.push(
      `/dashboard/ledger/reports?from=${encodeURIComponent(f)}&to=${encodeURIComponent(t)}`
    );

  return (
    <form
      className="flex flex-wrap items-end gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        apply();
      }}
    >
      <div className="space-y-1.5">
        <Label htmlFor="from">From</Label>
        <Input id="from" type="date" value={f} onChange={(e) => setF(e.target.value)} />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="to">To</Label>
        <Input id="to" type="date" value={t} onChange={(e) => setT(e.target.value)} />
      </div>
      <Button type="submit" variant="outline" disabled={!f || !t || f > t}>
        Apply
      </Button>
      {f > t && (
        <p className="text-xs text-destructive">
          The start date is after the end date.
        </p>
      )}
    </form>
  );
}
