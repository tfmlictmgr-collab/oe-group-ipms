/**
 * When an administrator may act on a request (0304) — the screen's copy of the
 * rule `tickets_admin_acts_only_on_left_work` enforces at the database.
 *
 * An administrator sees every request but acts on one only once it has gone
 * 24 hours with nobody assigned, or 24 hours without anyone on the desk acting
 * on it. This only decides what the page OFFERS; the trigger decides what
 * happens, so a clock that disagrees costs a refused click, never a bypass.
 *
 * Returns `null` if they may act now, otherwise the moment they may.
 */
const DAY_MS = 24 * 3600_000;

export function adminMayActFrom(
  t: {
    created_at: string;
    last_acted_at: string | null;
    assigned_vendor_id: string | null;
    assigned_to_user_id: string | null;
  },
  now: Date = new Date()
): Date | null {
  const created = new Date(t.created_at).getTime();
  const quiet = new Date(t.last_acted_at ?? t.created_at).getTime();
  const unassigned = !t.assigned_vendor_id && !t.assigned_to_user_id;

  const candidates = [quiet + DAY_MS];
  if (unassigned) candidates.push(created + DAY_MS);
  const from = Math.min(...candidates);
  return from <= now.getTime() ? null : new Date(from);
}
