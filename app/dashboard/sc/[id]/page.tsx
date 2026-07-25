import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { getSessionProfile } from "@/lib/auth";
import { apportion } from "@/lib/apportionment";
import { formatNaira } from "@/lib/currency";
import { PageHeader } from "@/components/patterns/page-header";
import { StatusBadge } from "@/components/patterns/status-badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from "@/components/ui/table";
import GenerateButton from "./GenerateButton";

export default async function BudgetDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const session = await getSessionProfile();
  if (!session) redirect("/login");

  const supabase = await createClient();
  const { data: budget } = await supabase
    .from("sc_budgets")
    .select("id, period, description, total_amount, status, property_id, properties(name, address)")
    .eq("id", id)
    .single();
  if (!budget) notFound();

  const property = budget.properties as unknown as {
    name: string;
    address: string | null;
  } | null;

  const { data: units } = await supabase
    .from("units")
    .select("id, label, apportionment_factor, occupant_user_id")
    .eq("property_id", budget.property_id)
    .order("label");

  const shares = apportion(
    Number(budget.total_amount),
    (units ?? []).map((u) => ({
      id: u.id,
      label: u.label,
      factor: Number(u.apportionment_factor),
      occupant_user_id: u.occupant_user_id,
    }))
  );
  const sharesTotal = shares.reduce((a, s) => a + s.amount, 0);

  const canManage =
    session.profile?.role === "admin" ||
    session.profile?.role === "finance_approver";

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <PageHeader
        title={property?.name ?? "Budget"}
        description={`${budget.description ?? ""} · ${budget.period}`}
        actions={
          <Button asChild variant="ghost" size="sm">
            <Link href="/dashboard/sc">
              <ArrowLeft /> Back
            </Link>
          </Button>
        }
      />

      <Card>
        <CardContent className="pt-5">
          <div className="flex flex-wrap items-end justify-between gap-4">
            <div>
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Budget total
              </p>
              <p className="text-3xl font-semibold tabular-nums">
                {formatNaira(budget.total_amount)}
              </p>
              {property?.address && (
                <p className="mt-1 text-xs text-muted-foreground">{property.address}</p>
              )}
            </div>
            <StatusBadge status={budget.status} />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <CardTitle className="text-base">
              Apportionment
              <span className="ml-2 font-normal text-muted-foreground">
                {shares.length} units, pro-rata by floor area
              </span>
            </CardTitle>
            {canManage && (
              <GenerateButton
                budgetId={budget.id}
                alreadyInvoiced={budget.status === "invoiced"}
              />
            )}
          </div>
        </CardHeader>
        <CardContent className="px-0 pb-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Unit</TableHead>
                <TableHead className="text-right">Factor</TableHead>
                <TableHead className="text-right">Share %</TableHead>
                <TableHead className="text-right">Amount</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {shares.map((s) => (
                <TableRow key={s.id}>
                  <TableCell className="font-medium">{s.label}</TableCell>
                  <TableCell className="text-right tabular-nums text-muted-foreground">
                    {s.factor}
                  </TableCell>
                  <TableCell className="text-right tabular-nums text-muted-foreground">
                    {(s.pct * 100).toFixed(2)}%
                  </TableCell>
                  <TableCell className="text-right font-medium tabular-nums">
                    {formatNaira(s.amount)}
                  </TableCell>
                </TableRow>
              ))}
              <TableRow className="bg-muted/40 hover:bg-muted/40">
                <TableCell colSpan={3} className="font-semibold">
                  Total
                </TableCell>
                <TableCell className="text-right font-semibold tabular-nums">
                  {formatNaira(sharesTotal)}
                </TableCell>
              </TableRow>
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <p className="text-xs text-muted-foreground">
        Apportionment reconciles to the budget total exactly. Generating invoices
        creates a per-unit charge on each occupant&apos;s statement.
      </p>
    </div>
  );
}
