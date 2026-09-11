import * as React from "react";
import { Document, Page, Text, View, Image, StyleSheet } from "@react-pdf/renderer";
import type { RoleGuide } from "@/lib/guides/content";

// The role guide, as a branded document someone can keep.
//
// It carries the ORGANISATION's brand, never OE Group's — B1 again: a TFML
// caretaker's handbook showing OEA's colours would be the same leak as a
// dashboard doing it. Everything here comes from the org's own settings, so a
// new client's guides are correctly branded the day they are onboarded, with
// nobody editing a template.
//
// ⚠️ On "cannot be edited". This is a FLAT PDF — the text is drawn, not held in
// form fields, so it cannot be filled in or amended in an ordinary reader, and
// the watermark makes a doctored copy obvious. That is not the same as an
// encrypted, permission-locked PDF, which @react-pdf/renderer cannot produce
// and which would need a native binary this stack deliberately does not run
// (A2: managed services, no self-hosting). Saying "secure" when what we have is
// "flattened and watermarked" would be the kind of claim an auditor tests once
// and never trusts again. If true document encryption is ever required, it is a
// scoped piece of work with its own decision, not a checkbox here.

export type GuideOrg = {
  name: string;
  logoUrl: string | null;
  primary: string;
  tagline: string | null;
  supportEmail: string | null;
  supportPhone: string | null;
  portalName: string | null;
};

export type RoleGuideData = {
  org: GuideOrg;
  guide: RoleGuide;
  roleLabel: string;
  /** Who it was generated for, so a shared copy is traceable to a person. */
  generatedFor: string;
  generatedAt: string;
};

const styles = StyleSheet.create({
  page: {
    paddingTop: 44, paddingBottom: 56, paddingHorizontal: 44,
    fontSize: 10.5, lineHeight: 1.55, color: "#1A1A2E", fontFamily: "Helvetica",
  },
  // Sits behind the content. Rendered first and given no space in the flow, so
  // it tints the page rather than pushing anything down.
  watermark: {
    position: "absolute", top: 300, left: 0, right: 0,
    textAlign: "center", fontSize: 62, color: "#000000", opacity: 0.05,
    fontFamily: "Helvetica-Bold", transform: "rotate(-30deg)",
  },
  header: {
    flexDirection: "row", alignItems: "center", justifyContent: "space-between",
    borderBottomWidth: 2, paddingBottom: 12, marginBottom: 18,
  },
  logo: { width: 46, height: 46, objectFit: "contain" },
  orgName: { fontSize: 13, fontFamily: "Helvetica-Bold" },
  orgTag: { fontSize: 8.5, color: "#666", marginTop: 2, maxWidth: 300 },
  title: { fontSize: 21, fontFamily: "Helvetica-Bold", marginBottom: 4 },
  audience: { fontSize: 10, color: "#555", marginBottom: 18 },
  sectionHeading: {
    fontSize: 12.5, fontFamily: "Helvetica-Bold", marginTop: 16, marginBottom: 6,
  },
  sectionIntro: { fontSize: 9.5, color: "#555", marginBottom: 8 },
  step: { marginBottom: 9, paddingLeft: 10, borderLeftWidth: 2 },
  stepTitle: { fontSize: 10.5, fontFamily: "Helvetica-Bold", marginBottom: 2 },
  stepBody: { fontSize: 10, color: "#333" },
  cannotBox: {
    marginTop: 18, padding: 11, backgroundColor: "#FAFAFA",
    borderLeftWidth: 3, borderLeftColor: "#999",
  },
  cannotHeading: { fontSize: 11, fontFamily: "Helvetica-Bold", marginBottom: 5 },
  cannotItem: { fontSize: 9.5, color: "#444", marginBottom: 3 },
  footer: {
    position: "absolute", bottom: 26, left: 44, right: 44,
    borderTopWidth: 1, borderTopColor: "#DDD", paddingTop: 7,
    flexDirection: "row", justifyContent: "space-between",
    fontSize: 7.5, color: "#888",
  },
});

export function RoleGuideDocument({
  org, guide, roleLabel, generatedFor, generatedAt,
}: RoleGuideData) {
  const brand = org.primary || "#003366";
  const support = [org.supportEmail, org.supportPhone].filter(Boolean).join("  ·  ");

  return (
    <Document
      title={`${guide.title} — ${org.name}`}
      author={org.name}
      subject={`${roleLabel} guide`}
      creator={org.name}
      producer={org.name}
    >
      <Page size="A4" style={styles.page} wrap>
        <Text style={styles.watermark} fixed>{org.name}</Text>

        <View style={[styles.header, { borderBottomColor: brand }]} fixed>
          <View style={{ flex: 1, paddingRight: 12 }}>
            <Text style={[styles.orgName, { color: brand }]}>{org.name}</Text>
            {org.tagline ? <Text style={styles.orgTag}>{org.tagline}</Text> : null}
          </View>
          {/* An org with no logo simply gets none — a broken image box on a
              handbook looks worse than white space. */}
          {org.logoUrl ? <Image src={org.logoUrl} style={styles.logo} /> : null}
        </View>

        <Text style={styles.title}>{guide.title}</Text>
        <Text style={styles.audience}>{guide.audience}</Text>

        {guide.sections.map((section) => (
          <View key={section.heading} wrap={false}>
            <Text style={[styles.sectionHeading, { color: brand }]}>
              {section.heading}
            </Text>
            {section.intro ? (
              <Text style={styles.sectionIntro}>{section.intro}</Text>
            ) : null}
            {section.steps.map((step) => (
              <View key={step.title} style={[styles.step, { borderLeftColor: brand }]}>
                <Text style={styles.stepTitle}>{step.title}</Text>
                <Text style={styles.stepBody}>{step.body}</Text>
              </View>
            ))}
          </View>
        ))}

        {/* Stated as plainly as what you CAN do. This is the half that stops a
            support call asking for something the role was never meant to have —
            and, for the money roles, the half that explains a refusal as the
            control working rather than as a fault. */}
        <View style={styles.cannotBox} wrap={false}>
          <Text style={styles.cannotHeading}>What this role cannot do</Text>
          {guide.cannot.map((c) => (
            <Text key={c} style={styles.cannotItem}>•  {c}</Text>
          ))}
        </View>

        <View style={styles.footer} fixed>
          <Text>{support || org.name}</Text>
          <Text
            render={({ pageNumber, totalPages }) =>
              `Prepared for ${generatedFor} · ${generatedAt} · ${pageNumber} of ${totalPages}`
            }
          />
        </View>
      </Page>
    </Document>
  );
}
