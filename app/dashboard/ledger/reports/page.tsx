import { Fragment } from "react";
import Link from "next/link";
import { redirect } from "next/navigation";
import { FileBarChart } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { getSessionProfile } from "@/lib/auth";
import { formatMoney } from "@/lib/currency";
import { cn } from "@/lib/utils";
import { EmptyState } from "@/components/patterns/empty-state";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table, TableHeader, TableBody, TableRow, TableHead, TableCell,
} from "@/components/ui/table";
import PeriodPicker from "./PeriodPicker";
import DownloadCsv from "./DownloadCsv";
import { TestRecordsToggle, TestBadge } from "@/components/patterns/test-records-toggle";

// The head of accounts' reports (0318).
//
// Five views of one period, each read through the caller's own policies (every
// report function is SECURITY INVOKER), so the Payment Approver sees the whole
// organisation and nobody sees more than their role already reaches.
//
// ⚠️ Rendered PER CURRENCY, with no grand total across currencies anywhere.
// That is the 0103 lesson made visible: the segregation view once summed every
// currency into one figure and reported a shortfall that meant nothing. Rent
// and service charge are likewise never added into one "income" (decision 25):
// grouping by type keeps them on separate lines.

export const dynamic = "force-dynamic";

type View = "pnl" | "collections" | "payouts" | "funds" | "trial";
const VIEWS: { key: View; label: string }[] = [
  { key: "collections", label: "Money in" },
  { key: "payouts", label: "Money out" },
  { key: "funds", label: "Property funds" },
  { key: "trial", label: "Trial balance" },
  { key: "pnl", label: "Profit & loss" },
];

type PnlRow = { currency: string; class: string; account_code: string; account_name: string; amount: number | string; posting_count: number };
type Collection = {
  paid_on: string; channel: string; purpose: string; property: string | null; unit: string | null; payer: string | null;
  landlord: string | null; currency: string; amount: number | string; management_fee: number | string | null;
  landlord_net: number | string | null; reference: string | null; is_test: boolean;
};
type Payout = {
  paid_on: string; kind: string; payee: string | null; property: string | null; channel: string; currency: string;
  gross: number | string; fees: number | string; net: number | string; reference: string | null; bank_reference: string | null;
  is_test: boolean;
};
type Fund = {
  account_id: string; code: string; property: string; currency: string; opening: number | string; collected: number | string;
  spent: number | string; closing: number | string; overdrawn: boolean;
};
type Trial = {
  account_id: string; code: string; name: string; class: string; currency: string; debits: number | string; credits: number | string; balance: number | string;
};

const COLLECTION_GROUPS: Record<string, { label: string; key: (r: Collection) => string }> = {
  none: { label: "No grouping", key: () => "" },
  property: { label: "Property", key: (r) => r.property ?? "Not attached to a property" },
  payer: { label: "Tenant / payer", key: (r) => r.payer ?? "Unknown payer" },
  landlord: { label: "Landlord", key: (r) => r.landlord ?? "No landlord recorded" },
  purpose: { label: "Type of payment", key: (r) => r.purpose },
  channel: { label: "Channel", key: (r) => r.channel },
};
const PAYOUT_GROUPS: Record<string, { label: string; key: (r: Payout) => string }> = {
  none: { label: "No grouping", key: () => "" },
  kind: { label: "Type of payout", key: (r) => r.kind },
  payee: { label: "Payee", key: (r) => r.payee ?? "Unnamed payee" },
  property: { label: "Property", key: (r) => r.property ?? "Not attached to a property" },
  channel: { label: "Channel", key: (r) => r.channel },
};

/** `YYYY-MM-DD` as a person writes it, formatted in UTC so a boundary never shifts a day. */
function formatPeriodDate(iso: string) {
  const d = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat("en-GB", { dateStyle: "long", timeZone: "UTC" }).format(d);
}

function defaultRange() {
  const now = new Date();
  return { from: `${now.getFullYear()}-01-01`, to: now.toISOString().slice(0, 10) };
}

const n = (v: number | string | null | undefined) => Number(v ?? 0);

function groupBy<T>(rows: T[], key: (r: T) => string) {
  const out = new Map<string, T[]>();
  for (const r of rows) {
    const k = key(r);
    out.set(k, [...(out.get(k) ?? []), r]);
  }
  return Array.from(out.entries()).sort((a, b) => a[0].localeCompare(b[0]));
}

function currenciesOf(rows: { currency: string }[]) {
  return Array.from(new Set(rows.map((r) => r.currency))).sort((a, b) => (a === "NGN" ? -1 : b === "NGN" ? 1 : a.localeCompare(b)));
}

export default async function ReportsPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; to?: string; view?: string; group?: string; test?: string }>;
}) {
  const session = await getSessionProfile();
  if (!session) redirect("/login");

  const sp = await searchParams;
  const fallback = defaultRange();
  const from = sp.from || fallback.from;
  const to = sp.to || fallback.to;
  const view: View = (VIEWS.find((v) => v.key === sp.view)?.key ?? "collections") as View;
  const groups = view === "payouts" ? PAYOUT_GROUPS : COLLECTION_GROUPS;
  const group = sp.group && sp.group in groups ? sp.group : "none";
  // 0321/0323: activity reports leave test records out unless asked for. The
  // property funds, trial balance and P&L are the ledger itself and always
  // include them — a ledger report that leaves rows out does not add up.
  const showTest = sp.test === "1";
  const qs = (o: Record<string, string>) => new URLSearchParams({ from, to, view, group, ...o }).toString();
  const title = VIEWS.find((v) => v.key === view)!.label;
  const fileTag = `${title.toLowerCase().replace(/[^a-z]+/g, "-")}-${from}-to-${to}`;

  const supabase = await createClient();

  let body: React.ReactNode = null;

  if (view === "pnl") {
    const { data, error } = await supabase.rpc("org_profit_and_loss", { p_from: from, p_to: to });
    const rows = (data ?? []) as PnlRow[];
    body = error ? <Problem message={error.message} /> : rows.length === 0 ? <Nothing /> : (
      currenciesOf(rows).map((ccy) => {
        const mine = rows.filter((r) => r.currency === ccy);
        const income = mine.filter((r) => r.class === "income").reduce((a, r) => a + n(r.amount), 0);
        const expense = mine.filter((r) => r.class === "expense").reduce((a, r) => a + n(r.amount), 0);
        const net = income - expense;
        return (
          <Card key={ccy}>
            <CardHeader><CardTitle className="text-base">Profit &amp; loss — {ccy}</CardTitle></CardHeader>
            <CardContent className="p-0">
              <Table>
                <TableHeader><TableRow><TableHead>Account</TableHead><TableHead>Code</TableHead><TableHead className="text-right">Postings</TableHead><TableHead className="text-right">Amount</TableHead></TableRow></TableHeader>
                <TableBody>
                  {(["income", "expense"] as const).map((cls) => {
                    const g = mine.filter((r) => r.class === cls);
                    if (g.length === 0) return null;
                    return (
                      <Fragment key={cls}>
                        <TableRow className="bg-muted/30 hover:bg-muted/30"><TableCell colSpan={4} className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{cls}</TableCell></TableRow>
                        {g.map((r) => (
                          <TableRow key={`${cls}-${r.account_code}`}>
                            <TableCell className="font-medium">{r.account_name}</TableCell>
                            <TableCell className="font-mono text-xs text-muted-foreground">{r.account_code}</TableCell>
                            <TableCell className="text-right tabular-nums text-muted-foreground">{r.posting_count}</TableCell>
                            <TableCell className="text-right font-medium tabular-nums">{formatMoney(r.amount, ccy)}</TableCell>
                          </TableRow>
                        ))}
                      </Fragment>
                    );
                  })}
                  <TableRow className="bg-muted/40 hover:bg-muted/40">
                    <TableCell colSpan={3} className="font-semibold">Net {net >= 0 ? "surplus" : "deficit"}</TableCell>
                    <TableCell className={cn("text-right font-semibold tabular-nums", net >= 0 ? "text-success" : "text-destructive")}>{formatMoney(net, ccy)}</TableCell>
                  </TableRow>
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        );
      })
    );
  }

  if (view === "collections") {
    const { data, error } = await supabase.rpc("report_collections", { p_from: from, p_to: to });
    const all = (data ?? []) as Collection[];
    const testCount = all.filter((r) => r.is_test).length;
    const rows = showTest ? all : all.filter((r) => !r.is_test);
    const g = COLLECTION_GROUPS[group];
    const headers = ["Date", "Channel", "Type", "Property", "Unit", "Tenant / payer", "Landlord", "Currency", "Amount", "Management fee", "Landlord net", "Reference", "Test record"];
    const csv = rows.map((r) => [r.paid_on, r.channel, r.purpose, r.property, r.unit, r.payer, r.landlord, r.currency, n(r.amount), r.management_fee == null ? null : n(r.management_fee), r.landlord_net == null ? null : n(r.landlord_net), r.reference, r.is_test ? "yes" : ""]);
    body = error ? <Problem message={error.message} /> : (
      <>
        <Toolbar groups={COLLECTION_GROUPS} group={group} qs={qs} csv={<DownloadCsv filename={`${fileTag}.csv`} headers={headers} rows={csv} />} />
        <TestRecordsToggle count={testCount} />
        {rows.length === 0 ? <Nothing /> : currenciesOf(rows).map((ccy) => {
          const mine = rows.filter((r) => r.currency === ccy);
          return (
            <Card key={ccy}>
              <CardHeader className="pb-2">
                <CardTitle className="text-base">Money in — {ccy}</CardTitle>
                <CardDescription>Every payment received in the period, online and confirmed bank transfers, with the fee and landlord share as they were posted.</CardDescription>
              </CardHeader>
              <CardContent className="overflow-x-auto p-0">
                <Table>
                  <TableHeader><TableRow>
                    <TableHead>Date</TableHead><TableHead>Type</TableHead><TableHead>Channel</TableHead><TableHead>Property · unit</TableHead><TableHead>Tenant / payer</TableHead><TableHead>Landlord</TableHead>
                    <TableHead className="text-right">Amount</TableHead><TableHead className="text-right">Fee</TableHead><TableHead className="text-right">Landlord net</TableHead>
                  </TableRow></TableHeader>
                  <TableBody>
                    {groupBy(mine, g.key).map(([k, list]) => (
                      <Fragment key={k || "all"}>
                        {group !== "none" && (
                          <TableRow className="bg-muted/30 hover:bg-muted/30"><TableCell colSpan={9} className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{g.label}: {k}</TableCell></TableRow>
                        )}
                        {list.map((r, i) => (
                          <TableRow key={`${k}-${i}`}>
                            <TableCell className="whitespace-nowrap">{r.paid_on}</TableCell>
                            <TableCell>{r.purpose}</TableCell>
                            <TableCell className="whitespace-nowrap">{r.channel}</TableCell>
                            <TableCell>{r.property ?? "—"}{r.unit ? ` · ${r.unit}` : ""}</TableCell>
                            <TableCell>{r.payer ?? "—"}{r.is_test && <TestBadge />}</TableCell>
                            <TableCell>{r.landlord ?? "—"}</TableCell>
                            <TableCell className="text-right tabular-nums">{formatMoney(r.amount, ccy)}</TableCell>
                            <TableCell className="text-right tabular-nums text-muted-foreground">{r.management_fee == null ? "—" : formatMoney(r.management_fee, ccy)}</TableCell>
                            <TableCell className="text-right tabular-nums text-muted-foreground">{r.landlord_net == null ? "—" : formatMoney(r.landlord_net, ccy)}</TableCell>
                          </TableRow>
                        ))}
                        {group !== "none" && <Subtotal label={`${k} total`} cols={6} values={[sum(list, "amount"), sumNullable(list, "management_fee"), sumNullable(list, "landlord_net")]} ccy={ccy} />}
                      </Fragment>
                    ))}
                    <Subtotal label={`Total received (${ccy})`} cols={6} strong values={[sum(mine, "amount"), sumNullable(mine, "management_fee"), sumNullable(mine, "landlord_net")]} ccy={ccy} />
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          );
        })}
      </>
    );
  }

  if (view === "payouts") {
    const { data, error } = await supabase.rpc("report_payouts", { p_from: from, p_to: to });
    const all = (data ?? []) as Payout[];
    const testCount = all.filter((r) => r.is_test).length;
    const rows = showTest ? all : all.filter((r) => !r.is_test);
    const g = PAYOUT_GROUPS[group];
    const headers = ["Date", "Type", "Payee", "Property", "Channel", "Currency", "Gross", "Fees", "Net", "Reference", "Bank / gateway reference", "Test record"];
    const csv = rows.map((r) => [r.paid_on, r.kind, r.payee, r.property, r.channel, r.currency, n(r.gross), n(r.fees), n(r.net), r.reference, r.bank_reference, r.is_test ? "yes" : ""]);
    body = error ? <Problem message={error.message} /> : (
      <>
        <Toolbar groups={PAYOUT_GROUPS} group={group} qs={qs} csv={<DownloadCsv filename={`${fileTag}.csv`} headers={headers} rows={csv} />} />
        <TestRecordsToggle count={testCount} />
        {rows.length === 0 ? <Nothing /> : currenciesOf(rows).map((ccy) => {
          const mine = rows.filter((r) => r.currency === ccy);
          return (
            <Card key={ccy}>
              <CardHeader className="pb-2">
                <CardTitle className="text-base">Money out — {ccy}</CardTitle>
                <CardDescription>Every payout released in the period: vendor invoices, requisitions and landlord payouts, by the route it took.</CardDescription>
              </CardHeader>
              <CardContent className="overflow-x-auto p-0">
                <Table>
                  <TableHeader><TableRow>
                    <TableHead>Date</TableHead><TableHead>Type</TableHead><TableHead>Payee</TableHead><TableHead>Property</TableHead><TableHead>Channel</TableHead><TableHead>Bank / gateway ref</TableHead>
                    <TableHead className="text-right">Gross</TableHead><TableHead className="text-right">Fees</TableHead><TableHead className="text-right">Net paid</TableHead>
                  </TableRow></TableHeader>
                  <TableBody>
                    {groupBy(mine, g.key).map(([k, list]) => (
                      <Fragment key={k || "all"}>
                        {group !== "none" && (
                          <TableRow className="bg-muted/30 hover:bg-muted/30"><TableCell colSpan={9} className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{g.label}: {k}</TableCell></TableRow>
                        )}
                        {list.map((r, i) => (
                          <TableRow key={`${k}-${i}`}>
                            <TableCell className="whitespace-nowrap">{r.paid_on}</TableCell>
                            <TableCell>{r.kind}</TableCell>
                            <TableCell>{r.payee ?? "—"}{r.is_test && <TestBadge />}</TableCell>
                            <TableCell>{r.property ?? "—"}</TableCell>
                            <TableCell className="whitespace-nowrap">{r.channel}</TableCell>
                            <TableCell className="font-mono text-xs">{r.bank_reference ?? "—"}</TableCell>
                            <TableCell className="text-right tabular-nums">{formatMoney(r.gross, ccy)}</TableCell>
                            <TableCell className="text-right tabular-nums text-muted-foreground">{formatMoney(r.fees, ccy)}</TableCell>
                            <TableCell className="text-right tabular-nums">{formatMoney(r.net, ccy)}</TableCell>
                          </TableRow>
                        ))}
                        {group !== "none" && <Subtotal label={`${k} total`} cols={6} values={[sum(list, "gross"), sum(list, "fees"), sum(list, "net")]} ccy={ccy} />}
                      </Fragment>
                    ))}
                    <Subtotal label={`Total paid out (${ccy})`} cols={6} strong values={[sum(mine, "gross"), sum(mine, "fees"), sum(mine, "net")]} ccy={ccy} />
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          );
        })}
      </>
    );
  }

  if (view === "funds") {
    const { data, error } = await supabase.rpc("report_property_funds", { p_from: from, p_to: to });
    const rows = (data ?? []) as Fund[];
    const headers = ["Code", "Property", "Currency", "Opening", "Collected", "Spent", "Closing", "Overdrawn"];
    const csv = rows.map((r) => [r.code, r.property, r.currency, n(r.opening), n(r.collected), n(r.spent), n(r.closing), r.overdrawn ? "yes" : "no"]);
    body = error ? <Problem message={error.message} /> : (
      <>
        <div className="flex justify-end" data-print="screen-only"><DownloadCsv filename={`${fileTag}.csv`} headers={headers} rows={csv} /></div>
        {rows.length === 0 ? <Nothing /> : currenciesOf(rows).map((ccy) => {
          const mine = rows.filter((r) => r.currency === ccy);
          return (
            <Card key={ccy}>
              <CardHeader className="pb-2">
                <CardTitle className="text-base">Service-charge funds by property — {ccy}</CardTitle>
                <CardDescription>What each building&apos;s fund held at the start, collected, spent and held at the end of the period. A fund below zero spent money it never collected.</CardDescription>
              </CardHeader>
              <CardContent className="overflow-x-auto p-0">
                <Table>
                  <TableHeader><TableRow>
                    <TableHead>Property</TableHead><TableHead className="text-right">Opening</TableHead><TableHead className="text-right">Collected</TableHead>
                    <TableHead className="text-right">Spent</TableHead><TableHead className="text-right">Closing</TableHead>
                  </TableRow></TableHeader>
                  <TableBody>
                    {mine.map((r) => (
                      <TableRow key={r.account_id}>
                        <TableCell>
                          <Link href={`/dashboard/ledger/accounts/${r.account_id}`} className="font-medium hover:underline">{r.property}</Link>
                          <span className="ml-2 font-mono text-xs text-muted-foreground">{r.code}</span>
                          {r.overdrawn && <Badge variant="destructive" className="ml-2">Overdrawn</Badge>}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">{formatMoney(r.opening, ccy)}</TableCell>
                        <TableCell className="text-right tabular-nums">{formatMoney(r.collected, ccy)}</TableCell>
                        <TableCell className="text-right tabular-nums">{formatMoney(r.spent, ccy)}</TableCell>
                        <TableCell className={cn("text-right font-medium tabular-nums", r.overdrawn && "text-destructive")}>{formatMoney(r.closing, ccy)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          );
        })}
      </>
    );
  }

  if (view === "trial") {
    const { data, error } = await supabase.rpc("report_trial_balance", { p_as_at: to });
    const rows = ((data ?? []) as Trial[]).filter((r) => n(r.debits) !== 0 || n(r.credits) !== 0);
    const headers = ["Code", "Account", "Class", "Currency", "Debits", "Credits", "Balance"];
    const csv = rows.map((r) => [r.code, r.name, r.class, r.currency, n(r.debits), n(r.credits), n(r.balance)]);
    body = error ? <Problem message={error.message} /> : (
      <>
        <div className="flex justify-end" data-print="screen-only"><DownloadCsv filename={`trial-balance-as-at-${to}.csv`} headers={headers} rows={csv} /></div>
        {rows.length === 0 ? <Nothing /> : currenciesOf(rows).map((ccy) => {
          const mine = rows.filter((r) => r.currency === ccy);
          const dr = mine.reduce((a, r) => a + n(r.debits), 0);
          const cr = mine.reduce((a, r) => a + n(r.credits), 0);
          const balanced = Math.abs(dr - cr) < 0.005;
          return (
            <Card key={ccy}>
              <CardHeader className="pb-2">
                <CardTitle className="flex items-center gap-2 text-base">
                  Trial balance — {ccy}, as at {formatPeriodDate(to)}
                  <Badge variant={balanced ? "success" : "destructive"}>{balanced ? "Debits equal credits" : `Out by ${formatMoney(Math.abs(dr - cr), ccy)}`}</Badge>
                </CardTitle>
              </CardHeader>
              <CardContent className="overflow-x-auto p-0">
                <Table>
                  <TableHeader><TableRow>
                    <TableHead>Code</TableHead><TableHead>Account</TableHead><TableHead className="text-right">Debits</TableHead><TableHead className="text-right">Credits</TableHead><TableHead className="text-right">Balance</TableHead>
                  </TableRow></TableHeader>
                  <TableBody>
                    {mine.map((r) => {
                      const over = r.class === "liability" && n(r.balance) < 0;
                      return (
                        <TableRow key={r.account_id}>
                          <TableCell className="font-mono text-xs text-muted-foreground">{r.code}</TableCell>
                          <TableCell>
                            <Link href={`/dashboard/ledger/accounts/${r.account_id}`} className="hover:underline">{r.name}</Link>
                            {over && <Badge variant="destructive" className="ml-2">Overdrawn</Badge>}
                          </TableCell>
                          <TableCell className="text-right tabular-nums">{formatMoney(r.debits, ccy)}</TableCell>
                          <TableCell className="text-right tabular-nums">{formatMoney(r.credits, ccy)}</TableCell>
                          <TableCell className={cn("text-right font-medium tabular-nums", over && "text-destructive")}>{formatMoney(r.balance, ccy)}</TableCell>
                        </TableRow>
                      );
                    })}
                    <TableRow className="bg-muted/40 hover:bg-muted/40">
                      <TableCell colSpan={2} className="font-semibold">Totals</TableCell>
                      <TableCell className="text-right font-semibold tabular-nums">{formatMoney(dr, ccy)}</TableCell>
                      <TableCell className="text-right font-semibold tabular-nums">{formatMoney(cr, ccy)}</TableCell>
                      <TableCell />
                    </TableRow>
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          );
        })}
      </>
    );
  }

  return (
    <div className="space-y-6">
      <div data-print="screen-only" className="space-y-4">
        <nav className="flex flex-wrap gap-2" aria-label="Report">
          {VIEWS.map((v) => (
            <Link
              key={v.key}
              href={`/dashboard/ledger/reports?${new URLSearchParams({ from, to, view: v.key }).toString()}`}
              className={cn(
                "rounded-full border px-3 py-1 text-sm",
                v.key === view ? "border-transparent bg-[var(--brand)] font-medium text-[var(--brand-fg)]" : "hover:bg-muted"
              )}
            >
              {v.label}
            </Link>
          ))}
        </nav>
        <PeriodPicker from={from} to={to} keep={new URLSearchParams({ view, group }).toString()} />
        {view === "trial" && <p className="text-xs text-muted-foreground">The trial balance is as at the &ldquo;To&rdquo; date.</p>}
      </div>
      {/* What the controls were saying on screen, in a form paper can carry. */}
      <p data-print="print-only" className="hidden text-sm">
        <strong>{title}</strong>
        {view === "trial" ? ` · as at ${formatPeriodDate(to)}` : ` · ${formatPeriodDate(from)} to ${formatPeriodDate(to)}`}
        {group !== "none" && view !== "trial" && view !== "funds" && view !== "pnl" ? ` · grouped by ${groups[group].label.toLowerCase()}` : ""}
      </p>
      {body}
      <p className="text-xs text-muted-foreground">
        Shown separately per currency and never totalled across currencies. Rent and service charge stay on separate lines:
        rent is collected for a landlord, service charge into the building&apos;s own fund.
      </p>
    </div>
  );
}

function sum<T>(rows: T[], k: keyof T) {
  return rows.reduce((a, r) => a + n(r[k] as unknown as number), 0);
}
function sumNullable<T>(rows: T[], k: keyof T): number | null {
  const vals = rows.map((r) => r[k] as unknown as number | null).filter((v) => v != null);
  return vals.length === 0 ? null : vals.reduce((a, v) => a + n(v), 0);
}

function Subtotal({ label, cols, values, ccy, strong }: { label: string; cols: number; values: (number | null)[]; ccy: string; strong?: boolean }) {
  return (
    <TableRow className={cn(strong ? "bg-muted/50 hover:bg-muted/50" : "bg-muted/20 hover:bg-muted/20")}>
      <TableCell colSpan={cols} className={cn(strong ? "font-semibold" : "text-sm text-muted-foreground")}>{label}</TableCell>
      {values.map((v, i) => (
        <TableCell key={i} className={cn("text-right tabular-nums", strong && "font-semibold")}>{v == null ? "—" : formatMoney(v, ccy)}</TableCell>
      ))}
    </TableRow>
  );
}

function Toolbar({ groups, group, qs, csv }: {
  groups: Record<string, { label: string }>; group: string; qs: (o: Record<string, string>) => string; csv: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3" data-print="screen-only">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="text-muted-foreground">Group by</span>
        {Object.entries(groups).map(([k, g]) => (
          <Link key={k} href={`/dashboard/ledger/reports?${qs({ group: k })}`}
            className={cn("rounded-full border px-2.5 py-0.5", k === group ? "bg-muted font-medium" : "hover:bg-muted")}>
            {g.label}
          </Link>
        ))}
      </div>
      {csv}
    </div>
  );
}

function Problem({ message }: { message: string }) {
  return <EmptyState icon={<FileBarChart />} title="The report could not be produced" description={message} />;
}
function Nothing() {
  return (
    <EmptyState icon={<FileBarChart />} title="Nothing in this period"
      description="Widen the dates if you expected to see something. Online payments appear once the gateway confirms them; bank transfers once the last desk confirms them." />
  );
}
