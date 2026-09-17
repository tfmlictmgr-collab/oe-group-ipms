"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { UserPlus, Building2, DoorOpen, FileSignature, Contact } from "lucide-react";
import { cn } from "@/lib/utils";

// A profile (/dashboard/people/<uuid>) is reached from the Directory, so the
// Directory tab stays lit on it — otherwise the reader lands on a page where no
// tab says where they are.
const PROFILE = /^\/dashboard\/people\/[0-9a-f]{8}-[0-9a-f-]{27}$/i;

// Section tabs. Counts sit on the tab so an admin can see at a glance where
// work is waiting without opening each page.
//
// 📌 "Members" is gone as a tab (12 Sept 2026): its list and every one of its
// controls are in the Directory, which is the administrator's alone. Hidden
// from everyone else rather than shown and refused — a tab that always says
// "not for you" is a question every manager has to ask.
const TABS = [
  { href: "/dashboard/people/directory", label: "Directory", icon: Contact, key: "directory", adminOnly: true },
  { href: "/dashboard/people/invitations", label: "Invitations", icon: UserPlus, key: "invites" },
  { href: "/dashboard/people/applications", label: "Vendor Applications", icon: Building2, key: "apps" },
  { href: "/dashboard/people/occupancy", label: "Unit Occupancy", icon: DoorOpen, key: "units" },
  // Lettings only. Hidden rather than disabled for a facilities org: a tab that
  // exists but never applies is a question every new administrator has to ask.
  { href: "/dashboard/people/tenancy", label: "Tenancy Applications", icon: FileSignature, key: "tenancy", module: "lettings" },
] as const;

export default function SubNav({
  counts,
  modules = {},
  isAdmin = false,
}: {
  counts: Partial<Record<string, number>>;
  modules?: Partial<Record<string, boolean>>;
  isAdmin?: boolean;
}) {
  const pathname = usePathname();

  return (
    <div className="-mx-1 flex gap-1 overflow-x-auto border-b border-border px-1">
      {TABS.filter(
        (t) => (!("module" in t) || modules[t.module]) && (!("adminOnly" in t) || isAdmin)
      ).map((t) => {
        const active =
          pathname.startsWith(t.href) || (t.key === "directory" && PROFILE.test(pathname));
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
