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
import StatementsRegister, { type RegisterRow } from "./StatementsRegister";
import { unitDisplayLabel } from "@/lib/apportionment";
import { FM_PM, OVERSIGHT_ROLES } from "@/lib/roles";

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

  // A contractor is paid, not billed, so there is no statement for them to
  // read; they are sent to their work rather than shown an empty one.
  //
  // ⚠️ The REGIONAL MANAGER was redirected away from here too, on decision 9's
  // "nothing financial, no org-wide read". Decision 26 superseded the first
  // half of that on 30 Aug — they hold `sc.manage` and administer the service
  // charge on the properties they hold — and the redirect was never revisited,
  // so a role that can RAISE a budget could not read the invoices it produced.
  //
  // The second half of decision 9 still holds and is what makes letting them
  // in safe: their reach is the PLACE, not the organisation.
  // `service_charges_select` admits them through `budget_id` to
  // `sc_budgets.property_id in current_user_property_ids()`, so the register
  // below returns their own region and nothing else — no clause here decides
  // that, and none should.
  if (session.profile?.role === "vendor") redirect("/dashboard/my-work");

  // ⚠️ `fm_ops_staff` was never in this list either, and unlike vendor/regional
  // it had no redirect at all — reaching this page directly would have dropped
  // them into the tenant-billed branch below, querying service charges billed
  // to a unit they do not occupy. Excluded from the nav in the same pass, but
  // the page itself needed the same fix, since the nav is a courtesy and never
  // the boundary.
  if (session.profile?.role === "fm_ops_staff") redirect("/dashboard/my-jobs");

  // ⚠️ `payment_approver` was missing, and the consequence was not a refusal —
  // it was a BLANK PAGE. A role not in this list falls to the `else` branch
  // below and is served `my_service_charges()`, which is definer-scoped to
  // charges billed to them personally. The head of accounts is billed nothing,
  // so the register they are entitled to (25 charges, measured) rendered as
  // an empty statement of their own. Another copy of `oversight_roles()`
  // written before that role existed — see OVERSIGHT_ROLES in lib/roles.ts.
  const isStaff = [...FM_PM, "regional_manager", ...OVERSIGHT_ROLES].includes(
    (session.profile?.role ?? "") as never
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
          // ⚠️ `units(...)` and `users(...)` embedded so the register can be
          // grouped BY property, unit or tenant. `property_or_unit` is a text
          // label frozen at invoicing; grouping on it alone would group on a
          // string rather than on the thing it names.
          .select(
            "id, property_or_unit, billing_period, amount, amount_paid, apportionment_pct, status, due_date, " +
            "units(label, description, properties(name)), users:billed_to_user_id(full_name)"
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

  // Flattened for the register: the label as invoiced, plus the property, unit
  // and tenant it actually belongs to, so grouping is on the thing and not on
  // the string.
  const registerRows: RegisterRow[] = charges.map((c) => {
    const u = (c as unknown as {
      units?: { label?: string; description?: string | null; properties?: { name?: string } | null } | null;
      users?: { full_name?: string } | null;
    }).units ?? null;
    const t = (c as unknown as { users?: { full_name?: string } | null }).users ?? null;
    return {
      id: c.id,
      label: c.property_or_unit ?? "—",
      propertyName: u?.properties?.name ?? null,
      unitLabel: u ? unitDisplayLabel(u.label ?? "", u.description) : null,
      tenantName: t?.full_name ?? null,
      period: c.billing_period,
      amount: Number(c.amount),
      amountPaid: Number(c.amount_paid ?? 0),
      pct: c.apportionment_pct == null ? null : Number(c.apportionment_pct),
      status: c.status,
      dueDate: c.due_date,
    };
  });

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
            <StatementsRegister rows={registerRows} />
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
