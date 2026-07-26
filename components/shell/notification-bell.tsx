"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  Bell, Inbox, ClipboardCheck, Banknote, Building2, UserPlus, Package, Info, CheckCheck,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent,
} from "@/components/ui/dropdown-menu";

export type UserNotification = {
  id: string;
  kind: string;
  title: string;
  body: string | null;
  link: string | null;
  read_at: string | null;
  created_at: string;
};

const ICONS: Record<string, React.ElementType> = {
  request: Inbox,
  assignment: ClipboardCheck,
  approval: ClipboardCheck,
  payment: Banknote,
  application: Building2,
  invitation: UserPlus,
  asset: Package,
  system: Info,
};

function timeAgo(iso: string): string {
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return d < 7 ? `${d}d ago` : new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

export function NotificationBell({ initial }: { initial: UserNotification[] }) {
  const router = useRouter();
  const [items, setItems] = React.useState(initial);
  const [open, setOpen] = React.useState(false);
  const unread = items.filter((n) => !n.read_at).length;

  // Live updates. RLS restricts the stream to this user's own rows, so there is
  // no filtering to get wrong on the client.
  React.useEffect(() => {
    const supabase = createClient();
    const channel = supabase
      .channel("user-notifications")
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "user_notifications" },
        (payload) => {
          setItems((prev) => [payload.new as UserNotification, ...prev].slice(0, 30));
        }
      )
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, []);

  async function markAllRead() {
    const unreadIds = items.filter((n) => !n.read_at).map((n) => n.id);
    if (unreadIds.length === 0) return;
    // Optimistic: the panel should feel instant.
    const now = new Date().toISOString();
    setItems((prev) => prev.map((n) => (n.read_at ? n : { ...n, read_at: now })));
    const supabase = createClient();
    await supabase.from("user_notifications").update({ read_at: now }).in("id", unreadIds);
    router.refresh();
  }

  async function markRead(id: string) {
    const now = new Date().toISOString();
    setItems((prev) => prev.map((n) => (n.id === id ? { ...n, read_at: now } : n)));
    const supabase = createClient();
    await supabase.from("user_notifications").update({ read_at: now }).eq("id", id);
  }

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="relative"
          aria-label={unread > 0 ? `Notifications, ${unread} unread` : "Notifications"}
        >
          <Bell className="size-4" />
          {unread > 0 && (
            <span
              className="absolute right-1 top-1 flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[0.6rem] font-semibold leading-none text-white"
              style={{ background: "var(--brand)" }}
            >
              {unread > 9 ? "9+" : unread}
            </span>
          )}
        </Button>
      </DropdownMenuTrigger>

      <DropdownMenuContent align="end" className="w-[22rem] p-0">
        <div className="flex items-center justify-between border-b border-border px-4 py-2.5">
          <p className="text-sm font-semibold">Notifications</p>
          {unread > 0 && (
            <button
              onClick={markAllRead}
              className="flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
            >
              <CheckCheck className="size-3.5" /> Mark all read
            </button>
          )}
        </div>

        <div className="max-h-[26rem] overflow-y-auto">
          {items.length === 0 ? (
            <div className="px-4 py-10 text-center">
              <Bell className="mx-auto mb-2 size-6 text-muted-foreground" />
              <p className="text-sm font-medium">You&apos;re all caught up</p>
              <p className="text-xs text-muted-foreground">
                Requests, approvals and alerts for you will appear here.
              </p>
            </div>
          ) : (
            <ul>
              {items.map((n) => {
                const Icon = ICONS[n.kind] ?? Info;
                const unreadRow = !n.read_at;
                const Row = (
                  <div
                    className={cn(
                      "flex gap-3 px-4 py-3 transition-colors hover:bg-accent",
                      unreadRow && "bg-[var(--brand)]/[0.04]"
                    )}
                  >
                    <span
                      className="mt-0.5 flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full"
                      style={{
                        background: "color-mix(in srgb, var(--brand) 12%, transparent)",
                        color: "var(--brand)",
                      }}
                    >
                      <Icon className="size-3.5" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className={cn("text-sm", unreadRow ? "font-medium" : "text-muted-foreground")}>
                        {n.title}
                      </p>
                      {n.body && (
                        <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{n.body}</p>
                      )}
                      <p className="mt-1 text-[0.7rem] text-muted-foreground">{timeAgo(n.created_at)}</p>
                    </div>
                    {unreadRow && (
                      <span
                        aria-hidden
                        className="mt-2 h-1.5 w-1.5 flex-shrink-0 rounded-full"
                        style={{ background: "var(--brand)" }}
                      />
                    )}
                  </div>
                );

                return (
                  <li key={n.id} className="border-b border-border last:border-0">
                    {n.link ? (
                      <Link
                        href={n.link}
                        onClick={() => { markRead(n.id); setOpen(false); }}
                        className="block"
                      >
                        {Row}
                      </Link>
                    ) : (
                      <button onClick={() => markRead(n.id)} className="block w-full text-left">
                        {Row}
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
