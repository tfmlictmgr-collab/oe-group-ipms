import Link from "next/link";
import { redirect } from "next/navigation";
import { Bell, ArrowLeft } from "lucide-react";
import { getSessionProfile } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/patterns/page-header";
import { EmptyState } from "@/components/patterns/empty-state";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";

// The full notification list.
//
// ⚠️ Added because the bell had no page behind it. On mobile the bell folds
// into the profile menu (a 375px bar cannot hold a logo and three icon
// buttons), and a menu item needs somewhere to go — but the gap it exposed is
// real on every screen: the bell shows a capped, recent slice, so anything
// older than that slice was simply unreachable.
//
// Everything here comes from `my_notifications()` (0145), which is scoped to
// the caller and already answers whether the thing a notification points at is
// still reachable by this reader — a link to a ticket someone has since lost
// access to is worse than no link.

export const dynamic = "force-dynamic";

export default async function NotificationsPage() {
  const session = await getSessionProfile();
  if (!session) redirect("/login");

  const supabase = await createClient();
  // ⚠️ `p_days`, not a row limit — the function windows by AGE (default 30).
  // 90 gives a quarter's history without turning this into an unbounded scroll.
  const { data } = await supabase.rpc("my_notifications", { p_days: 90 });

  const items = (data ?? []) as {
    id: string;
    kind: string;
    title: string;
    body: string | null;
    link: string | null;
    target_live: boolean | null;
    read_at: string | null;
    created_at: string;
  }[];

  const unread = items.filter((n) => !n.read_at).length;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Notifications"
        description={
          unread > 0
            ? `${unread} unread, ${items.length} in the last 90 days`
            : `${items.length} in the last 90 days, all read`
        }
        actions={
          <Button asChild variant="ghost" size="sm">
            <Link href="/dashboard/settings/notifications">
              <ArrowLeft /> How we reach you
            </Link>
          </Button>
        }
      />

      {items.length === 0 ? (
        <EmptyState
          icon={<Bell />}
          title="Nothing yet"
          description="Requests, approvals and payments that need you will appear here."
        />
      ) : (
        <Card>
          <CardContent className="divide-y divide-border p-0">
            {items.map((n) => {
              // A dead link is rendered as plain text rather than removed: the
              // notification is still a true record of what happened, and
              // silently dropping it would leave a gap nobody can explain.
              const clickable = Boolean(n.link) && n.target_live !== false;
              const inner = (
                <div className="flex items-start gap-3 px-4 py-3">
                  <span
                    className={cn(
                      "mt-1.5 size-2 shrink-0 rounded-full",
                      n.read_at ? "bg-transparent" : "bg-[var(--brand)]"
                    )}
                    aria-hidden
                  />
                  <div className="min-w-0 flex-1">
                    <p className={cn("text-sm", !n.read_at && "font-medium")}>{n.title}</p>
                    {n.body && (
                      <p className="mt-0.5 text-xs text-muted-foreground">{n.body}</p>
                    )}
                    <p className="mt-1 text-xs text-muted-foreground">
                      {new Date(n.created_at).toLocaleString("en-NG", {
                        day: "numeric", month: "short", year: "numeric",
                        hour: "2-digit", minute: "2-digit",
                      })}
                      {n.link && n.target_live === false && (
                        <Badge variant="muted" className="ml-2 font-normal">
                          no longer available to you
                        </Badge>
                      )}
                    </p>
                  </div>
                </div>
              );

              return clickable ? (
                <Link key={n.id} href={n.link!} className="block hover:bg-accent/50">
                  {inner}
                </Link>
              ) : (
                <div key={n.id}>{inner}</div>
              );
            })}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
