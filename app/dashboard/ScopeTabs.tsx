import Link from "next/link";
import { cn } from "@/lib/utils";
import type { RequestScope } from "./request-scope";

/**
 * The three desks a manager works from.
 *
 * Links rather than client state, so the view survives a refresh, is
 * shareable, and — the reason that actually matters — so the SERVER re-runs the
 * query. The narrowing happens in the database query, not in the browser,
 * because a 200-row page filtered after the fact can hide a manager's own work
 * behind other people's (see page.tsx).
 *
 * "Raised by me" is decision 23: an FM who logs a request was previously unable
 * to follow it anywhere, because the only personal view filtered on
 * `assigned_to_user_id` and a raiser is not an assignee.
 */
export default function ScopeTabs({
  active,
  role,
  propertiesLabel,
}: {
  active: RequestScope;
  role: string | null;
  propertiesLabel: string;
}) {
  const tabs: { key: RequestScope; label: string; hint: string }[] = [
    {
      key: "mine",
      label: "Assigned to me",
      hint: "Work dispatched to you, which is what you sign off.",
    },
    {
      key: "raised",
      label: "Raised by me",
      hint: "Requests you logged yourself, whoever they were passed to.",
    },
    {
      key: "properties",
      label: propertiesLabel,
      hint:
        role === "regional_manager"
          ? "Everything across your region, including requests nobody has picked up yet."
          : "Everything on the properties you manage, including requests nobody has picked up yet.",
    },
  ];

  return (
    <div
      className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1"
      role="tablist"
      aria-label="Which requests to show"
    >
      {tabs.map((t) => {
        const on = active === t.key;
        return (
          <Link
            key={t.key}
            href={`/dashboard?view=${t.key}`}
            role="tab"
            aria-selected={on}
            title={t.hint}
            className={cn(
              "flex flex-shrink-0 items-center rounded-full border px-3 py-1.5 text-xs font-medium transition-colors",
              on
                ? "border-transparent bg-[var(--brand)] text-[var(--brand-fg)]"
                : "border-border bg-card text-muted-foreground hover:bg-accent hover:text-foreground"
            )}
          >
            {t.label}
          </Link>
        );
      })}
    </div>
  );
}
