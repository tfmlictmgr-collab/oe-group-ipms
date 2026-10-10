import Link from "next/link";
import { redirect } from "next/navigation";
import { ShieldAlert } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { getSessionProfile } from "@/lib/auth";
import { formatMoney } from "@/lib/currency";
import { readsPropertyFunds, roleLabel } from "@/lib/roles";
import { cn } from "@/lib/utils";
import { PageHeader } from "@/components/patterns/page-header";
import { EmptyState } from "@/components/patterns/empty-state";
import { PrintButton } from "@/components/patterns/print-button";
import { PrintMasthead } from "@/components/patterns/print-masthead";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table, TableHeader, TableBody, TableRow, TableHead, TableCell,
} from "@/components/ui/table";
import PeriodPicker from "../ledger/reports/PeriodPicker";
import DownloadCsv from "../ledger/reports/DownloadCsv";

// Client Funds for a property manager (requested 9 Oct 2026): the money held
// for the buildings they manage, read-only.
//
// ⚠️ Nothing is granted here. `property_finance_roles()` (0249) has admitted
// the property manager to the ledger accounts, postings and payment requests
// of the properties they hold since 5 Sept, and both reports below are
// SECURITY INVOKER (0318) — so every figure is what those policies already
// admit, scoped by `current_user_property_ids()`. What was missing was a
// screen. The organisation's Client Funds (bank balance, reconciliation,
// payouts, the whole journal) stays oversight-only: ledger read is a
// non-delegable control (decision 7), and this page is a window onto their own
// buildings' funds, not onto the client-funds account.

export const dynamic = "force-dynamic";

type Fund = {
  account_id: string; code: string; property: string; currency: string;
  opening: number | string; collected: number | string; spent: number | string;
  closing: number | string; overdrawn: boolean;
};
type Collection = {
  paid_on: string; channel: string; purpose: string; property: string | null; unit: string | null;
  payer: string | null; currency: string; amount: number | string; reference: string | null;
};

const n = (v: number | string | null | undefined) => Number(v ?? 0);
const fmt = (d: string) =>
  new Date(d).toLocaleDateString("en-GB", { timeZone: "Africa/Lagos", day: "numeric", month: "short", year: "numeric" });

function currenciesOf(rows: { currency: string }[]) {
  return Array.from(new Set(rows.map((r) => r.currency)))
    .sort((a, b) => (a === "NGN" ? -1 : b === "NGN" ? 1 : a.localeCompare(b)));
}

export default async function PropertyFundsPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; to?: string }>;
}) {
  const session = await getSessionProfile();
  if (!session) redirect("/login");
  const role = session.profile?.role;

  if (!readsPropertyFunds(role)) {
    return (
      <div className="space-y-6">
        <PageHeader title="Client Funds" />
        <EmptyState
          icon={<ShieldAlert />}
          title="Not available for your role"
          description="The funds held for each building are shown to the property manager who manages it."
        />
      </div>
    );
  }

  const sp = await searchParams;
  const now = new Date();
  const from = sp.from || `${now.getFullYear()}-01-01`;
  const to = sp.to || now.toISOString().slice(0, 10);

  const supabase = await createClient();
  const [fundsRes, inRes] = await Promise.all([
    supabase.rpc("report_property_funds", { p_from: from, p_to: to }),
    supabase.rpc("report_collections", { p_from: from, p_to: to }),
  ]);
  const funds = ((fundsRes.data ?? []) as Fund[]).filter((f) => f.property !== "Not attached to a property");
  const collections = (inRes.data ?? []) as Collection[];

  const printedBy = session.profile?.full_name || session.profile?.email || undefined;

  return (
    <div className="printable space-y-6">
      <PrintMasthead
        org={session.org?.name ?? "Client Funds"}
        title="Client funds — your properties"
        subtitle={`${fmt(from)} to ${fmt(to)}`}
        by={printedBy ? `${printedBy} · ${roleLabel(role, session.org?.delivery_brand)}` : undefined}
      />
      <div data-print="screen-only">
        <PageHeader
          title="Client Funds"
          description="Money held for the properties you manage: each building's service-charge fund and the payments received for them. Read-only."
          actions={<PrintButton />}
        />
      </div>

      <div data-print="screen-only">
        <PeriodPicker from={from} to={to} basePath="/dashboard/property-funds" />
      </div>

      {fundsRes.error && (
        <p className="text-sm text-destructive">Could not read the funds: {fundsRes.error.message}</p>
      )}

      {funds.length === 0 && !fundsRes.error ? (
        <EmptyState
          icon={<ShieldAlert />}
          title="No fund on your properties yet"
          description="A building's service-charge fund opens with its first collection or payment."
        />
      ) : (
        currenciesOf(funds).map((ccy) => {
          const mine = funds.filter((f) => f.currency === ccy);
          return (
            <Card key={ccy}>
              <CardHeader className="pb-2">
                <CardTitle className="text-base">Service-charge funds — {ccy}</CardTitle>
                <CardDescription>
                  What each building&apos;s fund held at the start, collected, spent and held at the end of the
                  period. A fund below zero paid out money it never collected. Open one to see every movement.
                </CardDescription>
              </CardHeader>
              <CardContent className="overflow-x-auto p-0">
                <div className="flex justify-end px-4 pb-2" data-print="screen-only">
                  <DownloadCsv
                    filename={`property-funds-${ccy}-${from}-to-${to}.csv`}
                    headers={["Code", "Property", "Currency", "Opening", "Collected", "Spent", "Closing", "Overdrawn"]}
                    rows={mine.map((r) => [r.code, r.property, r.currency, n(r.opening), n(r.collected), n(r.spent), n(r.closing), r.overdrawn ? "yes" : "no"])}
                  />
                </div>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Property</TableHead>
                      <TableHead className="text-right">Opening</TableHead>
                      <TableHead className="text-right">Collected</TableHead>
                      <TableHead className="text-right">Spent</TableHead>
                      <TableHead className="text-right">Closing</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {mine.map((r) => (
                      <TableRow key={r.account_id}>
                        <TableCell>
                          <Link href={`/dashboard/property-funds/${r.account_id}`} className="font-medium hover:underline">
                            {r.property}
                          </Link>
                          <span className="ml-2 font-mono text-xs text-muted-foreground">{r.code}</span>
                          {r.overdrawn && <Badge variant="destructive" className="ml-2">Overdrawn</Badge>}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">{formatMoney(r.opening, ccy)}</TableCell>
                        <TableCell className="text-right tabular-nums">{formatMoney(r.collected, ccy)}</TableCell>
                        <TableCell className="text-right tabular-nums">{formatMoney(r.spent, ccy)}</TableCell>
                        <TableCell className={cn("text-right font-medium tabular-nums", r.overdrawn && "text-destructive")}>
                          {formatMoney(r.closing, ccy)}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          );
        })
      )}

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Payments received for your properties</CardTitle>
          <CardDescription>
            Rent, service charge and deposits paid in the period, online or by confirmed bank transfer.
            Rent and service charge are listed separately and never added together.
          </CardDescription>
        </CardHeader>
        <CardContent className="overflow-x-auto p-0">
          {collections.length > 0 && (
            <div className="flex justify-end px-4 pb-2" data-print="screen-only">
              <DownloadCsv
                filename={`payments-received-${from}-to-${to}.csv`}
                headers={["Paid on", "Property", "Unit", "Payer", "For", "Channel", "Currency", "Amount", "Reference"]}
                rows={collections.map((c) => [c.paid_on, c.property, c.unit, c.payer, c.purpose, c.channel, c.currency, n(c.amount), c.reference])}
              />
            </div>
          )}
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Paid on</TableHead>
                <TableHead>Property</TableHead>
                <TableHead>Payer</TableHead>
                <TableHead>For</TableHead>
                <TableHead>Channel</TableHead>
                <TableHead className="text-right">Amount</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {collections.length === 0 && (
                <TableRow>
                  <TableCell colSpan={6} className="text-center text-sm text-muted-foreground">
                    Nothing was received for your properties in this period.
                  </TableCell>
                </TableRow>
              )}
              {collections.map((c, i) => (
                <TableRow key={`${c.reference ?? ""}-${i}`}>
                  <TableCell className="whitespace-nowrap">{fmt(c.paid_on)}</TableCell>
                  <TableCell>
                    {c.property ?? "—"}
                    {c.unit && <span className="block text-xs text-muted-foreground">{c.unit}</span>}
                  </TableCell>
                  <TableCell>{c.payer ?? "—"}</TableCell>
                  <TableCell>{c.purpose}</TableCell>
                  <TableCell className="text-muted-foreground">{c.channel}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatMoney(c.amount, c.currency)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
