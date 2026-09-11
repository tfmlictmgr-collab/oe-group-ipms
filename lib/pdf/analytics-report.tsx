import * as React from "react";
import { Document, Page, Text, View, Image, StyleSheet } from "@react-pdf/renderer";

// The console's figures as a board-ready document.
//
// Carries the ORG's brand, not OE Group's (B1 — the operator is not client-facing),
// states the filters it was drawn under, and repeats the measurement caveat on
// the page. A PDF outlives the screen it was printed from; a reader six months
// from now has only what is on it.

export type ReportPeriod = {
  label: string;
  total: number;
  completed: number;
  completionPct: number | null;
  timed: number;
  avgResolve: number | null;
  responded: number;
  avgResponse: number | null;
};

export type ReportVendor = {
  name: string;
  total: number;
  completed: number;
  completionPct: number | null;
  timed: number;
  avgResolve: number | null;
};

export type ReportCategory = {
  name: string;
  total: number;
  completed: number;
  completionPct: number | null;
  avgResolve: number | null;
};

export type AnalyticsReportData = {
  org: { name: string; logoUrl: string | null; primary: string; tagline: string | null };
  generatedAt: string;
  generatedBy: string;
  bucketLabel: string;
  /** Human descriptions of every filter applied, or an empty list for none. */
  appliedFilters: string[];
  headline: {
    total: number;
    completed: number;
    completionPct: number | null;
    timed: number;
    avgResolve: number | null;
    responded: number;
    avgResponse: number | null;
  };
  periods: ReportPeriod[];
  vendors: ReportVendor[];
  categories: ReportCategory[];
  /** Whether the vendor section belongs to this reader at all (B7). */
  includeVendors: boolean;
};

const hours = (n: number | null) =>
  n === null ? "—" : n < 48 ? `${n.toFixed(1)} h` : `${(n / 24).toFixed(1)} d`;
const pct = (n: number | null) => (n === null ? "—" : `${n.toFixed(1)}%`);
const num = (n: number) => n.toLocaleString("en-NG");

const s = StyleSheet.create({
  page: { paddingTop: 40, paddingBottom: 56, paddingHorizontal: 40, fontSize: 9, color: "#1A1A2E" },
  header: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start" },
  logo: { height: 30, maxWidth: 140, objectFit: "contain" },
  orgName: { fontSize: 14, fontWeight: 700 },
  tagline: { fontSize: 7.5, color: "#6B7280", marginTop: 2 },
  docTitle: { fontSize: 17, fontWeight: 700, textAlign: "right" },
  docMeta: { fontSize: 7.5, color: "#6B7280", textAlign: "right", marginTop: 3 },
  rule: { height: 3, marginTop: 14, marginBottom: 16, borderRadius: 2 },

  filterBox: {
    backgroundColor: "#F5F6F8", borderRadius: 5, padding: 10, marginBottom: 16,
  },
  filterLabel: { fontSize: 7, letterSpacing: 0.8, color: "#6B7280", textTransform: "uppercase" },
  filterText: { fontSize: 8.5, marginTop: 3, lineHeight: 1.4 },

  kpiRow: { flexDirection: "row", gap: 8, marginBottom: 16 },
  kpi: { flex: 1, borderWidth: 0.5, borderColor: "#E5E7EB", borderRadius: 5, padding: 9 },
  kpiLabel: { fontSize: 6.5, letterSpacing: 0.6, color: "#6B7280", textTransform: "uppercase" },
  kpiValue: { fontSize: 15, fontWeight: 700, marginTop: 3 },
  kpiHint: { fontSize: 6.5, color: "#6B7280", marginTop: 2 },

  section: { fontSize: 10.5, fontWeight: 700, marginTop: 6, marginBottom: 7 },
  th: {
    flexDirection: "row", borderBottomWidth: 1, borderBottomColor: "#D1D5DB",
    paddingBottom: 4, marginBottom: 2,
  },
  tr: {
    flexDirection: "row", paddingVertical: 4,
    borderBottomWidth: 0.5, borderBottomColor: "#F0F1F3",
  },
  thText: { fontSize: 7, letterSpacing: 0.4, color: "#6B7280", textTransform: "uppercase" },
  cell: { fontSize: 8.5 },
  right: { textAlign: "right" },

  caveat: {
    marginTop: 16, padding: 9, borderRadius: 5,
    borderWidth: 0.5, borderColor: "#E5E7EB", backgroundColor: "#FAFAFB",
  },
  caveatText: { fontSize: 7.5, color: "#4B5563", lineHeight: 1.5 },
  none: { fontSize: 8.5, color: "#6B7280", paddingVertical: 8 },
  footer: {
    position: "absolute", bottom: 28, left: 40, right: 40,
    fontSize: 7, color: "#6B7280", textAlign: "center",
    borderTopWidth: 0.5, borderTopColor: "#E5E7EB", paddingTop: 7,
  },
});

function Row({ cells, widths, head }: { cells: string[]; widths: string[]; head?: boolean }) {
  return (
    <View style={head ? s.th : s.tr}>
      {cells.map((c, i) => (
        <Text
          key={i}
          style={[
            head ? s.thText : s.cell,
            { width: widths[i] as `${number}%` },
            ...(i > 0 ? [s.right] : []),
          ]}
        >
          {c}
        </Text>
      ))}
    </View>
  );
}

export function AnalyticsReportDocument({ d }: { d: AnalyticsReportData }) {
  const brand = /^#[0-9a-fA-F]{6}$/.test(d.org.primary) ? d.org.primary : "#003366";
  const unmeasured = d.headline.completed - d.headline.timed;

  const periodW = ["22%", "13%", "15%", "12%", "19%", "19%"];
  const vendorW = ["34%", "12%", "14%", "13%", "12%", "15%"];
  const catW = ["34%", "17%", "17%", "16%", "16%"];

  return (
    <Document
      title={`Request analytics — ${d.org.name}`}
      author={d.org.name}
      subject="Service request volume, completion and turnaround"
    >
      <Page size="A4" style={s.page}>
        <View style={s.header}>
          <View>
            {d.org.logoUrl ? (
              /* eslint-disable-next-line jsx-a11y/alt-text --
                 react-pdf's Image draws into a PDF, not the DOM. */
              <Image src={d.org.logoUrl} style={s.logo} />
            ) : (
              <Text style={[s.orgName, { color: brand }]}>{d.org.name}</Text>
            )}
            {d.org.tagline ? <Text style={s.tagline}>{d.org.tagline}</Text> : null}
          </View>
          <View>
            <Text style={[s.docTitle, { color: brand }]}>REQUEST ANALYTICS</Text>
            <Text style={s.docMeta}>{d.bucketLabel} · generated {d.generatedAt}</Text>
            <Text style={s.docMeta}>Prepared for {d.generatedBy}</Text>
          </View>
        </View>

        <View style={[s.rule, { backgroundColor: brand }]} />

        <View style={s.filterBox}>
          <Text style={s.filterLabel}>Scope of this report</Text>
          <Text style={s.filterText}>
            {d.appliedFilters.length === 0
              ? "All requests visible to the recipient, unfiltered, for all recorded time."
              : d.appliedFilters.join("  ·  ")}
          </Text>
          <Text style={[s.filterText, { color: "#6B7280", fontSize: 7.5 }]}>
            Figures are limited to the records the recipient is authorised to see.
          </Text>
        </View>

        <View style={s.kpiRow}>
          <View style={s.kpi}>
            <Text style={s.kpiLabel}>Raised</Text>
            <Text style={[s.kpiValue, { color: brand }]}>{num(d.headline.total)}</Text>
            <Text style={s.kpiHint}>requests</Text>
          </View>
          <View style={s.kpi}>
            <Text style={s.kpiLabel}>Completed</Text>
            <Text style={[s.kpiValue, { color: brand }]}>{num(d.headline.completed)}</Text>
            <Text style={s.kpiHint}>{pct(d.headline.completionPct)} completion</Text>
          </View>
          <View style={s.kpi}>
            <Text style={s.kpiLabel}>Avg. resolve</Text>
            <Text style={[s.kpiValue, { color: brand }]}>{hours(d.headline.avgResolve)}</Text>
            <Text style={s.kpiHint}>over {num(d.headline.timed)} timed</Text>
          </View>
          <View style={s.kpi}>
            <Text style={s.kpiLabel}>Avg. first response</Text>
            <Text style={[s.kpiValue, { color: brand }]}>{hours(d.headline.avgResponse)}</Text>
            <Text style={s.kpiHint}>over {num(d.headline.responded)} responded</Text>
          </View>
        </View>

        <Text style={s.section}>By period</Text>
        {d.periods.length === 0 ? (
          <Text style={s.none}>No requests match this scope.</Text>
        ) : (
          <>
            <Row head widths={periodW}
                 cells={["Period", "Raised", "Completed", "Rate", "Avg. resolve", "Avg. response"]} />
            {d.periods.map((p) => (
              <Row key={p.label} widths={periodW} cells={[
                p.label, num(p.total), num(p.completed), pct(p.completionPct),
                hours(p.avgResolve), hours(p.avgResponse),
              ]} />
            ))}
          </>
        )}

        {d.includeVendors && (
          <>
            <Text style={s.section} break={d.periods.length > 22}>
              By vendor
            </Text>
            {d.vendors.length === 0 ? (
              <Text style={s.none}>No vendor has a request in this scope.</Text>
            ) : (
              <>
                <Row head widths={vendorW}
                     cells={["Vendor", "Raised", "Completed", "Rate", "Timed", "Avg. resolve"]} />
                {d.vendors.map((v) => (
                  <Row key={v.name} widths={vendorW} cells={[
                    v.name, num(v.total), num(v.completed), pct(v.completionPct),
                    num(v.timed), hours(v.avgResolve),
                  ]} />
                ))}
              </>
            )}
          </>
        )}

        <Text style={s.section}>By category</Text>
        {d.categories.length === 0 ? (
          <Text style={s.none}>No requests match this scope.</Text>
        ) : (
          <>
            <Row head widths={catW}
                 cells={["Category", "Raised", "Completed", "Rate", "Avg. resolve"]} />
            {d.categories.map((c) => (
              <Row key={c.name} widths={catW} cells={[
                c.name, num(c.total), num(c.completed), pct(c.completionPct), hours(c.avgResolve),
              ]} />
            ))}
          </>
        )}

        <View style={s.caveat}>
          <Text style={s.caveatText}>
            How durations are measured: resolution and first-response times are
            recorded when a request changes state. Averages cover only the
            requests actually timed —{" "}
            {unmeasured > 0
              ? `${num(unmeasured)} completed request${unmeasured === 1 ? "" : "s"} in this scope predate that recording and are counted in the totals but excluded from every average.`
              : "every completed request in this scope carries a recorded time."}{" "}
            A reopened request keeps the time of its first resolution. No duration
            is estimated or interpolated.
          </Text>
        </View>

        <Text style={s.footer} fixed>
          {d.org.name} · Computer-generated report · Figures live at {d.generatedAt}
        </Text>
      </Page>
    </Document>
  );
}
