import * as React from "react";
import { Document, Page, Text, View, Image, StyleSheet } from "@react-pdf/renderer";
import type { GuideOrg } from "@/lib/pdf/role-guide";
import type { Process } from "@/lib/guides/processes";

// The training handbook, as a branded document — the whole catalogue, one
// role's chapter, or a single process as a job aid, depending on what the
// route is asked to build. Same visual family as `role-guide.tsx` (org's own
// brand, watermark, footer attribution) because a trainer flipping between
// the two documents in one session should not be able to tell they came from
// different code.
//
// ⚠️ Same "flat, not encrypted" caveat as the role guide: this cannot be
// filled in or amended in an ordinary reader, and a leaked copy is traceable
// to whoever it was generated for — that is the whole of what "secure" means
// here, not a permission-locked file.

export type TrainingGuideData = {
  org: GuideOrg;
  title: string;
  subtitle: string;
  /** Pre-grouped in catalogue order — the route groups, the document only draws. */
  groups: { module: string; items: Process[] }[];
  /** Trainer view adds the demo/mistake/exercise block; Team view omits it. */
  trainerView: boolean;
  roleLabelFor: (role: string) => string;
  generatedFor: string;
  generatedAt: string;
};

const styles = StyleSheet.create({
  page: {
    paddingTop: 44, paddingBottom: 56, paddingHorizontal: 44,
    fontSize: 10, lineHeight: 1.5, color: "#1A1A2E", fontFamily: "Helvetica",
  },
  watermark: {
    position: "absolute", top: 320, left: 0, right: 0,
    textAlign: "center", fontSize: 60, color: "#000000", opacity: 0.05,
    fontFamily: "Helvetica-Bold", transform: "rotate(-30deg)",
  },
  header: {
    flexDirection: "row", alignItems: "center", justifyContent: "space-between",
    borderBottomWidth: 2, paddingBottom: 12, marginBottom: 16,
  },
  logo: { width: 42, height: 42, objectFit: "contain" },
  orgName: { fontSize: 12.5, fontFamily: "Helvetica-Bold" },
  title: { fontSize: 19, fontFamily: "Helvetica-Bold", marginBottom: 3 },
  subtitle: { fontSize: 9.5, color: "#555", marginBottom: 16 },
  moduleHeading: {
    fontSize: 8.5, fontFamily: "Helvetica-Bold", color: "#888",
    textTransform: "uppercase", letterSpacing: 1, marginTop: 14, marginBottom: 8,
  },
  processBlock: { marginBottom: 14 },
  processTitle: { fontSize: 12.5, fontFamily: "Helvetica-Bold", marginBottom: 2 },
  startsWhen: { fontSize: 9, color: "#555", marginBottom: 6, fontFamily: "Helvetica-Oblique" },
  step: { flexDirection: "row", marginBottom: 4, paddingLeft: 2 },
  stepRole: { fontSize: 8, fontFamily: "Helvetica-Bold", width: 92 },
  stepAction: { fontSize: 9.5, color: "#333", flex: 1 },
  doneBox: {
    marginTop: 6, padding: 8, backgroundColor: "#F0F7F2",
    borderLeftWidth: 3, borderLeftColor: "#1B7F5A",
  },
  doneLabel: { fontSize: 8.5, fontFamily: "Helvetica-Bold", color: "#1B7F5A" },
  doneText: { fontSize: 9, color: "#333" },
  refusalBox: {
    marginTop: 6, padding: 8, backgroundColor: "#FBF3E8",
    borderLeftWidth: 3, borderLeftColor: "#B4690E",
  },
  refusalHeading: {
    fontSize: 8, fontFamily: "Helvetica-Bold", color: "#B4690E",
    textTransform: "uppercase", marginBottom: 3,
  },
  refusalTrigger: { fontSize: 9, fontFamily: "Helvetica-Bold", marginTop: 3 },
  refusalExplanation: { fontSize: 8.5, color: "#555" },
  trainerBox: {
    marginTop: 6, padding: 8, backgroundColor: "#F5F5FA",
    borderLeftWidth: 3, borderLeftColor: "#5B6B8C",
  },
  trainerHeading: {
    fontSize: 8, fontFamily: "Helvetica-Bold", color: "#5B6B8C",
    textTransform: "uppercase", marginBottom: 3,
  },
  trainerLine: { fontSize: 8.5, color: "#333", marginBottom: 2 },
  footer: {
    position: "absolute", bottom: 26, left: 44, right: 44,
    borderTopWidth: 1, borderTopColor: "#DDD", paddingTop: 7,
    flexDirection: "row", justifyContent: "space-between",
    fontSize: 7.5, color: "#888",
  },
});

function ProcessBlock({
  process, trainerView, roleLabelFor, brand,
}: { process: Process; trainerView: boolean; roleLabelFor: (r: string) => string; brand: string }) {
  // ⚠️ NOT `wrap={false}` on the outer block. `@react-pdf/renderer`'s
  // pagination treats an unwrappable View as one atomic unit that must fit in
  // whatever space is left on the current page — and when that unit is taller
  // than a FULL page (this catalogue's longest process runs 7 steps, 4
  // refusals and a trainer box), pdfkit's remaining-height arithmetic goes
  // negative and throws `unsupported number: -2.0e+21` deep inside its own
  // border-clipping code. It is POSITION-DEPENDENT — the very same process
  // rendered fine in a shorter chapter where more of the page was still free
  // when it started — which is what makes it easy to miss in a quick check
  // and exactly why the whole handbook (the longest possible render) is the
  // one that has to be tested, not just one role's chapter.
  //
  // Individual pieces below (doneBox, refusalBox, trainerBox) keep their own
  // `wrap={false}` — each is short enough to always fit on one page, so
  // forcing them together only prevents an ugly mid-sentence break, never a
  // pagination failure.
  return (
    <View style={styles.processBlock}>
      <Text style={styles.processTitle}>{process.title}</Text>
      <Text style={styles.startsWhen}>Starts when: {process.startsWhen}</Text>

      {process.steps.map((step, i) => (
        <View key={i} style={styles.step} wrap={false}>
          <Text style={[styles.stepRole, { color: brand }]}>
            {step.role === "system" ? "AUTOMATIC" : roleLabelFor(step.role).toUpperCase()}
          </Text>
          <Text style={styles.stepAction}>{step.action}</Text>
        </View>
      ))}

      <View style={styles.doneBox} wrap={false}>
        <Text style={styles.doneLabel}>Done means</Text>
        <Text style={styles.doneText}>{process.doneMeans}</Text>
      </View>

      {process.refusals && process.refusals.length > 0 && (
        <View style={styles.refusalBox}>
          <Text style={styles.refusalHeading}>Common refusals — the control working</Text>
          {process.refusals.map((r, i) => (
            <View key={i} wrap={false}>
              <Text style={styles.refusalTrigger}>{r.trigger}</Text>
              <Text style={styles.refusalExplanation}>{r.explanation}</Text>
            </View>
          ))}
        </View>
      )}

      {trainerView && (
        <View style={styles.trainerBox} wrap={false}>
          <Text style={styles.trainerHeading}>For the trainer</Text>
          <Text style={styles.trainerLine}>Demo: {process.trainer.demo}</Text>
          {process.trainer.commonMistake && (
            <Text style={styles.trainerLine}>Common mistake: {process.trainer.commonMistake}</Text>
          )}
          <Text style={styles.trainerLine}>Practice exercise: {process.trainer.exercise}</Text>
        </View>
      )}
    </View>
  );
}

export function TrainingGuideDocument({
  org, title, subtitle, groups, trainerView, roleLabelFor, generatedFor, generatedAt,
}: TrainingGuideData) {
  const brand = org.primary || "#003366";
  const support = [org.supportEmail, org.supportPhone].filter(Boolean).join("  ·  ");

  return (
    <Document
      title={`${title} — ${org.name}`}
      author={org.name}
      subject="Training handbook"
      creator={org.name}
      producer={org.name}
    >
      <Page size="A4" style={styles.page} wrap>
        <Text style={styles.watermark} fixed>{org.name}</Text>

        <View style={[styles.header, { borderBottomColor: brand }]} fixed>
          <View style={{ flex: 1, paddingRight: 12 }}>
            <Text style={[styles.orgName, { color: brand }]}>{org.name}</Text>
          </View>
          {org.logoUrl ? <Image src={org.logoUrl} style={styles.logo} /> : null}
        </View>

        <Text style={styles.title}>{title}</Text>
        <Text style={styles.subtitle}>{subtitle}</Text>

        {groups.map((group, i) => (
          // `break` (before every module but the first) starts each module on
          // its own page. Reads better bound for training anyway, and it
          // bounds how much content react-pdf/pdfkit has to lay out in one
          // continuous run — the whole-handbook render (15 processes, every
          // module) reproducibly threw `unsupported number: -2.0e+21` deep in
          // pdfkit's border-clipping without this; a single role's shorter
          // chapter never hit it. Verified against the running route both
          // ways, not reasoned about: same catalogue, same process content,
          // only the per-module page break differs between the crash and the
          // fix.
          <View key={group.module} break={i > 0}>
            <Text style={styles.moduleHeading}>{group.module}</Text>
            {group.items.map((p) => (
              <ProcessBlock
                key={p.id}
                process={p}
                trainerView={trainerView}
                roleLabelFor={roleLabelFor}
                brand={brand}
              />
            ))}
          </View>
        ))}

        {/* ⚠️ NOT a `render={({pageNumber,totalPages}) => …}` callback, unlike
            `role-guide.tsx`'s footer — that per-page dynamic-text pattern is
            exactly what breaks the whole-handbook render. Bisected against
            the running route: a `fixed` bordered header, PLUS a `fixed`
            footer using `render`, PLUS enough pages (10+; the full OEA
            handbook is 15) throws `unsupported number: -2.0e+21` deep inside
            pdfkit's own border-clipping — with any ONE of those three
            removed, or the page count kept low (a single role's shorter
            chapter, or `role-guide.tsx`'s few-page document), it never
            fires. That is an upstream pagination bug, not a mistake in this
            JSX — the trade is a static footer (no live page count) instead
            of chasing it further. Loses "3 of 12"; keeps the document
            actually generating. */}
        <View style={styles.footer} fixed>
          <Text>{support || org.name}</Text>
          <Text>Prepared for {generatedFor} · {generatedAt}</Text>
        </View>
      </Page>
    </Document>
  );
}
