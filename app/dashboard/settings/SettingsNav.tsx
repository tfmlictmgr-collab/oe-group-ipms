"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Palette, Landmark, ShieldCheck, Bell, KeyRound } from "lucide-react";
import { cn } from "@/lib/utils";

// Tabs are filtered by role rather than the whole section being gated: personal
// notification preferences belong to everyone, while branding, banking and the
// payment gate are organisation configuration and stay admin-only.
type Tab = {
  href: string;
  label: string;
  icon: typeof Palette;
  adminOnly: boolean;
  /** Index route: match exactly, or every sub-route would light it up too. */
  exact?: boolean;
};

const TABS: Tab[] = [
  { href: "/dashboard/settings", label: "Branding", icon: Palette, adminOnly: true, exact: true },
  { href: "/dashboard/settings/banking", label: "Client Funds", icon: Landmark, adminOnly: true },
  { href: "/dashboard/settings/payments", label: "Payment Gate", icon: ShieldCheck, adminOnly: true },
  // Visible to every administrator: a brand admin reads their own matrix,
  // only the operator can change it.
  { href: "/dashboard/settings/permissions", label: "Permissions", icon: KeyRound, adminOnly: true },
  { href: "/dashboard/settings/notifications", label: "My Notifications", icon: Bell, adminOnly: false },
];

export default function SettingsNav({ isAdmin }: { isAdmin: boolean }) {
  const pathname = usePathname();
  const tabs = TABS.filter((t) => !t.adminOnly || isAdmin);

  return (
    <div className="-mx-1 flex gap-1 overflow-x-auto border-b border-border px-1">
      {tabs.map((t) => {
        const active = t.exact ? pathname === t.href : pathname.startsWith(t.href);
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
          </Link>
        );
      })}
    </div>
  );
}
