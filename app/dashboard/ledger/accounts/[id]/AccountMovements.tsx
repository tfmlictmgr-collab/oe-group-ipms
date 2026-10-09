import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { formatMoney } from "@/lib/currency";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table, TableHeader, TableBody, TableRow, TableHead, TableCell,
} from "@/components/ui/table";

// One account, every posting, and its balance after each (0318).
//
// Asked for after the walkthrough: the Journal showed the vendor's ₦200 leave
// Akpabio 01's fund and never said the fund was then at −₦183.35. This page
// reads `ledger_posting_balances`, the same running balance the Journal now
// shows beside each line, so the two cannot disagree. It runs in the reader's
// own session: what it shows is what their ledger policies already admit.


type Account = {
  id: string; code: string; name: string; class: string; purpose: string; currency: string;
  properties: { name: string } | null;
};
type Line = {
  posting_id: string; entry_id: string; amount: number | string; natural_amount: number | string;
  balance_after: number | string; entry_date: string; entry_created_at: string;
};
type Entry = { id: string; description: string; reference: string | null; source: string };
type Override = {
  consumed_entry_id: string | null; reason: string; created_at: string;
  shortfall_covered: number | string | null; fund_balance_at_authorisation: number | string | null;
  users: { full_name: string | null } | null;
};

const PURPOSE_HELP: Record<string, string> = {
  client_funds: "The segregated bank account holding client money. Its balance is what the bank should show once every payment has settled.",
  service_charge_fund: "Service charge collected for a building, spent only on that building. Below zero means it paid out money it never collected.",
  landlord_payable: "Rent collected for landlords, net of the management fee, not yet paid out to them.",
  vendor_payable: "Approved vendor invoices not yet paid.",
  requisition_payable: "Approved requisitions not yet paid.",
  tenant_deposit: "Deposits held for tenants.",
  fee_income: "The organisation's own management and admin fees.",
  bank_charges: "Bank and gateway charges.",
  suspense: "Money received but not yet identified. It belongs to someone and must be cleared.",
};

const fmt = (d: string) =>
  new Date(d).toLocaleDateString("en-GB", { timeZone: "Africa/Lagos", day: "numeric", month: "short", year: "numeric" });

/**
 * One account's movements and running balance, read in the caller's own
 * session. Shared by the finance ledger and the property manager's Client
 * Funds (9 Oct 2026), so the two cannot disagree about a building's fund:
 * what each shows is what that reader's ledger policies admit.
 */
export default async function AccountMovements({
  id,
  backHref,
  backLabel,
}: {
  id: string;
  backHref: string;
  backLabel: string;
}) {
  const supabase = await createClient();
  const { data: account } = await supabase
    .from("ledger_accounts")
    .select("id, code, name, class, purpose, currency, properties(name)")
    .eq("id", id)
    .maybeSingle();
  if (!account) notFound();
  const a = account as unknown as Account;

  const { data: lineData } = await supabase
    .from("ledger_posting_balances")
    .select("posting_id, entry_id, amount, natural_amount, balance_after, entry_date, entry_created_at")
    .eq("account_id", id)
    .order("entry_created_at", { ascending: false })
    .limit(500);
  const lines = (lineData ?? []) as Line[];

  const entryIds = Array.from(new Set(lines.map((l) => l.entry_id)));
  const [{ data: entryData }, { data: overrideData }] = await Promise.all([
    entryIds.length
      ? supabase.from("ledger_entries").select("id, description, reference, source").in("id", entryIds)
      : Promise.resolve({ data: [] }),
    supabase
      .from("fund_overrides")
      .select("consumed_entry_id, reason, created_at, shortfall_covered, fund_balance_at_authorisation, users:authorised_by(full_name)")
      .eq("account_id", id),
  ]);
  const entries = new Map(((entryData ?? []) as Entry[]).map((e) => [e.id, e]));
  const overrides = new Map(
    ((overrideData ?? []) as unknown as Override[])
      .filter((o) => o.consumed_entry_id)
      .map((o) => [o.consumed_entry_id as string, o])
  );

  const isLiability = a.class === "liability";
  const current = lines.length ? Number(lines[0].balance_after) : 0;
  const overdrawn = isLiability && current < 0;

  return (
    <div className="space-y-6">
      <Link href={backHref} className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:underline" data-print="screen-only">
        <ArrowLeft className="size-4" /> {backLabel}
      </Link>

      <Card className={cn(overdrawn && "border-destructive/50")}>
        <CardHeader>
          <CardTitle className="flex flex-wrap items-center gap-2 text-base">
            <span className="font-mono text-sm text-muted-foreground">{a.code}</span> {a.name}
            {a.properties?.name && <Badge variant="outline">{a.properties.name}</Badge>}
            {overdrawn && <Badge variant="destructive">Overdrawn</Badge>}
          </CardTitle>
          <CardDescription>{PURPOSE_HELP[a.purpose] ?? ""}</CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">Balance now</p>
          <p className={cn("text-2xl font-semibold tabular-nums", overdrawn && "text-destructive")}>{formatMoney(current, a.currency)}</p>
          {overdrawn && (
            <p className="mt-2 text-sm text-destructive">
              This account has paid out {formatMoney(-current, a.currency)} more than it held. That money came from elsewhere in the client account and is a shortfall until it is recovered or funded.
            </p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Every movement, newest first</CardTitle>
          <CardDescription>&ldquo;In&rdquo; raises this account&apos;s balance and &ldquo;Out&rdquo; lowers it, in the account&apos;s own terms; the last column is the balance after each line.</CardDescription>
        </CardHeader>
        <CardContent className="overflow-x-auto p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Date</TableHead>
                <TableHead>What happened</TableHead>
                <TableHead className="text-right">In</TableHead>
                <TableHead className="text-right">Out</TableHead>
                <TableHead className="text-right">Balance after</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {lines.length === 0 && (
                <TableRow><TableCell colSpan={5} className="text-center text-sm text-muted-foreground">Nothing has been posted to this account yet.</TableCell></TableRow>
              )}
              {lines.map((l) => {
                const e = entries.get(l.entry_id);
                const o = overrides.get(l.entry_id);
                const nat = Number(l.natural_amount);
                const after = Number(l.balance_after);
                const red = isLiability && after < 0;
                return (
                  <TableRow key={l.posting_id}>
                    <TableCell className="whitespace-nowrap align-top">{fmt(l.entry_date)}</TableCell>
                    <TableCell className="align-top">
                      <span className="font-medium">{e?.description ?? "Entry"}</span>
                      {e?.reference && <span className="ml-2 font-mono text-xs text-muted-foreground">{e.reference}</span>}
                      {o && (
                        <p className="mt-1 rounded-md border border-warning/50 bg-warning/5 px-2 py-1 text-xs">
                          Paid under a fund override by {o.users?.full_name ?? "the Payment Officer"}
                          {o.shortfall_covered != null && <> · covered a shortfall of <b>{formatMoney(o.shortfall_covered, a.currency)}</b></>}
                          {" "}· reason: &ldquo;{o.reason}&rdquo;
                        </p>
                      )}
                    </TableCell>
                    <TableCell className="text-right align-top tabular-nums">{nat > 0 ? formatMoney(nat, a.currency) : ""}</TableCell>
                    <TableCell className="text-right align-top tabular-nums">{nat < 0 ? formatMoney(-nat, a.currency) : ""}</TableCell>
                    <TableCell className={cn("text-right align-top font-medium tabular-nums", red && "text-destructive")}>{formatMoney(after, a.currency)}</TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
      {lines.length === 500 && (
        <p className="text-xs text-muted-foreground">Showing the latest 500 movements. Use Reports → Trial balance or Property funds for a period.</p>
      )}
    </div>
  );
}
