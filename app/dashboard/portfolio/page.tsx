import { redirect } from "next/navigation";
import { Building, Banknote, Wallet, PiggyBank } from "lucide-react";
import { getSessionProfile } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { formatNaira, formatMoney } from "@/lib/currency";
import { PageHeader } from "@/components/patterns/page-header";
import { StatCard } from "@/components/patterns/stat-card";
import { EmptyState } from "@/components/patterns/empty-state";
import { StatusBadge } from "@/components/patterns/status-badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
  charges: number;
  demanded: number | string;
  collected: number | string;
  fees: number | string;
  landlord_share: number | string;
  remitted: number | string;
  still_held: number | string;
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

  const collected = statement.reduce((a, r) => a + Number(r.collected), 0);
  const fees = statement.reduce((a, r) => a + Number(r.fees), 0);
  const remitted = statement.reduce((a, r) => a + Number(r.remitted), 0);
  const held = statement.reduce((a, r) => a + Number(r.still_held), 0);

  return (
    <div className="space-y-6">
      <PageHeader
        title="My Portfolio"
        description={`${properties.length} propert${properties.length === 1 ? "y" : "ies"} · statement for ${from} to ${to}.`}
      />

      {properties.length === 0 ? (
        <EmptyState
          icon={<Building />}
          title="No properties recorded against your account"
          description="If that looks wrong, contact your property manager — ownership is recorded against the property register."
        />
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <StatCard label="Rent collected" value={formatNaira(collected)} icon={<Banknote />} />
            <StatCard label="Management & admin fees" value={formatNaira(fees)} icon={<Wallet />} />
            <StatCard label="Remitted to you" value={formatNaira(remitted)} icon={<PiggyBank />} />
            {/* The number an owner actually rings about. Held is money that has
                been collected from a tenant, is net of fees, and has not
                reached them yet — distinct from "not yet collected", which is
                not owed to them at all. */}
            <StatCard label="Held for you" value={formatNaira(held)} icon={<Wallet />} />
          </div>

          {statement.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Statement by property</CardTitle>
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
