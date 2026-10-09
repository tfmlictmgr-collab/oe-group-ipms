import Link from "next/link";
import { redirect } from "next/navigation";
import { BookOpen } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { getSessionProfile } from "@/lib/auth";
import { formatMoney } from "@/lib/currency";
import { EmptyState } from "@/components/patterns/empty-state";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

type Posting = {
  id: string;
  amount: number | string;
  memo: string | null;
  ledger_accounts: { id: string; code: string; name: string; currency: string; class: string } | null;
};

type RunningBalance = { posting_id: string; balance_after: number | string };
type Override = {
  consumed_entry_id: string;
  reason: string;
  shortfall_covered: number | string | null;
  users: { full_name: string | null } | null;
};

type Entry = {
  id: string;
  entry_date: string;
  description: string;
  reference: string | null;
  source: string;
  created_at: string;
  ledger_postings: Posting[];
};

const SOURCE_VARIANT: Record<string, "success" | "info" | "warning" | "muted" | "destructive"> = {
  collection: "success",
  remittance: "info",
  fee: "info",
  opening_balance: "muted",
  adjustment: "warning",
  reversal: "destructive",
  bank_charge: "muted",
};

const fmtDate = (d: string) =>
  new Date(d).toLocaleDateString("en-GB", {
    timeZone: "Africa/Lagos", day: "numeric", month: "short", year: "numeric",
  });

export default async function JournalPage() {
  const session = await getSessionProfile();
  if (!session) redirect("/login");

  const supabase = await createClient();
  const { data } = await supabase
    .from("ledger_entries")
    .select(
      "id, entry_date, description, reference, source, created_at, ledger_postings(id, amount, memo, ledger_accounts(id, code, name, currency, class))"
    )
    .order("entry_date", { ascending: false })
    .order("created_at", { ascending: false })
    .limit(100);

  const entries = (data as unknown as Entry[]) ?? [];

  // 0318: each account's balance AFTER each line, from the same running
  // balance the per-account page reads — so a fund going below zero is said on
  // the line that took it there, not left to be added up by hand.
  const postingIds = entries.flatMap((e) => e.ledger_postings.map((p) => p.id));
  const entryIds = entries.map((e) => e.id);
  const [{ data: balData }, { data: ovData }] = await Promise.all([
    postingIds.length
      ? supabase.from("ledger_posting_balances").select("posting_id, balance_after").in("posting_id", postingIds)
      : Promise.resolve({ data: [] }),
    entryIds.length
      ? supabase.from("fund_overrides").select("consumed_entry_id, reason, shortfall_covered, users:authorised_by(full_name)").in("consumed_entry_id", entryIds)
      : Promise.resolve({ data: [] }),
  ]);
  const balanceAfter = new Map(((balData ?? []) as RunningBalance[]).map((b) => [b.posting_id, Number(b.balance_after)]));
  const overrideFor = new Map(((ovData ?? []) as unknown as Override[]).map((o) => [o.consumed_entry_id, o]));

  if (entries.length === 0) {
    return (
      <EmptyState
        icon={<BookOpen />}
        title="Nothing posted yet"
        description="Collections, remittances and fees will appear here as they happen, each with the accounts it moved."
      />
    );
  }

  return (
    <div className="space-y-4">
      {entries.map((e) => {
        // Every entry balances by construction, so showing one side is enough
        // to convey size; both sides are listed for traceability.
        const debits = e.ledger_postings
          .filter((p) => Number(p.amount) > 0)
          .reduce((s, p) => s + Number(p.amount), 0);

        // ⚠️ An entry with NO postings moved no money, and rendering it as
        // "₦0.00" says something false: it reads as a transaction of zero
        // rather than as a line with nothing behind it.
        //
        // These exist. `assert_entry_balanced` is a trigger on
        // `ledger_postings`, so it never fires for an entry that has none —
        // "every entry balances" is trivially true of the empty set, which is
        // the one case the invariant does not actually cover. No product path
        // can create one (every posting is written by a plpgsql function in the
        // same transaction as its entry, and RLS admits only admin/finance to
        // `ledger_entries` at all); the ones on this world were left behind by
        // verification fixtures, which cannot delete them afterwards because the
        // ledger is correctly append-only.
        //
        // So they are shown for what they are rather than hidden. Hiding a row
        // from the journal to make the journal look tidy is the opposite of an
        // audit trail.
        const empty = e.ledger_postings.length === 0;
        // Every posting in one entry shares a currency — record_collection and
        // every other money-path function only ever touch one currency's
        // accounts per entry (0103) — so the first posting's account speaks
        // for the whole entry.
        const currency = e.ledger_postings[0]?.ledger_accounts?.currency ?? "NGN";

        return (
          <Card key={e.id}>
            <CardHeader className="pb-3">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <CardTitle className="text-base">{e.description}</CardTitle>
                  <CardDescription>
                    {fmtDate(e.entry_date)}
                    {e.reference ? ` · ${e.reference}` : ""}
                  </CardDescription>
                </div>
                <div className="flex flex-shrink-0 items-center gap-2">
                  <Badge variant={SOURCE_VARIANT[e.source] ?? "muted"}>
                    {e.source.replace(/_/g, " ")}
                  </Badge>
                  {empty ? (
                    <Badge variant="warning">No postings</Badge>
                  ) : (
                    <span className="font-semibold tabular-nums">{formatMoney(debits, currency)}</span>
                  )}
                </div>
              </div>
            </CardHeader>
            <CardContent>
              {empty && (
                <p className="rounded-md border border-dashed border-warning/50 bg-warning/5 px-3 py-2 text-xs text-muted-foreground">
                  This entry has no postings, so no money moved against it. It
                  cannot be removed — the ledger is append-only — and it is shown
                  rather than hidden, because a journal that quietly drops rows is
                  not a record.
                </p>
              )}
              {overrideFor.get(e.id) && (() => {
                const o = overrideFor.get(e.id)!;
                return (
                  <p className="mb-2 rounded-md border border-warning/50 bg-warning/5 px-3 py-2 text-xs">
                    Paid under a fund override by {o.users?.full_name ?? "the Payment Officer"}
                    {o.shortfall_covered != null && <> · the fund was short by <b>{formatMoney(o.shortfall_covered, currency)}</b>, paid from other money in the client account</>}
                    {" "}· reason: &ldquo;{o.reason}&rdquo;
                  </p>
                );
              })()}
              <ul className="space-y-1.5">
                {e.ledger_postings.map((p) => {
                  const amt = Number(p.amount);
                  const isDebit = amt > 0;
                  const after = balanceAfter.get(p.id);
                  const overdrawn = p.ledger_accounts?.class === "liability" && after != null && after < 0;
                  return (
                    <li
                      key={p.id}
                      className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-muted/40 px-3 py-2 text-sm"
                    >
                      <span className="min-w-0 truncate">
                        <span className="font-mono text-xs text-muted-foreground">
                          {p.ledger_accounts?.code}
                        </span>{" "}
                        {p.ledger_accounts ? (
                          <Link href={`/dashboard/ledger/accounts/${p.ledger_accounts.id}`} className="hover:underline">
                            {p.ledger_accounts.name}
                          </Link>
                        ) : null}
                        {p.memo && (
                          <span className="ml-2 text-xs text-muted-foreground">— {p.memo}</span>
                        )}
                      </span>
                      <span className="flex flex-shrink-0 items-center gap-3">
                        <span className="text-xs uppercase tracking-wide text-muted-foreground">
                          {isDebit ? "Dr" : "Cr"}
                        </span>
                        <span className="tabular-nums">{formatMoney(Math.abs(amt), currency)}</span>
                        {after != null && (
                          <span className={overdrawn ? "text-xs font-semibold tabular-nums text-destructive" : "text-xs tabular-nums text-muted-foreground"}>
                            → {formatMoney(after, currency)}{overdrawn ? " overdrawn" : ""}
                          </span>
                        )}
                      </span>
                    </li>
                  );
                })}
              </ul>
            </CardContent>
          </Card>
        );
      })}

      <p className="text-xs text-muted-foreground">
        Showing the most recent {entries.length} entries. The figure after each arrow
        is that account&apos;s balance after the line. Entries cannot be edited
        or deleted — a correction is posted as a reversing entry, so both remain
        visible.
      </p>
    </div>
  );
}
