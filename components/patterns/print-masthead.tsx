"use client";

import * as React from "react";

/**
 * The identifying block at the top of a printed report.
 *
 * A printed page loses everything the screen was carrying around it — which
 * organisation's books these are, which period, who asked for it and when. A
 * sheet of figures with none of that on it is not evidence of anything, and
 * these are the pages a landlord, a client or an auditor is handed.
 *
 * ⚠️ The timestamp is stamped at PRINT time, not at render time. A ledger tab
 * left open since morning would otherwise print this morning's time against
 * this afternoon's figures — a small lie on a financial document is still a
 * lie. It is empty until the browser tells us a print is starting, which is
 * also why it never appears on screen.
 */
export function PrintMasthead({
  org,
  title,
  subtitle,
  by,
}: {
  org: string;
  title: string;
  subtitle?: string;
  by?: string;
}) {
  const [printedAt, setPrintedAt] = React.useState<string | null>(null);

  React.useEffect(() => {
    const stamp = () =>
      setPrintedAt(
        new Intl.DateTimeFormat("en-GB", {
          dateStyle: "long",
          timeStyle: "short",
          // West Africa Time, like every other timestamp in the product — the
          // reader's machine may be anywhere, the books are kept in Lagos.
          timeZone: "Africa/Lagos",
        }).format(new Date())
      );

    stamp();
    window.addEventListener("beforeprint", stamp);
    return () => window.removeEventListener("beforeprint", stamp);
  }, []);

  return (
    <div data-print="print-only" className="hidden">
      <div className="mb-4 border-b border-border pb-3">
        <p className="text-xs uppercase tracking-wide text-muted-foreground">{org}</p>
        <h1 className="text-lg font-semibold">{title}</h1>
        {subtitle && <p className="text-sm text-muted-foreground">{subtitle}</p>}
        <p className="mt-1 text-xs text-muted-foreground">
          {by ? `Printed by ${by}` : "Printed"}
          {printedAt ? ` · ${printedAt} WAT` : ""}
        </p>
      </div>
    </div>
  );
}
