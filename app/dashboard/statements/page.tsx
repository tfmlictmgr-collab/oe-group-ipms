import { redirect } from "next/navigation";
import { FileText, Receipt } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { getSessionProfile } from "@/lib/auth";
import { formatNaira, formatMoney } from "@/lib/currency";
import { PageHeader } from "@/components/patterns/page-header";
import { EmptyState } from "@/components/patterns/empty-state";
import { StatusBadge } from "@/components/patterns/status-badge";
import { PrintButton } from "@/components/patterns/print-button";
import { PrintMasthead } from "@/components/patterns/print-masthead";
import { roleLabel } from "@/lib/roles";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from "@/components/ui/table";
import ServiceCharges, { type ServiceChargeRow } from "./ServiceCharges";
import { FM_PM } from "@/lib/roles";

// Statements, from both sides of the invoice.
//
// Staff get the register: every charge they have access to, as a table. That is
// what was here before and it stays.
//
// The person BEING billed gets something the page never offered — a way to pay,
// and a record of what they have already paid. Module 3 built budgets,
// apportionment, invoicing, the ledger posting and daily reconciliation, and
// left the payer with a number and no button (see 0123). "View statements
// (payment history)" was likewise only ever the billed half: what was asked
// for, never what was settled, so a tenant had no receipt and no reference to
// quote in a dispute.

export const dynamic = "force-dynamic";

type Charge = {
  id: string;
  property_or_unit: string | null;
  billing_period: string | null;
  amount: number | string;
  amount_paid: number | string;
  apportionment_pct: number | string | null;
  status: string;
  due_date: string | null;
};

type PaymentRow = {
  intent_id: string;
  purpose: string;
  reference: string;
  description: string | null;
  amount_expected: number | string;
  amount_paid: number | string | null;
  currency: string;
  status: string;
  paid_at: string | null;
  created_at: string;
};

const fmtDateTime = (d: string | null) =>
  d
    ? new Date(d).toLocaleString("en-GB", {
        timeZone: "Africa/Lagos", day: "numeric", month: "short",
        year: "numeric", hour: "2-digit", minute: "2-digit",
      })
    : "—";

export default async function StatementsPage() {
  const session = await getSessionProfile();
  if (!session) redirect("/login");

  // Neither has a unit to be billed, and neither should see the org-wide
  // financial view: a contractor is paid, not billed, and a regional manager
  // holds "nothing financial, no org-wide read" (decision 9) — Statements is
  // exactly the financial screen that sentence rules them out of. Both are
  // sent to where they actually belong rather than shown a statement of
  // charges that cannot exist. The nav no longer offers this to either; a
  // bookmark or a typed URL should not reach it either.
  if (session.profile?.role === "vendor") redirect("/dashboard/my-work");
  if (session.profile?.role === "regional_manager") redirect("/dashboard");

  // ⚠️ `fm_ops_staff` was never in this list either, and unlike vendor/regional
  // it had no redirect at all — reaching this page directly would have dropped
  // them into the tenant-billed branch below, querying service charges billed
  // to a unit they do not occupy. Excluded from the nav in the same pass, but
  // the page itself needed the same fix, since the nav is a courtesy and never
  // the boundary.
  if (session.profile?.role === "fm_ops_staff") redirect("/dashboard/my-jobs");

  const isStaff = ["admin", ...FM_PM, "finance_approver", "executive"].includes(
    session.profile?.role ?? ""
  );

  const supabase = await createClient();

  // Two reads for two audiences, and only the one that will be shown.
  //
  // `my_service_charges()` is definer-scoped to `billed_to_user_id =
  // auth.uid()`; the table query is RLS-scoped to whatever the caller may see.
  // A staff member who also happens to be billed for their own flat would
  // otherwise appear in both, which reads as a duplicate rather than as two
  // different questions.
  const [mineRes, allRes, historyRes] = await Promise.all([
    isStaff
      ? Promise.resolve({ data: [] as ServiceChargeRow[] })
      : supabase.rpc("my_service_charges"),
    isStaff
      ? supabase
          .from("service_charges")
          .select(
            "id, property_or_unit, billing_period, amount, amount_paid, apportionment_pct, status, due_date"
          )
          .order("billing_period", { ascending: false })
      : Promise.resolve({ data: [] as Charge[] }),
    supabase.rpc("my_payment_history"),
  ]);

  const mine = (mineRes.data ?? []) as ServiceChargeRow[];
  const charges = (allRes.data ?? []) as Charge[];
  const history = (historyRes.data ?? []) as PaymentRow[];

  const rows = isStaff ? charges : mine;
  const total = isStaff
    ? charges.reduce((a, c) => a + Number(c.amount), 0)
    : mine.reduce((a, c) => a + Number(c.amount), 0);
  const outstanding = isStaff
    ? charges.reduce((a, c) => a + Math.max(0, Number(c.amount) - Number(c.amount_paid ?? 0)), 0)
    : mine.reduce((a, c) => a + Math.max(0, Number(c.outstanding)), 0);

  const paymentHistory = history.length > 0 && (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Payment history</CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>What for</TableHead>
              <TableHead>Reference</TableHead>
              <TableHead>Date</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Amount</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {history.map((p) => (
              <TableRow key={p.intent_id}>
                <TableCell className="font-medium capitalize">
                  {p.description ?? p.purpose.replace(/_/g, " ")}
                </TableCell>
                <TableCell className="font-mono text-xs text-muted-foreground">
                  {p.reference}
                </TableCell>
                <TableCell className="text-muted-foreground">
                  {/* A payment that never settled has no paid_at. Showing the
                      date it was REQUESTED is the honest answer to "when",
                      rather than an em-dash on a row that plainly happened. */}
                  {fmtDateTime(p.paid_at ?? p.created_at)}
                </TableCell>
                <TableCell>
                  <StatusBadge status={p.status} />
                </TableCell>
                <TableCell className="text-right font-medium tabular-nums">
                  {formatMoney(p.amount_paid ?? p.amount_expected, p.currency)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );

  // A tenant asking for "a statement" means a sheet of paper — for a bank, a
  // visa application, an employer, a dispute. This page has always been able to
  // answer the question on screen and never able to hand over the answer.
  //
  // The print carries whatever the reads above already returned and adds no
  // check of its own: RLS decided what is on the screen, so a tenant prints
  // their own charges and a finance lead prints the org's register, each seeing
  // exactly what they see now.
  const printedBy = session.profile?.full_name || session.profile?.email || undefined;
  const printedByLine = printedBy
    ? `${printedBy} · ${roleLabel(session.profile?.role, session.org?.delivery_brand)}`
    : undefined;

  return (
    <div className="printable space-y-6">
      <PrintMasthead
        org={session.org?.name ?? "Statement"}
        title={isStaff ? "Service charge register" : "Service charge statement"}
        subtitle={
          isStaff
            ? "All issued service-charge invoices"
            : `${formatNaira(outstanding)} outstanding across ${rows.length} invoice${rows.length === 1 ? "" : "s"}`
        }
        by={printedByLine}
      />
      <div data-print="screen-only">
        <PageHeader
          title={isStaff ? "Service Charge Statements" : "My Service Charge Statement"}
          description={
            isStaff
              ? "All issued service-charge invoices you have access to."
              : outstanding > 0
                ? `${formatNaira(outstanding)} outstanding across ${rows.length} invoice${rows.length === 1 ? "" : "s"}.`
                : "Charges apportioned to your unit."
          }
          actions={<PrintButton />}
        />
      </div>

      {rows.length === 0 ? (
        <>
          <EmptyState
            icon={<FileText />}
            title="No service-charge invoices yet"
            description="Invoices appear here once a billing cycle is issued for your property."
          />
          {paymentHistory}
        </>
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
                {rows.length} invoice{rows.length === 1 ? "" : "s"}
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

          {isStaff ? (
            <Card>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Property / Unit</TableHead>
                    <TableHead>Period</TableHead>
                    <TableHead className="text-right">Share</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="text-right">Outstanding</TableHead>
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
                      <TableCell className="text-right tabular-nums text-muted-foreground">
                        {formatNaira(
                          Math.max(0, Number(c.amount) - Number(c.amount_paid ?? 0))
                        )}
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
                      {formatNaira(outstanding)}
                    </TableCell>
                    <TableCell className="text-right font-semibold tabular-nums">
                      {formatNaira(total)}
                    </TableCell>
                  </TableRow>
                </TableBody>
              </Table>
            </Card>
          ) : (
            <ServiceCharges charges={mine} />
          )}

          {paymentHistory}
        </>
      )}

      {rows.length === 0 && history.length === 0 && (
        <EmptyState
          icon={<Receipt />}
          title="No payments yet"
          description="Once you pay an invoice, the receipt and its reference appear here."
        />
      )}
    </div>
  );
}
