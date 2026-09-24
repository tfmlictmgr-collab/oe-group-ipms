const fs = require("fs"), path = require("path");
const {
  Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType,
  BorderStyle, LevelFormat, Table, TableRow, TableCell, WidthType, ShadingType,
} = require("docx");

const SRC = path.join(__dirname, "policy-content.json");
const data = JSON.parse(fs.readFileSync(SRC, "utf8"));
const OUT = path.join(__dirname, "..", "..", "docs", "legal");

const numbering = {
  config: [{
    reference: "bullets",
    levels: [{
      level: 0, format: LevelFormat.BULLET, text: "•",
      alignment: AlignmentType.LEFT,
      style: { paragraph: { indent: { left: 720, hanging: 360 } } },
    }],
  }],
};

// A variable the page fills in at render time. Shown so a reviewer can see
// exactly where it lands, and cannot mistake it for fixed wording.
const VAR = /(\{Organisation\}|\{SupportEmail\}|\{FinanceEmail\})/g;
function runs(text, opts = {}) {
  return text.split(VAR).filter((s) => s !== "").map((piece) =>
    VAR.test(piece)
      ? new TextRun({ text: piece, bold: true, color: "8A4B00", ...opts })
      : new TextRun({ text: piece, ...opts })
  );
}

const body = (text) => new Paragraph({ children: runs(text), spacing: { after: 160, line: 276 } });
function bullet(text) {
  // The page leads some bullets with a bold category ("Duplicate payment — ...").
  // Preserve it: that is how the entitlement list is read, not decoration.
  const m = text.match(/^([^—]{1,40})— (.*)$/);
  const children = m
    ? [new TextRun({ text: m[1].trim(), bold: true }), new TextRun({ text: " — " }), ...runs(m[2])]
    : runs(text);
  return new Paragraph({ children, numbering: { reference: "bullets", level: 0 }, spacing: { after: 90, line: 276 } });
}
const h2 = (text) => new Paragraph({ text, heading: HeadingLevel.HEADING_2, spacing: { before: 320, after: 140 } });

function noteBox(lines) {
  return new Table({
    columnWidths: [9360],
    width: { size: 9360, type: WidthType.DXA },
    rows: [new TableRow({
      children: [new TableCell({
        width: { size: 9360, type: WidthType.DXA },
        shading: { type: ShadingType.CLEAR, fill: "F2F4F7" },
        margins: { top: 160, bottom: 160, left: 200, right: 200 },
        children: lines.map((l, i) => new Paragraph({
          children: [new TextRun({ text: l, size: 18, bold: i === 0, color: "3A3A3A" })],
          spacing: { after: i === lines.length - 1 ? 0 : 100 },
        })),
      })],
    })],
  });
}

function buildDoc(key) {
  const d = data[key];
  const children = [
    new Paragraph({
      children: [new TextRun({ text: "OE GROUP — FOR LEGAL REVIEW", size: 16, bold: true, color: "6B7280" })],
      spacing: { after: 200 },
    }),
    new Paragraph({ text: d.title, heading: HeadingLevel.HEADING_1, spacing: { after: 80 } }),
    new Paragraph({
      children: [new TextRun({ text: `Last updated: ${d.updated}`, italics: true, color: "6B7280", size: 20 })],
      spacing: { after: 260 },
      border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: "D0D5DD", space: 8 } },
    }),
    noteBox([
      "Note for the reviewer",
      "This is the text published at /legal/" + (key === "terms" ? "terms" : "refunds") + " on each portal domain. It was generated from the page source, so any wording you change here must be applied back to the application before it takes effect on the website — editing this file alone changes nothing that a gateway reviewer or a tenant will see.",
      "Words shown in bold amber are filled in by the page at the moment it is served, from the organisation that owns the domain being visited. They are not fixed wording:",
      "    {Organisation} — the legal entity. On oeaportal.com this is Ora Egbunike & Associates; on the TFML portal it is Total Facilities Management Limited. No other organisation is ever named on a given domain.",
      "    {SupportEmail} / {FinanceEmail} — that organisation's own support and finance addresses, taken from its settings. Where an organisation has not set one, no address is shown: in Terms clause 12 and Refunds clause 3 the phrase becomes “through the Portal”, and in Terms clause 5 it is left out altogether, so the sentence ends at “Data Protection Officer”.",
      "    Internal links (“Refund Policy” in Terms clause 3, “Terms of Service” in the Refunds opening) are live hyperlinks on the website and appear here as plain text.",
      "Context: these two policies were published because Flutterwave requires a merchant's website to carry terms of service and a refund policy before it will reactivate the account. They are also read by tenants, occupants, property owners and vendors, who are the people the wording actually has to work for.",
      "Please mark up freely. Questions of substance to note in particular are flagged in the covering email.",
    ]),
    new Paragraph({ text: "", spacing: { after: 280 } }),
  ];

  d.intro.forEach((p) => children.push(body(p)));
  d.sections.forEach((s) => {
    children.push(h2(s.h));
    (s.p || []).forEach((p) => children.push(body(p)));
    (s.ul || []).forEach((li) => children.push(bullet(li)));
    (s.after || []).forEach((p) => children.push(body(p)));
  });

  return new Document({
    numbering,
    styles: {
      default: {
        document: { run: { font: "Calibri", size: 21 } },
        heading1: { run: { font: "Calibri", size: 36, bold: true, color: "003366" } },
        heading2: { run: { font: "Calibri", size: 24, bold: true, color: "003366" } },
      },
    },
    sections: [{
      properties: { page: { margin: { top: 1080, bottom: 1080, left: 1080, right: 1080 } } },
      children,
    }],
  });
}

(async () => {
  for (const [key, name] of [["terms", "TENTai_Terms_of_Service"], ["refunds", "TENTai_Refund_Policy"]]) {
    const buf = await Packer.toBuffer(buildDoc(key));
    fs.writeFileSync(`${OUT}/${name}_FOR_LEGAL_REVIEW.docx`, buf);
    console.log("wrote", `${name}_FOR_LEGAL_REVIEW.docx`, buf.length, "bytes");
  }
})();
