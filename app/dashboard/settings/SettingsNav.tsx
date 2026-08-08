"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Palette, Landmark, ShieldCheck, Bell, KeyRound, FileSignature, ClipboardCheck, Sparkles, UserRound, Lock } from "lucide-react";
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
  // First, and open to everyone: this is where /dashboard/settings sends a
  // non-administrator, so it has to be the tab they see selected rather than
  // one they must notice. An administrator gets it too — an admin also has a
  // name and their own notification channels.
  { href: "/dashboard/settings/profile", label: "My Profile", icon: UserRound, adminOnly: false },
  { href: "/dashboard/settings/notifications", label: "My Notifications", icon: Bell, adminOnly: false },
  { href: "/dashboard/settings/security", label: "Security", icon: Lock, adminOnly: false },
  { href: "/dashboard/settings", label: "Branding", icon: Palette, adminOnly: true, exact: true },
  { href: "/dashboard/settings/banking", label: "Client Funds", icon: Landmark, adminOnly: true },
  { href: "/dashboard/settings/payments", label: "Payment Gate", icon: ShieldCheck, adminOnly: true },
  // Lettings is OEA-only (B9); the page says so for an org without the module
  // rather than the tab vanishing, so an administrator is not left wondering.
  { href: "/dashboard/settings/lettings", label: "Lettings", icon: FileSignature, adminOnly: true },
  { href: "/dashboard/settings/evaluation", label: "Evaluation Rubric", icon: ClipboardCheck, adminOnly: true },
  // Visible to every administrator: a brand admin reads their own matrix,
  // only the operator can change it.
  { href: "/dashboard/settings/ai", label: "AI & Classification", icon: Sparkles, adminOnly: true },
  { href: "/dashboard/settings/permissions", label: "Permissions", icon: KeyRound, adminOnly: true },
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
