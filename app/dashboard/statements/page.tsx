import { redirect } from "next/navigation";
import { FileText } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { getSessionProfile } from "@/lib/auth";
import { formatNaira } from "@/lib/currency";
import { PageHeader } from "@/components/patterns/page-header";
import { EmptyState } from "@/components/patterns/empty-state";
import { StatusBadge } from "@/components/patterns/status-badge";
import { Card } from "@/components/ui/card";
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from "@/components/ui/table";

type Charge = {
  id: string;
  property_or_unit: string | null;
  billing_period: string | null;
  amount: number | string;
  apportionment_pct: number | string | null;
  status: string;
  due_date: string | null;
};

export default async function StatementsPage() {
  const session = await getSessionProfile();
  if (!session) redirect("/login");

  const isStaff = ["admin", "facility_manager", "finance_approver"].includes(
    session.profile?.role ?? ""
  );

  const supabase = await createClient();
  const { data } = await supabase
    .from("service_charges")
    .select(
      "id, property_or_unit, billing_period, amount, apportionment_pct, status, due_date"
    )
    .order("billing_period", { ascending: false });

  const charges = (data as Charge[]) ?? [];
  const total = charges.reduce((a, c) => a + Number(c.amount), 0);
  const outstanding = charges
    .filter((c) => c.status !== "paid")
    .reduce((a, c) => a + Number(c.amount), 0);

  return (
    <div className="space-y-6">
      <PageHeader
        title={isStaff ? "Service Charge Statements" : "My Service Charge Statement"}
        description={
          isStaff
            ? "All issued service-charge invoices you have access to."
            : "Charges apportioned to your unit."
        }
      />

      {charges.length === 0 ? (
        <EmptyState
          icon={<FileText />}
          title="No service-charge invoices yet"
          description="Invoices appear here once a billing cycle is issued for your property."
        />
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-2">
            <Card className="p-4 sm:p-5">
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Total billed
              </p>
              <p className="mt-1 text-2xl font-semibold tabular-nums">
                {formatNaira(total)}
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                {charges.length} invoice{charges.length === 1 ? "" : "s"}
              </p>
            </Card>
            <Card className="p-4 sm:p-5">
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Outstanding
              </p>
              <p
                className={`mt-1 text-2xl font-semibold tabular-nums ${
                  outstanding > 0 ? "text-warning" : "text-success"
                }`}
              >
                {formatNaira(outstanding)}
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                {outstanding > 0 ? "Payment due" : "All settled"}
              </p>
            </Card>
          </div>

          <Card>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Property / Unit</TableHead>
                  <TableHead>Period</TableHead>
                  <TableHead className="text-right">Share</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Amount</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {charges.map((c) => (
                  <TableRow key={c.id}>
                    <TableCell className="font-medium">
                      {c.property_or_unit ?? "—"}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {c.billing_period ?? "—"}
                    </TableCell>
                    <TableCell className="text-right tabular-nums text-muted-foreground">
                      {c.apportionment_pct != null
                        ? `${Number(c.apportionment_pct).toFixed(2)}%`
                        : "—"}
                    </TableCell>
                    <TableCell>
                      <StatusBadge status={c.status} />
                    </TableCell>
                    <TableCell className="text-right font-medium tabular-nums">
                      {formatNaira(c.amount)}
                    </TableCell>
                  </TableRow>
                ))}
                <TableRow className="bg-muted/40 hover:bg-muted/40">
                  <TableCell colSpan={4} className="font-semibold">
                    Total
                  </TableCell>
                  <TableCell className="text-right font-semibold tabular-nums">
                    {formatNaira(total)}
                  </TableCell>
                </TableRow>
              </TableBody>
            </Table>
          </Card>
        </>
      )}
    </div>
  );
}
