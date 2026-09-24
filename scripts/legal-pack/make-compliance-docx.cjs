const fs = require("fs"), path = require("path");
const {
  Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType, BorderStyle,
  LevelFormat, Table, TableRow, TableCell, WidthType, ShadingType, ExternalHyperlink,
} = require("docx");

const PAGE_W = 9360; // usable width in DXA at 1080 margins on A4

// ── inline: **bold**, *italic*, `code`, [text](url) ────────────────────────
function inline(text, base = {}) {
  // Recursive: markdown nests (**A. Supabase `eu-west-1`**), and a one-level
  // parser leaves the inner backticks or asterisks on the page as literals —
  // which, in a document going to a lawyer, reads as a typo.
  const out = [];
  const re = /(\*\*[\s\S]+?\*\*|(?<![*\w])\*[^*]+?\*|`[^`]+`|\[[^\]]+\]\([^)]+\))/g;
  let last = 0, m;
  const plain = (t, o) => { if (t) out.push(new TextRun({ text: t, ...base, ...o })); };
  while ((m = re.exec(text))) {
    plain(text.slice(last, m.index));
    const tok = m[0];
    if (tok.startsWith("**")) out.push(...inline(tok.slice(2, -2), { ...base, bold: true }));
    else if (tok.startsWith("`")) plain(tok.slice(1, -1), { font: "Consolas", size: 18, color: "9A3412" });
    else if (tok.startsWith("[")) {
      const mm = tok.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
      out.push(new ExternalHyperlink({
        link: mm[2],
        children: inline(mm[1], { ...base, color: "1155CC", underline: {} }),
      }));
    } else out.push(...inline(tok.slice(1, -1), { ...base, italics: true }));
    last = m.index + tok.length;
  }
  plain(text.slice(last));
  return out.length ? out : [new TextRun({ text: "", ...base })];
}

const splitRow = (l) => l.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());

function makeTable(rows) {
  const head = splitRow(rows[0]);
  const bodyRows = rows.slice(2).map(splitRow);
  const n = head.length;
  const w = Math.floor(PAGE_W / n);
  const widths = Array(n).fill(w);
  widths[n - 1] = PAGE_W - w * (n - 1);
  const cell = (txt, i, hdr) => new TableCell({
    width: { size: widths[i], type: WidthType.DXA },
    shading: hdr ? { type: ShadingType.CLEAR, fill: "EAECF0" } : undefined,
    margins: { top: 70, bottom: 70, left: 110, right: 110 },
    children: [new Paragraph({ children: inline(txt, hdr ? { bold: true, size: 18 } : { size: 18 }), spacing: { after: 0 } })],
  });
  return new Table({
    columnWidths: widths,
    width: { size: PAGE_W, type: WidthType.DXA },
    rows: [
      new TableRow({ tableHeader: true, children: head.map((c, i) => cell(c, i, true)) }),
      ...bodyRows.map((r) => new TableRow({
        children: Array.from({ length: n }, (_, i) => cell(r[i] ?? "", i, false)),
      })),
    ],
  });
}

function convert(md) {
  const lines = md.split("\n");
  const out = [];
  let i = 0;
  const para = (txt, o = {}) => out.push(new Paragraph({ children: inline(txt), spacing: { after: 140, line: 268 }, ...o }));

  while (i < lines.length) {
    const l = lines[i];

    if (/^```/.test(l)) {
      i++;
      const block = [];
      while (i < lines.length && !/^```/.test(lines[i])) block.push(lines[i++]);
      i++; // closing fence
      out.push(new Table({
        columnWidths: [PAGE_W], width: { size: PAGE_W, type: WidthType.DXA },
        rows: [new TableRow({ children: [new TableCell({
          width: { size: PAGE_W, type: WidthType.DXA },
          shading: { type: ShadingType.CLEAR, fill: "F4F4F5" },
          margins: { top: 120, bottom: 120, left: 160, right: 160 },
          children: (block.length ? block : [""]).map((t, k, a) => new Paragraph({
            children: [new TextRun({ text: t, font: "Consolas", size: 17 })],
            spacing: { after: k === a.length - 1 ? 0 : 40 },
          })),
        })] })],
      }));
      out.push(new Paragraph({ text: "", spacing: { after: 160 } }));
      continue;
    }
    if (/^\|/.test(l) && /^\|[\s:|-]+\|?$/.test(lines[i + 1] || "")) {
      const block = [];
      while (i < lines.length && /^\|/.test(lines[i])) block.push(lines[i++]);
      out.push(makeTable(block));
      out.push(new Paragraph({ text: "", spacing: { after: 160 } }));
      continue;
    }
    if (/^(---+|\*\*\*+)\s*$/.test(l)) {
      out.push(new Paragraph({ text: "", spacing: { after: 120 },
        border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: "D0D5DD", space: 6 } } }));
      i++; continue;
    }
    let m;
    if ((m = l.match(/^(#{1,4})\s+(.*)$/))) {
      const lvl = m[1].length;
      out.push(new Paragraph({
        children: inline(m[2]),
        heading: [HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3, HeadingLevel.HEADING_4][lvl - 1],
        spacing: { before: lvl === 1 ? 0 : 300, after: 140 },
      }));
      i++; continue;
    }
    if (/^>\s?/.test(l)) {
      const block = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) block.push(lines[i++].replace(/^>\s?/, ""));
      out.push(new Table({
        columnWidths: [PAGE_W], width: { size: PAGE_W, type: WidthType.DXA },
        rows: [new TableRow({ children: [new TableCell({
          width: { size: PAGE_W, type: WidthType.DXA },
          shading: { type: ShadingType.CLEAR, fill: "F7F8FA" },
          margins: { top: 140, bottom: 140, left: 180, right: 180 },
          children: joinWrapped(block).map((t, k, a) => new Paragraph({
            children: inline(t, { size: 19 }), spacing: { after: k === a.length - 1 ? 0 : 100 } })),
        })] })],
      }));
      out.push(new Paragraph({ text: "", spacing: { after: 160 } }));
      continue;
    }
    if ((m = l.match(/^(\s*)([-*])\s+(.*)$/))) {
      const indent = Math.min(Math.floor(m[1].length / 2), 2);
      const block = [m[3]];
      i++;
      while (i < lines.length && /^\s{2,}\S/.test(lines[i]) && !/^\s*([-*]|\d+\.)\s/.test(lines[i])) block.push(lines[i++].trim());
      out.push(new Paragraph({
        children: inline(block.join(" ")),
        numbering: { reference: "bul", level: indent },
        spacing: { after: 80, line: 268 },
      }));
      continue;
    }
    if ((m = l.match(/^(\s*)(\d+)\.\s+(.*)$/))) {
      const block = [m[3]];
      i++;
      while (i < lines.length && /^\s{2,}\S/.test(lines[i]) && !/^\s*([-*]|\d+\.)\s/.test(lines[i])) block.push(lines[i++].trim());
      out.push(new Paragraph({
        children: inline(block.join(" ")),
        numbering: { reference: "num", level: 0 },
        spacing: { after: 80, line: 268 },
      }));
      continue;
    }
    if (!l.trim()) { i++; continue; }
    // ordinary paragraph: markdown soft-wraps, so join until a blank line
    const block = [];
    while (i < lines.length && lines[i].trim() && !/^(#{1,4}\s|>|\||\s*[-*]\s|\s*\d+\.\s|---)/.test(lines[i])) block.push(lines[i++].trim());
    para(block.join(" "));
  }
  return out;
}
const joinWrapped = (arr) => {
  const out = []; let buf = [];
  for (const l of arr) {
    if (!l.trim()) { if (buf.length) { out.push(buf.join(" ")); buf = []; } }
    else buf.push(l.trim());
  }
  if (buf.length) out.push(buf.join(" "));
  return out.length ? out : [""];
};

const numbering = { config: [
  { reference: "bul", levels: [0,1,2].map((lv) => ({
      level: lv, format: LevelFormat.BULLET, text: ["•","◦","▪"][lv],
      alignment: AlignmentType.LEFT,
      style: { paragraph: { indent: { left: 400 + lv * 360, hanging: 300 } } } })) },
  { reference: "num", levels: [{ level: 0, format: LevelFormat.DECIMAL, text: "%1.",
      alignment: AlignmentType.LEFT,
      style: { paragraph: { indent: { left: 400, hanging: 300 } } } }] },
] };

function build(mdPath, banner) {
  const md = fs.readFileSync(mdPath, "utf8");
  const children = [
    new Paragraph({ children: [new TextRun({ text: banner, size: 16, bold: true, color: "6B7280" })], spacing: { after: 240 } }),
    ...convert(md),
  ];
  return new Document({
    numbering,
    styles: { default: {
      document: { run: { font: "Calibri", size: 21 } },
      heading1: { run: { font: "Calibri", size: 34, bold: true, color: "003366" }, paragraph: { spacing: { after: 160 } } },
      heading2: { run: { font: "Calibri", size: 25, bold: true, color: "003366" } },
      heading3: { run: { font: "Calibri", size: 22, bold: true, color: "1F4E79" } },
      heading4: { run: { font: "Calibri", size: 21, bold: true, color: "374151" } },
    } },
    sections: [{ properties: { page: { margin: { top: 1080, bottom: 1080, left: 1080, right: 1080 } } }, children }],
  });
}

module.exports = { build, convert };

if (require.main === module) {
  const DOCS = path.join(__dirname, "..", "..", "docs");
  const OUT = `${DOCS}/legal`;
  const BANNER = "OE GROUP — FOR LEGAL REVIEW · generated from the repository, 24 September 2026";
  const set = [
    ["legal/00_READ_FIRST_Legal_Review_Pack_Index", "00_READ_FIRST_Legal_Review_Pack_Index"],
    ["PRIVACY_NOTICE", "Privacy_Notice"],
    ["NDPA_COMPLIANCE_PACK", "NDPA_Compliance_Pack"],
    ["DATA_SUBJECT_RIGHTS_PROCEDURE", "Data_Subject_Rights_Procedure"],
    ["BREACH_PROCEDURE", "Breach_Procedure"],
    ["DPA_TEMPLATE_AND_TRACKER", "Processor_DPA_Template_and_Tracker"],
    ["CROSS_BORDER_TRANSFER_BASIS", "Cross_Border_Transfer_Basis"],
    ["CONSENT_AND_OPEN_ITEMS", "Consent_and_Open_Items"],
  ];
  (async () => {
    for (const [src, name] of set) {
      const buf = await Packer.toBuffer(build(`${DOCS}/${src}.md`, BANNER));
      const file = name.startsWith("00_") ? `${name}.docx` : `${name}_FOR_LEGAL_REVIEW.docx`;
      fs.writeFileSync(`${OUT}/${file}`, buf);
      console.log(String(buf.length).padStart(7), file);
    }
  })();
}
