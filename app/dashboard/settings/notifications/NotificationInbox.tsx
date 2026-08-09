"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Inbox, CheckCheck, AlertCircle, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { runAction, describeError } from "@/lib/run-action";
import { markAllNotificationsRead } from "./actions";

export type InboxRow = {
  id: string;
  kind: string;
  title: string;
  body: string | null;
  link: string | null;
  read_at: string | null;
  created_at: string;
  target_live: boolean;
};

const when = (iso: string) => {
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  if (mins < 60) return `${Math.max(1, mins)}m ago`;
  if (mins < 1440) return `${Math.round(mins / 60)}h ago`;
  return new Date(iso).toLocaleDateString("en-GB", {
    timeZone: "Africa/Lagos", day: "numeric", month: "short",
  });
};

/**
 * The inbox: what still needs this person, and what they have already dealt
 * with recently.
 *
 * ⚠️ A dead link is rendered as PLAIN TEXT, never as a link. `target_live`
 * comes from `my_notifications` (0145) and is computed as the CALLER, so it
 * catches both halves of the 404 that was reported twice: a subject that was
 * deleted, and a subject that still EXISTS but is outside this reader's scope.
 * A cascade can only ever fix the first — and measured against live data, the
 * second is the more common one, because `notify_role` broadcasts org-wide by
 * role while RLS scopes each reader to a subset.
 *
 * The wording is "not available to you" rather than "no longer available" for
 * exactly that reason: for most of these the thing is alive and well, it is
 * simply not theirs. Telling someone an existing record was deleted would be a
 * different lie from the 404, not a fix for it.
 */
export default function NotificationInbox({ rows }: { rows: InboxRow[] }) {
  const router = useRouter();
  const [busy, setBusy] = React.useState(false);

  const untreated = rows.filter((r) => !r.read_at);
  const treated = rows.filter((r) => r.read_at);

  async function markAll() {
    setBusy(true);
    try {
      await runAction(markAllNotificationsRead());
      router.refresh();
    } catch (err) {
      toast.error("Could not mark notifications read", { description: describeError(err) });
    } finally {
      setBusy(false);
    }
  }

  const Row = ({ n }: { n: InboxRow }) => {
    const inner = (
      <div className="flex items-start gap-3">
        {!n.read_at && (
          <span className="mt-1.5 size-2 flex-shrink-0 rounded-full bg-[var(--brand)]" />
        )}
        <div className={`min-w-0 flex-1 ${n.read_at ? "pl-5" : ""}`}>
          <p className={`text-sm leading-snug ${n.read_at ? "text-muted-foreground" : "font-medium"}`}>
            {n.title}
          </p>
          {n.body && (
            <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{n.body}</p>
          )}
          <p className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
            <span>{when(n.created_at)}</span>
            {n.link && !n.target_live && (
              <span className="flex items-center gap-1 text-warning">
                <AlertCircle className="size-3" /> not available to you
              </span>
            )}
          </p>
        </div>
        {n.link && n.target_live && (
          <ChevronRight className="mt-1 size-4 flex-shrink-0 text-muted-foreground" />
        )}
      </div>
    );

    // Only a live target becomes a link.
    return n.link && n.target_live ? (
      <Link href={n.link} className="block rounded-md p-3 transition-colors hover:bg-muted/50">
        {inner}
      </Link>
    ) : (
      <div className="p-3">{inner}</div>
    );
  };

  return (
    <Card>
      <CardContent className="space-y-4 p-4 sm:p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="font-medium">
              Recent activity
              {untreated.length > 0 && (
                <Badge variant="info" className="ml-2">{untreated.length} new</Badge>
              )}
            </p>
            <p className="text-xs text-muted-foreground">
              {/* The rule, said plainly — otherwise "where did my notifications
                  go?" is the next question. */}
              Everything from the last 30 days, plus anything still unread
              whatever its age. Read items older than 30 days are cleared.
            </p>
          </div>
          {untreated.length > 0 && (
            <Button variant="outline" size="sm" disabled={busy} onClick={markAll}>
              <CheckCheck /> {busy ? "Marking…" : "Mark all read"}
            </Button>
          )}
        </div>

        {rows.length === 0 ? (
          <div className="py-8 text-center">
            <Inbox className="mx-auto size-8 text-muted-foreground" />
            <p className="mt-2 text-sm text-muted-foreground">
              Nothing in the last 30 days.
            </p>
          </div>
        ) : (
          <div className="space-y-4">
            {untreated.length > 0 && (
              <div>
                <p className="px-3 pb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Needs you
                </p>
                <div className="divide-y divide-border rounded-lg border border-border">
                  {untreated.map((n) => <Row key={n.id} n={n} />)}
                </div>
              </div>
            )}

            {treated.length > 0 && (
              <div>
                <p className="px-3 pb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Already dealt with
                </p>
                <div className="divide-y divide-border rounded-lg border border-border">
                  {treated.map((n) => <Row key={n.id} n={n} />)}
                </div>
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
