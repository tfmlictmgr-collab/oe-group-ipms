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
 *
 * ⚠️ `basePath` exists because this component hardcoded `/dashboard/ledger/reports`
 * and was then reused on the property statement (0228). Clicking Apply there
 * did not change the period: it navigated to the LEDGER, which is gated to
 * admin, finance and the executive — so a property manager or a landlord
 * pressing Apply on their own statement was thrown onto a page reading
 * "Finance access required". The default keeps the original caller identical;
 * every other caller states where it lives.
 */
export default function PeriodPicker({
  from,
  to,
  basePath = "/dashboard/ledger/reports",
}: {
  from: string;
  to: string;
  basePath?: string;
}) {
  const router = useRouter();
  const [f, setF] = React.useState(from);
  const [t, setT] = React.useState(to);

  const apply = () =>
    router.push(
      `${basePath}?from=${encodeURIComponent(f)}&to=${encodeURIComponent(t)}`
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
