"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import { NAV_GROUPS, isActive, type NavContext } from "./nav-config";

// Shared nav body used by both the desktop sidebar and the mobile drawer.
export function SidebarNav({
  ctx,
  onNavigate,
}: {
  ctx: NavContext;
  onNavigate?: () => void;
}) {
  const pathname = usePathname();

  return (
    <nav className="flex-1 space-y-6 overflow-y-auto px-3 py-4">
      {NAV_GROUPS.map((group) => {
        const items = group.items.filter((i) => i.show(ctx));
        if (items.length === 0) return null;
        return (
          <div key={group.heading} className="space-y-1">
            <p className="px-3 pb-1 text-[0.7rem] font-semibold uppercase tracking-wider text-sidebar-muted">
              {group.heading}
            </p>
            {items.map((item) => {
              const active = isActive(pathname, item.href);
              const Icon = item.icon;
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  onClick={onNavigate}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "group flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors",
                    active
                      ? "bg-[color-mix(in_srgb,var(--brand)_88%,black_10%)] text-[var(--brand-fg)] shadow-sm"
                      : "text-sidebar-foreground hover:bg-white/5 hover:text-white"
                  )}
                >
                  <Icon
                    className={cn(
                      "size-4 shrink-0",
                      active ? "text-[var(--brand-fg)]" : "text-sidebar-muted group-hover:text-white"
                    )}
                  />
                  <span className="truncate">{item.label}</span>
                </Link>
              );
            })}
          </div>
        );
      })}
    </nav>
  );
}
