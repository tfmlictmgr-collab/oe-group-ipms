"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Users, UserPlus, Building2, DoorOpen } from "lucide-react";
import { cn } from "@/lib/utils";

// Section tabs. Counts sit on the tab so an admin can see at a glance where
// work is waiting without opening each page.
const TABS = [
  { href: "/dashboard/people", label: "Members", icon: Users, key: "members" },
  { href: "/dashboard/people/invitations", label: "Invitations", icon: UserPlus, key: "invites" },
  { href: "/dashboard/people/applications", label: "Vendor Applications", icon: Building2, key: "apps" },
  { href: "/dashboard/people/occupancy", label: "Unit Occupancy", icon: DoorOpen, key: "units" },
] as const;

export default function SubNav({ counts }: { counts: Partial<Record<string, number>> }) {
  const pathname = usePathname();

  return (
    <div className="-mx-1 flex gap-1 overflow-x-auto border-b border-border px-1">
      {TABS.map((t) => {
        const active =
          t.href === "/dashboard/people"
            ? pathname === t.href
            : pathname.startsWith(t.href);
        const n = counts[t.key];
        const Icon = t.icon;
        return (
          <Link
            key={t.href}
            href={t.href}
            aria-current={active ? "page" : undefined}
            className={cn(
              "flex flex-shrink-0 items-center gap-2 border-b-2 px-3 py-2.5 text-sm font-medium transition-colors",
              active
                ? "border-[var(--brand)] text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground"
            )}
          >
            <Icon className="size-4" />
            {t.label}
            {n != null && n > 0 && (
              <span
                className="rounded-full px-1.5 py-0.5 text-[0.65rem] font-semibold tabular-nums"
                style={{
                  background: active ? "var(--brand)" : "color-mix(in srgb, var(--brand) 14%, transparent)",
                  color: active ? "var(--brand-fg)" : "var(--brand)",
                }}
              >
                {n}
              </span>
            )}
          </Link>
        );
      })}
    </div>
  );
}
