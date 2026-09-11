import { redirect } from "next/navigation";
import { Building } from "lucide-react";
import { getSessionProfile } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { formatNaira, formatMoney } from "@/lib/currency";
import { PageHeader } from "@/components/patterns/page-header";
import { EmptyState } from "@/components/patterns/empty-state";
import PortfolioStats from "./PortfolioStats";
import PeriodPicker from "../ledger/reports/PeriodPicker";
import { PrintButton } from "@/components/patterns/print-button";
import { PrintMasthead } from "@/components/patterns/print-masthead";
import { roleLabel } from "@/lib/roles";
import { StatusBadge } from "@/components/patterns/status-badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table, TableHeader, TableBody, TableRow, TableHead, TableCell,
} from "@/components/ui/table";

// The owner's own portfolio — what it earned, what was taken, what has reached
// them and what has not.
//
// Deck lane E asks for a portfolio dashboard, financial reports and "receive
// remittance". The owner had the first in part (Properties and Analytics, both
// RLS-scoped to what they own) and neither of the others.
//
// ⚠️ `landlord_statement()` was written in migration 0130 during the finance
// build and wired to nothing — the same defect that turn was closing elsewhere,
// committed in the same breath. It is a report about the owner's money that the
// owner could not open.
//
// And the Statements screen was actively wrong for them: it branches on staff
// vs not-staff, and a property owner is not staff, so they were shown the
// TENANT view — service charges billed TO them. An owner is not billed; they
// are paid. The page answered a question they had not asked.

export const dynamic = "force-dynamic";

type StatementRow = {
  property_id: string;
  property_name: string;
  currency: string;
  // 0233. How many currencies this property was actually let in over the
  // period. The rent columns are ONE of them — filtered, not summed across all
  // and labelled with the commonest, which is what they were until 0233.
  rent_currencies: number;
  charges: number;
  demanded: number | string;
  collected: number | string;
  fees: number | string;
  landlord_share: number | string;
  remitted: number | string;
  still_held: number | string;
  // 0230. The fund's side of the same buildings — billed to the units, spent on
  // the property. Reported beside the rent and never added to it.
  sc_invoices: number;
  sc_billed: number | string;
  sc_collected: number | string;
  sc_outstanding: number | string;
};

type Remittance = {
  id: string;
  reference: string;
  period: string | null;
  net_amount: number | string;
  currency: string;
  status: string;
  created_at: string;
  sent_at: string | null;
};

const fmtDate = (d: string | null) =>
  d
    ? new Date(d).toLocaleDateString("en-GB", {
        timeZone: "Africa/Lagos", day: "numeric", month: "short", year: "numeric",
      })
    : "—";

export default async function PortfolioPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; to?: string }>;
}) {
  const session = await getSessionProfile();
  if (!session) redirect("/login");

  const sp = await searchParams;
  const now = new Date();
  const from = sp.from || `${now.getFullYear()}-01-01`;
  const to = sp.to || `${now.getFullYear()}-12-31`;

  const supabase = await createClient();

  const [propsRes, stmtRes, remRes] = await Promise.all([
    // RLS scopes this to properties they are a stakeholder of — no filter here
    // on purpose, so if a policy were ever loosened this page widens visibly
    // rather than masking it.
    supabase.from("properties").select("id, name, address").order("name"),
    supabase.rpc("landlord_statement", {
      p_landlord_user_id: session.user.id,
      p_from: from,
      p_to: to,
    }),
    supabase
      .from("remittances")
      .select("id, reference, period, net_amount, currency, status, created_at, sent_at")
      .eq("party", "landlord")
      .order("created_at", { ascending: false })
      .limit(50),
  ]);

  const properties = (propsRes.data ?? []) as { id: string; name: string; address: string | null }[];
  const statement = (stmtRes.data ?? []) as StatementRow[];
  const remittances = (remRes.data ?? []) as Remittance[];

  // The tiles compute their own sums (PortfolioStats), but this one is still
  // needed HERE: the empty-remittances message below turns on it, to tell
  // "nothing has been sent" apart from "nothing is owed".
  const held = statement.reduce((a, r) => a + Number(r.still_held), 0);

  const scBilled = statement.reduce((a, r) => a + Number(r.sc_billed), 0);
  const scCollected = statement.reduce((a, r) => a + Number(r.sc_collected), 0);
  const scOutstanding = statement.reduce((a, r) => a + Number(r.sc_outstanding), 0);
  const hasServiceCharge = statement.some((r) => Number(r.sc_invoices) > 0);

  // Whoever the RLS-scoped reads above already let in prints exactly what they
  // are looking at — the same rule the ledger's own print follows. An owner
  // prints their portfolio; oversight opening this prints the same page.
  const printedBy = session.profile?.full_name || session.profile?.email || undefined;
  const printedByLine = printedBy
    ? `${printedBy} · ${roleLabel(session.profile?.role, session.org?.delivery_brand)}`
    : undefined;

  return (
    <div className="printable space-y-6">
      {/* A landlord statement is the page most likely to be printed and posted
          to someone — and until now it was the one financial surface with no
          masthead, so a printed copy carried no org, no period and no date. */}
      <PrintMasthead
        org={session.org?.name ?? "Portfolio"}
        title="Landlord statement"
        subtitle={`${from} to ${to}`}
        by={printedByLine}
      />
      <div data-print="screen-only">
        <PageHeader
          title="My Portfolio"
          description={`${properties.length} propert${properties.length === 1 ? "y" : "ies"} · statement for ${from} to ${to}.`}
          actions={<PrintButton />}
        />
        {properties.length > 0 && (
          <div className="mt-4">
            {/* The page has read `from`/`to` off the URL since it was written
                and offered no way to set them, so every landlord saw the
                current calendar year and could reach no other period without
                editing the address bar. */}
            <PeriodPicker from={from} to={to} basePath="/dashboard/portfolio" />
          </div>
        )}
      </div>

      {properties.length === 0 ? (
        <EmptyState
          icon={<Building />}
          title="No properties recorded against your account"
          description="If that looks wrong, contact your property manager — ownership is recorded against the property register."
        />
      ) : (
        <>
          {/* "Held for you" is the number an owner actually rings about: money
              collected from a tenant, net of fees, that has not reached them
              yet — distinct from "not yet collected", which is not owed to
              them at all. Each tile opens onto its own per-property split. */}
          <PortfolioStats statement={statement} from={from} to={to} />

          {statement.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Rent by property</CardTitle>
                <CardDescription>
                  What was demanded, what came in, and what of it is yours. Fees
                  are apportioned to rent actually collected, at the rate in
                  force when each demand was raised.
                </CardDescription>
              </CardHeader>
              <CardContent className="p-0">
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Property</TableHead>
                        <TableHead className="text-right">Demanded</TableHead>
                        <TableHead className="text-right">Collected</TableHead>
                        <TableHead className="text-right">Fees</TableHead>
                        <TableHead className="text-right">Your share</TableHead>
                        <TableHead className="text-right">Remitted</TableHead>
                        <TableHead className="text-right">Still held</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {statement.map((r) => (
                        <TableRow key={r.property_id}>
                          <TableCell className="font-medium">{r.property_name}</TableCell>
                          <TableCell className="text-right tabular-nums text-muted-foreground">
                            {formatNaira(r.demanded)}
                          </TableCell>
                          <TableCell className="text-right tabular-nums">
                            {formatNaira(r.collected)}
                          </TableCell>
                          <TableCell className="text-right tabular-nums text-muted-foreground">
                            {formatNaira(r.fees)}
                          </TableCell>
                          <TableCell className="text-right font-medium tabular-nums">
                            {formatNaira(r.landlord_share)}
                          </TableCell>
                          <TableCell className="text-right tabular-nums text-success">
                            {formatNaira(r.remitted)}
                          </TableCell>
                          <TableCell className="text-right tabular-nums text-warning">
                            {formatNaira(r.still_held)}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </CardContent>
            </Card>
          )}

          {/* ⚠️ SERVICE CHARGE IS A SEPARATE CARD, AND THAT IS THE POINT.
              Rent is collected FOR the owner and remitted to them net of fees;
              service charge is collected INTO a fund the building spends on
              itself. Adding them produces a figure that means nothing — the
              0103 mistake, which this codebase has already made once at scale
              on the one screen built to catch it. `property_statement` refuses
              the same sum, and so does this.

              Until 0230 `landlord_statement` carried no service-charge column
              at all, so an owner's own screen and their building's statement
              gave different accounts of the same property: measured live,
              Parkview Terraces showed ₦71,000,000 billed and ₦18,000,000
              collected to a manager, and nothing whatever to its landlord. */}
          {hasServiceCharge && (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Service charge by property</CardTitle>
                <CardDescription>
                  Billed to the units and spent on the building. Shown apart from
                  the rent above and never added to it — this is the fund&apos;s
                  money, not yours to be remitted.
                </CardDescription>
              </CardHeader>
              <CardContent className="p-0">
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Property</TableHead>
                        <TableHead className="text-right">Invoices</TableHead>
                        <TableHead className="text-right">Billed</TableHead>
                        <TableHead className="text-right">Collected</TableHead>
                        <TableHead className="text-right">Outstanding</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {statement
                        .filter((r) => Number(r.sc_invoices) > 0)
                        .map((r) => (
                          <TableRow key={r.property_id}>
                            <TableCell className="font-medium">{r.property_name}</TableCell>
                            <TableCell className="text-right tabular-nums text-muted-foreground">
                              {r.sc_invoices}
                            </TableCell>
                            <TableCell className="text-right tabular-nums">
                              {formatMoney(r.sc_billed, r.currency)}
                            </TableCell>
                            <TableCell className="text-right tabular-nums text-success">
                              {formatMoney(r.sc_collected, r.currency)}
                            </TableCell>
                            <TableCell className="text-right tabular-nums text-warning">
                              {formatMoney(r.sc_outstanding, r.currency)}
                            </TableCell>
                          </TableRow>
                        ))}
                      <TableRow className="bg-muted/40 hover:bg-muted/40">
                        <TableCell colSpan={2} className="font-semibold">Total</TableCell>
                        <TableCell className="text-right font-semibold tabular-nums">
                          {formatNaira(scBilled)}
                        </TableCell>
                        <TableCell className="text-right font-semibold tabular-nums">
                          {formatNaira(scCollected)}
                        </TableCell>
                        <TableCell className="text-right font-semibold tabular-nums">
                          {formatNaira(scOutstanding)}
                        </TableCell>
                      </TableRow>
                    </TableBody>
                  </Table>
                </div>
              </CardContent>
            </Card>
          )}

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Remittances to you</CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              {remittances.length === 0 ? (
                <p className="p-4 text-sm text-muted-foreground">
                  {/* Distinguishes "nothing has been sent" from "nothing is
                      owed" — an owner reading an empty list wants to know
                      which. */}
                  {held > 0
                    ? `Nothing has been sent yet. ${formatNaira(held)} is currently held for you.`
                    : "No remittances yet. Rent reaches you once it has been collected from a tenant."}
                </p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Reference</TableHead>
                      <TableHead>Period</TableHead>
                      <TableHead>Sent</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead className="text-right">Amount</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {remittances.map((r) => (
                      <TableRow key={r.id}>
                        <TableCell className="font-mono text-xs">{r.reference}</TableCell>
                        <TableCell className="text-muted-foreground">
                          {r.period ?? "—"}
                        </TableCell>
                        <TableCell className="text-muted-foreground">
                          {fmtDate(r.sent_at ?? r.created_at)}
                        </TableCell>
                        <TableCell>
                          <StatusBadge status={r.status} />
                        </TableCell>
                        <TableCell className="text-right font-medium tabular-nums">
                          {formatMoney(r.net_amount, r.currency)}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>

          <div className="space-y-1.5">
            <p className="text-sm font-medium">Your properties</p>
            <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {properties.map((p) => (
                <li key={p.id}>
                  <Card>
                    <CardContent className="p-4">
                      <p className="font-medium">{p.name}</p>
                      <p className="text-xs text-muted-foreground">
                        {p.address ?? "No address recorded"}
                      </p>
                    </CardContent>
                  </Card>
                </li>
              ))}
            </ul>
          </div>
        </>
      )}
    </div>
  );
}
