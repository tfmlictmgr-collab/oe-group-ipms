import Link from "next/link";
import { cn } from "@/lib/utils";
import type { RequestScope } from "./request-scope";

/** Fixed labels. `properties` is passed in because it reads differently for a
 *  regional manager ("In my region") than for an FM/PM ("On my properties"). */
const LABELS: Record<RequestScope, string> = {
  mine: "Assigned to me",
  raised: "Raised by me",
  properties: "On my properties",
  all: "All",
};

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
  scopes,
}: {
  active: RequestScope;
  role: string | null;
  propertiesLabel: string;
  /** Which views this role is offered — `scopesFor(role)`, resolved server-side
   *  so the tab strip cannot offer a view the query does not implement. */
  scopes: RequestScope[];
}) {
  const HINTS: Record<RequestScope, string> = {
    mine: "Work dispatched to you, which is what you sign off.",
    raised: "Requests you logged yourself, whoever they were passed to.",
    properties:
      role === "regional_manager"
        ? "Everything across your region, including requests nobody has picked up yet."
        : "Everything on the properties you manage, including requests nobody has picked up yet.",
    all: "Every request in the organisation.",
  };

  const tabs = scopes.map((key) => ({
    key,
    label: key === "properties" ? propertiesLabel : LABELS[key],
    hint: HINTS[key],
  }));

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
