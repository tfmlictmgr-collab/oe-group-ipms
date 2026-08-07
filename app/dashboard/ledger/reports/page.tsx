import { Fragment } from "react";
import { redirect } from "next/navigation";
import { FileBarChart } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { getSessionProfile } from "@/lib/auth";
import { formatMoney } from "@/lib/currency";
import { EmptyState } from "@/components/patterns/empty-state";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table, TableHeader, TableBody, TableRow, TableHead, TableCell,
} from "@/components/ui/table";
import PeriodPicker from "./PeriodPicker";

// Org-wide P&L, and the landlord statements behind part of it.
//
// ⚠️ Rendered PER CURRENCY, with no grand total anywhere on the page. That is
// not a simplification — it is the 0103 lesson made visible. The segregation
// view once summed every currency into one figure and reported a shortfall that
// meant nothing, on the one screen built to catch exactly that. A P&L that adds
// ₦ and $ into a single "profit" is the same error wearing a friendlier label,
// so `org_profit_and_loss` returns a currency column and this page groups by it
// rather than reducing.

export const dynamic = "force-dynamic";

type PnlRow = {
  currency: string;
  class: string;
  account_code: string;
  account_name: string;
  amount: number | string;
  posting_count: number;
};

function defaultRange() {
  const now = new Date();
  // The year to date. A finance lead opening "reports" wants the current
  // position far more often than a fixed quarter, and the picker is one field
  // away for anything else.
  return {
    from: `${now.getFullYear()}-01-01`,
    to: now.toISOString().slice(0, 10),
  };
}

export default async function ReportsPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; to?: string }>;
}) {
  const session = await getSessionProfile();
  if (!session) redirect("/login");

  const sp = await searchParams;
  const fallback = defaultRange();
  const from = sp.from || fallback.from;
  const to = sp.to || fallback.to;

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("org_profit_and_loss", {
    p_from: from,
    p_to: to,
  });

  const rows = (data ?? []) as PnlRow[];
  const currencies = Array.from(new Set(rows.map((r) => r.currency))).sort();

  return (
    <div className="space-y-6">
      <PeriodPicker from={from} to={to} />

      {error ? (
        <EmptyState
          icon={<FileBarChart />}
          title="The report could not be produced"
          description={error.message}
        />
      ) : rows.length === 0 ? (
        <EmptyState
          icon={<FileBarChart />}
          title="Nothing posted in this period"
          description="Income and expense appear here as fees are taken at collection and charges are posted. Widen the dates if you expected to see something."
        />
      ) : (
        currencies.map((ccy) => {
          const mine = rows.filter((r) => r.currency === ccy);
          const income = mine
            .filter((r) => r.class === "income")
            .reduce((a, r) => a + Number(r.amount), 0);
          const expense = mine
            .filter((r) => r.class === "expense")
            .reduce((a, r) => a + Number(r.amount), 0);
          const net = income - expense;

          return (
            <Card key={ccy}>
              <CardHeader>
                <CardTitle className="text-base">
                  Profit &amp; loss — {ccy}
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4 p-0">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Account</TableHead>
                      <TableHead>Code</TableHead>
                      <TableHead className="text-right">Postings</TableHead>
                      <TableHead className="text-right">Amount</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {(["income", "expense"] as const).map((cls) => {
                      const group = mine.filter((r) => r.class === cls);
                      if (group.length === 0) return null;
                      return (
                        // Keyed on the Fragment, not the first row inside it —
                        // a keyless fragment wrapping a mapped list is a React
                        // warning and, worse, loses row identity on re-render.
                        <Fragment key={cls}>
                          <TableRow className="bg-muted/30 hover:bg-muted/30">
                            <TableCell colSpan={4} className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                              {cls}
                            </TableCell>
                          </TableRow>
                          {group.map((r) => (
                            <TableRow key={`${cls}-${r.account_code}`}>
                              <TableCell className="font-medium">
                                {r.account_name}
                              </TableCell>
                              <TableCell className="font-mono text-xs text-muted-foreground">
                                {r.account_code}
                              </TableCell>
                              <TableCell className="text-right tabular-nums text-muted-foreground">
                                {r.posting_count}
                              </TableCell>
                              <TableCell className="text-right font-medium tabular-nums">
                                {formatMoney(r.amount, ccy)}
                              </TableCell>
                            </TableRow>
                          ))}
                        </Fragment>
                      );
                    })}
                    <TableRow className="bg-muted/40 hover:bg-muted/40">
                      <TableCell colSpan={3} className="font-semibold">
                        Net {net >= 0 ? "surplus" : "deficit"}
                      </TableCell>
                      <TableCell
                        className={`text-right font-semibold tabular-nums ${
                          net >= 0 ? "text-success" : "text-destructive"
                        }`}
                      >
                        {formatMoney(net, ccy)}
                      </TableCell>
                    </TableRow>
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          );
        })
      )}

      {currencies.length > 1 && (
        <p className="text-xs text-muted-foreground">
          Shown separately per currency, and deliberately not totalled. Adding
          balances in different currencies produces a figure that means nothing —
          a defect this codebase has already had once, on the segregation view.
        </p>
      )}
    </div>
  );
}
