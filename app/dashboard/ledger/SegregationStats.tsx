"use client";

import { Wallet, Landmark, TriangleAlert, CheckCircle2 } from "lucide-react";
import { StatCard } from "@/components/patterns/stat-card";
import { RecordDrawer, useDrawer, type DrawerRecord } from "@/components/patterns/record-drawer";
import { formatMoney } from "@/lib/currency";

export type Balance = {
  account_id: string;
  code: string;
  name: string;
  class: string;
  purpose: string;
  natural_balance: number | string;
  posting_count: number;
  currency: string;
};

// Which accounts compose each side of the segregation position. Mirrors what
// `client_funds_position` sums, so the drawer explains the same figure the
// tile shows rather than a similar one computed differently.
const HELD_PURPOSES = ["client_funds"];
const OWED_PURPOSES = ["service_charge_fund", "landlord_payable", "vendor_payable", "tenant_deposit", "requisition_payable"];

/**
 * The three segregation tiles, each opening onto the accounts behind it.
 *
 * ⚠️ The figure that matters most on this screen is the shortfall, and until
 * now it was a number with no way to ask "which account?". The account
 * balances were already on the page in the table below — the drawer puts the
 * composition next to the figure it explains, which is the difference between
 * spotting a shortfall and being able to act on one.
 *
 * No fetch: `balances` is what the server component already loaded, and the
 * grouping below is the same one `client_funds_position` applies in SQL.
 */
export default function SegregationStats({
  currency,
  held,
  owed,
  unallocated,
  balances,
}: {
  currency: string;
  held: number;
  owed: number;
  unallocated: number;
  balances: Balance[];
}) {
  const drawer = useDrawer();
  const shortfall = unallocated < 0;

  const rows = (purposes: string[]): DrawerRecord[] =>
    balances
      .filter((b) => purposes.includes(b.purpose))
      .sort((a, b) => Math.abs(Number(b.natural_balance)) - Math.abs(Number(a.natural_balance)))
      .map((b) => ({
        id: b.account_id,
        title: `${b.code} · ${b.name}`,
        meta: `${formatMoney(Number(b.natural_balance), b.currency)} · ${b.posting_count} posting${b.posting_count === 1 ? "" : "s"}`,
      }));

  return (
    <>
      <div className="grid gap-4 sm:grid-cols-3">
        <StatCard
          label="Funds held" value={formatMoney(held, currency)} icon={<Wallet />}
          onClick={() => drawer.open({
            eyebrow: `Segregation · ${currency}`, title: "Funds held",
            scope: "The client-funds bank account(s) backing everything owed",
            facts: [["Total held", formatMoney(held, currency)]],
            records: rows(HELD_PURPOSES),
            emptyLabel: "No client-funds account configured for this currency.",
          })}
        />
        <StatCard
          label="Owed to clients" value={formatMoney(owed, currency)} icon={<Landmark />}
          onClick={() => drawer.open({
            eyebrow: `Segregation · ${currency}`, title: "Owed to clients",
            scope: "Every liability the funds held must cover",
            facts: [["Total owed", formatMoney(owed, currency)]],
            records: rows(OWED_PURPOSES),
            emptyLabel: "Nothing currently owed in this currency.",
          })}
        />
        <StatCard
          label={shortfall ? "Shortfall" : "Unallocated"}
          value={formatMoney(unallocated, currency)}
          icon={shortfall ? <TriangleAlert /> : <CheckCircle2 />}
          hint={shortfall ? "must be zero or positive" : "earned fees not yet swept"}
          onClick={() => drawer.open({
            eyebrow: `Segregation · ${currency}`,
            title: shortfall ? "Shortfall" : "Unallocated",
            scope: shortfall
              ? "Liabilities exceed funds held — investigate before any further disbursement"
              : "Held funds beyond what is owed: earned fees not yet swept",
            facts: [
              ["Funds held", formatMoney(held, currency)],
              ["Owed to clients", formatMoney(owed, currency)],
              [shortfall ? "Shortfall" : "Unallocated", formatMoney(unallocated, currency)],
            ],
            // Both sides, because a shortfall is a statement about the
            // RELATIONSHIP between them — showing one alone would not let
            // anyone find where it came from.
            records: [...rows(HELD_PURPOSES), ...rows(OWED_PURPOSES)],
            emptyLabel: "No accounts in this currency yet.",
          })}
        />
      </div>
      <RecordDrawer state={drawer.state} onClose={drawer.close} />
    </>
  );
}
