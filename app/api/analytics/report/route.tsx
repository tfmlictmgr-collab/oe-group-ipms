import { NextRequest, NextResponse } from "next/server";
import { renderToBuffer } from "@react-pdf/renderer";
import { createClient } from "@/lib/supabase/server";
import { biScope } from "@/app/dashboard/bi/scope";
import {
  AnalyticsReportDocument, type AnalyticsReportData,
} from "@/lib/pdf/analytics-report";

// The analytics console's figures as a PDF.
//
// ⚠️ Generated with the CALLER's client, never the service role. The three `bi_*`
// functions are plain SQL over `tickets`, so the same RLS that narrows the screen
// narrows this document — an FM/PM exporting "all vendors" gets their own
// properties' vendors, without this route knowing that rule exists.
//
// Filters arrive as query parameters so the link can be shared, bookmarked and
// re-run. They are passed to the RPC as parameters, not interpolated.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BUCKETS = ["week", "month", "quarter", "year"] as const;
const BUCKET_LABEL: Record<string, string> = {
  week: "Weekly", month: "Monthly", quarter: "Quarterly", year: "Yearly",
};

const titleize = (s: string) =>
  s.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

/** A date only if it is one — an unparseable value is dropped, not passed on. */
function asDate(v: string | null): string | null {
  return v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null;
}
function asUuid(v: string | null): string | null {
  return v && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v) ? v : null;
}

function periodLabel(iso: string, bucket: string) {
  const d = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return iso;
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth();
  if (bucket === "year") return String(y);
  if (bucket === "quarter") return `Q${Math.floor(m / 3) + 1} ${y}`;
  const mon = d.toLocaleString("en-GB", { month: "short", timeZone: "UTC" });
  if (bucket === "week") return `w/c ${d.getUTCDate()} ${mon} ${y}`;
  return `${mon} ${y}`;
}

export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return new NextResponse("Sign in required", { status: 401 });

  const { data: profile } = await supabase
    .from("users").select("role, full_name, email, org_id").eq("id", user.id).single();

  const scope = biScope(profile?.role);
  // The same gate the page uses. Without it, a role that cannot open the console
  // could still fetch its contents by typing the export URL.
  if (!scope.requests) {
    return new NextResponse("Request analytics are not available for your role.", { status: 403 });
  }

  const q = request.nextUrl.searchParams;
  const bucketRaw = q.get("bucket") ?? "month";
  const bucket = (BUCKETS as readonly string[]).includes(bucketRaw) ? bucketRaw : "month";
  const from = asDate(q.get("from"));
  const to = asDate(q.get("to"));
  const vendorId = asUuid(q.get("vendor"));
  const propertyId = asUuid(q.get("property"));
  const category = q.get("category");
  const status = q.get("status");

  const shared = {
    p_from: from, p_to: to, p_vendor_id: vendorId,
    p_category: category, p_property_id: propertyId,
  };

  const [metricsRes, vendorsRes, categoriesRes, orgRes] = await Promise.all([
    supabase.rpc("bi_ticket_metrics", { ...shared, p_status: status, p_bucket: bucket }),
    // Mirrors the screen: the vendor and category breakdowns ignore the status
    // filter, because completion rate within "completed only" is 100% for
    // everyone and says nothing.
    scope.vendorPerf
      ? supabase.rpc("bi_vendor_performance", {
          p_from: from, p_to: to, p_category: category, p_property_id: propertyId,
        })
      : Promise.resolve({ data: [], error: null }),
    supabase.rpc("bi_category_performance", {
      p_from: from, p_to: to, p_vendor_id: vendorId, p_property_id: propertyId,
    }),
    supabase.from("orgs")
      .select("name, portal_name, logo_url, theme_primary, tagline")
      .eq("id", profile?.org_id).single(),
  ]);

  if (metricsRes.error) {
    return new NextResponse(`Could not build the report: ${metricsRes.error.message}`, { status: 500 });
  }

  type M = {
    period: string; total: number; completed: number; completion_pct: number | null;
    timed: number; avg_hours_to_resolve: number | null;
    responded: number; avg_hours_to_first_response: number | null;
  };
  const metrics = (metricsRes.data ?? []) as M[];

  // Pooled with each average weighted by its OWN population (0101).
  const h = metrics.reduce(
    (a, m) => ({
      total: a.total + Number(m.total),
      completed: a.completed + Number(m.completed),
      timed: a.timed + Number(m.timed),
      responded: a.responded + Number(m.responded),
      resolveSum: a.resolveSum +
        (m.avg_hours_to_resolve === null ? 0 : Number(m.avg_hours_to_resolve) * Number(m.timed)),
      responseSum: a.responseSum +
        (m.avg_hours_to_first_response === null ? 0
          : Number(m.avg_hours_to_first_response) * Number(m.responded)),
    }),
    { total: 0, completed: 0, timed: 0, responded: 0, resolveSum: 0, responseSum: 0 }
  );

  // Filters are described by the LABEL the reader chose, not the id they never
  // saw — "Vendor: Bright Facilities", not a uuid. Resolved through the caller's
  // own client, so an unreadable id simply stays unnamed.
  const applied: string[] = [];
  if (from || to) {
    const fmt = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString("en-GB", {
      day: "numeric", month: "short", year: "numeric", timeZone: "UTC",
    });
    applied.push(
      from && to ? `Period: ${fmt(from)} – ${fmt(to)}`
        : from ? `From ${fmt(from)}` : `Up to ${fmt(to as string)}`
    );
  }
  if (propertyId) {
    const { data: p } = await supabase.from("properties").select("name").eq("id", propertyId).maybeSingle();
    applied.push(`Property: ${p?.name ?? "restricted"}`);
  }
  if (vendorId) {
    const { data: v } = await supabase.from("vendors").select("name").eq("id", vendorId).maybeSingle();
    applied.push(`Vendor: ${v?.name ?? "restricted"}`);
  }
  if (category) applied.push(`Category: ${titleize(category)}`);
  if (status) applied.push(`Status: ${titleize(status)}`);

  const org = orgRes.data;
  const data: AnalyticsReportData = {
    org: {
      name: org?.portal_name || org?.name || "Organisation",
      logoUrl: org?.logo_url ?? null,
      primary: org?.theme_primary ?? "#003366",
      tagline: org?.tagline ?? null,
    },
    generatedAt: new Date().toLocaleString("en-GB", {
      timeZone: "Africa/Lagos", day: "numeric", month: "long", year: "numeric",
      hour: "2-digit", minute: "2-digit",
    }) + " WAT",
    generatedBy: profile?.full_name || profile?.email || "the recipient",
    bucketLabel: BUCKET_LABEL[bucket],
    appliedFilters: applied,
    headline: {
      total: h.total,
      completed: h.completed,
      completionPct: h.total > 0 ? (h.completed / h.total) * 100 : null,
      timed: h.timed,
      avgResolve: h.timed > 0 ? h.resolveSum / h.timed : null,
      responded: h.responded,
      avgResponse: h.responded > 0 ? h.responseSum / h.responded : null,
    },
    periods: metrics.map((m) => ({
      label: periodLabel(m.period, bucket),
      total: Number(m.total),
      completed: Number(m.completed),
      completionPct: m.completion_pct === null ? null : Number(m.completion_pct),
      timed: Number(m.timed),
      avgResolve: m.avg_hours_to_resolve === null ? null : Number(m.avg_hours_to_resolve),
      responded: Number(m.responded),
      avgResponse: m.avg_hours_to_first_response === null ? null
        : Number(m.avg_hours_to_first_response),
    })),
    vendors: ((vendorsRes.data ?? []) as {
      vendor_name: string; total: number; completed: number;
      completion_pct: number | null; timed: number; avg_hours_to_resolve: number | null;
    }[]).map((v) => ({
      name: v.vendor_name,
      total: Number(v.total),
      completed: Number(v.completed),
      completionPct: v.completion_pct === null ? null : Number(v.completion_pct),
      timed: Number(v.timed),
      avgResolve: v.avg_hours_to_resolve === null ? null : Number(v.avg_hours_to_resolve),
    })),
    categories: ((categoriesRes.data ?? []) as {
      category: string; total: number; completed: number;
      completion_pct: number | null; avg_hours_to_resolve: number | null;
    }[]).map((c) => ({
      name: titleize(c.category),
      total: Number(c.total),
      completed: Number(c.completed),
      completionPct: c.completion_pct === null ? null : Number(c.completion_pct),
      avgResolve: c.avg_hours_to_resolve === null ? null : Number(c.avg_hours_to_resolve),
    })),
    includeVendors: scope.vendorPerf,
  };

  const buffer = await renderToBuffer(<AnalyticsReportDocument d={data} />);
  const filename = `request-analytics-${new Date().toISOString().slice(0, 10)}.pdf`;

  return new NextResponse(new Uint8Array(buffer), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="${filename}"`,
      // A report of live figures must not be served from a cache — least of all
      // a shared one, where the next reader's scope is not this reader's.
      "Cache-Control": "private, no-store",
    },
  });
}
