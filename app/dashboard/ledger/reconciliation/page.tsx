import { redirect } from "next/navigation";
import Link from "next/link";
import { Landmark, TriangleAlert, CheckCircle2 } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { getSessionProfile } from "@/lib/auth";
import { formatMoney } from "@/lib/currency";
import { EmptyState } from "@/components/patterns/empty-state";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table, TableHeader, TableBody, TableRow, TableHead, TableCell,
} from "@/components/ui/table";
import ReconcileClient from "./ReconcileClient";
import { existingStatementRefs } from "../actions";

const fmtDate = (d: string) =>
  new Date(d).toLocaleDateString("en-GB", {
    timeZone: "Africa/Lagos",
    day: "numeric",
    month: "short",
    year: "numeric",
  });

export default async function ReconciliationPage({
  searchParams,
}: {
  searchParams: Promise<{ account?: string }>;
}) {
  const session = await getSessionProfile();
  if (!session) redirect("/login");
  const { account: requestedAccountId } = await searchParams;

  const supabase = await createClient();
  // ⚠️ Every active client-funds account, not `.maybeSingle()`. An org can now
  // hold several — one per currency (0103) — and reconciliation is inherently
  // PER ACCOUNT: a bank statement is denominated in one currency, and matching
  // a USD statement line against an NGN ledger balance would be meaningless.
  // `.maybeSingle()` here would have THROWN the moment a second account
  // existed, not silently picked one — this was found live, not hypothesised.
  const { data: banks } = await supabase
    .from("bank_accounts")
    .select("id, label, currency, ledger_account_id")
    .eq("purpose", "client_funds")
    .eq("active", true)
    .order("currency", { ascending: true }); // NGN sorts first

  if (!banks?.length) {
    return (
      <EmptyState
        icon={<Landmark />}
        title="No client-funds account configured"
        description="Add the segregated bank account first — reconciliation compares it against the ledger."
        action={
          <Button asChild variant="brand" size="sm">
            <Link href="/dashboard/settings/banking">Configure the account</Link>
          </Button>
        }
      />
    );
  }

  // Default to NGN (or whichever sorts first) so the common single-currency
  // org sees exactly the page it always saw — the picker below only appears
  // once there is genuinely something to pick between.
  const bank = banks.find((b) => b.id === requestedAccountId) ?? banks[0];

  const [refs, runsRes, unmatchedRes] = await Promise.all([
    existingStatementRefs(bank.id),
    supabase
      .from("reconciliations")
      .select(
        "id, as_of_date, ledger_balance, statement_balance, variance, matched_lines, unmatched_lines, status, run_at"
      )
      .eq("bank_account_id", bank.id)
      .order("run_at", { ascending: false })
      .limit(10),
    supabase
      .from("bank_statement_lines")
      .select("id, value_date, description, reference, amount")
      .eq("bank_account_id", bank.id)
      .eq("status", "unmatched")
      .order("value_date", { ascending: false })
      .limit(50),
  ]);

  const runs = runsRes.data ?? [];
  const unmatched = unmatchedRes.data ?? [];

  return (
    <div className="space-y-4">
      {banks.length > 1 && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs font-medium text-muted-foreground">Account:</span>
          {banks.map((b) => (
            <Link
              key={b.id}
              href={`/dashboard/ledger/reconciliation?account=${b.id}`}
              className={
                b.id === bank.id
                  ? "rounded-full bg-[var(--brand)] px-3 py-1 text-xs font-medium text-[var(--brand-fg)]"
                  : "rounded-full border border-input px-3 py-1 text-xs text-muted-foreground hover:bg-accent"
              }
            >
              {b.currency} · {b.label}
            </Link>
          ))}
        </div>
      )}

      <ReconcileClient
        bankAccountId={bank.id}
        bankLabel={bank.label}
        currency={bank.currency}
        existingRefs={refs.ok ? refs.data : []}
      />

      {unmatched.length > 0 && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Unexplained statement lines</CardTitle>
            <CardDescription>
              On the bank statement but not in the ledger. Each is either a
              movement still to be recorded, or something that needs querying.
            </CardDescription>
          </CardHeader>
          <CardContent className="px-0 pb-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Date</TableHead>
                  <TableHead>Description</TableHead>
                  <TableHead>Reference</TableHead>
                  <TableHead className="text-right">Amount</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {unmatched.map((l) => (
                  <TableRow key={l.id}>
                    <TableCell className="whitespace-nowrap">{fmtDate(l.value_date)}</TableCell>
                    <TableCell className="max-w-[20rem] truncate">{l.description ?? "—"}</TableCell>
                    <TableCell className="text-muted-foreground">{l.reference ?? "—"}</TableCell>
                    <TableCell className="text-right font-medium tabular-nums">
                      {formatMoney(l.amount, bank.currency)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Reconciliation history</CardTitle>
          <CardDescription>
            Every run is kept, balanced or not — a record only saved when it
            succeeds is one nobody can audit.
          </CardDescription>
        </CardHeader>
        <CardContent className="px-0 pb-0">
          {runs.length === 0 ? (
            <p className="px-5 pb-5 text-sm text-muted-foreground">
              No reconciliation has been run yet.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>As at</TableHead>
                  <TableHead className="text-right">Ledger</TableHead>
                  <TableHead className="text-right">Bank</TableHead>
                  <TableHead className="text-right">Variance</TableHead>
                  <TableHead className="text-right">Unmatched</TableHead>
                  <TableHead>Result</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {runs.map((r) => (
                  <TableRow key={r.id}>
                    <TableCell className="whitespace-nowrap">{fmtDate(r.as_of_date)}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatMoney(r.ledger_balance, bank.currency)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatMoney(r.statement_balance, bank.currency)}
                    </TableCell>
                    <TableCell className="text-right font-medium tabular-nums">
                      {formatMoney(r.variance, bank.currency)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums text-muted-foreground">
                      {r.unmatched_lines}
                    </TableCell>
                    <TableCell>
                      {r.status === "balanced" ? (
                        <Badge variant="success">
                          <CheckCircle2 className="size-3" /> Balanced
                        </Badge>
                      ) : (
                        <Badge variant="destructive">
                          <TriangleAlert className="size-3" /> Variance
                        </Badge>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
