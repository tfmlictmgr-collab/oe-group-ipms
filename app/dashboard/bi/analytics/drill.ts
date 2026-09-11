"use server";

import { createClient } from "@/lib/supabase/server";
import { ok, fail, failFromDb, type ActionResult } from "@/lib/action-result";
import { shortRef } from "@/lib/acknowledgement";
import type { Filters, MetricRow } from "./actions";
// Pure period arithmetic. In its own module because this file is `"use server"`,
// where every export must be an async action — see the note at its head for why
// a period's WIDTH cannot be read off its start date.
import {
  normaliseBucket, periodBucket, periodRange, finer, type Bucket,
} from "./period";

// The drill-down read.
//
// ⚠️ THIS RE-CHECKS SCOPE ITSELF. Task 4 step 4 asks for exactly that, and the
// reason is worth stating: the console's gate answers "may this person open the
// analytics section", which is a different question from "may this person see
// THIS property's requests". A drill target reached by URL never passed through
// the console at all — someone can paste a link, or keep a bookmark after their
// region changes.
//
// The defence is layered, and the outer layers are the courtesies:
//   1. `biScope(role).requests` — may they read request analytics at all;
//   2. the dimension value must be one THEY can name (a property they hold, a
//      vendor they manage) — checked below by asking the database for it under
//      their own session, so RLS answers rather than this file;
//   3. every figure comes from the same RLS-scoped RPCs the console uses.
//
// Layer 3 alone is sufficient for correctness — an out-of-scope property yields
// an empty result rather than someone else's data. Layers 1 and 2 exist so the
// answer is "that is not yours" rather than a page of zeroes, which reads as a
// broken report and generates a support call.

export type DrillDimension = "period" | "property" | "category" | "vendor";

export type DrillTicket = {
  id: string;
  reference: string | null;
  summary: string | null;
  category: string | null;
  urgency: string | null;
  status: string;
  created_at: string;
  resolved_at: string | null;
  hours_to_resolve: number | null;
};

export type DrillResult = {
  dimension: DrillDimension;
  value: string;
  /** What to call it on screen — resolved from the record, never from the URL. */
  label: string;
  /**
   * How wide the opened period is. Returned rather than re-derived by the page,
   * because the width of a period is not recoverable from its start date and two
   * callers guessing separately is two chances to disagree about what a figure
   * means.
   */
  bucket: Bucket;
  /** The grouping of `series` — one level finer than `bucket`. */
  innerBucket: Bucket;
  series: MetricRow[];
  tickets: DrillTicket[];
  totals: {
    total: number;
    completed: number;
    completionPct: number | null;
    avgResolve: number | null;
    open: number;
  };
};

const TICKET_LIMIT = 100;

/**
 * Resolve the display label for a drill target BY ASKING THE DATABASE under the
 * caller's own session. If they cannot see the record, there is no label — and
 * that is the refusal, rather than echoing back whatever the URL contained.
 *
 * Echoing the URL would also be an injection of sorts: a crafted link could put
 * arbitrary text on a page that looks like the product asserting it.
 */
async function resolveLabel(
  supabase: Awaited<ReturnType<typeof createClient>>,
  dimension: DrillDimension,
  value: string
): Promise<string | null> {
  if (dimension === "period") {
    // A period is not a record; it is validated by shape instead.
    return /^\d{4}(-\d{2}){0,2}$/.test(value) ? value : null;
  }
  if (dimension === "category") {
    const ok = ["maintenance", "billing", "vendor", "complaint", "general"];
    return ok.includes(value) ? value : null;
  }
  if (dimension === "property") {
    const { data } = await supabase
      .from("properties").select("name").eq("id", value).is("deleted_at", null).maybeSingle();
    return data?.name ?? null;
  }
  const { data } = await supabase
    .from("vendors").select("name").eq("id", value).maybeSingle();
  return data?.name ?? null;
}

export async function loadDrill(
  dimension: DrillDimension,
  value: string,
  f: Filters
): Promise<ActionResult<DrillResult>> {
  const supabase = await createClient();

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return fail("Your session expired. Please sign in again.");

  const { data: me } = await supabase
    .from("users").select("role").eq("id", user.id).single();

  const { biScope } = await import("../scope");
  if (!biScope(me?.role).requests) {
    return fail(
      "Request analytics are not available for your role.",
      "The financial dashboard is on the Analytics page."
    );
  }

  const label = await resolveLabel(supabase, dimension, value);
  if (!label) {
    // Deliberately the same answer for "does not exist" and "not yours". A
    // distinguishable refusal tells a caller which property ids are real.
    return fail(
      "That is not something you can open.",
      "It may belong to another organisation, or to properties outside your scope."
    );
  }

  // The drill narrows the SAME filters the console had, plus its own dimension.
  const narrowed: Filters = { ...f };
  if (dimension === "property") narrowed.propertyId = value;
  if (dimension === "vendor") narrowed.vendorId = value;
  if (dimension === "category") narrowed.category = value;

  // How wide the opened period is, and therefore the range it covers. Both come
  // from the bucket the console grouped by, never from the date's shape — see
  // the note above `periodBucket`.
  const consoleBucket = normaliseBucket(f.bucket);
  const openedBucket = dimension === "period" ? periodBucket(value, consoleBucket) : consoleBucket;
  const range = dimension === "period" ? periodRange(value, openedBucket) : null;

  const series = await supabase.rpc("bi_ticket_metrics", {
    p_from: range ? range.start : (narrowed.from || null),
    // Inclusive: this RPC's own predicate is `created_at < (p_to + 1)`.
    p_to: range ? range.endInclusive : (narrowed.to || null),
    p_vendor_id: narrowed.vendorId || null,
    p_category: narrowed.category || null,
    p_property_id: narrowed.propertyId || null,
    p_status: narrowed.status || null,
    // Inside a drill the bucket is always one step finer than the level above —
    // opening a month to see the same month as one bar tells the reader nothing.
    p_bucket: dimension === "period" ? finer(openedBucket) : consoleBucket,
  });
  if (series.error) return failFromDb(series.error, "load these figures");

  // The records behind the number. RLS decides which rows come back; this only
  // decides how many, and orders them so the ones needing attention are first.
  let q = supabase
    .from("tickets")
    .select("id, summary, category, urgency, status, created_at, resolved_at")
    .order("created_at", { ascending: false })
    .limit(TICKET_LIMIT);

  if (dimension === "property") q = q.eq("property_id", value);
  if (dimension === "category") q = q.eq("category", value);
  if (dimension === "vendor") q = q.eq("assigned_vendor_id", value);
  if (range) {
    // Half-open: `lt` on the exclusive end, so the final day of the period is
    // included in full rather than truncated at its midnight.
    q = q.gte("created_at", range.start).lt("created_at", range.endExclusive);
  }
  if (narrowed.propertyId && dimension !== "property") q = q.eq("property_id", narrowed.propertyId);
  if (narrowed.category && dimension !== "category") q = q.eq("category", narrowed.category);
  if (narrowed.status) q = q.eq("status", narrowed.status);

  const { data: rows, error: ticketErr } = await q;
  if (ticketErr) return failFromDb(ticketErr, "load the requests behind this figure");

  const tickets: DrillTicket[] = (rows ?? []).map((t) => ({
    id: t.id,
    // ⚠️ `tickets` has NO reference column — the reference a reporter is quoted
    // is DERIVED, the first eight hex characters of the id (lib/acknowledgement
    // shortRef). Selecting `reference` here failed silently as undefined.
    reference: shortRef(t.id),
    summary: t.summary ?? null,
    category: t.category ?? null,
    urgency: t.urgency ?? null,
    status: t.status,
    created_at: t.created_at,
    resolved_at: t.resolved_at ?? null,
    hours_to_resolve:
      t.resolved_at
        ? Math.round(
            ((new Date(t.resolved_at).getTime() - new Date(t.created_at).getTime()) / 36e5) * 10
          ) / 10
        : null,
  }));

  const metrics = (series.data ?? []) as MetricRow[];
  const total = metrics.reduce((a, m) => a + Number(m.total), 0);
  const completed = metrics.reduce((a, m) => a + Number(m.completed), 0);
  const timed = metrics.reduce((a, m) => a + Number(m.timed), 0);
  // Weighted by its OWN population, per 0101 — averaging averages across
  // periods of different sizes is arithmetic on the wrong set.
  const resolveSum = metrics.reduce(
    (a, m) => a + (m.avg_hours_to_resolve === null ? 0 : Number(m.avg_hours_to_resolve) * Number(m.timed)),
    0
  );

  return ok({
    dimension,
    value,
    label,
    bucket: openedBucket,
    innerBucket: finer(openedBucket),
    series: metrics,
    tickets,
    totals: {
      total,
      completed,
      completionPct: total > 0 ? Math.round((completed / total) * 1000) / 10 : null,
      avgResolve: timed > 0 ? Math.round((resolveSum / timed) * 10) / 10 : null,
      open: tickets.filter((t) => !["resolved", "closed"].includes(t.status)).length,
    },
  });
}
