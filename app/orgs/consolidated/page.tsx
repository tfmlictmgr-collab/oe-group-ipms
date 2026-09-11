import { redirect } from "next/navigation";
import Link from "next/link";
import { ArrowLeft, Layers } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { getSessionProfile } from "@/lib/auth";
import { formatMoney } from "@/lib/currency";
import { PageHeader } from "@/components/patterns/page-header";
import { EmptyState } from "@/components/patterns/empty-state";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table, TableHeader, TableBody, TableRow, TableHead, TableCell,
} from "@/components/ui/table";

// Multi-entity consolidation — and it lives HERE, on the operator portal,
// deliberately.
//
// ⚠️ A consolidated position is one figure built from several organisations'
// books, which is exactly what B1 forbids anyone but the operator from seeing.
// So this sits under `/orgs`, behind the operator sign-in, beside the org
// directory that decision 12 put there for the same reason — not as a
// "Consolidated" tab on a brand's own finance page, where a TFML finance lead
// would be one click from OEA's numbers.
//
// The gate is inside `operator_consolidated_position()`, not in this file. A
// brand administrator who types this URL gets an empty set and the empty state
// below — never a refusal, which would confirm there are other organisations to
// be refused access to.

export const dynamic = "force-dynamic";

type Row = {
  org_id: string;
  org_name: string;
  org_slug: string;
  delivery_brand: string;
  currency: string;
  income: number | string;
  expense: number | string;
  net: number | string;
  funds_held: number | string;
  funds_owed: number | string;
};

export default async function ConsolidatedPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; to?: string }>;
}) {
  const session = await getSessionProfile();
  if (!session) redirect("/login");

  const sp = await searchParams;
  const now = new Date();
  const from = sp.from || `${now.getFullYear()}-01-01`;
  const to = sp.to || now.toISOString().slice(0, 10);

  const supabase = await createClient();
  const { data } = await supabase.rpc("operator_consolidated_position", {
    p_from: from,
    p_to: to,
  });

  const rows = (data ?? []) as Row[];
  const brands = Array.from(new Set(rows.map((r) => r.delivery_brand))).sort();

  return (
    <div className="mx-auto max-w-5xl space-y-6 p-6">
      <PageHeader
        title="Consolidated position"
        description={`Every client organisation, ${from} to ${to}.`}
        actions={
          <Button asChild variant="ghost" size="sm">
            <Link href="/orgs">
              <ArrowLeft /> Organisations
            </Link>
          </Button>
        }
      />

      {rows.length === 0 ? (
        <EmptyState
          icon={<Layers />}
          title="Nothing to consolidate"
          description="No client organisation has posted income or expense in this period."
        />
      ) : (
        brands.map((brand) => {
          const mine = rows.filter((r) => r.delivery_brand === brand);
          const currencies = Array.from(new Set(mine.map((r) => r.currency))).sort();
          return (
            <Card key={brand}>
              <CardHeader>
                <CardTitle className="text-base">
                  {brand === "direct" ? "Direct clients" : brand}
                </CardTitle>
              </CardHeader>
              <CardContent className="p-0">
                {currencies.map((ccy) => {
                  const group = mine.filter((r) => r.currency === ccy);
                  const income = group.reduce((a, r) => a + Number(r.income), 0);
                  const expense = group.reduce((a, r) => a + Number(r.expense), 0);
                  const held = group.reduce((a, r) => a + Number(r.funds_held), 0);
                  const owed = group.reduce((a, r) => a + Number(r.funds_owed), 0);
                  return (
                    <Table key={ccy}>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Organisation ({ccy})</TableHead>
                          <TableHead className="text-right">Income</TableHead>
                          <TableHead className="text-right">Expense</TableHead>
                          <TableHead className="text-right">Net</TableHead>
                          <TableHead className="text-right">Held</TableHead>
                          <TableHead className="text-right">Owed</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {group.map((r) => (
                          <TableRow key={`${r.org_id}-${r.currency}`}>
                            <TableCell className="font-medium">
                              <Link
                                href={`/o/${r.org_slug}`}
                                className="underline underline-offset-2"
                              >
                                {r.org_name}
                              </Link>
                            </TableCell>
                            <TableCell className="text-right tabular-nums">
                              {formatMoney(r.income, ccy)}
                            </TableCell>
                            <TableCell className="text-right tabular-nums">
                              {formatMoney(r.expense, ccy)}
                            </TableCell>
                            <TableCell
                              className={`text-right font-medium tabular-nums ${
                                Number(r.net) >= 0 ? "text-success" : "text-destructive"
                              }`}
                            >
                              {formatMoney(r.net, ccy)}
                            </TableCell>
                            <TableCell className="text-right tabular-nums text-muted-foreground">
                              {formatMoney(r.funds_held, ccy)}
                            </TableCell>
                            <TableCell className="text-right tabular-nums text-muted-foreground">
                              {formatMoney(r.funds_owed, ccy)}
                            </TableCell>
                          </TableRow>
                        ))}
                        <TableRow className="bg-muted/40 hover:bg-muted/40">
                          <TableCell className="font-semibold">
                            {brand === "direct" ? "Direct clients" : brand} total
                          </TableCell>
                          <TableCell className="text-right font-semibold tabular-nums">
                            {formatMoney(income, ccy)}
                          </TableCell>
                          <TableCell className="text-right font-semibold tabular-nums">
                            {formatMoney(expense, ccy)}
                          </TableCell>
                          <TableCell className="text-right font-semibold tabular-nums">
                            {formatMoney(income - expense, ccy)}
                          </TableCell>
                          <TableCell className="text-right font-semibold tabular-nums">
                            {formatMoney(held, ccy)}
                          </TableCell>
                          <TableCell className="text-right font-semibold tabular-nums">
                            {formatMoney(owed, ccy)}
                          </TableCell>
                        </TableRow>
                      </TableBody>
                    </Table>
                  );
                })}
              </CardContent>
            </Card>
          );
        })
      )}

      <p className="text-xs text-muted-foreground">
        Grouped by delivery brand, and totalled only within a single currency.
        {/* Stated on the page rather than only in the migration, because the
            person reading this is the one who would otherwise ask for a single
            group-wide number. */}{" "}
        No organisation currently carries a parent, so there is no legal-entity
        hierarchy to roll up — when parents are configured, that becomes the
        grouping.
      </p>
    </div>
  );
}
