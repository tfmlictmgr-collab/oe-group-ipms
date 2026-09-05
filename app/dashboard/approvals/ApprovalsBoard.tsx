"use client";

import { useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter, useSearchParams, usePathname } from "next/navigation";
import { ChevronDown, Search, Inbox, Banknote, AlertTriangle } from "lucide-react";
import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import ChainTrail from "@/components/approvals/ChainTrail";
import StageActions from "@/components/approvals/StageActions";
import ResubmitPanel from "@/components/approvals/ResubmitPanel";
import PayableDetail, { type PayableDetailData } from "@/components/approvals/PayableDetail";
import { refMatches } from "@/lib/acknowledgement";
import {
  canActorAction, whyNotActionable, waitingOn, formatNaira,
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
   * What this payable needs against what its property's fund holds (0247), for
   * the rows the payment officer could actually send today.
   *
   * ⚠️ Shown BEFORE the send, because the guarantee fires at COMMIT: the officer
   * who hit "account 2000 would be overpaid by 21000.00" met a correct control
   * at the only moment it had no way to explain itself. Absent for rows nobody
   * can send yet — asking the question for a payable three approvals away costs
   * a query per row and answers nothing.
   */
  funding?: {
    propertyName: string | null;
    required: number;
    available: number;
    shortfall: number;
    sufficient: boolean;
  } | null;
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
  sort,
  from,
  to,
  truncated,
}: {
  rows: QueueRow[];
  actor: Actor;
  /**
   * Whether this person appears at any stage — decides whether the "someone
   * else" tab exists at all. Somebody outside the chain has no reason to watch
   * other people's payments queue up.
   */
  inChain: boolean;
  /**
   * ⚠️ Sort and the date range are SERVER state now, passed down rather than
   * held here. They decide which rows are fetched, and a control that only
   * reorders what the server already chose is the bug this replaces: "Oldest
   * first" sorted the newest hundred and could never return the oldest row.
   */
  sort: "newest" | "oldest";
  from: string;
  to: string;
  /** The cap was reached, so this is a window rather than everything. */
  truncated: boolean;
}) {
  const [tab, setTab] = useState<"mine" | "others">("mine");
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState<Record<string, boolean>>({});

  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [pending, startTransition] = useTransition();

  // One helper for all three server-side controls. Empty means "not filtering",
  // and is removed from the URL rather than sent as a blank — a `?from=` that
  // means nothing still makes two identical views look like different pages.
  const setParam = (key: string, value: string) => {
    const next = new URLSearchParams(params.toString());
    if (value) next.set(key, value);
    else next.delete(key);
    startTransition(() => {
      router.replace(next.toString() ? `${pathname}?${next}` : pathname, { scroll: false });
    });
  };

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

        <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
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
            onChange={(e) => setParam("sort", e.target.value)}
            aria-label="Order the approvals queue"
            className="h-9 flex-shrink-0 rounded-md border border-input bg-card px-2 text-xs text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)]"
          >
            <option value="newest">Newest first</option>
            <option value="oldest">Oldest first</option>
          </select>
        </div>
      </div>

      {/* Raised between — a second way to find one, asked for alongside the
          reference search. Server-side, so it searches the whole table rather
          than the rows that happened to be on the page. */}
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <span className="font-medium">Raised between</span>
        <input
          type="date"
          value={from}
          max={to || undefined}
          onChange={(e) => setParam("from", e.target.value)}
          aria-label="Show approvals raised on or after this date"
          className="h-9 rounded-md border border-input bg-card px-2 outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)]"
        />
        <span>and</span>
        <input
          type="date"
          value={to}
          min={from || undefined}
          onChange={(e) => setParam("to", e.target.value)}
          aria-label="Show approvals raised on or before this date"
          className="h-9 rounded-md border border-input bg-card px-2 outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)]"
        />
        {(from || to) && (
          <button
            type="button"
            onClick={() => {
              const next = new URLSearchParams(params.toString());
              next.delete("from");
              next.delete("to");
              startTransition(() => {
                router.replace(next.toString() ? `${pathname}?${next}` : pathname, { scroll: false });
              });
            }}
            className="rounded-md border border-border px-2 py-1 hover:bg-accent hover:text-foreground"
          >
            Clear dates
          </button>
        )}
        {pending && <span className="opacity-70">updating…</span>}
      </div>

      {truncated && (
        <div className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-900/40 dark:bg-amber-950/30 dark:text-amber-200">
          <AlertTriangle className="mt-0.5 size-3.5 flex-shrink-0" />
          <span>
            More payables match than fit on one page, so this is the{" "}
            {sort === "oldest" ? "oldest" : "newest"} 100 of them. Narrow the
            date range to see the rest — the order above is applied before the
            cut, so nothing is being hidden behind a sort.
          </span>
        </div>
      )}

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
                      {r.state.returnedToRaiser
                        ? "Sent back to whoever raised it — nothing can move until it is corrected and resent."
                        : r.state.returnedAtStage
                          ? `Sent back to stage ${r.state.returnedAtStage - 1} for correction.`
                          : waitingOn(r.state)}
                    </p>
                    {r.state.returnedReason && (
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        {r.state.returnedBy ? `${r.state.returnedBy}: ` : ""}
                        &ldquo;{r.state.returnedReason}&rdquo;
                      </p>
                    )}
                    {tab === "others" && blocked && (
                      <p className="mt-0.5 text-xs text-muted-foreground">{blocked}</p>
                    )}
                    {/* The fund, before the send rather than at COMMIT (0247).
                        Shown whether it is short or not: "Osborne Tower's fund
                        holds ₦405,927.73" is the fact that makes the refusal
                        legible when it does come, and confidence when it does
                        not. */}
                    {r.funding && (
                      <p
                        className={cn(
                          "mt-1 inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs",
                          r.funding.sufficient
                            ? "bg-muted text-muted-foreground"
                            : "bg-amber-50 text-amber-800 dark:bg-amber-950/30 dark:text-amber-200"
                        )}
                      >
                        <Banknote className="size-3.5 flex-shrink-0" />
                        {r.funding.sufficient ? (
                          <>
                            {r.funding.propertyName ?? "The unattributed"} fund holds{" "}
                            {formatNaira(r.funding.available)} — enough for this.
                          </>
                        ) : (
                          <>
                            {r.funding.propertyName
                              ? `${r.funding.propertyName}'s`
                              : "The unattributed"}{" "}
                            service-charge fund holds{" "}
                            {formatNaira(r.funding.available)} and this needs{" "}
                            {formatNaira(r.funding.required)} —{" "}
                            {formatNaira(r.funding.shortfall)} short. Collect
                            before sending.
                          </>
                        )}
                      </p>
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
                  {/* Returned all the way to the raiser: `nextStage` is null by
                      design, so no stage action renders and — without this —
                      the card would explain the situation and offer no way out
                      of it. The server decides who may actually resend. */}
                  {r.state.returnedToRaiser && (
                    <ResubmitPanel
                      payableType={r.payableType}
                      payableId={r.payableId}
                      returnedReason={r.state.returnedReason}
                      returnedBy={r.state.returnedBy}
                    />
                  )}
                  {tab === "mine" && r.state.nextStage && (
                    <StageActions
                      payableType={r.payableType}
                      payableId={r.payableId}
                      stage={r.state.nextStage.stageOrder as StageOrder}
                      stageLabel={r.state.nextStage.short}
                      verb={r.state.nextStage.verb}
                      returnsTo={
                        r.state.nextStage.stageOrder === 1
                          ? "whoever raised it"
                          : (r.state.stages.find(
                              (s) => s.stageOrder === r.state.nextStage!.stageOrder - 1
                            )?.short ?? "the desk below")
                      }
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
