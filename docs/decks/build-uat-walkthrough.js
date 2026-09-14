// OEA UAT — three-day walkthrough deck.
//
// Audience-facing slides; the facilitator script lives in speaker notes, and
// every day ends with hands-on exercises the staff run themselves.
const pptxgen = require("pptxgenjs");
const path = require("path");
const {
  FiCheckCircle, FiAlertTriangle, FiUsers, FiHome, FiTool, FiFileText,
  FiDollarSign, FiShield, FiBarChart2, FiClipboard,
} = require("react-icons/fi");
const C = require("./common.js");

const OUT = path.join(__dirname, process.argv[2] || "OE_Group_IPMS_UAT_Walkthrough_OEA.pptx");
const PW = "OEGroupDemo2026!";
const PORTAL = "oeaportal.com";

// Every role, with the login that exercises it. Order groups the room.
const ROLES_OPS = [
  ["Tenant", "oea.tenant@oegroup.test", "Kelechi Umeh", "Raises requests, sees own rent and statements"],
  ["Vendor", "oea.vendor@oegroup.test", "GreenLeaf Landscaping", "Own jobs, evidence, invoices, scorecard"],
  ["FM Ops Staff", "oea.ops@oegroup.test", "Yusuf Garba", "Jobs dispatched to them; no money, no config"],
  ["Facilities Manager", "oea.fmgr@oegroup.test", "Chika Eze", "Plant and services on assigned properties"],
  ["Properties Manager", "oea.pm@oegroup.test", "Ngozi Chukwu", "Tenancies and buildings on assigned properties"],
  ["Regional Manager", "oea.regional@oegroup.test", "Aisha Sani", "Everything an FM/PM holds, across their region"],
];
const ROLES_MONEY = [
  ["Finance Approver", "oea.finance@oegroup.test", "Tunde Bakare", "All financials — and the ONLY role that releases money"],
  ["Payment Approver", "oea.approver@oegroup.test", "Tunde Salami", "Stage 3 final approval, Tier 2 (to ₦1,000,000)"],
  ["Payment Auditor", "oea.auditapprover@oegroup.test", "Grace Nwankwo", "Stage 2 — checks invoice against job card and evidence"],
  ["Executive", "oea.executive@oegroup.test", "Emeka Ilo", "Managing Partner. Approves above threshold; never releases"],
];
const ROLES_OTHER = [
  ["Property Owner", "oea.owner@oegroup.test", "Ifeoma Duru", "Own portfolio, statements, payments — not the request queue"],
  ["Administrator", "oea.admin@oegroup.test", "Zainab Bello", "All of it, plus approvers, limits and settings"],
  ["Viewer", "oea.viewer@oegroup.test", "Blessing Okoro", "Read-only. The safest seat to explore from"],
];

async function main() {
  const I = {
    check: await C.iconPng(FiCheckCircle, C.OK),
    warn: await C.iconPng(FiAlertTriangle, C.RED_DEEP),
    users: await C.iconPng(FiUsers, C.RED_DEEP),
    home: await C.iconPng(FiHome, C.RED_DEEP),
    tool: await C.iconPng(FiTool, C.RED_DEEP),
    doc: await C.iconPng(FiFileText, C.RED_DEEP),
    money: await C.iconPng(FiDollarSign, C.RED_DEEP),
    shield: await C.iconPng(FiShield, C.RED_DEEP),
    chart: await C.iconPng(FiBarChart2, C.RED_DEEP),
    clip: await C.iconPng(FiClipboard, C.PAPER),
  };

  const pres = new pptxgen();
  pres.layout = "LAYOUT_WIDE";
  const h = C.helpers(pres);
  const { W, H, PAPER, CREAM, INK, INK_SOFT, LINE, RED, RED_DEEP, RED_SOFT, OK, OK_SOFT, CHARCOAL, TITLE_FONT, BODY_FONT } = C;
  let page = 0;
  const P = (s) => h.pageNum(s, ++page);

  // ── 1 · Title ────────────────────────────────────────────────────────────
  {
    const s = pres.addSlide();
    h.darkBg(s);
    s.addShape("ellipse", { x: 9.5, y: -2.7, w: 7.2, h: 7.2, fill: { color: CHARCOAL, transparency: 25 }, line: { type: "none" } });
    s.addShape("ellipse", { x: 11.1, y: 4.7, w: 4.6, h: 4.6, fill: { color: RED, transparency: 82 }, line: { type: "none" } });

    s.addText("ORA EGBUNIKE & ASSOCIATES · INTEGRATED PROPERTY MANAGEMENT", {
      x: 0.9, y: 1.45, w: 11, h: 0.4, fontFace: BODY_FONT, fontSize: 12.5, bold: true,
      color: RED, charSpacing: 1.6, margin: 0, valign: "top" });
    s.addText("User Acceptance Testing", {
      x: 0.85, y: 1.95, w: 11.5, h: 1.1, fontFace: TITLE_FONT, fontSize: 54, bold: true, color: PAPER, margin: 0, valign: "top" });
    s.addText("A three-day walkthrough — every role, every flow, hands on", {
      x: 0.9, y: 3.15, w: 11, h: 0.55, fontFace: BODY_FONT, fontSize: 19, color: "C9CBD8", italic: true, margin: 0, valign: "top" });
    s.addShape("line", { x: 0.9, y: 4.0, w: 2.2, h: 0, line: { color: RED, width: 2 } });
    s.addText(`${PORTAL}  ·  staging rehearsal environment`, {
      x: 0.9, y: 4.2, w: 9, h: 0.4, fontFace: BODY_FONT, fontSize: 13.5, color: "E4E5EC", margin: 0, valign: "top" });

    const days = [["Day 1", "Requests"], ["Day 2", "Money"], ["Day 3", "Tenancies"]];
    let cx = 0.9;
    days.forEach(([d, t]) => {
      s.addShape("roundRect", { x: cx, y: 5.35, w: 2.5, h: 1.0, rectRadius: 0.1, fill: { color: CHARCOAL }, line: { color: "34364E", width: 1 } });
      s.addText(d, { x: cx + 0.25, y: 5.5, w: 2, h: 0.3, fontFace: BODY_FONT, fontSize: 11, bold: true, color: RED, charSpacing: 1.5, margin: 0, valign: "top" });
      s.addText(t, { x: cx + 0.25, y: 5.78, w: 2, h: 0.42, fontFace: TITLE_FONT, fontSize: 19, bold: true, color: PAPER, margin: 0, valign: "top" });
      cx += 2.72;
    });
    s.addNotes(
      "Welcome. Three days, and by the end of them every person in this room will have driven this system themselves, not watched someone else drive it.\n\n" +
      "Set expectations now: this is a rehearsal environment. The data is synthetic. Nothing you do here reaches a real tenant, a real landlord or a real bank. You cannot break anything that matters — so try the thing you are unsure about.\n\n" +
      "What we want from you is the opposite of politeness. If a screen confuses you, that is a finding. Write it down."
    );
  }

  // ── 2 · How the three days run ───────────────────────────────────────────
  {
    const s = pres.addSlide();
    h.lightBg(s);
    h.kicker(s, "How this works");
    h.title(s, "Watch it once. Then do it yourself.");
    h.lede(s, "Each session follows the same shape, so you always know what is coming next.");

    const steps = [
      ["Walkthrough", "We drive it on screen, slowly, with the reasoning — why the system asks for this, and why it refuses that."],
      ["Hands-on", "You sign in as the role and repeat it on your own machine. Facilitators circulate."],
      ["Findings", "Anything confusing, wrong or missing goes on the sheet before we move on."],
    ];
    let x = 0.7;
    steps.forEach(([t, d], i) => {
      h.card(s, x, 2.5, 3.9, 2.0);
      h.disc(s, x + 0.32, 2.78, i + 1);
      s.addText(t, { x: x + 0.95, y: 2.78, w: 2.7, h: 0.42, fontFace: TITLE_FONT, fontSize: 18, bold: true, color: INK, margin: 0, valign: "middle" });
      s.addText(d, { x: x + 0.32, y: 3.38, w: 3.28, h: 0.95, fontFace: BODY_FONT, fontSize: 12, color: INK_SOFT, margin: 0, valign: "top" });
      x += 4.06;
    });

    h.card(s, 0.7, 4.9, 11.93, 1.75, { fill: OK_SOFT, line: "CBE3D6" });
    s.addImage({ data: I.check, x: 1.0, y: 5.18, w: 0.28, h: 0.28 });
    s.addText("Ground rules", { x: 1.42, y: 5.12, w: 4, h: 0.38, fontFace: TITLE_FONT, fontSize: 16, bold: true, color: INK, margin: 0, valign: "middle" });
    s.addText(
      [
        { text: "Synthetic data only — no real tenant, landlord, vendor or bank is touched.", options: { bullet: true, breakLine: true } },
        { text: "One password for every demo login, shown on the next slide.", options: { bullet: true, breakLine: true } },
        { text: "A refusal is usually the system working. Note it, then ask why — the answer is normally a control.", options: { bullet: true } },
      ],
      { x: 1.42, y: 5.55, w: 10.9, h: 1.0, fontFace: BODY_FONT, fontSize: 12, color: INK, paraSpaceAfter: 4, margin: 0, valign: "top" }
    );
    P(s);
    s.addNotes(
      "Three parts to every session: we drive, you drive, we capture findings.\n\n" +
      "Stress the last ground rule. People assume an error message means the software is broken. In this system most refusals are deliberate — the approver who cannot also release the payment, the request that cannot be dispatched before someone has reviewed it. When you hit one, tell us, and we will explain which rule you just met. If we cannot explain it, that IS a defect."
    );
  }

  // ── 3 · Logins, part 1 ───────────────────────────────────────────────────
  {
    const s = pres.addSlide();
    h.lightBg(s);
    h.kicker(s, "Signing in · 1 of 2");
    h.title(s, "Operational roles");

    h.card(s, 0.7, 1.62, 11.93, 0.62, { fill: RED_SOFT, line: "F0D4D4" });
    s.addText([
      { text: "All logins:  ", options: { bold: true } },
      { text: `https://${PORTAL}`, options: { bold: true, color: RED_DEEP } },
      { text: "      Password for every account:  " },
      { text: PW, options: { bold: true, color: RED_DEEP } },
    ], { x: 1.0, y: 1.62, w: 11.4, h: 0.62, fontFace: BODY_FONT, fontSize: 13, color: INK, valign: "middle", margin: 0 });

    let y = 2.72;
    const rowH = 0.62;
    s.addText("ROLE", { x: 0.85, y: 2.32, w: 2.6, h: 0.28, fontFace: BODY_FONT, fontSize: 9.5, bold: true, color: INK_SOFT, charSpacing: 1.4, margin: 0, valign: "top" });
    s.addText("SIGN IN AS", { x: 3.5, y: 2.32, w: 3.9, h: 0.28, fontFace: BODY_FONT, fontSize: 9.5, bold: true, color: INK_SOFT, charSpacing: 1.4, margin: 0, valign: "top" });
    s.addText("WHAT THEY SEE", { x: 7.5, y: 2.32, w: 5.1, h: 0.28, fontFace: BODY_FONT, fontSize: 9.5, bold: true, color: INK_SOFT, charSpacing: 1.4, margin: 0, valign: "top" });

    ROLES_OPS.forEach(([role, email, person, sees], i) => {
      if (i % 2 === 0) s.addShape("rect", { x: 0.7, y, w: 11.93, h: rowH, fill: { color: CREAM }, line: { type: "none" } });
      s.addText(role, { x: 0.85, y, w: 2.6, h: rowH, fontFace: BODY_FONT, fontSize: 12.5, bold: true, color: INK, valign: "middle", margin: 0 });
      s.addText(email, { x: 3.5, y: y + 0.04, w: 3.9, h: 0.32, fontFace: BODY_FONT, fontSize: 11, color: RED_DEEP, valign: "middle", margin: 0 });
      s.addText(person, { x: 3.5, y: y + 0.33, w: 3.9, h: 0.28, fontFace: BODY_FONT, fontSize: 9.5, color: INK_SOFT, italic: true, valign: "middle", margin: 0 });
      s.addText(sees, { x: 7.5, y, w: 5.1, h: rowH, fontFace: BODY_FONT, fontSize: 11, color: INK_SOFT, valign: "middle", margin: 0 });
      y += rowH;
    });

    s.addImage({ data: I.warn, x: 0.85, y: 6.62, w: 0.24, h: 0.24 });
    s.addText("Facilities Manager and Properties Manager are two separate roles as of this month — same rank, different discipline, neither can invite the other.", {
      x: 1.2, y: 6.55, w: 11.3, h: 0.4, fontFace: BODY_FONT, fontSize: 11, color: INK_SOFT, italic: true, valign: "middle", margin: 0,
    });
    P(s);
    s.addNotes(
      "Hand this slide out on paper as well — people will be signing in and out all week.\n\n" +
      "The FM/PM split is new and worth pausing on. Until recently one role wore two labels: 'Facilities Manager' on the TFML side, 'Properties Manager' on ours. That worked only while no organisation employed both. OEA now does — so they are two roles, with two logins, holding identical rights over their own properties.\n\n" +
      "If someone asks 'which one am I?' — a Properties Manager runs tenancies and buildings; a Facilities Manager runs plant and services."
    );
  }

  // ── 4 · Logins, part 2 ───────────────────────────────────────────────────
  {
    const s = pres.addSlide();
    h.lightBg(s);
    h.kicker(s, "Signing in · 2 of 2");
    h.title(s, "Money, oversight and the rest");

    // Two sections of rows have to finish above the page number at 6.95. Seven
    // rows plus two headers at the part-1 metrics ran to 7.61 — off the bottom
    // of the slide, which pptxgenjs writes out rather than clamping.
    let y = 1.9;
    const rowH = 0.56;
    const section = (label, rows) => {
      s.addText(label.toUpperCase(), {
        x: 0.85, y, w: 6, h: 0.28, fontFace: BODY_FONT, fontSize: 10, bold: true, color: RED_DEEP, charSpacing: 1.6, margin: 0, valign: "top" });
      y += 0.32;
      rows.forEach(([role, email, person, sees], i) => {
        if (i % 2 === 0) s.addShape("rect", { x: 0.7, y, w: 11.93, h: rowH, fill: { color: CREAM }, line: { type: "none" } });
        s.addText(role, { x: 0.85, y, w: 2.6, h: rowH, fontFace: BODY_FONT, fontSize: 12, bold: true, color: INK, valign: "middle", margin: 0 });
        s.addText(email, { x: 3.5, y: y + 0.02, w: 3.9, h: 0.28, fontFace: BODY_FONT, fontSize: 10.5, color: RED_DEEP, valign: "middle", margin: 0 });
        s.addText(person, { x: 3.5, y: y + 0.29, w: 3.9, h: 0.25, fontFace: BODY_FONT, fontSize: 9, color: INK_SOFT, italic: true, valign: "middle", margin: 0 });
        s.addText(sees, { x: 7.5, y, w: 5.1, h: rowH, fontFace: BODY_FONT, fontSize: 10.5, color: INK_SOFT, valign: "middle", margin: 0 });
        y += rowH;
      });
      y += 0.18;
    };
    section("The payment chain", ROLES_MONEY);
    section("Portfolio, administration and read-only", ROLES_OTHER);

    P(s);
    s.addNotes(
      "Thirteen roles in total across both slides. Nobody needs to memorise them — but two facts should stick.\n\n" +
      "First: the Finance Approver is the only role that actually releases money. Not the administrator, not the Managing Partner. Approving and paying are different acts held by different people.\n\n" +
      "Second: the Viewer login is read-only. If someone is nervous about clicking, start them there — they can explore every screen without being able to change anything."
    );
  }

  // ── 5 · Role map ─────────────────────────────────────────────────────────
  {
    const s = pres.addSlide();
    h.creamBg(s);
    h.kicker(s, "Orientation");
    h.title(s, "Who does what, in one picture");
    h.lede(s, "Four groups. Work flows left to right; money flows through the middle and out.");

    const groups = [
      ["Raise", ["Tenant", "Property Owner", "FM / PM"], I.home, "Something needs doing, or someone needs an answer."],
      ["Do", ["FM / PM", "FM Ops Staff", "Vendor", "Regional Manager"], I.tool, "Review, dispatch, attend, evidence, invoice."],
      ["Check & approve", ["FM / PM sign-off", "Payment Auditor", "Payment Approver", "Executive"], I.shield, "Three stages, three different pairs of hands."],
      ["Release & report", ["Finance Approver", "Administrator", "Viewer"], I.chart, "Money leaves once. Everything is on the trail."],
    ];
    let x = 0.7;
    groups.forEach(([t, members, icon, foot]) => {
      h.card(s, x, 2.42, 2.9, 3.55, { fill: PAPER });
      s.addImage({ data: icon, x: x + 0.28, y: 2.68, w: 0.34, h: 0.34 });
      s.addText(t, { x: x + 0.28, y: 3.1, w: 2.4, h: 0.4, fontFace: TITLE_FONT, fontSize: 17, bold: true, color: INK, margin: 0, valign: "top" });
      let my = 3.58;
      members.forEach((m) => {
        s.addText(m, { x: x + 0.28, y: my, w: 2.4, h: 0.3, fontFace: BODY_FONT, fontSize: 11.5, color: RED_DEEP, bold: true, margin: 0, valign: "top" });
        my += 0.3;
      });
      s.addText(foot, { x: x + 0.28, y: 5.05, w: 2.4, h: 0.8, fontFace: BODY_FONT, fontSize: 10.5, color: INK_SOFT, margin: 0, valign: "top" });
      x += 3.06;
    });
    P(s);
    s.addNotes(
      "Use this as the map for the whole three days. Every exercise you do sits in one of these four columns.\n\n" +
      "Point at column three. Notice it takes three separate people to get a payment out — the manager who signs off the work, the auditor who checks the invoice against the evidence, and the approver who clears the amount. That is not bureaucracy for its own sake; it is what stops one person paying themselves."
    );
  }

  // ── 6 · DAY 1 divider ────────────────────────────────────────────────────
  {
    const s = pres.addSlide();
    h.dayDivider(s, 1, "Requests & the buildings they happen in", "From a tenant's complaint to a vendor's evidence", [
      "Where work lives — region, state, project, site, property, unit, asset",
      "A service request, end to end",
      "Who sees which requests, and why yours looks different from mine",
      "Hands-on: raise it, review it, dispatch it, complete it",
    ]);
    P(s);
    s.addNotes("Day one is deliberately the least frightening. No money moves today. The point is to get everyone comfortable signing in, finding their way around, and seeing one job travel the whole length of the system.");
  }

  // ── 7 · Hierarchy ────────────────────────────────────────────────────────
  {
    const s = pres.addSlide();
    h.lightBg(s);
    h.kicker(s, "Day 1 · Where work lives");
    h.title(s, "Everything hangs off a place");
    h.lede(s, "Seven levels. You will mostly work at the bottom three — but the top four are what let a regional manager see everything at once.");

    const levels = [
      ["Region", "North · South · East"],
      ["State", "36 states + FCT, chosen from a list"],
      ["Project", "A development or mandate"],
      ["Site", "A phase or block"],
      ["Property", "Parkview Terraces"],
      ["Unit", "Flat 3B"],
      ["Asset", "The generator, the lift, the pump"],
    ];
    let x = 0.7;
    const cw = 1.62;
    levels.forEach(([t, d], i) => {
      const isLeaf = i >= 4;
      s.addShape("roundRect", {
        x, y: 2.6, w: cw, h: 1.55, rectRadius: 0.08,
        fill: { color: isLeaf ? RED_SOFT : CREAM },
        line: { color: isLeaf ? "F0D4D4" : LINE, width: 1 },
      });
      s.addText(t, { x: x + 0.12, y: 2.75, w: cw - 0.24, h: 0.4, fontFace: TITLE_FONT, fontSize: 14.5, bold: true, color: isLeaf ? RED_DEEP : INK, align: "center", margin: 0, valign: "top" });
      s.addText(d, { x: x + 0.12, y: 3.18, w: cw - 0.24, h: 0.85, fontFace: BODY_FONT, fontSize: 9.5, color: INK_SOFT, align: "center", margin: 0, valign: "top" });
      if (i < levels.length - 1) {
        s.addText("›", { x: x + cw, y: 3.15, w: 0.16, h: 0.4, fontFace: BODY_FONT, fontSize: 18, color: INK_SOFT, align: "center", margin: 0, valign: "top" });
      }
      x += cw + 0.16;
    });

    h.card(s, 0.7, 4.5, 5.85, 2.05);
    s.addText("You do not have to file everything", { x: 1.0, y: 4.72, w: 5.2, h: 0.4, fontFace: TITLE_FONT, fontSize: 16, bold: true, color: INK, margin: 0, valign: "top" });
    s.addText("A property with no project or site above it still works completely. Build the tree when it earns its keep — you can create a state, project or site inline while filing a property.", {
      x: 1.0, y: 5.15, w: 5.25, h: 1.2, fontFace: BODY_FONT, fontSize: 12, color: INK_SOFT, margin: 0, valign: "top" });

    h.card(s, 6.78, 4.5, 5.85, 2.05);
    s.addText("Assets say what they cover", { x: 7.08, y: 4.72, w: 5.2, h: 0.4, fontFace: TITLE_FONT, fontSize: 16, bold: true, color: INK, margin: 0, valign: "top" });
    s.addText("A generator states whether it serves a unit, a property or the whole site — stated as a fact, never implied by leaving a field blank. Plant on running hours is serviced by the hour, not the calendar.", {
      x: 7.08, y: 5.15, w: 5.25, h: 1.2, fontFace: BODY_FONT, fontSize: 12, color: INK_SOFT, margin: 0, valign: "top" });
    P(s);
    s.addNotes(
      "Locations are the 36 states plus the FCT, picked from a dropdown. That is deliberate: when people typed their own, we got 'Port Harcourt', 'Portharcourt' and 'PH' as three different places, and no report could add them up.\n\n" +
      "If the place genuinely is not a state — a free trade zone, a campus — there is a 'somewhere else' option. Use it sparingly.\n\n" +
      "The asset point matters for OEA because so much of what fails in a building is shared plant. If you are asked 'whose generator is this?', the register answers it."
    );
  }

  // ── 8 · Service request flow ─────────────────────────────────────────────
  {
    const s = pres.addSlide();
    h.creamBg(s);
    h.kicker(s, "Day 1 · The core flow");
    h.title(s, "One service request, end to end");

    const steps = [
      ["Raised", "Tenant", "Portal, WhatsApp or Telegram. A photo helps."],
      ["Classified", "System", "Category, urgency and a plain-English summary, written automatically."],
      ["Reviewed", "PM / FM", "Someone operational looks at it before anyone is sent. This step cannot be skipped."],
      ["Dispatched", "PM / FM", "To a vendor, or to your own ops staff."],
      ["Attended", "Vendor / Ops", "Job card updated as it progresses."],
      ["Evidenced", "Vendor / Ops", "Photographs and notes attached — this is what the auditor reads later."],
    ];
    let x = 0.7;
    const cw = 1.93;
    steps.forEach(([t, who, d], i) => {
      h.card(s, x, 2.3, cw, 3.15, { fill: PAPER });
      h.disc(s, x + 0.14, 2.46, i + 1, { d: 0.38, size: 12 });
      s.addText(t, { x: x + 0.14, y: 2.95, w: cw - 0.28, h: 0.38, fontFace: TITLE_FONT, fontSize: 15, bold: true, color: INK, margin: 0, valign: "top" });
      s.addText(who.toUpperCase(), { x: x + 0.14, y: 3.32, w: cw - 0.28, h: 0.26, fontFace: BODY_FONT, fontSize: 9, bold: true, color: RED_DEEP, charSpacing: 1.2, margin: 0, valign: "top" });
      s.addText(d, { x: x + 0.14, y: 3.64, w: cw - 0.28, h: 1.6, fontFace: BODY_FONT, fontSize: 10.5, color: INK_SOFT, margin: 0, valign: "top" });
      x += cw + 0.11;
    });

    h.card(s, 0.7, 5.68, 11.93, 1.05, { fill: RED_SOFT, line: "F0D4D4" });
    s.addImage({ data: I.warn, x: 1.0, y: 5.95, w: 0.28, h: 0.28 });
    s.addText([
      { text: "Step 3 is a gate, not a suggestion. ", options: { bold: true } },
      { text: "Nothing can be assigned to a vendor until someone with the building in their hands has read it. An administrator cannot receive a request and dispatch it in one move — the person with the operational context has to look first.", options: {} },
    ], { x: 1.42, y: 5.78, w: 10.95, h: 0.85, fontFace: BODY_FONT, fontSize: 12, color: INK, valign: "middle", margin: 0 });
    P(s);
    s.addNotes(
      "Walk this on screen with oea.tenant@ raising something real — a failed generator at Parkview Terraces.\n\n" +
      "Show the classification landing. Say plainly what it is: the system reads the request and suggests category and urgency. It does not decide anything and it does not close anything. A person still triages.\n\n" +
      "Then switch to oea.pm@ and show the request waiting. Try to dispatch it before reviewing — let the room watch the refusal. That is the clearest possible demonstration of why this step exists."
    );
  }

  // ── 9 · Visibility ───────────────────────────────────────────────────────
  {
    const s = pres.addSlide();
    h.lightBg(s);
    h.kicker(s, "Day 1 · Why your screen differs from mine");
    h.title(s, "A request reaches the desk it belongs to");
    h.lede(s, "Expect different people to see different queues. That is the design, not a fault.");

    const rows = [
      ["Tenant", "Only what they raised themselves.", CREAM],
      ["Vendor", "Only jobs dispatched to their company.", CREAM],
      ["FM / PM / Regional", "Assigned to me — plus fresh requests on my own buildings, so I can triage.", RED_SOFT],
      ["Property Owner", "Only what they raised themselves. Not every complaint about their building.", CREAM],
      ["Finance Approver", "A request only once money attached to it has reached their desk — and it stays visible after.", CREAM],
      ["Admin · Executive · Auditor", "Everything, organisation-wide.", CREAM],
    ];
    let y = 2.35;
    rows.forEach(([who, what, fill]) => {
      s.addShape("roundRect", { x: 0.7, y, w: 11.93, h: 0.62, rectRadius: 0.06, fill: { color: fill }, line: { color: fill === RED_SOFT ? "F0D4D4" : LINE, width: 1 } });
      s.addText(who, { x: 0.95, y, w: 3.3, h: 0.62, fontFace: BODY_FONT, fontSize: 12.5, bold: true, color: INK, valign: "middle", margin: 0 });
      s.addText(what, { x: 4.35, y, w: 8.05, h: 0.62, fontFace: BODY_FONT, fontSize: 12, color: INK_SOFT, valign: "middle", margin: 0 });
      y += 0.7;
    });
    P(s);
    s.addNotes(
      "This slide pre-empts the most common UAT complaint: 'I cannot see the ticket you are looking at.'\n\n" +
      "The landlord line is worth dwelling on. A property owner used to see every complaint any tenant had ever made about their building. Nobody decided that — it was four sensible rules adding up to something none of them intended. It is now closed: an owner sees their statements, their payments, and what they raised themselves.\n\n" +
      "The FM/PM default view is 'Assigned to me'. The property-wide view is one click away, and they need it to triage."
    );
  }

  // ── 10 · Day 1 hands-on ──────────────────────────────────────────────────
  {
    const s = pres.addSlide();
    h.creamBg(s);
    h.kicker(s, "Day 1 · Hands-on");
    h.title(s, "Your turn — three exercises");
    h.lede(s, "Work in pairs. Swap logins between exercises so everyone drives at least once.");

    const ex = [
      ["1", "Raise a request", "oea.tenant@", [
        "Sign in and raise a request against your unit.",
        "Attach a photograph.",
        "Note the reference and what the system classified it as.",
      ]],
      ["2", "Review and dispatch", "oea.pm@", [
        "Find the request. Try dispatching before reviewing.",
        "Review it, then assign GreenLeaf Landscaping.",
        "Check the tenant can see the status change.",
      ]],
      ["3", "Attend and evidence", "oea.vendor@", [
        "Open the job from your queue.",
        "Move it through to completion with notes.",
        "Attach evidence — the auditor will read this on Day 2.",
      ]],
    ];
    let x = 0.7;
    ex.forEach(([n, t, who, items]) => {
      h.card(s, x, 2.45, 3.9, 3.85, { fill: PAPER });
      h.disc(s, x + 0.3, 2.72, n);
      s.addText(t, { x: x + 0.92, y: 2.72, w: 2.75, h: 0.46, fontFace: TITLE_FONT, fontSize: 17, bold: true, color: INK, valign: "middle", margin: 0 });
      h.pill(s, x + 0.3, 3.34, who);
      s.addText(items.map((it, i) => ({ text: it, options: { bullet: true, breakLine: i < items.length - 1 } })), {
        x: x + 0.3, y: 3.85, w: 3.3, h: 2.25, fontFace: BODY_FONT, fontSize: 11.5, color: INK_SOFT, paraSpaceAfter: 6, margin: 0, valign: "top" });
      x += 4.06;
    });

    s.addText("Finish by writing down anything that surprised you — wording, a missing field, a step you expected and did not find.", {
      x: 0.7, y: 6.55, w: 11.93, h: 0.4, fontFace: BODY_FONT, fontSize: 12, color: INK_SOFT, italic: true, margin: 0, valign: "top" });
    P(s);
    s.addNotes(
      "Allow about 45 minutes. Facilitators: walk the room rather than waiting at the front.\n\n" +
      "Exercise 2 asks people to attempt something that will fail. Make sure they actually try it — the refusal is the lesson, and people who skip it never quite believe the gate is real.\n\n" +
      "Keep the request references. Day 2 picks up exactly these jobs and pays for them."
    );
  }

  // ── 11 · DAY 2 divider ───────────────────────────────────────────────────
  {
    const s = pres.addSlide();
    h.dayDivider(s, 2, "Money, and the hands it passes through", "Nothing leaves this system on one person's say-so", [
      "Two kinds of payable — a vendor's invoice and your own requisition",
      "The three-stage chain, and why stage one is not an approval",
      "What the system will refuse, and who it refuses",
      "Hands-on: raise it, sign it off, audit it, approve it, release it",
    ]);
    P(s);
    s.addNotes("Day two is the day that matters most for audit. If people leave understanding only one thing, it should be that approving a payment and releasing a payment are two different acts, held deliberately by two different people.");
  }

  // ── 12 · Two payables ────────────────────────────────────────────────────
  {
    const s = pres.addSlide();
    h.lightBg(s);
    h.kicker(s, "Day 2 · What gets paid");
    h.title(s, "Two kinds of payable");
    h.lede(s, "They look similar on screen and are deliberately different underneath.");

    const cards = [
      ["Vendor invoice", I.tool, "A contractor bills you for work you dispatched.", [
        "One vendor, one invoice.",
        "Checked against the job card and the evidence.",
        "The vendor's performance score is part of the picture.",
      ]],
      ["Ops requisition", I.doc, "Your own staff spend money — materials, a callout, a part.", [
        "Itemised lines, each with its own cost.",
        "A line may name a registered vendor, carry its own verified payee, or neither.",
        "A line with no payee is recorded spend, not a transfer — and that is allowed.",
      ]],
    ];
    let x = 0.7;
    cards.forEach(([t, icon, sub, items]) => {
      h.card(s, x, 2.35, 5.85, 3.95, { fill: CREAM });
      s.addImage({ data: icon, x: x + 0.35, y: 2.62, w: 0.36, h: 0.36 });
      s.addText(t, { x: x + 0.9, y: 2.6, w: 4.6, h: 0.42, fontFace: TITLE_FONT, fontSize: 20, bold: true, color: INK, valign: "middle", margin: 0 });
      s.addText(sub, { x: x + 0.35, y: 3.12, w: 5.15, h: 0.4, fontFace: BODY_FONT, fontSize: 12.5, color: RED_DEEP, italic: true, margin: 0, valign: "top" });
      s.addText(items.map((it, i) => ({ text: it, options: { bullet: true, breakLine: i < items.length - 1 } })), {
        x: x + 0.35, y: 3.62, w: 5.15, h: 2.4, fontFace: BODY_FONT, fontSize: 12, color: INK_SOFT, paraSpaceAfter: 7, margin: 0, valign: "top" });
      x += 6.08;
    });

    s.addText("Both travel the same three-stage chain. Neither can be paid without it.", {
      x: 0.7, y: 6.5, w: 11.93, h: 0.4, fontFace: BODY_FONT, fontSize: 12.5, color: INK, bold: true, margin: 0, valign: "top" });
    P(s);
    s.addNotes(
      "The requisition is the newer of the two and the one OEA staff will use most.\n\n" +
      "Draw out the third bullet on the right: a line with no payee at all is legitimate. Something donated, something already paid for another way — it still belongs on the record even though no transfer follows. The system does not force every line to resolve to money leaving."
    );
  }

  // ── 13 · The chain ───────────────────────────────────────────────────────
  {
    const s = pres.addSlide();
    h.creamBg(s);
    h.kicker(s, "Day 2 · The approval chain");
    h.title(s, "Three stages, three different people");

    const stages = [
      ["1", "Work signed off", "FM · PM · Regional Manager", "Confirms the work was DONE — they have been to the building and the job card matches. No spending limit applies here.", false],
      ["2", "Audit verification", "Payment Auditor", "Checks the invoice against the job card and the evidence. This is why Day 1's photographs mattered.", false],
      ["3", "Final approval", "Payment Approver · Executive · Admin", "Clears the amount. This is the stage a spending tier applies to — above the threshold it needs the Managing Partner.", true],
    ];
    let x = 0.7;
    stages.forEach(([n, t, who, d, tier]) => {
      h.card(s, x, 2.3, 3.9, 3.0, { fill: PAPER });
      h.disc(s, x + 0.3, 2.56, n);
      s.addText(t, { x: x + 0.92, y: 2.56, w: 2.8, h: 0.46, fontFace: TITLE_FONT, fontSize: 18, bold: true, color: INK, valign: "middle", margin: 0 });
      s.addText(who, { x: x + 0.3, y: 3.16, w: 3.3, h: 0.34, fontFace: BODY_FONT, fontSize: 11, bold: true, color: RED_DEEP, margin: 0, valign: "top" });
      s.addText(d, { x: x + 0.3, y: 3.56, w: 3.3, h: 1.5, fontFace: BODY_FONT, fontSize: 11.5, color: INK_SOFT, margin: 0, valign: "top" });
      if (tier) h.pill(s, x + 0.3, 4.92, "Tier applies");
      x += 4.06;
    });

    h.card(s, 0.7, 5.5, 11.93, 1.22, { fill: "1A1A2E", line: "1A1A2E" });
    s.addText("Stage 1 is not an approval.", { x: 1.0, y: 5.66, w: 4.2, h: 0.4, fontFace: TITLE_FONT, fontSize: 17, bold: true, color: PAPER, margin: 0, valign: "top" });
    s.addText("A manager confirming the work happened holds no spending limit and no tier. Calling it an approval put “Requires Tier 2” above a stage no tier applies to — so it is now named for what it is.", {
      x: 1.0, y: 6.05, w: 11.3, h: 0.55, fontFace: BODY_FONT, fontSize: 12, color: "C9CBD8", margin: 0, valign: "top" });
    P(s);
    s.addNotes(
      "Run one payable all the way through on screen, switching logins as you go: oea.pm@, then oea.auditapprover@, then oea.approver@.\n\n" +
      "At each stage show that the button is only actionable for the role that owns that stage. Everyone else can see where it has got to, and can do nothing to it.\n\n" +
      "The board renamed stage one this month. Worth saying why: it was called an approval, and that single word made people think a manager signing off a job card was clearing the money. They are not. They are saying 'I went, and this was done.'"
    );
  }

  // ── 14 · Separation of duties ────────────────────────────────────────────
  {
    const s = pres.addSlide();
    h.lightBg(s);
    h.kicker(s, "Day 2 · What the system refuses");
    h.title(s, "The refusals are the point");
    h.lede(s, "Every one of these is enforced in the database, not merely hidden on screen. Try them.");

    const rules = [
      ["Only the Finance Approver releases money", "An administrator approves within the threshold. An executive approves above it. Neither can execute the transfer."],
      ["Whoever approved it cannot release it", "Per payment, per person — not merely per role. It can legitimately refuse a finance approver who approved it themselves. The answer is a second pair of hands."],
      ["An approver cannot raise their own limit", "You may not approve against a threshold you are able to lift."],
      ["A payment above the threshold needs two", "The administrator and the Managing Partner together."],
      ["Every release is attributed", "The one action that moves real money records exactly who performed it."],
    ];
    let y = 2.4;
    rules.forEach(([t, d]) => {
      s.addShape("roundRect", { x: 0.7, y, w: 11.93, h: 0.82, rectRadius: 0.06, fill: { color: CREAM }, line: { color: LINE, width: 1 } });
      s.addImage({ data: I.shield, x: 0.95, y: y + 0.24, w: 0.3, h: 0.3 });
      s.addText(t, { x: 1.4, y: y + 0.06, w: 4.5, h: 0.36, fontFace: BODY_FONT, fontSize: 12.5, bold: true, color: INK, margin: 0, valign: "middle" });
      s.addText(d, { x: 1.4, y: y + 0.4, w: 11, h: 0.36, fontFace: BODY_FONT, fontSize: 11, color: INK_SOFT, margin: 0, valign: "middle" });
      y += 0.9;
    });
    P(s);
    s.addNotes(
      "Invite the room to try to break these. Genuinely — sign in as the administrator and attempt to release a payment you approved. Watch it refuse.\n\n" +
      "The second rule catches people out and it is meant to. If your finance approver is the only person who ever approves, they will eventually be blocked from paying. That is not a bug to route around; it is the control telling you the organisation needs a second approver."
    );
  }

  // ── 15 · Day 2 hands-on ──────────────────────────────────────────────────
  {
    const s = pres.addSlide();
    h.creamBg(s);
    h.kicker(s, "Day 2 · Hands-on");
    h.title(s, "Your turn — take one payable all the way");
    h.lede(s, "Use the job you completed yesterday. Swap seats at every stage.");

    const ex = [
      ["4", "Raise a requisition", "oea.pm@", [
        "Requisitions → New. Link it to yesterday's job.",
        "Add two lines: one naming GreenLeaf, one with no payee.",
        "Submit, and note the total it locks in.",
      ]],
      ["5", "Sign off, then audit", "oea.pm@ · oea.auditapprover@", [
        "Stage 1: confirm the work was done.",
        "Sign in as the auditor and open the evidence.",
        "Stage 2: verify, or send it back with a reason.",
      ]],
      ["6", "Approve, then release", "oea.approver@ · oea.finance@", [
        "Stage 3: approve within tier.",
        "Now try to release it as the approver — expect a refusal.",
        "Release as Finance. Find it on the ledger and the audit trail.",
      ]],
    ];
    let x = 0.7;
    ex.forEach(([n, t, who, items]) => {
      h.card(s, x, 2.5, 3.9, 3.9, { fill: PAPER });
      h.disc(s, x + 0.3, 2.76, n);
      s.addText(t, { x: x + 0.92, y: 2.76, w: 2.8, h: 0.46, fontFace: TITLE_FONT, fontSize: 16.5, bold: true, color: INK, valign: "middle", margin: 0 });
      h.pill(s, x + 0.3, 3.4, who, { size: 9 });
      s.addText(items.map((it, i) => ({ text: it, options: { bullet: true, breakLine: i < items.length - 1 } })), {
        x: x + 0.3, y: 3.92, w: 3.3, h: 2.3, fontFace: BODY_FONT, fontSize: 11.5, color: INK_SOFT, paraSpaceAfter: 6, margin: 0, valign: "top" });
      x += 4.06;
    });
    s.addText("Exercise 6 contains a deliberate failure. If it does not refuse you, that is a finding — tell a facilitator immediately.", {
      x: 0.7, y: 6.62, w: 11.93, h: 0.4, fontFace: BODY_FONT, fontSize: 12, color: RED_DEEP, italic: true, bold: true, margin: 0, valign: "top" });
    P(s);
    s.addNotes(
      "Allow a full 90 minutes. This is the longest hands-on block of the three days and the one people ask most questions during.\n\n" +
      "Watch for pairs who quietly skip the deliberate failure because it 'did not work'. Go and stand with them and make them do it.\n\n" +
      "Close by opening the audit trail together, so the room sees their own names against the actions they just took."
    );
  }

  // ── 16 · DAY 3 divider ───────────────────────────────────────────────────
  {
    const s = pres.addSlide();
    h.dayDivider(s, 3, "Tenancies, landlords and the record", "The property side — the work OEA is actually known for", [
      "Application through to a signed tenancy",
      "Rent demanded, collected, split and remitted",
      "What the landlord sees, and what they never see",
      "Hands-on, then open testing on whatever you like",
    ]);
    P(s);
    s.addNotes("Day three is closest to the day job for most of this room. It is also the day where the fee arithmetic gets scrutinised, so leave room for that conversation.");
  }

  // ── 17 · Lettings flow ───────────────────────────────────────────────────
  {
    const s = pres.addSlide();
    h.lightBg(s);
    h.kicker(s, "Day 3 · Lettings");
    h.title(s, "From enquiry to a landlord's statement");

    const steps = [
      ["Application", "Arrives through the property's own link, carrying the property with it."],
      ["Two-tier review", "Two people, both human. No automated system scores or decides."],
      ["Lease", "Drafted, then activated. A unit cannot be let twice for the same dates."],
      ["Rent demand", "Annual in advance — raised ahead by however many days you configure."],
      ["Collection", "Payment link; part payments handled."],
      ["Split & remit", "Fees taken, landlord's net paid out."],
      ["Statement", "What the landlord actually receives."],
    ];
    let x = 0.7;
    const cw = 1.62;
    steps.forEach(([t, d], i) => {
      h.card(s, x, 2.35, cw, 2.55, { fill: i === 1 ? RED_SOFT : CREAM, line: i === 1 ? "F0D4D4" : LINE });
      h.disc(s, x + 0.12, 2.5, i + 1, { d: 0.34, size: 11 });
      s.addText(t, { x: x + 0.12, y: 2.95, w: cw - 0.24, h: 0.6, fontFace: TITLE_FONT, fontSize: 12.5, bold: true, color: INK, margin: 0, valign: "top" });
      s.addText(d, { x: x + 0.12, y: 3.55, w: cw - 0.24, h: 1.25, fontFace: BODY_FONT, fontSize: 9.5, color: INK_SOFT, margin: 0, valign: "top" });
      x += cw + 0.16;
    });

    h.card(s, 0.7, 5.1, 5.85, 1.6, { fill: RED_SOFT, line: "F0D4D4" });
    s.addText("Screening stays human", { x: 1.0, y: 5.3, w: 5.2, h: 0.38, fontFace: TITLE_FONT, fontSize: 15.5, bold: true, color: INK, margin: 0, valign: "top" });
    s.addText("Documents may be checked automatically — extraction, format, duplicates. No system decides, scores or recommends an outcome, and the reviewer records their own reason.", {
      x: 1.0, y: 5.68, w: 5.25, h: 0.9, fontFace: BODY_FONT, fontSize: 11, color: INK_SOFT, margin: 0, valign: "top" });

    h.card(s, 6.78, 5.1, 5.85, 1.6);
    s.addText("Renewal notices", { x: 7.08, y: 5.3, w: 5.2, h: 0.38, fontFace: TITLE_FONT, fontSize: 15.5, bold: true, color: INK, margin: 0, valign: "top" });
    s.addText("Go out at 90, 60 and 30 days before a tenancy ends — configurable per organisation. Each fires once per tenancy, per threshold, however many times the job runs.", {
      x: 7.08, y: 5.68, w: 5.25, h: 0.9, fontFace: BODY_FONT, fontSize: 11, color: INK_SOFT, margin: 0, valign: "top" });
    P(s);
    s.addNotes(
      "The two-tier review is a compliance requirement, not a preference. Refusing someone housing is a significant decision, and under the NDPA it cannot be made solely by an automated system. Two people look, and each records their own reason in their own words.\n\n" +
      "On renewal notices: the record decides whether a notice has gone, not the schedule. If the job runs three times in a night, the tenant still hears from us once."
    );
  }

  // ── 18 · Fees ────────────────────────────────────────────────────────────
  {
    const s = pres.addSlide();
    h.creamBg(s);
    h.kicker(s, "Day 3 · The arithmetic");
    h.title(s, "What comes out of the rent");
    h.lede(s, "Both fees are frozen onto the demand when it is raised. Changing a rate later never rewrites a statement already issued.");

    const fees = [
      ["Management fee", "A percentage of the rent.", [
        "The organisation sets a default rate.",
        "A landlord may carry their own negotiated rate, shown as a difference from the default with a one-click reset.",
      ]],
      ["Admin fee", "A flat amount.", [
        "Charged ONCE per tenancy, on the first demand — the setting that was agreed this month.",
        "A renewal continues the same tenancy, so it is not charged again.",
        "An individual tenancy can depart from the default if it was negotiated that way.",
      ]],
    ];
    let x = 0.7;
    fees.forEach(([t, sub, items]) => {
      h.card(s, x, 2.5, 5.85, 3.4, { fill: PAPER });
      s.addImage({ data: I.money, x: x + 0.35, y: 2.78, w: 0.34, h: 0.34 });
      s.addText(t, { x: x + 0.88, y: 2.75, w: 4.6, h: 0.42, fontFace: TITLE_FONT, fontSize: 19, bold: true, color: INK, valign: "middle", margin: 0 });
      s.addText(sub, { x: x + 0.35, y: 3.26, w: 5.15, h: 0.34, fontFace: BODY_FONT, fontSize: 12.5, color: RED_DEEP, italic: true, margin: 0, valign: "top" });
      s.addText(items.map((it, i) => ({ text: it, options: { bullet: true, breakLine: i < items.length - 1 } })), {
        x: x + 0.35, y: 3.72, w: 5.15, h: 2.0, fontFace: BODY_FONT, fontSize: 11.5, color: INK_SOFT, paraSpaceAfter: 7, margin: 0, valign: "top" });
      x += 6.08;
    });

    h.card(s, 0.7, 6.05, 11.93, 0.85, { fill: OK_SOFT, line: "CBE3D6" });
    s.addImage({ data: I.check, x: 1.0, y: 6.28, w: 0.26, h: 0.26 });
    s.addText("Both are set in Settings → Lettings by an administrator. Neither needs a developer, and neither reaches backwards.", {
      x: 1.4, y: 6.05, w: 11, h: 0.85, fontFace: BODY_FONT, fontSize: 12, color: INK, valign: "middle", margin: 0,
    });
    P(s);
    s.addNotes(
      "Expect the most detailed questions of the week here, from whoever owns landlord relationships.\n\n" +
      "The 'frozen onto the demand' point is the one to land. If the organisation changes its management fee in March, every statement issued in January and February still says what it said. The rate lives on the transaction, not in a setting the statement looks up each time it is printed.\n\n" +
      "The admin fee being once per tenancy was decided this month. Before that it was being taken on every demand — and since rent here is annual, that meant a one-off fee landing every year. Worth saying out loud; someone in the room will have wondered."
    );
  }

  // ── 19 · Reporting & audit ───────────────────────────────────────────────
  {
    const s = pres.addSlide();
    h.lightBg(s);
    h.kicker(s, "Day 3 · The record");
    h.title(s, "Reporting, and who is allowed to see it");

    const left = [
      ["Landlord", "Their own portfolio, their statements, their payments — live, plus a monthly report."],
      ["Managers", "Operational KPIs for the properties they hold."],
      ["Finance & Executive", "All financials, live."],
      ["Auditor", "Payments at their stage, and their own actions."],
    ];
    h.card(s, 0.7, 2.25, 5.85, 4.1, { fill: CREAM });
    s.addImage({ data: I.chart, x: 1.0, y: 2.5, w: 0.34, h: 0.34 });
    s.addText("Reporting by role", { x: 1.52, y: 2.47, w: 4.6, h: 0.42, fontFace: TITLE_FONT, fontSize: 19, bold: true, color: INK, valign: "middle", margin: 0 });
    let y = 3.1;
    left.forEach(([who, what]) => {
      s.addText(who, { x: 1.0, y, w: 5.2, h: 0.3, fontFace: BODY_FONT, fontSize: 12, bold: true, color: RED_DEEP, margin: 0, valign: "top" });
      s.addText(what, { x: 1.0, y: y + 0.29, w: 5.25, h: 0.52, fontFace: BODY_FONT, fontSize: 11, color: INK_SOFT, margin: 0, valign: "top" });
      y += 0.82;
    });

    h.card(s, 6.78, 2.25, 5.85, 4.1, { fill: CREAM });
    s.addImage({ data: I.shield, x: 7.08, y: 2.5, w: 0.34, h: 0.34 });
    s.addText("The audit trail", { x: 7.6, y: 2.47, w: 4.6, h: 0.42, fontFace: TITLE_FONT, fontSize: 19, bold: true, color: INK, valign: "middle", margin: 0 });
    s.addText([
      { text: "Every action is written down as it happens — who, what, when, and the state before and after.", options: { bullet: true, breakLine: true } },
      { text: "Records are never deleted. Things are retired, not erased.", options: { bullet: true, breakLine: true } },
      { text: "The trail survives the person: deactivating an account never removes what they did.", options: { bullet: true, breakLine: true } },
      { text: "Approvals, payments and releases each carry the name of whoever performed them.", options: { bullet: true } },
    ], { x: 7.08, y: 3.1, w: 5.25, h: 3.0, fontFace: BODY_FONT, fontSize: 11.5, color: INK_SOFT, paraSpaceAfter: 8, margin: 0, valign: "top" });
    P(s);
    s.addNotes(
      "Open the audit trail live and search for one of the room's own names. It lands better than any explanation.\n\n" +
      "If someone asks whether records can be removed: no. Even test accounts created during this week cannot be deleted once they have acted, because the trail holds them. They get deactivated instead. That is the same rule that will protect a real dispute two years from now."
    );
  }

  // ── 20 · Day 3 hands-on ──────────────────────────────────────────────────
  {
    const s = pres.addSlide();
    h.creamBg(s);
    h.kicker(s, "Day 3 · Hands-on");
    h.title(s, "Your turn — a tenancy, and then anything you like");

    const ex = [
      ["7", "Create a tenancy", "oea.pm@", [
        "Draft a lease against a vacant unit at Parkview Terraces.",
        "Set the rent and the escalation.",
        "Activate it, then raise the first demand.",
      ]],
      ["8", "Follow the money", "oea.tenant@ · oea.finance@", [
        "Pay the demand as the tenant.",
        "As Finance, find the split — fees taken, landlord's net.",
        "Check the fee matches what the demand froze.",
      ]],
      ["9", "See it as the landlord", "oea.owner@", [
        "Open your portfolio and your statement.",
        "Confirm you can see your money.",
        "Confirm you cannot see other tenants' complaints.",
      ]],
    ];
    let x = 0.7;
    ex.forEach(([n, t, who, items]) => {
      h.card(s, x, 2.3, 3.9, 3.75, { fill: PAPER });
      h.disc(s, x + 0.3, 2.56, n);
      s.addText(t, { x: x + 0.92, y: 2.56, w: 2.8, h: 0.46, fontFace: TITLE_FONT, fontSize: 16.5, bold: true, color: INK, valign: "middle", margin: 0 });
      h.pill(s, x + 0.3, 3.2, who, { size: 9 });
      s.addText(items.map((it, i) => ({ text: it, options: { bullet: true, breakLine: i < items.length - 1 } })), {
        x: x + 0.3, y: 3.72, w: 3.3, h: 2.2, fontFace: BODY_FONT, fontSize: 11.5, color: INK_SOFT, paraSpaceAfter: 6, margin: 0, valign: "top" });
      x += 4.06;
    });

    h.card(s, 0.7, 6.2, 11.93, 0.78, { fill: PAPER });
    s.addText([
      { text: "Then: open testing. ", options: { bold: true } },
      { text: "Pick the screens you will actually live in and use them as if it were a normal Tuesday. That is where the useful findings come from.", options: {} },
    ], { x: 1.0, y: 6.2, w: 11.3, h: 0.78, fontFace: BODY_FONT, fontSize: 12, color: INK, valign: "middle", margin: 0 });
    P(s);
    s.addNotes(
      "Exercise 9's third bullet is a control check dressed as an exercise — the landlord visibility rule we fixed. Make sure someone actually tries it.\n\n" +
      "Leave at least 90 minutes for open testing. The scripted exercises prove the system does what we say; open testing is where you find out what we forgot."
    );
  }

  // ── 21 · Findings ────────────────────────────────────────────────────────
  {
    const s = pres.addSlide();
    h.lightBg(s);
    h.kicker(s, "Throughout");
    h.title(s, "How to report what you find");
    h.lede(s, "A finding we can reproduce is worth ten we cannot.");

    const fields = [
      ["Who you were", "The exact login — oea.pm@, not “as a manager”."],
      ["What you did", "The steps, in order, from signing in."],
      ["What you expected", "In your own words."],
      ["What happened", "Including the exact wording of any message."],
      ["The reference", "Request, requisition or lease number if there is one."],
      ["When", "Roughly the time — it lets us find it in the trail."],
    ];
    let x = 0.7, y = 2.4;
    fields.forEach(([t, d], i) => {
      const cx = x + (i % 3) * 4.06;
      const cy = y + Math.floor(i / 3) * 1.6;
      h.card(s, cx, cy, 3.9, 1.4);
      s.addText(t, { x: cx + 0.3, y: cy + 0.18, w: 3.3, h: 0.36, fontFace: TITLE_FONT, fontSize: 15, bold: true, color: INK, margin: 0, valign: "top" });
      s.addText(d, { x: cx + 0.3, y: cy + 0.56, w: 3.3, h: 0.7, fontFace: BODY_FONT, fontSize: 11, color: INK_SOFT, margin: 0, valign: "top" });
    });

    h.card(s, 0.7, 5.75, 11.93, 1.05, { fill: OK_SOFT, line: "CBE3D6" });
    s.addImage({ data: I.check, x: 1.0, y: 6.05, w: 0.28, h: 0.28 });
    s.addText("“It refused me” is not automatically a defect — but it is always worth reporting. Half of them are controls working, and the other half are the ones we want.", {
      x: 1.42, y: 5.75, w: 10.95, h: 1.05, fontFace: BODY_FONT, fontSize: 12.5, color: INK, valign: "middle", margin: 0,
    });
    P(s);
    s.addNotes("Have the finding sheet printed and on every table from the first session. People will not remember at 4pm what confused them at 10am.");
  }

  // ── 22 · Known gaps ──────────────────────────────────────────────────────
  {
    const s = pres.addSlide();
    h.creamBg(s);
    h.kicker(s, "Before you ask");
    h.title(s, "Known gaps — please do not log these");
    h.lede(s, "These are already tracked. Anything not on this list, we want to hear about.");

    const gaps = [
      ["This is the rehearsal environment", "A separate production environment has not been provisioned yet. That is deliberate and sequenced for go-live."],
      ["Payments run in test mode", "Card payments show a test-mode banner. No money moves anywhere."],
      ["Some channels are still being provisioned", "WhatsApp and Telegram routing works; a couple of account-level confirmations are outstanding."],
      ["Email replies", "Sending works. The reply-to inboxes for OEA are being set by an administrator this week."],
    ];
    let y = 2.5;
    gaps.forEach(([t, d]) => {
      h.card(s, 0.7, y, 11.93, 0.95, { fill: PAPER });
      s.addImage({ data: I.warn, x: 1.0, y: y + 0.32, w: 0.3, h: 0.3 });
      s.addText(t, { x: 1.45, y: y + 0.13, w: 4.6, h: 0.38, fontFace: BODY_FONT, fontSize: 13, bold: true, color: INK, margin: 0, valign: "middle" });
      s.addText(d, { x: 1.45, y: y + 0.5, w: 10.9, h: 0.36, fontFace: BODY_FONT, fontSize: 11, color: INK_SOFT, margin: 0, valign: "middle" });
      y += 1.05;
    });
    P(s);
    s.addNotes("Update this slide the morning of day one — it is the slide most likely to have gone stale between writing and delivery. Anything closed since should come off it, and anything newly known should go on.");
  }

  // ── 23 · Close ───────────────────────────────────────────────────────────
  {
    const s = pres.addSlide();
    h.darkBg(s);
    s.addShape("ellipse", { x: 9.7, y: -2.5, w: 6.8, h: 6.8, fill: { color: CHARCOAL, transparency: 28 }, line: { type: "none" } });
    s.addText("Three days, thirteen roles, one system.", {
      x: 0.9, y: 2.5, w: 11, h: 1.0, fontFace: TITLE_FONT, fontSize: 40, bold: true, color: PAPER, margin: 0, valign: "top" });
    s.addText("What you could not do is as important as what you could. Tell us both.", {
      x: 0.9, y: 3.6, w: 10.5, h: 0.5, fontFace: BODY_FONT, fontSize: 18, color: "C9CBD8", italic: true, margin: 0, valign: "top" });
    s.addShape("line", { x: 0.9, y: 4.5, w: 2.2, h: 0, line: { color: RED, width: 2 } });
    s.addText(`Ora Egbunike & Associates  ·  ${PORTAL}`, {
      x: 0.9, y: 4.7, w: 9, h: 0.4, fontFace: BODY_FONT, fontSize: 13, color: "E4E5EC", margin: 0, valign: "top" });
    s.addNotes("Close by thanking them for the awkward questions specifically. The room that says nothing is the room that signs off a system nobody can use.");
  }

  await pres.writeFile({ fileName: OUT });
  console.log("wrote", OUT, "·", page + 1, "slides");
}

main().catch((e) => { console.error(e); process.exit(1); });
