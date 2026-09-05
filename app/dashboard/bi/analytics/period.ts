// Period arithmetic for the analytics drill-down. Pure functions, no I/O.
//
// ⚠️ A separate module rather than part of `drill.ts` because that file is
// `"use server"`, where every export must be an async server action — a
// synchronous helper exported from it fails the build outright. These belong
// here on their own merits too: nothing in them touches the database.
//
// ── WHAT A PERIOD VALUE ACTUALLY LOOKS LIKE ────────────────────────────────
//
// `bi_ticket_metrics` returns `period` as `date_trunc(bucket, created_at)::date`
// — a FULL DATE at every bucket. August grouped by month arrives as
// `2026-08-01`, and 2026 grouped by year as `2026-01-01`. The console links with
// that value verbatim.
//
// The drill used to infer the bucket from the string's shape: `2026` → a year,
// `2026-08` → a month, anything else → a day. Since the RPC never emits those
// shorter shapes, EVERY drill fell to the day branch — opening August queried
// 1 August alone, charted it "per day", and headed the page "Aug 26". The width
// of a period is not recoverable from its start date; it has to come from the
// bucket that produced it, which is why it is threaded through here.
//
// The shorter shapes are still honoured, because a hand-typed or bookmarked
// `/period/2026` is unambiguous and should mean the year rather than whatever
// the console's bucket happens to be.

export type Bucket = "day" | "week" | "month" | "quarter" | "year";

const BUCKETS: Bucket[] = ["day", "week", "month", "quarter", "year"];

/**
 * ⚠️ Allow-listed rather than passed through. `bi_ticket_metrics` CLAMPS an
 * unrecognised bucket to 'month' instead of refusing it, so an unsupported value
 * arriving from the query string would draw months while the page said something
 * else — wrong quietly, which is the worst way to be wrong about a figure.
 */
export function normaliseBucket(b: string | null | undefined): Bucket {
  return BUCKETS.includes(b as Bucket) ? (b as Bucket) : "month";
}

/**
 * How wide the period at `v` is: from its own shape where that is unambiguous,
 * otherwise from the bucket the console grouped by.
 */
export function periodBucket(v: string, consoleBucket: Bucket): Bucket {
  if (/^\d{4}$/.test(v)) return "year";
  if (/^\d{4}-\d{2}$/.test(v)) return "month";
  return consoleBucket;
}

/** One level finer, for the chart inside the drill. A day does not subdivide. */
const FINER: Record<Bucket, Bucket> = {
  year: "month",
  quarter: "month",
  month: "week",
  week: "day",
  day: "day",
};

export function finer(bucket: Bucket): Bucket {
  return FINER[bucket];
}

function periodStart(v: string): string {
  if (/^\d{4}$/.test(v)) return `${v}-01-01`;
  if (/^\d{4}-\d{2}$/.test(v)) return `${v}-01`;
  return v;
}

export type PeriodRange = {
  start: string;
  /** Exclusive, for a timestamp comparison. */
  endExclusive: string;
  /** The last day itself, for `bi_ticket_metrics`. */
  endInclusive: string;
};

/**
 * The period as a HALF-OPEN range, `[start, endExclusive)`.
 *
 * ⚠️ Half-open, not inclusive, because `created_at` is a timestamp and these
 * bounds are calendar dates. `created_at <= '2026-08-31'` means
 * `<= 2026-08-31 00:00:00`, which silently drops everything raised during the
 * last day of the range — and where start and end were the same date it matched
 * only rows created exactly at midnight, i.e. nothing at all. `endInclusive` is
 * offered alongside it for `bi_ticket_metrics`, whose own predicate is
 * `created_at < (p_to + 1)` and which therefore wants the last day itself.
 */
export function periodRange(v: string, bucket: Bucket): PeriodRange {
  const start = periodStart(v);
  const end = new Date(`${start}T00:00:00Z`);
  if (Number.isNaN(end.getTime())) {
    // Shape-validated by the caller before reaching here, so unreachable — but a
    // NaN date would otherwise become the string "Invalid Date" inside a query
    // predicate rather than failing.
    return { start, endExclusive: start, endInclusive: start };
  }

  if (bucket === "day") end.setUTCDate(end.getUTCDate() + 1);
  else if (bucket === "week") end.setUTCDate(end.getUTCDate() + 7);
  else if (bucket === "month") end.setUTCMonth(end.getUTCMonth() + 1);
  else if (bucket === "quarter") end.setUTCMonth(end.getUTCMonth() + 3);
  else end.setUTCFullYear(end.getUTCFullYear() + 1);

  const inclusive = new Date(end);
  inclusive.setUTCDate(inclusive.getUTCDate() - 1);

  return {
    start,
    endExclusive: end.toISOString().slice(0, 10),
    endInclusive: inclusive.toISOString().slice(0, 10),
  };
}
