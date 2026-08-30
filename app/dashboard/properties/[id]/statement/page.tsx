import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { ArrowLeft, FileBarChart } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { getSessionProfile } from "@/lib/auth";
import { formatMoney } from "@/lib/currency";
import { roleLabel } from "@/lib/roles";
import { PageHeader } from "@/components/patterns/page-header";
import { EmptyState } from "@/components/patterns/empty-state";
import { StatusBadge } from "@/components/patterns/status-badge";
import { PrintButton } from "@/components/patterns/print-button";
import { PrintMasthead } from "@/components/patterns/print-masthead";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table, TableHeader, TableBody, TableRow, TableHead, TableCell,
} from "@/components/ui/table";
import PeriodPicker from "../../../ledger/reports/PeriodPicker";

// Everything that happened on one building, over a period.
//
// The gap this closes: `landlord_statement` (0130) answers what one OWNER is
// owed, `org_profit_and_loss` what the ORGANISATION earned, `my_service_charges`
// what one TENANT was billed — and nothing answered "show me this property".
// That is the question a landlord asks on the phone and an auditor asks in
// writing, and answering it meant reading the rent roll, the service-charge
// budget and the ledger side by side and doing the arithmetic by hand.
//
// ⚠️ RENT AND SERVICE CHARGE ARE NEVER ADDED. Rent is collected FOR a landlord
// and remitted to them net of fees; service charge is collected INTO a fund the
// property spends. A combined total is a number that means nothing, and this
// codebase has made that mistake once already at scale — 0103's segregation view
// summed across currencies and reported a shortfall that meant nothing, on the
// one screen built to catch exactly that. There is no grand total on this page.
//
// No scoping is repeated here: `property_statement()` is definer-scoped through
// `current_user_property_ids()` and `oversight_roles()`, and returns no row to a
// caller who holds neither — which renders as a 404, the same answer a property
// id that does not exist gets.

export const dynamic = "force-dynamic";

type Statement = {
  property_id: string;
  property_name: string;
  currency: string;
  rent_charges: number;
  rent_demanded: number | string;
  rent_collected: number | string;
  fees_taken: number | string;
  landlord_share: number | string;
  landlord_remitted: number | string;
  landlord_held: number | string;
  sc_invoices: number;
  sc_billed: number | string;
  sc_collected: number | string;
  sc_outstanding: number | string;
  unit_count: number;
  occupied_units: number;
  live_tenancies: number;
};

type Line = {
  kind: string;
  reference: string;
  unit_label: string | null;
  party: string | null;
  period_label: string | null;
  due_date: string | null;
  amount: number | string;
  amount_paid: number | string;
  status: string;
  settled_at: string | null;
};

const fmtDate = (d: string | null) =>
  d
    ? new Date(`${d}T00:00:00Z`).toLocaleDateString("en-GB", {
        timeZone: "UTC", day: "numeric", month: "short", year: "numeric",
      })
    : "—";

export default async function PropertyStatementPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ from?: string; to?: string }>;
}) {
  const { id } = await params;
  const session = await getSessionProfile();
  if (!session) redirect("/login");

  const sp = await searchParams;
  const now = new Date();
  const from = sp.from || `${now.getFullYear()}-01-01`;
  const to = sp.to || `${now.getFullYear()}-12-31`;

  const supabase = await createClient();
  const [stmtRes, linesRes] = await Promise.all([
    supabase.rpc("property_statement", { p_property_id: id, p_from: from, p_to: to }),
    supabase.rpc("property_statement_lines", { p_property_id: id, p_from: from, p_to: to }),
  ]);

  const stmt = ((stmtRes.data ?? []) as Statement[])[0] ?? null;
  // No row means the caller holds neither the property nor oversight — answered
  // identically to a property that does not exist, so this page cannot be used
  // to find out which property ids are real.
  if (!stmt) notFound();

  const lines = (linesRes.data ?? []) as Line[];
  const rentLines = lines.filter((l) => l.kind === "rent");
  const scLines = lines.filter((l) => l.kind === "service_charge");

  const ccy = stmt.currency || "NGN";
  const money = (n: number | string | null | undefined) => formatMoney(n ?? 0, ccy);
  const printedBy = session.profile?.full_name || session.profile?.email || undefined;

  return (
    <div className="printable space-y-6">
      <PrintMasthead
        org={session.org?.name ?? "Property"}
        title="Property statement"
        subtitle={`${stmt.property_name} · ${fmtDate(from)} to ${fmtDate(to)}`}
        by={
          printedBy
            ? `${printedBy} · ${roleLabel(session.profile?.role, session.org?.delivery_brand)}`
            : undefined
        }
      />

      <div data-print="screen-only">
        <PageHeader
          title={stmt.property_name}
          description={`Statement for ${fmtDate(from)} to ${fmtDate(to)} · ${stmt.unit_count} unit${stmt.unit_count === 1 ? "" : "s"}, ${stmt.occupied_units} occupied, ${stmt.live_tenancies} live tenanc${stmt.live_tenancies === 1 ? "y" : "ies"}`}
          actions={
            <div className="flex items-center gap-2">
              <PrintButton />
              <Button asChild variant="ghost" size="sm">
                <Link href={`/dashboard/properties/${id}`}><ArrowLeft /> Back</Link>
              </Button>
            </div>
          }
        />
        <div className="mt-4">
          {/* ⚠️ basePath, or Apply navigates to the ledger's own reports page —
              which is gated to admin, finance and the executive, so the two
              audiences this statement exists for (the property's manager and
              its landlord) were sent to "Finance access required" instead of a
              re-dated statement. */}
          <PeriodPicker from={from} to={to} basePath={`/dashboard/properties/${id}/statement`} />
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        {/* Rent — the landlord's side of the house. */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Rent</CardTitle>
            <CardDescription>
              Collected for the landlord and remitted to them net of fees. The fee
              is the rate snapshotted on each demand, apportioned to what was
              actually received — never to what was billed.
            </CardDescription>
          </CardHeader>
          <CardContent className="p-0">
            <Table>
              <TableBody>
                <Row label="Demanded" value={money(stmt.rent_demanded)} muted
                     note={`${stmt.rent_charges} demand${Number(stmt.rent_charges) === 1 ? "" : "s"}`} />
                <Row label="Collected" value={money(stmt.rent_collected)} />
                <Row label="Fees taken" value={money(stmt.fees_taken)} muted />
                <Row label="Landlord's share" value={money(stmt.landlord_share)} strong />
                <Row label="Remitted to the landlord" value={money(stmt.landlord_remitted)} tone="success" />
                <Row label="Still held for them" value={money(stmt.landlord_held)}
                     tone={Number(stmt.landlord_held) > 0 ? "warning" : undefined} />
              </TableBody>
            </Table>
          </CardContent>
        </Card>

        {/* Service charge — the fund's side. */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Service charge</CardTitle>
            <CardDescription>
              Collected into the fund this property spends. Owed to the fund, not
              to the landlord — which is why it is never added to the figures
              beside it.
            </CardDescription>
          </CardHeader>
          <CardContent className="p-0">
            <Table>
              <TableBody>
                <Row label="Billed" value={money(stmt.sc_billed)} muted
                     note={`${stmt.sc_invoices} invoice${Number(stmt.sc_invoices) === 1 ? "" : "s"}`} />
                <Row label="Collected" value={money(stmt.sc_collected)} />
                <Row label="Outstanding" value={money(stmt.sc_outstanding)} strong
                     tone={Number(stmt.sc_outstanding) > 0 ? "destructive" : undefined} />
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </div>

      {/* The lines behind the figures. A summary nobody can drill into is an
          assertion, not a statement. */}
      {lines.length === 0 ? (
        <EmptyState
          icon={<FileBarChart />}
          title="Nothing billed in this period"
          description="Rent demands and service-charge invoices appear here as they are raised. Widen the dates if you expected to see something."
        />
      ) : (
        <>
          {rentLines.length > 0 && (
            <LineTable title="Rent demands" lines={rentLines} money={money} />
          )}
          {scLines.length > 0 && (
            <LineTable title="Service-charge invoices" lines={scLines} money={money} />
          )}
        </>
      )}

      <p className="text-xs text-muted-foreground">
        Rent and service charge are reported separately and deliberately not
        totalled — one is owed to a landlord and the other to a fund, and adding
        them produces a figure that means nothing.
      </p>
    </div>
  );
}

function Row({
  label, value, note, muted, strong, tone,
}: {
  label: string;
  value: string;
  note?: string;
  muted?: boolean;
  strong?: boolean;
  tone?: "success" | "warning" | "destructive";
}) {
  const toneClass =
    tone === "success" ? "text-success"
      : tone === "warning" ? "text-warning"
        : tone === "destructive" ? "text-destructive"
          : muted ? "text-muted-foreground"
            : "";
  return (
    <TableRow>
      <TableCell className={strong ? "font-semibold" : ""}>
        {label}
        {note && <span className="block text-xs text-muted-foreground">{note}</span>}
      </TableCell>
      <TableCell className={`text-right tabular-nums ${strong ? "font-semibold" : ""} ${toneClass}`}>
        {value}
      </TableCell>
    </TableRow>
  );
}

function LineTable({
  title, lines, money,
}: {
  title: string;
  lines: Line[];
  money: (n: number | string | null | undefined) => string;
}) {
  const total = lines.reduce((a, l) => a + Number(l.amount), 0);
  const paid = lines.reduce((a, l) => a + Number(l.amount_paid), 0);
  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="text-base">{title}</CardTitle>
          <span className="text-sm text-muted-foreground">
            {lines.length} line{lines.length === 1 ? "" : "s"}
          </span>
        </div>
      </CardHeader>
      <CardContent className="px-0 pb-0">
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Unit</TableHead>
                <TableHead>Billed to</TableHead>
                <TableHead>Period</TableHead>
                <TableHead>Due</TableHead>
                <TableHead className="text-right">Amount</TableHead>
                <TableHead className="text-right">Received</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {lines.map((l) => (
                <TableRow key={`${l.kind}-${l.reference}`}>
                  <TableCell className="font-medium">{l.unit_label ?? "—"}</TableCell>
                  <TableCell className="text-muted-foreground">{l.party ?? "—"}</TableCell>
                  <TableCell className="whitespace-nowrap text-muted-foreground">
                    {l.period_label ?? "—"}
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-muted-foreground">
                    {fmtDate(l.due_date)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{money(l.amount)}</TableCell>
                  <TableCell className="text-right tabular-nums">{money(l.amount_paid)}</TableCell>
                  <TableCell>
                    <StatusBadge status={l.status} />
                    {l.settled_at && (
                      <Badge variant="success" className="ml-2">remitted</Badge>
                    )}
                  </TableCell>
                </TableRow>
              ))}
              <TableRow className="bg-muted/40 hover:bg-muted/40">
                <TableCell colSpan={4} className="font-semibold">Total</TableCell>
                <TableCell className="text-right font-semibold tabular-nums">{money(total)}</TableCell>
                <TableCell className="text-right font-semibold tabular-nums">{money(paid)}</TableCell>
                <TableCell />
              </TableRow>
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>
  );
}
