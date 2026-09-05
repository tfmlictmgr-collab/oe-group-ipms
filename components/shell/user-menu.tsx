"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useTheme } from "next-themes";
import { createClient } from "@/lib/supabase/client";
import { LogOut, Settings as SettingsIcon, UserRound, Bell, Sun, Moon } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";

function initials(nameOrEmail: string): string {
  const base = nameOrEmail.includes("@") ? nameOrEmail.split("@")[0] : nameOrEmail;
  const parts = base.replace(/[._-]+/g, " ").trim().split(/\s+/);
  return (parts[0]?.[0] ?? "") + (parts[1]?.[0] ?? "");
}

export function UserMenu({
  name,
  email,
  roleLabel,
  isAdmin,
  unreadCount = 0,
}: {
  name: string;
  email: string;
  roleLabel: string;
  isAdmin: boolean;
  /**
   * Unread notifications. Only used on mobile, where the bell is folded into
   * this menu — the count has to reach the avatar, or the one signal telling
   * someone to open the menu is the thing hidden inside it.
   */
  unreadCount?: number;
}) {
  const router = useRouter();
  const { resolvedTheme, setTheme } = useTheme();
  const [mounted, setMounted] = React.useState(false);
  React.useEffect(() => setMounted(true), []);
  const isDark = mounted && resolvedTheme === "dark";

  async function signOut() {
    const supabase = createClient();
    await supabase.auth.signOut();
    router.push("/login");
    router.refresh();
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger className="relative flex items-center gap-2 rounded-full outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)]/40">
        <Avatar>
          <AvatarFallback
            className="uppercase"
            style={{ background: "var(--brand)", color: "var(--brand-fg)" }}
          >
            {initials(name || email).toUpperCase()}
          </AvatarFallback>
        </Avatar>
        {/* Mobile only: the bell lives inside this menu there, so its unread
            state has to show on the outside of it. A count would not fit
            legibly at this size — a dot answers the only question that
            matters, which is whether to open it. */}
        {unreadCount > 0 && (
          <span
            aria-hidden
            className="absolute -right-0.5 -top-0.5 size-2.5 rounded-full border-2 border-card bg-[var(--brand)] sm:hidden"
          />
        )}
        <span className="sr-only">
          {unreadCount > 0
            ? `Account menu, ${unreadCount} unread notification${unreadCount === 1 ? "" : "s"}`
            : "Account menu"}
        </span>
      </DropdownMenuTrigger>
      {/* `avoidCollisions={false}`: this trigger lives in one place — the
          header's top-right corner — on every screen, every role, every
          width. Radix's own collision-flip is what a menu with a
          conditionally-positioned trigger needs; this one doesn't have that
          problem, and on a slow first paint or a partially-hydrated layout it
          was the flip logic itself landing the panel top-left instead of
          under the avatar. Pinning it removes that failure mode outright. */}
      <DropdownMenuContent align="end" avoidCollisions={false} className="w-60">
        <DropdownMenuLabel className="flex items-center gap-3 py-2 text-foreground">
          <Avatar className="h-9 w-9">
            <AvatarFallback
              className="text-xs uppercase"
              style={{ background: "var(--brand)", color: "var(--brand-fg)" }}
            >
              {initials(name || email).toUpperCase()}
            </AvatarFallback>
          </Avatar>
          <div className="min-w-0">
            <p className="truncate text-sm font-medium">{name || email}</p>
            <p className="truncate text-xs text-muted-foreground">{roleLabel}</p>
          </div>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />

        {/* ── Folded in on mobile ──────────────────────────────────────────
            The bell and the theme switch keep their own place in the header
            from `sm` up. Below that the bar was three icons and a logo on a
            375px screen, so they move in here rather than shrink. */}
        <DropdownMenuItem asChild className="sm:hidden">
          <Link href="/dashboard/notifications">
            <Bell /> Notifications
            {unreadCount > 0 && (
              <span className="ml-auto rounded-full bg-[var(--brand)] px-1.5 py-0.5 text-[11px] font-semibold leading-none text-[var(--brand-fg)]">
                {unreadCount > 99 ? "99+" : unreadCount}
              </span>
            )}
          </Link>
        </DropdownMenuItem>
        <DropdownMenuItem
          className="sm:hidden"
          onSelect={(e) => {
            // Keep the menu open: switching theme is something people try both
            // ways, and closing it makes that two taps each time.
            e.preventDefault();
            setTheme(isDark ? "light" : "dark");
          }}
        >
          {isDark ? <Sun /> : <Moon />}
          {isDark ? "Light mode" : "Dark mode"}
        </DropdownMenuItem>
        <DropdownMenuSeparator className="sm:hidden" />

        <DropdownMenuItem asChild>
          <Link href="/dashboard/statements">
            <UserRound /> My statements
          </Link>
        </DropdownMenuItem>
        {isAdmin && (
          <DropdownMenuItem asChild>
            <Link href="/dashboard/settings">
              <SettingsIcon /> Settings
            </Link>
          </DropdownMenuItem>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onClick={signOut}
          className="text-destructive focus:bg-destructive/10 focus:text-destructive [&_svg]:text-destructive"
        >
          <LogOut /> Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
