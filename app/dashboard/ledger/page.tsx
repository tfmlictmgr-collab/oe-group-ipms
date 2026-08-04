import { redirect } from "next/navigation";
import Link from "next/link";
import { Scale, TriangleAlert, CheckCircle2, Wallet, Landmark } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { getSessionProfile } from "@/lib/auth";
import { formatMoney } from "@/lib/currency";
import { cn } from "@/lib/utils";
import { EmptyState } from "@/components/patterns/empty-state";
import { StatCard } from "@/components/patterns/stat-card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table, TableHeader, TableBody, TableRow, TableHead, TableCell,
} from "@/components/ui/table";
import { stuckRemittances } from "./actions";
import StuckRemittances from "./StuckRemittances";

type Balance = {
  account_id: string;
  code: string;
  name: string;
  class: string;
  purpose: string;
  natural_balance: number | string;
  posting_count: number;
  currency: string;
};

type Position = {
  currency: string;
  funds_held: number | string | null;
  funds_owed: number | string | null;
  unallocated: number | string | null;
};

const CLASS_LABEL: Record<string, string> = {
  asset: "Held",
  liability: "Owed to others",
  income: "Earned",
  expense: "Spent",
};

export default async function LedgerBalancesPage() {
  const session = await getSessionProfile();
  if (!session) redirect("/login");

  const supabase = await createClient();
  const [balancesRes, positionRes] = await Promise.all([
    supabase
      .from("ledger_account_balances")
      .select("account_id, code, name, class, purpose, natural_balance, posting_count, currency")
      .order("code"),
    // ⚠️ No longer `.maybeSingle()`. `client_funds_position` is now one row PER
    // CURRENCY (0103) — an org with a USD collections account alongside its
    // Naira one has two segregation positions, each independently correct.
    // `.maybeSingle()` would have thrown the moment a second currency existed.
    supabase
      .from("client_funds_position")
      .select("currency, funds_held, funds_owed, unallocated"),
  ]);

  const balances = (balancesRes.data as Balance[]) ?? [];
  const positions = new Map(
    ((positionRes.data as Position[]) ?? []).map((p) => [p.currency, p])
  );

  if (balances.length === 0) {
    return (
      <EmptyState
        icon={<Scale />}
        title="No chart of accounts yet"
        description="Set up the standard accounts — client funds, landlord and vendor payables, deposits and fee income — before posting anything."
        action={
          <Button asChild variant="brand" size="sm">
            <Link href="/dashboard/settings/banking">Go to Client Funds settings</Link>
          </Button>
        }
      />
    );
  }

  // Group by class so the page reads like a balance sheet rather than a list.
  const groups = ["asset", "liability", "income", "expense"] as const;

  // Every currency actually present in the chart, NGN first (the default —
  // every org starts here) then alphabetical, so a foreign currency never
  // pushes Naira out of its familiar top spot.
  const currencies = Array.from(new Set(balances.map((b) => b.currency))).sort((a, b) =>
    a === "NGN" ? -1 : b === "NGN" ? 1 : a.localeCompare(b)
  );

  // Money that left the bank but never reached the books. Shown FIRST and above
  // the position itself, because while one of these is outstanding the position
  // below it is wrong.
  const stuck = await stuckRemittances();

  return (
    <div className="space-y-6">
      {stuck.ok && <StuckRemittances rows={stuck.data} />}

      {currencies.map((currency) => {
        const position = positions.get(currency);
        const held = Number(position?.funds_held ?? 0);
        const owed = Number(position?.funds_owed ?? 0);
        const unallocated = Number(position?.unallocated ?? 0);
        const shortfall = unallocated < 0;
        const currencyBalances = balances.filter((b) => b.currency === currency);

        return (
          <div key={currency} className="space-y-6">
            {currencies.length > 1 && (
              <h2 className="flex items-center gap-2 text-sm font-semibold text-muted-foreground">
                {currency}
                {currency !== "NGN" && <Badge variant="outline">Segregated separately from Naira</Badge>}
              </h2>
            )}

            {/* The segregation position — the single most important figure here,
                now scoped to ONE currency. Summing across currencies would add
                Naira and Dollars together and report a shortfall that means
                nothing (0103). */}
            <Card className={cn(shortfall && "border-destructive/50")}>
              <CardHeader className="pb-3">
                <CardTitle className="flex items-center gap-2 text-base">
                  {shortfall ? (
                    <TriangleAlert className="size-4 text-destructive" />
                  ) : (
                    <CheckCircle2 className="size-4 text-success" />
                  )}
                  Segregation position{currency !== "NGN" ? ` — ${currency}` : ""}
                </CardTitle>
                <CardDescription>
                  {shortfall
                    ? "Liabilities exceed the funds held. Client money may have been applied to something it shouldn't have been — investigate before any further disbursement."
                    : "Money held covers everything owed to clients."}
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="grid gap-4 sm:grid-cols-3">
                  <StatCard label="Funds held" value={formatMoney(held, currency)} icon={<Wallet />} />
                  <StatCard label="Owed to clients" value={formatMoney(owed, currency)} icon={<Landmark />} />
                  <StatCard
                    label={shortfall ? "Shortfall" : "Unallocated"}
                    value={formatMoney(unallocated, currency)}
                    icon={shortfall ? <TriangleAlert /> : <CheckCircle2 />}
                    hint={shortfall ? "must be zero or positive" : "earned fees not yet swept"}
                  />
                </div>
              </CardContent>
            </Card>

            {groups.map((cls) => {
              const rows = currencyBalances.filter((b) => b.class === cls);
              if (rows.length === 0) return null;
              const total = rows.reduce((s, r) => s + Number(r.natural_balance), 0);

              return (
                <Card key={cls}>
                  <CardHeader className="pb-2">
                    <div className="flex items-center justify-between gap-3">
                      <CardTitle className="text-base">{CLASS_LABEL[cls] ?? cls}</CardTitle>
                      <span className="text-sm font-semibold tabular-nums">{formatMoney(total, currency)}</span>
                    </div>
                  </CardHeader>
                  <CardContent className="px-0 pb-0">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead className="w-24">Code</TableHead>
                          <TableHead>Account</TableHead>
                          <TableHead className="text-right">Entries</TableHead>
                          <TableHead className="text-right">Balance</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {rows.map((b) => (
                          <TableRow key={b.account_id}>
                            <TableCell className="font-mono text-xs text-muted-foreground">{b.code}</TableCell>
                            <TableCell>
                              <span className="font-medium">{b.name}</span>
                              {b.purpose === "client_funds" && (
                                <Badge variant="info" className="ml-2">Segregated</Badge>
                              )}
                            </TableCell>
                            <TableCell className="text-right tabular-nums text-muted-foreground">
                              {b.posting_count}
                            </TableCell>
                            <TableCell className="text-right font-medium tabular-nums">
                              {formatMoney(b.natural_balance, currency)}
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        );
      })}

      <p className="text-xs text-muted-foreground">
        Balances are derived from postings, never stored — so a balance can never
        disagree with the entries behind it. The ledger is append-only;
        corrections are reversing entries.
      </p>
    </div>
  );
}
