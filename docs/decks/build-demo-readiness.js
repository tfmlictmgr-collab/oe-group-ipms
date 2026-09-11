const pptxgen = require("pptxgenjs");
const path = require("path");
const fs = require("fs");
const React = require("react");
const ReactDOMServer = require("react-dom/server");
const sharp = require("sharp");
const {
  FiCheckCircle, FiMessageCircle, FiSend, FiUsers, FiShield,
  FiLayers, FiArrowRight, FiGitBranch, FiUserPlus, FiFlag,
} = require("react-icons/fi");

// Optional argv override — a deck open in PowerPoint locks the file (EBUSY),
// and rebuilding to a fresh name is safer than half-writing over one.
const OUT = path.join(__dirname, process.argv[2] || "OE_Group_IPMS_Demo_Readiness.pptx");

// ── Palette ──────────────────────────────────────────────────────────────
// Deep institutional indigo-navy (the platform's own neutral identity — used
// on the login screens and neither brand's literal color), warm amber accent
// (value/trust, one sharp pop), warm parchment-white content ground.
const NAVY = "1B2456";
const NAVY_DEEP = "141A40";
const ICE = "D9DEF2";
const PAPER = "FFFFFF";
const INK = "20242C";
const INK_SOFT = "5B6070";
const AMBER = "D9A441";
const AMBER_DEEP = "B9852B";
const OK = "1E7B4D";
const OK_SOFT = "E6F3EB";
const LINE = "E4E1D6";
const CARD = "F7F5EF";

const TITLE_FONT = "Cambria";
const BODY_FONT = "Calibri";

// ── Icon rasterizer ──────────────────────────────────────────────────────
async function iconPng(IconComp, color, size = 256) {
  const svg = ReactDOMServer.renderToStaticMarkup(
    React.createElement(IconComp, { color: `#${color}`, size })
  );
  const buf = await sharp(Buffer.from(svg)).resize(size, size).png().toBuffer();
  return "image/png;base64," + buf.toString("base64");
}

async function main() {
  const icons = {
    check: await iconPng(FiCheckCircle, OK),
    checkWhite: await iconPng(FiCheckCircle, PAPER),
    message: await iconPng(FiMessageCircle, PAPER),
    send: await iconPng(FiSend, PAPER),
    users: await iconPng(FiUsers, NAVY),
    shield: await iconPng(FiShield, NAVY),
    layers: await iconPng(FiLayers, NAVY),
    arrow: await iconPng(FiArrowRight, AMBER_DEEP),
    branch: await iconPng(FiGitBranch, PAPER),
    userPlus: await iconPng(FiUserPlus, AMBER_DEEP),
    flag: await iconPng(FiFlag, PAPER),
  };

  const pres = new pptxgen();
  pres.layout = "LAYOUT_WIDE"; // 13.333 x 7.5
  const W = 13.333, H = 7.5;

  // ── Helpers ──────────────────────────────────────────────────────────
  function darkBg(slide) {
    slide.background = { color: NAVY_DEEP };
  }
  function lightBg(slide) {
    slide.background = { color: PAPER };
  }
  function pageNum(slide, n) {
    slide.addText(String(n).padStart(2, "0"), {
      x: W - 0.9, y: H - 0.55, w: 0.6, h: 0.35,
      fontFace: BODY_FONT, fontSize: 10, color: INK_SOFT, align: "right",
    });
  }
  function kicker(slide, text, opts = {}) {
    slide.addText(text.toUpperCase(), {
      x: opts.x ?? 0.7, y: opts.y ?? 0.55, w: opts.w ?? 8, h: 0.35,
      fontFace: BODY_FONT, fontSize: 12, bold: true,
      color: opts.color ?? AMBER_DEEP, charSpacing: 2,
    });
  }
  function title(slide, text, opts = {}) {
    slide.addText(text, {
      x: opts.x ?? 0.7, y: opts.y ?? 0.9, w: opts.w ?? 11.5, h: opts.h ?? 0.9,
      fontFace: TITLE_FONT, fontSize: opts.size ?? 34, bold: true,
      color: opts.color ?? INK, align: "left",
    });
  }

  // ── Slide 1 — Title ────────────────────────────────────────────────────
  {
    const s = pres.addSlide();
    darkBg(s);
    s.addShape("ellipse", { x: 9.6, y: -2.6, w: 7, h: 7, fill: { color: NAVY, transparency: 40 }, line: { type: "none" } });
    s.addShape("ellipse", { x: 11.2, y: 4.6, w: 4.6, h: 4.6, fill: { color: AMBER, transparency: 82 }, line: { type: "none" } });

    s.addText("OE GROUP · INTEGRATED FM & PROPERTY MANAGEMENT", {
      x: 0.9, y: 1.5, w: 10, h: 0.4, fontFace: BODY_FONT, fontSize: 13, bold: true,
      color: AMBER, charSpacing: 2,
    });
    s.addText("Demo Readiness", {
      x: 0.85, y: 2.0, w: 11, h: 1.5, fontFace: TITLE_FONT, fontSize: 60, bold: true,
      color: PAPER, margin: 0,
    });
    s.addText("Staging rehearsal — dry run confirmed end to end", {
      x: 0.9, y: 3.45, w: 10, h: 0.6, fontFace: BODY_FONT, fontSize: 19,
      color: ICE, italic: true,
    });

    s.addShape("line", { x: 0.9, y: 4.35, w: 2.2, h: 0, line: { color: AMBER, width: 2 } });
    s.addText("20 August 2026  ·  oe-group-ipms-staging", {
      x: 0.9, y: 4.55, w: 8, h: 0.4, fontFace: BODY_FONT, fontSize: 13, color: ICE,
    });

    // Status chips row
    const chips = ["Classifier", "Checkout", "Email", "Telegram", "WhatsApp"];
    let cx = 0.9;
    chips.forEach((c) => {
      const w = 0.42 + c.length * 0.105;
      s.addShape("roundRect", { x: cx, y: 5.65, w, h: 0.5, rectRadius: 0.25, fill: { color: NAVY }, line: { color: "3A4278", width: 1 } });
      s.addImage({ data: icons.checkWhite, x: cx + 0.14, y: 5.83, w: 0.16, h: 0.16 });
      s.addText(c, { x: cx + 0.36, y: 5.65, w: w - 0.4, h: 0.5, fontFace: BODY_FONT, fontSize: 11.5, color: PAPER, valign: "middle", margin: 0 });
      cx += w + 0.18;
    });
  }

  // ── Slide 2 — Agenda ───────────────────────────────────────────────────
  {
    const s = pres.addSlide();
    lightBg(s);
    kicker(s, "Agenda");
    title(s, "What this covers");

    const items = [
      ["01", "Environment", "The staging world — an isolated production preview, migrated clean."],
      ["02", "Status at a glance", "Every headline capability, confirmed working today."],
      ["03", "The golden path & logins", "One request, five roles — and who to sign in as for each."],
      ["04", "Live channels", "WhatsApp and Telegram, wired and confirmed."],
      ["05", "Brand isolation", "One platform, two identities, neither sees the other."],
      ["06", "What's next", "The short list still ahead of production go-live."],
    ];
    const colW = 5.55, rowH = 1.55;
    items.forEach((it, i) => {
      const col = i % 2, row = Math.floor(i / 2);
      const x = 0.7 + col * (colW + 0.4), y = 2.1 + row * (rowH + 0.15);
      s.addShape("roundRect", { x, y, w: colW, h: rowH, rectRadius: 0.08, fill: { color: CARD }, line: { color: LINE, width: 1 } });
      s.addText(it[0], { x: x + 0.3, y: y + 0.18, w: 1, h: 0.6, fontFace: TITLE_FONT, fontSize: 26, bold: true, color: ICE.replace("D9DEF2", "C7CDE8") || AMBER, margin: 0 });
      s.addText(it[0], { x: x + 0.3, y: y + 0.18, w: 1, h: 0.6, fontFace: TITLE_FONT, fontSize: 26, bold: true, color: "C9CFE6", margin: 0 });
      s.addText(it[1], { x: x + 1.15, y: y + 0.2, w: colW - 1.4, h: 0.4, fontFace: BODY_FONT, fontSize: 15, bold: true, color: INK, margin: 0 });
      s.addText(it[2], { x: x + 1.15, y: y + 0.62, w: colW - 1.4, h: 0.8, fontFace: BODY_FONT, fontSize: 11.5, color: INK_SOFT, margin: 0 });
    });
    pageNum(s, 2);
  }

  // ── Slide 3 — Environment ──────────────────────────────────────────────
  {
    const s = pres.addSlide();
    lightBg(s);
    kicker(s, "01 · Environment");
    title(s, "A true production preview");
    s.addText(
      "Its own Supabase project, its own Vercel deployment, migrated to the current schema and reset freely — separate from dev, and separate from the production environment that hasn't been provisioned yet on purpose.",
      { x: 0.7, y: 1.75, w: 7.1, h: 1.1, fontFace: BODY_FONT, fontSize: 13.5, color: INK_SOFT }
    );

    const facts = [
      ["Supabase project", "tjboghjzbalxwhhatogl · eu-west-2"],
      ["Vercel project", "oe-group-ipms-staging"],
      ["Schema", "Migrated to 0178, zero synthetic rows at provisioning"],
      ["Seed data", "Standard demo dataset + brand-specific content for TFML and OEA"],
    ];
    let fy = 3.05;
    facts.forEach(([k, v]) => {
      s.addText(k.toUpperCase(), { x: 0.7, y: fy, w: 2.6, h: 0.35, fontFace: BODY_FONT, fontSize: 10.5, bold: true, color: AMBER_DEEP, charSpacing: 1 });
      s.addText(v, { x: 0.7, y: fy + 0.32, w: 6.7, h: 0.4, fontFace: BODY_FONT, fontSize: 13, color: INK });
      fy += 0.78;
    });

    // Access points card, right
    s.addShape("roundRect", { x: 8.15, y: 1.75, w: 4.5, h: 5.0, rectRadius: 0.1, fill: { color: NAVY_DEEP }, line: { type: "none" } });
    s.addImage({ data: icons.layers, x: 8.5, y: 2.05, w: 0.4, h: 0.4 });
    s.addText("Access points", { x: 9.0, y: 2.02, w: 3.4, h: 0.45, fontFace: TITLE_FONT, fontSize: 17, bold: true, color: PAPER });
    const doors = [
      ["oe-group-ipms-staging.vercel.app", "Generic door · POC content"],
      ["oeaportal.com", "OEA branded"],
      ["tfmlportal.com", "TFML branded"],
      ["portal.tfmlconsultant.com", "Operator sign-in"],
    ];
    let dy = 2.75;
    doors.forEach(([u, d]) => {
      s.addShape("roundRect", { x: 8.5, y: dy, w: 3.75, h: 0.85, rectRadius: 0.06, fill: { color: NAVY }, line: { type: "none" } });
      s.addText(u, { x: 8.68, y: dy + 0.1, w: 3.4, h: 0.35, fontFace: "Courier New", fontSize: 11.5, bold: true, color: AMBER });
      s.addText(d, { x: 8.68, y: dy + 0.46, w: 3.4, h: 0.32, fontFace: BODY_FONT, fontSize: 10.5, color: ICE });
      dy += 1.0;
    });
    pageNum(s, 3);
  }

  // ── Slide 4 — Status grid ──────────────────────────────────────────────
  {
    const s = pres.addSlide();
    lightBg(s);
    kicker(s, "02 · Status at a glance");
    title(s, "Confirmed, not assumed");
    s.addText("Every headline capability checked live against staging today — not a plan, a result.", {
      x: 0.7, y: 1.7, w: 10, h: 0.4, fontFace: BODY_FONT, fontSize: 13.5, color: INK_SOFT, italic: true,
    });

    const status = [
      ["AI classifier", "Live Anthropic calls verified against a real critical-priority request"],
      ["Paystack checkout", "Test-mode banner confirmed, live authorization URL created"],
      ["Resend email", "Key validated, verified sending domain in place"],
      ["Telegram · TFML + OEA", "Both bots registered, routing confirmed per brand"],
      ["WhatsApp · TFML + OEA", "Both numbers registered, inbound routing and classification confirmed"],
      ["Live org creation", "Operator can provision a new client organisation end to end"],
    ];
    const cw = 3.95, ch = 1.5, gx = 0.25, gy = 0.22;
    status.forEach((it, i) => {
      const col = i % 3, row = Math.floor(i / 3);
      const x = 0.7 + col * (cw + gx), y = 2.35 + row * (ch + gy);
      s.addShape("roundRect", { x, y, w: cw, h: ch, rectRadius: 0.08, fill: { color: CARD }, line: { color: LINE, width: 1 } });
      s.addImage({ data: icons.check, x: x + 0.22, y: y + 0.22, w: 0.32, h: 0.32 });
      s.addText(it[0], { x: x + 0.66, y: y + 0.18, w: cw - 0.9, h: 0.4, fontFace: BODY_FONT, fontSize: 13.5, bold: true, color: INK, margin: 0 });
      s.addText(it[1], { x: x + 0.22, y: y + 0.68, w: cw - 0.44, h: 0.75, fontFace: BODY_FONT, fontSize: 10.8, color: INK_SOFT, margin: 0 });
    });
    pageNum(s, 4);
  }

  // ── Slide 5 — Golden path ───────────────────────────────────────────────
  {
    const s = pres.addSlide();
    lightBg(s);
    kicker(s, "03 · The golden path");
    title(s, "One request, start to finish");

    const steps = [
      ["Tenant", "Raises a request", "Classified live — category, urgency, AI summary"],
      ["FM / PM", "Dispatches it", "Assigned to a vendor from the property queue"],
      ["Vendor", "Completes & invoices", "Evidence logged, invoice submitted"],
      ["Finance", "Verifies & remits", "Gated: verify → performance → approve → send"],
      ["Admin", "Sees the whole trail", "Ledger, BI dashboard, audit — one place"],
    ];
    const n = steps.length, gap = 0.32;
    const cw = (W - 1.4 - gap * (n - 1)) / n, y0 = 2.5, ch = 3.3;
    steps.forEach((st, i) => {
      const x = 0.7 + i * (cw + gap);
      s.addShape("roundRect", { x, y: y0, w: cw, h: ch, rectRadius: 0.08, fill: { color: i % 2 === 0 ? NAVY_DEEP : NAVY }, line: { type: "none" } });
      s.addShape("ellipse", { x: x + cw / 2 - 0.28, y: y0 + 0.32, w: 0.56, h: 0.56, fill: { color: AMBER }, line: { type: "none" } });
      s.addText(String(i + 1), { x: x + cw / 2 - 0.28, y: y0 + 0.32, w: 0.56, h: 0.56, fontFace: TITLE_FONT, fontSize: 20, bold: true, color: NAVY_DEEP, align: "center", valign: "middle", margin: 0 });
      s.addText(st[0].toUpperCase(), { x: x + 0.15, y: y0 + 1.05, w: cw - 0.3, h: 0.35, fontFace: BODY_FONT, fontSize: 11, bold: true, color: AMBER, align: "center", charSpacing: 1 });
      s.addText(st[1], { x: x + 0.15, y: y0 + 1.4, w: cw - 0.3, h: 0.75, fontFace: TITLE_FONT, fontSize: 15.5, bold: true, color: PAPER, align: "center" });
      s.addText(st[2], { x: x + 0.18, y: y0 + 2.25, w: cw - 0.36, h: 0.95, fontFace: BODY_FONT, fontSize: 10.3, color: ICE, align: "center" });
      if (i < n - 1) {
        s.addImage({ data: icons.arrow, x: x + cw + gap / 2 - 0.14, y: y0 + ch / 2 - 0.14, w: 0.28, h: 0.28 });
      }
    });
    pageNum(s, 5);
  }

  // ── Slide 6 — Logins, role by role ─────────────────────────────────────
  {
    const s = pres.addSlide();
    lightBg(s);
    kicker(s, "03 · Logins");
    title(s, "Signing in, role by role");

    // One password across the whole demo set — stated once, prominently,
    // rather than repeated on fourteen rows.
    s.addShape("roundRect", { x: 0.7, y: 1.72, w: 11.9, h: 0.62, rectRadius: 0.08, fill: { color: "FAF1DC" }, line: { color: "E8D5A8", width: 1 } });
    s.addText(
      [
        { text: "Every login below uses the same password:  ", options: { fontFace: BODY_FONT, fontSize: 13, color: INK } },
        { text: "OEGroupDemo2026!", options: { fontFace: "Courier New", fontSize: 14, bold: true, color: AMBER_DEEP } },
      ],
      { x: 1.0, y: 1.72, w: 11.3, h: 0.62, valign: "middle", margin: 0 }
    );

    const CREDS_POC = [
      ["Tenant", "oe-group-foundation-poc.tenant@oegroup.test"],
      ["Facility manager", "oe-group-foundation-poc.facilitymanager@oegroup.test"],
      ["FM ops staff", "oe-group-foundation-poc.fmopsstaff@oegroup.test"],
      ["Vendor", "oe-group-foundation-poc.vendor@oegroup.test"],
      ["Finance approver", "oe-group-foundation-poc.financeapprover@oegroup.test"],
      ["Admin", "oe-group-foundation-poc.admin@oegroup.test"],
      ["Property owner", "oe-group-foundation-poc.propertyowner@oegroup.test"],
    ];
    // Both brands now carry all twelve roles — 24 addresses, which is a pattern
    // to state rather than a list to read out.
    const ROLE_TOKENS = "admin · fm · finance · ops · owner · tenant · vendor · regional · executive · viewer · approver · auditapprover";

    const colW = 5.75, rowH = 0.58, headY = 2.5, rowsY = 3.05;
    function credColumn(x, heading, where, rows, tint) {
      s.addText(heading, { x, y: headY, w: colW, h: 0.32, fontFace: BODY_FONT, fontSize: 12.5, bold: true, color: INK, margin: 0 });
      s.addText(where, { x, y: headY + 0.26, w: colW, h: 0.28, fontFace: BODY_FONT, fontSize: 10, italic: true, color: INK_SOFT, margin: 0 });
      rows.forEach(([role, email], i) => {
        const y = rowsY + i * rowH;
        if (i % 2 === 0) {
          s.addShape("roundRect", { x: x - 0.12, y: y - 0.04, w: colW + 0.24, h: rowH - 0.04, rectRadius: 0.05, fill: { color: tint }, line: { type: "none" } });
        }
        s.addText(role, { x, y, w: colW, h: 0.26, fontFace: BODY_FONT, fontSize: 11, bold: true, color: INK, margin: 0 });
        s.addText(email, { x, y: y + 0.24, w: colW, h: 0.26, fontFace: "Courier New", fontSize: 9.5, color: AMBER_DEEP, margin: 0 });
      });
    }
    credColumn(0.82, "The walkthrough — POC organisation", "at oe-group-ipms-staging.vercel.app", CREDS_POC, CARD);

    // ── Right column: the brands, by pattern ───────────────────────────
    const bx = 7.1;
    s.addText("Both brands — every role", { x: bx, y: headY, w: colW, h: 0.32, fontFace: BODY_FONT, fontSize: 12.5, bold: true, color: INK, margin: 0 });
    s.addText("at tfmlportal.com and oeaportal.com", { x: bx, y: headY + 0.26, w: colW, h: 0.28, fontFace: BODY_FONT, fontSize: 10, italic: true, color: INK_SOFT, margin: 0 });

    s.addShape("roundRect", { x: bx - 0.12, y: rowsY, w: colW + 0.24, h: 1.02, rectRadius: 0.06, fill: { color: CARD }, line: { color: LINE, width: 1 } });
    s.addText("tfml.<role>@oegroup.test", { x: bx, y: rowsY + 0.1, w: colW, h: 0.4, fontFace: "Courier New", fontSize: 13, bold: true, color: AMBER_DEEP, margin: 0 });
    s.addText("oea.<role>@oegroup.test", { x: bx, y: rowsY + 0.52, w: colW, h: 0.4, fontFace: "Courier New", fontSize: 13, bold: true, color: AMBER_DEEP, margin: 0 });

    s.addText("where <role> is one of", { x: bx, y: rowsY + 1.2, w: colW, h: 0.28, fontFace: BODY_FONT, fontSize: 10.5, italic: true, color: INK_SOFT, margin: 0 });
    s.addText(ROLE_TOKENS, { x: bx, y: rowsY + 1.5, w: colW, h: 1.15, fontFace: BODY_FONT, fontSize: 12, color: INK, margin: 0 });

    s.addText(
      [
        { text: "Operator — all organisations\n", options: { fontFace: BODY_FONT, fontSize: 11, bold: true, color: INK } },
        { text: "operator.admin@oegroup.test", options: { fontFace: "Courier New", fontSize: 9.5, color: AMBER_DEEP } },
      ],
      { x: bx, y: rowsY + 2.75, w: colW, h: 0.6, margin: 0 }
    );

    s.addText(
      "Demo accounts on staging, against synthetic data — none of these reach a production system.",
      { x: 0.7, y: 7.02, w: 10, h: 0.32, fontFace: BODY_FONT, fontSize: 9.5, italic: true, color: INK_SOFT }
    );
    pageNum(s, 6);
  }

  // ── Slide 7 — Live channels (WhatsApp + Telegram) ──────────────────────
  {
    const s = pres.addSlide();
    lightBg(s);
    kicker(s, "04 · Live channels");
    title(s, "Reachable today, on real numbers");
    s.addText("Both channels route per brand — the same platform, answering as two distinct businesses.", {
      x: 0.7, y: 1.7, w: 10.5, h: 0.4, fontFace: BODY_FONT, fontSize: 13.5, color: INK_SOFT, italic: true,
    });

    // WhatsApp card
    const cardY = 2.35, cardH = 4.35, cardW = 5.75;
    s.addShape("roundRect", { x: 0.7, y: cardY, w: cardW, h: cardH, rectRadius: 0.1, fill: { color: OK_SOFT }, line: { color: "BFE0CC", width: 1 } });
    s.addShape("ellipse", { x: 1.05, y: cardY + 0.35, w: 0.6, h: 0.6, fill: { color: OK }, line: { type: "none" } });
    s.addImage({ data: icons.send, x: 1.19, y: cardY + 0.49, w: 0.32, h: 0.32 });
    s.addText("WhatsApp", { x: 1.85, y: cardY + 0.38, w: 3, h: 0.5, fontFace: TITLE_FONT, fontSize: 22, bold: true, color: INK });
    s.addText("360dialog · direct client", { x: 1.85, y: cardY + 0.82, w: 3.5, h: 0.3, fontFace: BODY_FONT, fontSize: 10.5, color: INK_SOFT });

    const wa = [["TFML", "+234 703 689 1329"], ["OEA", "+234 708 471 4148"]];
    let wy = cardY + 1.45;
    wa.forEach(([label, num]) => {
      s.addShape("roundRect", { x: 1.05, y: wy, w: cardW - 0.7, h: 1.05, rectRadius: 0.06, fill: { color: PAPER }, line: { color: "BFE0CC", width: 1 } });
      s.addText(label, { x: 1.25, y: wy + 0.12, w: 2, h: 0.3, fontFace: BODY_FONT, fontSize: 11, bold: true, color: OK, charSpacing: 1 });
      s.addText(num, { x: 1.25, y: wy + 0.42, w: cardW - 1.1, h: 0.5, fontFace: "Courier New", fontSize: 20, bold: true, color: INK, margin: 0 });
      wy += 1.25;
    });
    s.addText("First message must come from the sender — WhatsApp opens the reply window on inbound contact.", {
      x: 1.05, y: cardY + cardH - 0.7, w: cardW - 0.7, h: 0.6, fontFace: BODY_FONT, fontSize: 9.5, italic: true, color: INK_SOFT,
    });

    // Telegram card
    const tx = 7.0;
    s.addShape("roundRect", { x: tx, y: cardY, w: cardW, h: cardH, rectRadius: 0.1, fill: { color: ICE, transparency: 40 }, line: { color: "C3CBEA", width: 1 } });
    s.addShape("ellipse", { x: tx + 0.35, y: cardY + 0.35, w: 0.6, h: 0.6, fill: { color: NAVY }, line: { type: "none" } });
    s.addImage({ data: icons.message, x: tx + 0.49, y: cardY + 0.49, w: 0.32, h: 0.32 });
    s.addText("Telegram", { x: tx + 1.15, y: cardY + 0.38, w: 3, h: 0.5, fontFace: TITLE_FONT, fontSize: 22, bold: true, color: INK });
    s.addText("Bot API · no session window", { x: tx + 1.15, y: cardY + 0.82, w: 3.5, h: 0.3, fontFace: BODY_FONT, fontSize: 10.5, color: INK_SOFT });

    // Verified against Telegram's own getMe, not the setup guide's suggested
    // names — TFML registered as @tfml_support_bot, not the doc's first choice.
    const tg = [["TFML", "@tfml_support_bot"], ["OEA", "@oea_properties_bot"]];
    let ty = cardY + 1.45;
    tg.forEach(([label, handle]) => {
      s.addShape("roundRect", { x: tx + 0.35, y: ty, w: cardW - 0.7, h: 1.05, rectRadius: 0.06, fill: { color: PAPER }, line: { color: "C3CBEA", width: 1 } });
      s.addText(label, { x: tx + 0.55, y: ty + 0.12, w: 2, h: 0.3, fontFace: BODY_FONT, fontSize: 11, bold: true, color: NAVY, charSpacing: 1 });
      s.addText(handle, { x: tx + 0.55, y: ty + 0.42, w: cardW - 1.1, h: 0.5, fontFace: "Courier New", fontSize: 18, bold: true, color: INK, margin: 0 });
      ty += 1.25;
    });
    s.addText("Open to anyone who finds it — no approval step. Publish deliberately, not by obscurity.", {
      x: tx + 0.35, y: cardY + cardH - 0.7, w: cardW - 0.7, h: 0.6, fontFace: BODY_FONT, fontSize: 9.5, italic: true, color: INK_SOFT,
    });
    pageNum(s, 7);
  }

  // ── Slide 8 — Brand isolation ───────────────────────────────────────────
  {
    const s = pres.addSlide();
    lightBg(s);
    kicker(s, "05 · Brand isolation");
    title(s, "One platform. Two identities. No overlap.");

    const half = 5.65, gap = 0.35, y0 = 2.15, ch = 4.6;
    // TFML
    s.addShape("roundRect", { x: 0.7, y: y0, w: half, h: ch, rectRadius: 0.1, fill: { color: "0F2A44" }, line: { type: "none" } });
    s.addText("TFML", { x: 1.0, y: y0 + 0.3, w: 4, h: 0.5, fontFace: TITLE_FONT, fontSize: 24, bold: true, color: PAPER });
    s.addText("Total Facilities Management Limited", { x: 1.0, y: y0 + 0.78, w: 4.9, h: 0.35, fontFace: BODY_FONT, fontSize: 11.5, color: "9FC3DE" });
    s.addText("tfmlportal.com", { x: 1.0, y: y0 + 1.25, w: 4, h: 0.35, fontFace: "Courier New", fontSize: 12, bold: true, color: "5FC97F" });
    const tfmlFacts = ["Marina Business Park · 5 units", "2 vendors under evaluation", "6 requests, mixed channels & states", "+234 703 689 1329 · WhatsApp"];
    let tfy = y0 + 1.85;
    tfmlFacts.forEach((f) => { s.addText("· " + f, { x: 1.0, y: tfy, w: 4.9, h: 0.35, fontFace: BODY_FONT, fontSize: 12, color: "D7E4EE" }); tfy += 0.5; });

    // OEA
    s.addShape("roundRect", { x: 0.7 + half + gap, y: y0, w: half, h: ch, rectRadius: 0.1, fill: { color: "5C1620" }, line: { type: "none" } });
    s.addText("OEA", { x: 1.0 + half + gap, y: y0 + 0.3, w: 4, h: 0.5, fontFace: TITLE_FONT, fontSize: 24, bold: true, color: PAPER });
    s.addText("Ora Egbunike & Associates", { x: 1.0 + half + gap, y: y0 + 0.78, w: 4.9, h: 0.35, fontFace: BODY_FONT, fontSize: 11.5, color: "E8B8BC" });
    s.addText("oeaportal.com", { x: 1.0 + half + gap, y: y0 + 1.25, w: 4, h: 0.35, fontFace: "Courier New", fontSize: 12, bold: true, color: "5FC97F" });
    const oeaFacts = ["Parkview Terraces · 4 units", "2 vendors under evaluation", "6 requests, mixed channels & states", "+234 708 471 4148 · WhatsApp"];
    let oey = y0 + 1.85;
    oeaFacts.forEach((f) => { s.addText("· " + f, { x: 1.0 + half + gap, y: oey, w: 4.9, h: 0.35, fontFace: BODY_FONT, fontSize: 12, color: "F1D9DB" }); oey += 0.5; });

    s.addImage({ data: icons.shield, x: W / 2 - 0.3, y: y0 + ch / 2 - 0.3, w: 0.6, h: 0.6 });
    pageNum(s, 8);
  }

  // ── Slide 9 — New capability spotlight ─────────────────────────────────
  {
    const s = pres.addSlide();
    darkBg(s);
    s.addShape("ellipse", { x: -2, y: 3.5, w: 6, h: 6, fill: { color: NAVY, transparency: 45 }, line: { type: "none" } });
    kicker(s, "06 · New today", { color: AMBER });
    title(s, "Real onboarding, not a fixture", { color: PAPER });
    s.addText(
      "The operator can provision a brand-new organisation live — name, brand, first admin — and a genuine invitation email goes out through Resend on submit. That admin can then invite their own FM, vendor, and tenant, each with a real email.",
      { x: 0.7, y: 1.85, w: 7.3, h: 1.5, fontFace: BODY_FONT, fontSize: 14, color: ICE }
    );

    const steps = [
      [icons.userPlus, "Operator creates the org", "/orgs — name, brand, first administrator's email"],
      [icons.send, "Invitation sends for real", "Resend delivers — no seeded fixture, no shortcut"],
      [icons.branch, "They invite their own people", "Settings → People → Invitations, any role"],
    ];
    let sy = 3.55;
    steps.forEach(([icon, h, d]) => {
      s.addShape("roundRect", { x: 0.7, y: sy, w: 7.3, h: 1.0, rectRadius: 0.08, fill: { color: NAVY }, line: { type: "none" } });
      s.addImage({ data: icon, x: 0.95, y: sy + 0.28, w: 0.42, h: 0.42 });
      s.addText(h, { x: 1.55, y: sy + 0.12, w: 6.2, h: 0.4, fontFace: BODY_FONT, fontSize: 14, bold: true, color: PAPER, margin: 0 });
      s.addText(d, { x: 1.55, y: sy + 0.52, w: 6.3, h: 0.4, fontFace: BODY_FONT, fontSize: 11, color: ICE, margin: 0 });
      sy += 1.18;
    });

    // Right: quote-style callout
    s.addShape("roundRect", { x: 8.55, y: 1.85, w: 4.1, h: 4.9, rectRadius: 0.1, fill: { color: AMBER }, line: { type: "none" } });
    s.addText("“", { x: 8.75, y: 1.9, w: 1, h: 1, fontFace: TITLE_FONT, fontSize: 60, bold: true, color: NAVY_DEEP, margin: 0 });
    s.addText("The core walkthrough runs on seeded logins — fast, reliable. This is the one moment worth calling out live.", {
      x: 8.9, y: 3.0, w: 3.5, h: 2.4, fontFace: TITLE_FONT, fontSize: 16, italic: true, bold: true, color: NAVY_DEEP,
    });
    pageNum(s, 9);
  }

  // ── Slide 10 — What's next ───────────────────────────────────────────────
  {
    const s = pres.addSlide();
    lightBg(s);
    kicker(s, "What's next");
    title(s, "Between here and go-live");

    const rows = [
      ["Done", "DPO designated · staging provisioned · DPA & privacy drafts ready", OK],
      ["In progress", "Paystack & Flutterwave business verification underway", AMBER_DEEP],
      ["Outstanding", "Telegram bots to be created · 360dialog tier to confirm · production Supabase + Vercel provisioning", INK_SOFT],
    ];
    let ry = 2.3;
    rows.forEach(([label, text, color]) => {
      s.addShape("roundRect", { x: 0.7, y: ry, w: 11.9, h: 1.15, rectRadius: 0.08, fill: { color: CARD }, line: { color: LINE, width: 1 } });
      s.addShape("roundRect", { x: 0.95, y: ry + 0.28, w: 1.7, h: 0.6, rectRadius: 0.3, fill: { color }, line: { type: "none" } });
      s.addText(label, { x: 0.95, y: ry + 0.28, w: 1.7, h: 0.6, fontFace: BODY_FONT, fontSize: 11.5, bold: true, color: PAPER, align: "center", valign: "middle", margin: 0 });
      s.addText(text, { x: 2.9, y: ry, w: 9.5, h: 1.15, fontFace: BODY_FONT, fontSize: 14, color: INK, valign: "middle" });
      ry += 1.4;
    });
    pageNum(s, 10);
  }

  // ── Slide 11 — Close ───────────────────────────────────────────────────
  {
    const s = pres.addSlide();
    darkBg(s);
    s.addShape("ellipse", { x: 9.6, y: -2.6, w: 7, h: 7, fill: { color: NAVY, transparency: 40 }, line: { type: "none" } });
    s.addImage({ data: icons.flag, x: 0.9, y: 2.0, w: 0.6, h: 0.6 });
    s.addText("Ready for the live run.", {
      x: 0.85, y: 2.85, w: 10, h: 1.2, fontFace: TITLE_FONT, fontSize: 46, bold: true, color: PAPER,
    });
    s.addText("Staging — confirmed end to end. Questions welcome.", {
      x: 0.9, y: 3.95, w: 9, h: 0.5, fontFace: BODY_FONT, fontSize: 16, color: ICE, italic: true,
    });
    s.addShape("line", { x: 0.9, y: 4.65, w: 2.2, h: 0, line: { color: AMBER, width: 2 } });
    s.addText("OE Group IPMS  ·  oe-group-ipms-staging.vercel.app", {
      x: 0.9, y: 4.85, w: 8, h: 0.4, fontFace: BODY_FONT, fontSize: 12, color: ICE,
    });
  }

  pres.writeFile({ fileName: OUT }).then(() => {
    console.log("Written:", OUT);
  });
}

main().catch((e) => { console.error(e); process.exit(1); });
