import * as React from "react";
import { Document, Page, Text, View, Image, StyleSheet } from "@react-pdf/renderer";

// A receipt is evidence, not decoration. It carries the org's own brand (B1 —
// OE Group is not client-facing), our payment reference, and the ledger entry
// id, so a payer's copy can be tied back to a specific posting in the books
// without a support conversation.

export type ReceiptData = {
  org: {
    name: string;
    logoUrl: string | null;
    primary: string;
    supportEmail: string | null;
    supportPhone: string | null;
    tagline: string | null;
  };
  reference: string;
  ledgerEntryId: string | null;
  purpose: string;
  description: string | null;
  payerName: string;
  payerEmail: string | null;
  amountExpected: number;
  amountPaid: number;
  currency: string;
  paidAt: string | null;
  gateway: string;
  partial: boolean;
};

const naira = (n: number, currency: string) =>
  `${currency === "NGN" ? "₦" : currency + " "}${Number(n).toLocaleString("en-NG", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;

const fmt = (d: string | null) =>
  d
    ? new Date(d).toLocaleString("en-GB", {
        timeZone: "Africa/Lagos",
        day: "numeric", month: "long", year: "numeric",
        hour: "2-digit", minute: "2-digit",
      }) + " WAT"
    : "—";

const s = StyleSheet.create({
  page: { paddingTop: 44, paddingBottom: 56, paddingHorizontal: 46, fontSize: 10, color: "#1A1A2E" },
  header: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start" },
  logo: { height: 34, maxWidth: 150, objectFit: "contain" },
  orgName: { fontSize: 15, fontWeight: 700 },
  tagline: { fontSize: 8, color: "#6B7280", marginTop: 2 },
  docTitle: { fontSize: 20, fontWeight: 700, textAlign: "right" },
  docMeta: { fontSize: 8, color: "#6B7280", textAlign: "right", marginTop: 3 },
  rule: { height: 3, marginTop: 16, marginBottom: 20, borderRadius: 2 },
  amountBox: { padding: 16, borderRadius: 6, backgroundColor: "#F5F6F8", marginBottom: 22 },
  amountLabel: { fontSize: 8, letterSpacing: 1, color: "#6B7280", textTransform: "uppercase" },
  amount: { fontSize: 26, fontWeight: 700, marginTop: 4 },
  partial: { fontSize: 8, color: "#B45309", marginTop: 6 },
  row: { flexDirection: "row", paddingVertical: 6, borderBottomWidth: 0.5, borderBottomColor: "#E5E7EB" },
  key: { width: "36%", color: "#6B7280" },
  val: { width: "64%" },
  mono: { fontFamily: "Courier" },
  footer: {
    position: "absolute", bottom: 30, left: 46, right: 46,
    fontSize: 7.5, color: "#6B7280", textAlign: "center",
    borderTopWidth: 0.5, borderTopColor: "#E5E7EB", paddingTop: 8,
  },
});

export function ReceiptDocument({ d }: { d: ReceiptData }) {
  const brand = /^#[0-9a-fA-F]{6}$/.test(d.org.primary) ? d.org.primary : "#003366";

  return (
    <Document
      title={`Receipt ${d.reference}`}
      author={d.org.name}
      subject={`Payment receipt — ${d.reference}`}
    >
      <Page size="A4" style={s.page}>
        <View style={s.header}>
          <View>
            {d.org.logoUrl ? (
              /* eslint-disable-next-line jsx-a11y/alt-text --
                 react-pdf's Image draws into a PDF, not the DOM. It has no alt
                 prop, and a PDF has no screen-reader tree to put one in. */
              <Image src={d.org.logoUrl} style={s.logo} />
            ) : (
              <Text style={[s.orgName, { color: brand }]}>{d.org.name}</Text>
            )}
            {d.org.tagline ? <Text style={s.tagline}>{d.org.tagline}</Text> : null}
          </View>
          <View>
            <Text style={[s.docTitle, { color: brand }]}>RECEIPT</Text>
            <Text style={s.docMeta}>{d.reference}</Text>
            <Text style={s.docMeta}>Issued {fmt(d.paidAt)}</Text>
          </View>
        </View>

        <View style={[s.rule, { backgroundColor: brand }]} />

        <View style={s.amountBox}>
          <Text style={s.amountLabel}>Amount received</Text>
          <Text style={[s.amount, { color: brand }]}>{naira(d.amountPaid, d.currency)}</Text>
          {d.partial && (
            <Text style={s.partial}>
              Part payment. {naira(d.amountExpected, d.currency)} was invoiced;
              {" "}{naira(d.amountExpected - d.amountPaid, d.currency)} remains outstanding.
            </Text>
          )}
        </View>

        <Field k="Received from" v={d.payerName} />
        {d.payerEmail ? <Field k="Email" v={d.payerEmail} /> : null}
        <Field k="For" v={d.description ?? d.purpose.replace(/_/g, " ")} />
        <Field k="Amount invoiced" v={naira(d.amountExpected, d.currency)} />
        <Field k="Amount received" v={naira(d.amountPaid, d.currency)} />
        <Field k="Paid on" v={fmt(d.paidAt)} />
        <Field k="Payment method" v={d.gateway === "paystack" ? "Card / bank transfer (Paystack)" : d.gateway} />
        <Field k="Payment reference" v={d.reference} mono />
        {d.ledgerEntryId ? <Field k="Ledger entry" v={d.ledgerEntryId} mono /> : null}

        <View style={{ marginTop: 24 }}>
          <Text style={{ fontSize: 8.5, color: "#6B7280", lineHeight: 1.5 }}>
            This payment is held in a designated client-funds account, separately
            from {d.org.name}&rsquo;s own money, and is recorded against the
            ledger entry shown above. Queries:{" "}
            {d.org.supportEmail ?? "your account manager"}
            {d.org.supportPhone ? ` · ${d.org.supportPhone}` : ""}.
          </Text>
        </View>

        <Text style={s.footer} fixed>
          {d.org.name} · Computer-generated receipt — valid without signature ·
          Verify using reference {d.reference}
        </Text>
      </Page>
    </Document>
  );
}

function Field({ k, v, mono }: { k: string; v: string; mono?: boolean }) {
  return (
    <View style={s.row}>
      <Text style={s.key}>{k}</Text>
      <Text style={[s.val, ...(mono ? [s.mono] : [])]}>{v}</Text>
    </View>
  );
}
