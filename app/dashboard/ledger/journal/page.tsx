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
  ledger_accounts: { code: string; name: string; currency: string } | null;
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
      "id, entry_date, description, reference, source, created_at, ledger_postings(id, amount, memo, ledger_accounts(code, name, currency))"
    )
    .order("entry_date", { ascending: false })
    .order("created_at", { ascending: false })
    .limit(100);

  const entries = (data as unknown as Entry[]) ?? [];

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
                  <span className="font-semibold tabular-nums">{formatMoney(debits, currency)}</span>
                </div>
              </div>
            </CardHeader>
            <CardContent>
              <ul className="space-y-1.5">
                {e.ledger_postings.map((p) => {
                  const amt = Number(p.amount);
                  const isDebit = amt > 0;
                  return (
                    <li
                      key={p.id}
                      className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-muted/40 px-3 py-2 text-sm"
                    >
                      <span className="min-w-0 truncate">
                        <span className="font-mono text-xs text-muted-foreground">
                          {p.ledger_accounts?.code}
                        </span>{" "}
                        {p.ledger_accounts?.name}
                        {p.memo && (
                          <span className="ml-2 text-xs text-muted-foreground">— {p.memo}</span>
                        )}
                      </span>
                      <span className="flex flex-shrink-0 items-center gap-3">
                        <span className="text-xs uppercase tracking-wide text-muted-foreground">
                          {isDebit ? "Dr" : "Cr"}
                        </span>
                        <span className="tabular-nums">{formatMoney(Math.abs(amt), currency)}</span>
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
        Showing the most recent {entries.length} entries. Entries cannot be edited
        or deleted — a correction is posted as a reversing entry, so both remain
        visible.
      </p>
    </div>
  );
}
