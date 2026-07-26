import { redirect } from "next/navigation";
import Link from "next/link";
import { Landmark, TriangleAlert, CheckCircle2 } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { getSessionProfile } from "@/lib/auth";
import { formatNaira } from "@/lib/currency";
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

export default async function ReconciliationPage() {
  const session = await getSessionProfile();
  if (!session) redirect("/login");

  const supabase = await createClient();
  const { data: bank } = await supabase
    .from("bank_accounts")
    .select("id, label, ledger_account_id")
    .eq("purpose", "client_funds")
    .eq("active", true)
    .maybeSingle();

  if (!bank) {
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
      <ReconcileClient bankAccountId={bank.id} bankLabel={bank.label} existingRefs={refs} />

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
                      {formatNaira(l.amount)}
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
                      {formatNaira(r.ledger_balance)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatNaira(r.statement_balance)}
                    </TableCell>
                    <TableCell className="text-right font-medium tabular-nums">
                      {formatNaira(r.variance)}
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
