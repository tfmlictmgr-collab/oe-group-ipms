"use client";

import * as React from "react";
import { Home, Wallet } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/patterns/empty-state";
import { formatMoney, totalsByCurrency } from "@/lib/currency";
import RentCharges, { type RentChargeRow } from "./RentCharges";

export type Tenancy = {
  lease_id: string;
  property_name: string;
  unit_label: string;
  status: string;
  end_date: string;
  rent_outstanding: number | string;
  currency: string;
};

// My Rent, for somebody who holds more than one home.
//
// Reported from the live portal: the tenancy cards were inert, so the one thing
// on the page styled as a fact about YOUR home did nothing, and every demand for
// every tenancy was rendered in one flat list below them — 39 of them on the
// account in the report, with the paid ones mixed among the unpaid and the Pay
// button a long scroll away.
//
// ⚠️ Nothing here changes what a tenant may see. `my_rent_charges()` already
// returned exactly their own demands and still does; this narrows what is
// DISPLAYED, on the client, from a list the server had already scoped. That is
// the same line decision 24 drew when it moved the FM's default view — a
// narrowing of what the query released, never a widening.

const fmtDate = (d: string | null) =>
  d ? new Date(d).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) : "—";

type Tab = "outstanding" | "paid";
type Pane = "demands" | "homes";

export default function RentBoard({
  tenancies,
  charges,
}: {
  tenancies: Tenancy[];
  charges: RentChargeRow[];
}) {
  // `null` means every home. Deliberately the default: a tenant with one home
  // must not have to choose it, and one with several is looking at a total
  // first.
  const [lease, setLease] = React.useState<string | null>(null);
  const [tab, setTab] = React.useState<Tab>("outstanding");
  // Opens on the demands: paying is the job, and the homes grid is a filter.
  const [pane, setPane] = React.useState<Pane>("demands");
  const listRef = React.useRef<HTMLDivElement>(null);

  const forLease = React.useMemo(
    () => (lease ? charges.filter((c) => c.lease_id === lease) : charges),
    [charges, lease]
  );

  const outstanding = forLease.filter((c) => Number(c.outstanding) > 0);
  const paid = forLease.filter((c) => Number(c.outstanding) <= 0);
  const shown = tab === "outstanding" ? outstanding : paid;

  // Per currency, never one total — see totalsByCurrency.
  const owedText = totalsByCurrency(outstanding.map((c) => ({ amount: c.outstanding, currency: c.currency })));

  function chooseLease(id: string | null) {
    setLease(id);
    // ⚠️ Switch panes too. On the tabbed layout the filtered list is on the OTHER
    // tab, so staying put would make the tap look like it did nothing.
    setPane("demands");
    // Land on whichever tab actually has something in it, so clicking a
    // fully-settled home does not show an empty "Outstanding" and read as a
    // broken filter.
    const scoped = id ? charges.filter((c) => c.lease_id === id) : charges;
    setTab(scoped.some((c) => Number(c.outstanding) > 0) ? "outstanding" : "paid");
    // The whole point of the report: the demands, and the Pay button, without a
    // scroll. `smooth` is skipped for anyone who has asked not to be moved.
    const smooth = !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    listRef.current?.scrollIntoView({ behavior: smooth ? "smooth" : "auto", block: "start" });
  }

  return (
    <div className="space-y-6">
      {/* ⚠️ TWO TOP-LEVEL TABS, not two stacked sections.
          Reported twice. The homes grid and the demands list were both on the
          page at once, and on the account in the report that is NINETEEN cards
          before the first demand — so the actionable half of the screen was
          permanently below the fold. Tabs mean the page opens on the thing you
          came to do, and the homes are one tap away rather than a scroll past.
          "Demands" is the default for the same reason: paying is the job. */}
      {tenancies.length > 1 && (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant={pane === "demands" ? "default" : "outline"}
            onClick={() => setPane("demands")}
          >
            Demands ({charges.length})
          </Button>
          <Button
            size="sm"
            variant={pane === "homes" ? "default" : "outline"}
            onClick={() => setPane("homes")}
          >
            My homes ({tenancies.length})
          </Button>
        </div>
      )}

      {tenancies.length > 0 && (pane === "homes" || tenancies.length === 1) && (
        <div>
          {tenancies.length > 1 && (
            <div className="mb-3 flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                variant={lease === null ? "default" : "outline"}
                onClick={() => chooseLease(null)}
              >
                All homes ({tenancies.length})
              </Button>
              <span className="text-xs text-muted-foreground">
                or pick one to see just its demands
              </span>
            </div>
          )}

          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {tenancies.map((t) => {
              const selected = lease === t.lease_id;
              const due = Number(t.rent_outstanding);
              return (
                // ⚠️ A real <button>, not a div with an onClick. This is the
                // control the report asked for, and a control that keyboard and
                // screen-reader users cannot reach is not a control.
                <button
                  key={t.lease_id}
                  type="button"
                  onClick={() => chooseLease(selected ? null : t.lease_id)}
                  aria-pressed={selected}
                  className="text-left"
                >
                  <Card
                    className={`h-full transition hover:border-primary/60 hover:shadow-sm ${
                      selected ? "border-primary ring-1 ring-primary/30" : ""
                    }`}
                  >
                    <CardContent className="space-y-1 p-4">
                      <p className="flex items-center gap-2 text-sm font-medium">
                        <Home className="size-4 text-muted-foreground" />
                        {t.property_name}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        Unit {t.unit_label} · tenancy ends {fmtDate(t.end_date)}
                      </p>
                      <p className="pt-1 text-lg font-semibold tabular-nums">
                        {formatMoney(due, t.currency)}
                        <span className="ml-1.5 text-xs font-normal text-muted-foreground">
                          outstanding
                        </span>
                      </p>
                      <p className="pt-1 text-xs font-medium text-primary">
                        {selected ? "Showing this home — tap to clear" : "See demands and pay →"}
                      </p>
                    </CardContent>
                  </Card>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {(pane === "demands" || tenancies.length <= 1) && (
      <div ref={listRef} className="scroll-mt-4 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              variant={tab === "outstanding" ? "default" : "outline"}
              onClick={() => setTab("outstanding")}
            >
              Outstanding ({outstanding.length})
            </Button>
            <Button
              size="sm"
              variant={tab === "paid" ? "default" : "outline"}
              onClick={() => setTab("paid")}
            >
              Paid ({paid.length})
            </Button>
          </div>
          {lease && (
            <p className="text-xs text-muted-foreground">
              {tenancies.find((t) => t.lease_id === lease)?.property_name} ·{" "}
              <button
                type="button"
                onClick={() => chooseLease(null)}
                className="underline underline-offset-2"
              >
                show all homes
              </button>
            </p>
          )}
        </div>

        {tab === "outstanding" && outstanding.length > 0 && (
          <p className="text-sm text-muted-foreground">
            {owedText} outstanding across {outstanding.length} demand
            {outstanding.length === 1 ? "" : "s"}
            {lease ? " on this home" : ""}.
          </p>
        )}

        {shown.length === 0 ? (
          <EmptyState
            icon={<Wallet className="size-6" />}
            title={tab === "outstanding" ? "Nothing outstanding" : "Nothing paid yet"}
            description={
              tab === "outstanding"
                ? lease
                  ? "This home is up to date. Nothing is due on it."
                  : "You are up to date — no rent demand is outstanding."
                : "Once a demand is settled it moves here, with its receipt."
            }
          />
        ) : (
          <RentCharges charges={shown} />
        )}
      </div>
      )}
    </div>
  );
}
