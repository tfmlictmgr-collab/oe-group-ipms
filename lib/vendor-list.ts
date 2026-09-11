/**
 * How the vendor register is searched and ordered.
 *
 * Extracted from the component so the rules can be exercised directly against
 * real data (`scripts/verify-vendor-list.mjs`) rather than through a rendered
 * page. The component imports these — there is no second copy to drift, which
 * is the fault decision 24 recorded when `RequestStats` and `TicketList` each
 * kept their own array.
 */

export type VendorListRow = {
  id: string;
  name: string;
  serviceCategory: string | null;
  avg: number | null;
  count: number;
  /**
   * Position in the SCORE ranking, fixed before any sorting here runs.
   *
   * ⚠️ Not a row index. The page's premise is "ranked by composite performance
   * score", so if the badge were the display index then sorting by name would
   * renumber every vendor and read as though the ranking had changed — one
   * number meaning two things depending on a control elsewhere on the page.
   */
  rank: number;
};

export const VENDOR_SORTS = {
  score_desc: "Score — best first",
  score_asc: "Score — worst first",
  name_asc: "Name — A to Z",
  name_desc: "Name — Z to A",
  evaluations: "Most evaluated",
} as const;

export type VendorSortKey = keyof typeof VENDOR_SORTS;

/** Name or trade, case-insensitive substring. */
export function filterVendors<T extends VendorListRow>(rows: T[], query: string): T[] {
  const q = query.trim().toLowerCase();
  if (!q) return rows;
  return rows.filter(
    (v) =>
      v.name.toLowerCase().includes(q) ||
      (v.serviceCategory ?? "").toLowerCase().includes(q)
  );
}

/**
 * ⚠️ An unscored vendor sorts LAST in BOTH score directions, never first in the
 * ascending one.
 *
 * "Worst first" asks about performance. A vendor nobody has evaluated has not
 * performed badly — it has not been measured, and those are different facts.
 * Treating `null` as a low number would hand an FM a "worst vendors" list whose
 * leaders are simply the newest ones, which is precisely the reading that gets
 * somebody dropped from a tender for having just arrived.
 *
 * Never sorts in place: the caller's array is a React prop.
 */
export function sortVendors<T extends VendorListRow>(rows: T[], sort: VendorSortKey): T[] {
  const byName = (a: T, b: T) => a.name.localeCompare(b.name);
  const unscoredLast = (a: T, b: T): number | null => {
    if (a.avg == null && b.avg == null) return byName(a, b);
    if (a.avg == null) return 1;
    if (b.avg == null) return -1;
    return null;
  };

  return [...rows].sort((a, b) => {
    switch (sort) {
      case "name_asc":
        return byName(a, b);
      case "name_desc":
        return byName(b, a);
      case "evaluations":
        return b.count - a.count || byName(a, b);
      case "score_asc": {
        const u = unscoredLast(a, b);
        return u ?? a.avg! - b.avg!;
      }
      default: {
        const u = unscoredLast(a, b);
        return u ?? b.avg! - a.avg!;
      }
    }
  });
}
