"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { ChevronDown, Search, Inbox, Banknote } from "lucide-react";
import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import ChainTrail from "@/components/approvals/ChainTrail";
import StageActions from "@/components/approvals/StageActions";
import PayableDetail, { type PayableDetailData } from "@/components/approvals/PayableDetail";
import { refMatches } from "@/lib/acknowledgement";
import {
  canActorAction, whyNotActionable, waitingOn,
  type Actor, type ChainState, type PayableType, type StageOrder,
} from "@/lib/approvals/chain";

export type QueueRow = {
  payableType: PayableType;
  payableId: string;
  /** The auto-generated identifier this payable is known by, everywhere. */
  ref: string;
  title: string;
  subtitle: string;
  href: string | null;
  state: ChainState;
  detail?: PayableDetailData;
  /** Everything a search should match, lower-cased and pre-joined server-side. */
  haystack: string;
  /**
   * When this payable was raised, ISO, for ordering.
   *
   * ⚠️ Built server-side rather than parsed out of `subtitle`. The three
   * payable types carry their date in three different columns and one of them
   * (`remittances`) was ORDERED on `created_at` without ever SELECTING it — so
   * a client sort would have had nothing to read on a third of the queue and
   * would have silently grouped those rows together at one end.
   */
  sortKey: string;
};

/**
 * The approvals queue.
 *
 * Three things reported from the demo, all of them about the LIST rather than
 * about the chain:
 *
 *   - a payment approver could not tell whose desk a requisition was on, or why
 *     they had no button (they hold tier 1; the requisition needs tier 2);
 *   - every card was expanded, so a handful of payables filled the screen;
 *   - there was no way to find one by its reference.
 *
 * So: tabs, search, collapse, and a plain sentence naming who it waits for.
 *
 * None of this decides anything. `StageActions` still asks the database and
 * `enforce_approval_rules` still refuses whatever it should — this only stops
 * the screen withholding the reason.
 */
export default function ApprovalsBoard({
  rows,
  actor,
  inChain,
}: {
  rows: QueueRow[];
  actor: Actor;
  /**
   * Whether this person appears at any stage — decides whether the "someone
   * else" tab exists at all. Somebody outside the chain has no reason to watch
   * other people's payments queue up.
   */
  inChain: boolean;
}) {
  const [tab, setTab] = useState<"mine" | "others">("mine");
  const [query, setQuery] = useState("");
  // Newest first by default, matching the server order. "Oldest" is kept
  // because a queue is legitimately worked FIFO — the longest-waiting
  // approval is the one most at risk of rotting — and taking that away to
  // satisfy a default would trade one complaint for another.
  const [sort, setSort] = useState<"newest" | "oldest">("newest");
  const [open, setOpen] = useState<Record<string, boolean>>({});

  /**
   * ⚠️ "Waiting on you" means THERE IS SOMETHING FOR YOU TO DO — which is not
   * the same question for every role.
   *
   * The payment officer holds no approval stage (decision 16: oversight
   * authorises, they disburse), so `canActorAction` is false for them on every
   * row and their queue was permanently empty. Meanwhile the payable they exist
   * to send had been filtered out of the page entirely for being cleared. The
   * one desk with an action to take had the one tab that could never fill.
   *
   * For them, "waiting on you" is a cleared chain: the money is theirs to
   * release.
   */
  const isOfficer = actor.role === "finance_approver";

  const mine = useMemo(
    () =>
      rows.filter((r) =>
        isOfficer ? r.state.clearedForDisbursement : canActorAction(actor, r.state)
      ),
    [rows, actor, isOfficer]
  );
  const others = useMemo(
    () =>
      inChain
        ? rows.filter((r) =>
            isOfficer ? !r.state.clearedForDisbursement : !canActorAction(actor, r.state)
          )
        : [],
    [rows, actor, inChain, isOfficer]
  );

  const active = tab === "mine" ? mine : others;

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return active;
    // Two ways to match: the plain text of the row (vendor, job, the raiser's
    // own reference), and the auto reference with punctuation ignored — so
    // "REQ4F2A1C90", "req4f2a1c90" and a hyphenated form pasted from an older
    // message all find the same row.
    const matched = active.filter((r) => r.haystack.includes(q) || refMatches(query, r.ref));
    // Copied before sorting: `active` is one of the memoised arrays above, and
    // sorting in place would reorder those on every keystroke.
    return [...matched].sort((a, b) =>
      sort === "newest" ? b.sortKey.localeCompare(a.sortKey) : a.sortKey.localeCompare(b.sortKey)
    );
  }, [active, query, sort]);

  const TABS = [
    {
      key: "mine" as const,
      label: isOfficer ? "Ready for you to send" : "Waiting on you",
      count: mine.length,
    },
    ...(inChain
      ? [{ key: "others" as const, label: "Waiting on someone else", count: others.length }]
      : []),
  ];

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex gap-2" role="tablist" aria-label="Which approvals to show">
          {TABS.map((t) => (
            <button
              key={t.key}
              role="tab"
              type="button"
              aria-selected={tab === t.key}
              onClick={() => setTab(t.key)}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium transition-colors",
                tab === t.key
                  ? "border-transparent bg-[var(--brand)] text-[var(--brand-fg)]"
                  : "border-border bg-card text-muted-foreground hover:bg-accent hover:text-foreground"
              )}
            >
              {t.label}
              <span className="tabular-nums opacity-80">{t.count}</span>
            </button>
          ))}
        </div>

        <div className="flex w-full items-center gap-2 sm:w-auto">
          <div className="relative w-full sm:max-w-xs">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search by reference…"
              aria-label="Search approvals by reference, vendor, property or job"
              className="pl-9"
            />
          </div>
          <select
            value={sort}
            onChange={(e) => setSort(e.target.value as "newest" | "oldest")}
            aria-label="Order the approvals queue"
            className="h-9 flex-shrink-0 rounded-md border border-input bg-card px-2 text-xs text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)]"
          >
            <option value="newest">Newest first</option>
            <option value="oldest">Oldest first</option>
          </select>
        </div>
      </div>

      {shown.length === 0 ? (
        <Card>
          <CardContent className="py-10 text-center">
            <Inbox className="mx-auto size-6 text-muted-foreground" />
            <p className="mt-2 text-sm font-medium">
              {query
                ? "Nothing matches that reference"
                : tab === "mine"
                  ? "Nothing is waiting on you right now"
                  : "Nothing is waiting on anyone else"}
            </p>
            {query && (
              <p className="mt-1 text-xs text-muted-foreground">
                A requisition reference looks like{" "}
                <span className="font-mono">REQ4F2A1C90</span>. Clear the box to
                see everything.
              </p>
            )}
          </CardContent>
        </Card>
      ) : (
        shown.map((r) => {
          const key = `${r.payableType}:${r.payableId}`;
          // Rows awaiting THIS person open by default — they are here to act on
          // them. Everything else starts collapsed, which is the whole point: a
          // queue nobody can scroll is a queue nobody reads.
          const isOpen = open[key] ?? tab === "mine";
          const blocked = whyNotActionable(actor, r.state);
          return (
            <Card key={key} className={tab === "others" ? "opacity-90" : undefined}>
              <CardHeader className="pb-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <CardTitle className="flex flex-wrap items-center gap-2 text-base">
                      <Badge variant="outline" className="font-mono text-[10px]">
                        {r.ref}
                      </Badge>
                      {r.href ? (
                        <Link href={r.href} className="hover:underline">{r.title}</Link>
                      ) : (
                        r.title
                      )}
                    </CardTitle>
                    <CardDescription>{r.subtitle}</CardDescription>
                    {/* The sentence that was missing. `waitingOn` answers "then
                        who?"; `blocked` answers "why not me?". A queue that
                        shows a decision and withholds the reason teaches people
                        the product is broken rather than that they are the
                        wrong pair of hands. */}
                    <p className="mt-1.5 text-xs font-medium text-foreground">
                      {waitingOn(r.state)}
                    </p>
                    {tab === "others" && blocked && (
                      <p className="mt-0.5 text-xs text-muted-foreground">{blocked}</p>
                    )}
                  </div>
                  <button
                    type="button"
                    aria-expanded={isOpen}
                    aria-label={isOpen ? "Hide the detail" : "Show the detail"}
                    onClick={() => setOpen((p) => ({ ...p, [key]: !isOpen }))}
                    className="shrink-0 rounded-md border border-input p-1.5 hover:bg-accent"
                  >
                    <ChevronDown
                      className={cn("size-4 transition-transform", isOpen && "rotate-180")}
                    />
                  </button>
                </div>
              </CardHeader>

              {isOpen && (
                <CardContent className="space-y-4">
                  {r.detail && <PayableDetail data={r.detail} />}
                  <ChainTrail state={r.state} />
                  {/* ⚠️ The payment officer's action lives on the payable's own
                      screen (SendLineGroup for a requisition, Send on a vendor
                      payment, the payouts ledger for a landlord). Nothing here
                      releases money — this is the route to the place that does,
                      which is what was missing. */}
                  {r.state.clearedForDisbursement && r.href && (
                    <Link
                      href={r.href}
                      className="inline-flex items-center gap-1.5 rounded-md bg-[var(--brand)] px-3 py-2 text-xs font-medium text-[var(--brand-fg)] hover:opacity-90"
                    >
                      <Banknote className="size-3.5" />
                      {isOfficer ? "Open to release the payment" : "Open it"}
                    </Link>
                  )}
                  {tab === "mine" && r.state.nextStage && (
                    <StageActions
                      payableType={r.payableType}
                      payableId={r.payableId}
                      stage={r.state.nextStage.stageOrder as StageOrder}
                      stageLabel={r.state.nextStage.short}
                      verb={r.state.nextStage.verb}
                    />
                  )}
                </CardContent>
              )}
            </Card>
          );
        })
      )}
    </div>
  );
}
