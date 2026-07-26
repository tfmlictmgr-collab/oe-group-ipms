"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Scale, BookOpen, Landmark } from "lucide-react";
import { cn } from "@/lib/utils";

const TABS = [
  { href: "/dashboard/ledger", label: "Balances", icon: Scale, exact: true },
  { href: "/dashboard/ledger/journal", label: "Journal", icon: BookOpen },
  { href: "/dashboard/ledger/reconciliation", label: "Reconciliation", icon: Landmark },
];

export default function LedgerNav({ variance }: { variance?: number }) {
  const pathname = usePathname();

  return (
    <div className="-mx-1 flex gap-1 overflow-x-auto border-b border-border px-1">
      {TABS.map((t) => {
        const active = t.exact ? pathname === t.href : pathname.startsWith(t.href);
        const Icon = t.icon;
        // Surface an unreconciled variance on the tab itself — it is the one
        // number that should never be discovered by accident.
        const flag = t.href.endsWith("reconciliation") && variance != null && variance !== 0;
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
            {flag && (
              <span className="rounded-full bg-destructive/12 px-1.5 py-0.5 text-[0.65rem] font-semibold text-destructive">
                variance
              </span>
            )}
          </Link>
        );
      })}
    </div>
  );
}
