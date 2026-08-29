import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { getSessionProfile } from "@/lib/auth";
import { apportion, type ApportionMethod } from "@/lib/apportionment";
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
import ApportionmentControls from "./ApportionmentControls";

const METHOD_LABEL: Record<ApportionMethod, string> = {
  area: "pro-rata by occupied space",
  equal: "split equally per unit",
  manual: "stated per unit",
};

export default async function BudgetDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const session = await getSessionProfile();
  if (!session) redirect("/login");

  const supabase = await createClient();
  const { data: rawBudget } = await supabase
    .from("sc_budgets")
    .select(
      "id, period, description, total_amount, status, property_id, apportion_method, " +
      "properties(name, address)"
    )
    .eq("id", id)
    .maybeSingle();
  if (!rawBudget) notFound();

  // `apportion_method` is new in 0227 and not in the generated types yet, so the
  // client types the whole row as an error. Narrowed once here rather than at
  // every field, the same way the tenancy page handles its aliased embed.
  const budget = rawBudget as unknown as {
    id: string;
    period: string;
    description: string | null;
    total_amount: number | string;
    status: string;
    property_id: string;
    apportion_method: ApportionMethod | null;
    properties: { name: string; address: string | null } | null;
  };

  const method = (budget.apportion_method ?? "area") as ApportionMethod;

  const property = budget.properties as unknown as {
    name: string;
    address: string | null;
  } | null;

  const [{ data: units }, { data: stated }, { data: canManageData }] = await Promise.all([
    supabase
      .from("units")
      .select("id, label, apportionment_factor, unit_quantity, occupant_user_id")
      .eq("property_id", budget.property_id)
      .is("deleted_at", null)
      .order("label"),
    // Read whatever the method, so switching to `manual` shows work stated
    // earlier rather than a blank form. `apportion()` ignores these unless the
    // method is manual, so a stale set cannot leak into a computed split.
    supabase.from("sc_budget_shares").select("unit_id, amount").eq("budget_id", id),
    // ⚠️ Asked of the database rather than restated as a role list. This was
    // `role === 'admin' || role === 'finance_approver'`, which happens to be
    // exactly who holds `sc.manage` today — but `sc_budgets_write` asks the
    // permission, and decision 7 makes the matrix the authority. Two copies of
    // one rule is how they drift; there is now one.
    supabase.rpc("has_permission", { p_capability: "sc.manage" }),
  ]);

  const statedBy = new Map(
    (stated ?? []).map((s) => [s.unit_id as string, Number(s.amount)])
  );

  const unitInputs = (units ?? []).map((u) => ({
    id: u.id,
    label: u.label,
    factor: Number(u.apportionment_factor),
    // 0198: the area is PER unit, so a row of 12 stalls weighs 12x it.
    quantity: Number(u.unit_quantity ?? 1),
    occupant_user_id: u.occupant_user_id,
    statedAmount: statedBy.get(u.id) ?? null,
  }));

  const shares = apportion(Number(budget.total_amount), unitInputs, method);
  const sharesTotal = shares.reduce((a, s) => a + s.amount, 0);

  // What the area split WOULD give, shown beside each manual input as a
  // reference point. A person stating shares by hand is departing from a
  // convention, and departing from it knowingly is the difference between a
  // negotiated split and a typo.
  const byArea = new Map(
    apportion(Number(budget.total_amount), unitInputs, "area").map((s) => [s.id, s.amount])
  );

  const canManage = Boolean(canManageData);

  // ⚠️ Read from `sc_manual_shares_state()` — the SAME function the server
  // action calls to refuse generation, and the same one the editor above shows
  // its running variance from. Three consumers, one answer, so the button, the
  // variance and the refusal cannot tell three different stories.
  //
  // Disabled rather than hidden, on the pattern the payouts page already uses
  // for a control finance may see and not press: a missing button is a mystery,
  // a disabled one with a reason is an instruction.
  let blockedReason: string | null = null;
  if (method === "manual" && budget.status !== "invoiced") {
    const { data: stateRows } = await supabase.rpc("sc_manual_shares_state", {
      p_budget_id: budget.id,
    });
    const st = (Array.isArray(stateRows) ? stateRows[0] : stateRows) as {
      variance: number; missing_units: number; reconciles: boolean;
    } | null;
    if (!st?.reconciles) {
      const missing = Number(st?.missing_units ?? 0);
      const variance = Number(st?.variance ?? 0);
      blockedReason =
        missing > 0
          ? `${missing} unit${missing === 1 ? " has" : "s have"} no stated share`
          : `the stated shares are ${formatNaira(Math.abs(variance))} ${variance > 0 ? "short of" : "over"} the budget`;
    }
  }

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

      {canManage && (
        <ApportionmentControls
          budgetId={budget.id}
          method={method}
          budgetTotal={Number(budget.total_amount)}
          invoiced={budget.status === "invoiced"}
          units={unitInputs.map((u) => ({
            id: u.id,
            label: u.label,
            factor: u.factor,
            quantity: u.quantity,
            stated: u.statedAmount,
            computed: byArea.get(u.id) ?? 0,
          }))}
        />
      )}

      <Card>
        <CardHeader>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <CardTitle className="text-base">
              Apportionment
              <span className="ml-2 font-normal text-muted-foreground">
                {shares.length} units, {METHOD_LABEL[method]}
              </span>
            </CardTitle>
            {canManage && (
              <GenerateButton
                budgetId={budget.id}
                alreadyInvoiced={budget.status === "invoiced"}
                blockedReason={blockedReason}
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

      {/* ⚠️ Conditional, because the flat version was a lie on a manual split.
          It read "Apportionment reconciles to the budget total exactly" above a
          table of ₦0.00 — true of the computed methods, which reconcile by
          construction, and false of a stated one that nobody has finished. A
          standing reassurance under a figure that contradicts it is the same
          fault as a total that disagrees with its own rows. */}
      <p className="text-xs text-muted-foreground">
        {method === "manual" ? (
          blockedReason ? (
            <>
              This split does not yet account for the budget — {blockedReason}. Nothing
              can be invoiced until it does, because a short set would silently
              under-bill the property.
            </>
          ) : (
            <>
              These are the shares stated by hand, and they account for the budget
              exactly. Generating invoices creates a per-unit charge on each
              occupant&apos;s statement.
            </>
          )
        ) : (
          <>
            Apportionment reconciles to the budget total exactly — the rounding
            residual is placed on the largest unit rather than lost. Generating
            invoices creates a per-unit charge on each occupant&apos;s statement.
          </>
        )}
      </p>
    </div>
  );
}
