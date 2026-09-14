"use server";

import { createClient } from "@/lib/supabase/server";
import { ok, failFromDb, type ActionResult } from "@/lib/action-result";

// The analytics console's reads.
//
// Every call runs under the caller's own session, so the RLS on `tickets`
// decides what is counted. Nothing here re-states a scoping rule: an FM/PM
// asking for "all vendors this quarter" gets their own properties' figures
// because the database narrowed them, not because this file remembered to.

export type Filters = {
  from?: string | null;
  to?: string | null;
  vendorId?: string | null;
  category?: string | null;
  propertyId?: string | null;
  status?: string | null;
  bucket?: "week" | "month" | "quarter" | "year";
};

export type MetricRow = {
  period: string;
  total: number;
  completed: number;
  completion_pct: number | null;
  timed: number;
  avg_hours_to_resolve: number | null;
  responded: number;
  avg_hours_to_first_response: number | null;
};

export type VendorRow = {
  vendor_id: string;
  vendor_name: string;
  total: number;
  completed: number;
  completion_pct: number | null;
  timed: number;
  avg_hours_to_resolve: number | null;
};

export type CategoryRow = {
  category: string;
  total: number;
  completed: number;
  completion_pct: number | null;
  avg_hours_to_resolve: number | null;
};

/** Turns the UI's filter object into the arguments the SQL functions take. */
function args(f: Filters) {
  return {
    p_from: f.from || null,
    p_to: f.to || null,
    p_vendor_id: f.vendorId || null,
    p_category: f.category || null,
    p_property_id: f.propertyId || null,
  };
}

export async function loadAnalytics(f: Filters): Promise<
  ActionResult<{ metrics: MetricRow[]; vendors: VendorRow[]; categories: CategoryRow[] }>
> {
  const supabase = await createClient();
  const a = args(f);

  const [metricsRes, vendorsRes, categoriesRes] = await Promise.all([
    supabase.rpc("bi_ticket_metrics", {
      ...a,
      p_status: f.status || null,
      p_bucket: f.bucket ?? "month",
    }),
    // Vendor and category breakdowns deliberately ignore the STATUS filter:
    // "completion rate by vendor" means nothing when the set has been narrowed
    // to completed tickets only — it would read 100% for everyone.
    supabase.rpc("bi_vendor_performance", {
      p_from: a.p_from, p_to: a.p_to,
      p_category: a.p_category, p_property_id: a.p_property_id,
    }),
    supabase.rpc("bi_category_performance", {
      p_from: a.p_from, p_to: a.p_to,
      p_vendor_id: a.p_vendor_id, p_property_id: a.p_property_id,
    }),
  ]);

  if (metricsRes.error) return failFromDb(metricsRes.error, "load these figures");
  if (vendorsRes.error) return failFromDb(vendorsRes.error, "load vendor performance");
  if (categoriesRes.error) return failFromDb(categoriesRes.error, "load the category breakdown");

  return ok({
    metrics: (metricsRes.data ?? []) as MetricRow[],
    vendors: (vendorsRes.data ?? []) as VendorRow[],
    categories: (categoriesRes.data ?? []) as CategoryRow[],
  });
}

/**
 * The same figures as CSV.
 *
 * Built from a fresh query rather than from whatever the browser is showing —
 * an export that serialises client state exports the state, not the data, and
 * the two drift the moment a filter is changed without a refetch.
 */
export async function exportAnalyticsCsv(f: Filters): Promise<ActionResult<{ csv: string }>> {
  const result = await loadAnalytics(f);
  if (!result.ok) return result;

  const { metrics, vendors, categories } = result.data;
  const esc = (v: unknown) => {
    const s = v === null || v === undefined ? "" : String(v);
    // A property called "Ikoyi Heights, Block B" must not become two columns.
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const rows: string[] = [];

  rows.push(
    "Period,Raised,Completed,Completion %,Timed,Avg hours to resolve,Responded,Avg hours to first response"
  );
  for (const m of metrics) {
    rows.push([
      m.period, m.total, m.completed, m.completion_pct ?? "",
      m.timed, m.avg_hours_to_resolve ?? "",
      m.responded, m.avg_hours_to_first_response ?? "",
    ].map(esc).join(","));
  }

  rows.push("", "Vendor,Total,Completed,Completion %,Timed,Avg hours to resolve");
  for (const v of vendors) {
    rows.push([
      v.vendor_name, v.total, v.completed, v.completion_pct ?? "",
      v.timed, v.avg_hours_to_resolve ?? "",
    ].map(esc).join(","));
  }

  rows.push("", "Category,Total,Completed,Completion %,Avg hours to resolve");
  for (const c of categories) {
    rows.push([
      c.category, c.total, c.completed, c.completion_pct ?? "", c.avg_hours_to_resolve ?? "",
    ].map(esc).join(","));
  }

  // A note on the export itself, so a spreadsheet handed to a board carries the
  // same caveat the screen does.
  rows.push(
    "",
    esc("Averages cover only tickets with a recorded resolution time. Requests resolved before timing began are counted in totals but excluded from durations.")
  );

  return ok({ csv: rows.join("\n") });
}
