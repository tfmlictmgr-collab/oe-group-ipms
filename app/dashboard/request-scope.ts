import { FM_PM } from "@/lib/roles";

/**
 * Which requests a Service Requests page is showing.
 *
 * Board direction, 21 Aug 2026: *"only requests assigned to FM/PM should land
 * on their service request dashboard"*. That is a statement about the DEFAULT
 * VIEW, not about what they may reach — an FM still has to be able to see a
 * fresh, unassigned request on a property they manage in order to review and
 * dispatch it, which is the whole of 0178's review-before-dispatch gate. Taking
 * that away would leave nobody able to triage their own buildings.
 *
 * So: two views, one of them the default.
 *
 * ⚠️ This is presentation, never a control. Every scope below narrows what RLS
 * already returned — `tickets_select` (0184) is the enforced boundary, and no
 * value here can widen it. A manager who switches to `properties` sees their
 * managed properties because the policy allows it, not because this file said
 * so.
 */
export const REQUEST_SCOPES = ["mine", "raised", "properties", "all"] as const;
export type RequestScope = (typeof REQUEST_SCOPES)[number];

/** Roles whose landing view is their own desk rather than the whole queue. */
const DESK_FIRST: readonly string[] = [...FM_PM, "regional_manager", "fm_ops_staff"];

/**
 * Roles that can RAISE work as well as read the queue, and therefore need
 * somewhere to follow what they raised.
 *
 * ⚠️ `admin` is here and was not. The board asked that "fm/pm/admin/vendor
 * should be able to see their work order/requests raised", and an administrator
 * had no such view at all: they land on "All" with no tabs, so a request they
 * raised themselves sits in a queue of everything with nothing marking it as
 * theirs. Measured on the live database, an org's administrator had raised
 * requests and no way to list them.
 *
 * A vendor is deliberately absent: they are redirected to My Work, whose ticket
 * list is unfiltered and RLS-scoped, so anything they raised already appears
 * there beside the jobs dispatched to them.
 */
const CAN_RAISE: readonly string[] = [...DESK_FIRST, "admin"];

export function defaultScope(role: string | null | undefined): RequestScope {
  return DESK_FIRST.includes(role ?? "") ? "mine" : "all";
}

/**
 * The views this role is offered, in order. Not every role gets every one:
 * "Assigned to me" is meaningless for an administrator, who is not dispatched
 * work, and "All" is not offered to an FM/PM because their reach is their
 * places rather than the organisation.
 */
export function scopesFor(role: string | null | undefined): RequestScope[] {
  const r = role ?? "";
  if (DESK_FIRST.includes(r)) return ["mine", "raised", "properties"];
  if (r === "admin") return ["raised", "all"];
  return [];
}

export function parseScope(
  raw: string | undefined,
  role: string | null | undefined
): RequestScope {
  return (REQUEST_SCOPES as readonly string[]).includes(raw ?? "")
    ? (raw as RequestScope)
    : defaultScope(role);
}

/** Whether to offer the view switcher at all. */
export function showsScopeTabs(role: string | null | undefined): boolean {
  return CAN_RAISE.includes(role ?? "");
}

export function scopeLabel(scope: RequestScope, role: string | null | undefined): string {
  if (scope === "mine") return "Assigned to me";
  // Board direction, 28 Aug 2026: *"fm should see their own requests on their
  // dashboards"*. "Their own" turned out to mean two different things and the
  // product only had one of them — an FM who RAISES a request (a job they
  // logged, a fault they reported upward) then had nowhere to watch it, because
  // "Assigned to me" filters on `assigned_to_user_id` and a raiser is not an
  // assignee. `tickets_select` has always returned it to them via `sender_id`;
  // there was simply no view that asked.
  if (scope === "raised") return "Raised by me";
  if (scope === "properties") {
    return role === "regional_manager" ? "In my region" : "On my properties";
  }
  return "All";
}
