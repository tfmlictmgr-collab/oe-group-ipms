// OEA UAT — day-in-the-life scenarios.
//
// The companion to the walkthrough deck. Each scenario is one realistic
// situation carried across every role it touches, so staff see the handover
// points rather than a sequence of isolated screens.
const pptxgen = require("pptxgenjs");
const path = require("path");
const { FiAlertTriangle, FiCheckCircle, FiClock, FiUsers } = require("react-icons/fi");
const C = require("./common.js");

const OUT = path.join(__dirname, process.argv[2] || "OE_Group_IPMS_UAT_Scenarios_OEA.pptx");

const SCENARIOS = [
  {
    day: 1,
    title: "The generator gives out at Parkview Terraces",
    setting: "Saturday, 6pm. The estate loses power. A tenant in Flat 3B reports it from her phone, on WhatsApp, in the dark.",
    baton: [
      ["Tenant", "oea.tenant@", "Reports it with a photograph of the panel. Gets a reference back immediately."],
      ["System", "—", "Classifies it: power, critical. Writes a short summary a manager can read at a glance."],
      ["Properties Manager", "oea.pm@", "Reviews it — confirms it is the shared generator, not a unit fault. Only then dispatches."],
      ["Vendor", "oea.vendor@", "GreenLeaf attends, updates the job card, photographs the repair and the meter reading."],
      ["Facilities Manager", "oea.fmgr@", "Logs the running hours against the asset, so the next service is scheduled by use, not by calendar."],
      ["Tenant", "oea.tenant@", "Sees it closed, and can say whether it was actually fixed."],
    ],
    watch: [
      "The dispatch is refused until someone reviews it. Deliberate — nobody is sent to a building sight unseen.",
      "The classification is a suggestion, not a decision. The manager can change it.",
      "The evidence attached here is what the auditor reads on day two. Thin evidence now means a blocked payment later.",
    ],
  },
  {
    day: 2,
    title: "Month end: paying for the work",
    setting: "The generator repair needs paying — GreenLeaf's invoice, plus the fuel your own supervisor bought on the night.",
    baton: [
      ["Vendor", "oea.vendor@", "Submits the invoice against the job it belongs to."],
      ["Properties Manager", "oea.pm@", "Raises a requisition for the fuel — one line to a payee, one line for something already covered."],
      ["PM / FM", "oea.pm@", "Stage 1: confirms the work was done. Not an approval — no spending limit applies."],
      ["Payment Auditor", "oea.auditapprover@", "Stage 2: reads the invoice against the job card and Saturday's photographs."],
      ["Payment Approver", "oea.approver@", "Stage 3: clears the amount, within tier."],
      ["Finance Approver", "oea.finance@", "Releases it. The only role that can, and never the person who approved it."],
    ],
    watch: [
      "Try releasing as the person who approved. It will refuse — per payment, per person, not merely per role.",
      "A requisition line with no payee is legitimate: recorded spend, no transfer.",
      "Edit the amount upward after approval and watch the chain invalidate. It approved a number, not a document.",
    ],
  },
  {
    day: 3,
    title: "A new tenancy, and what the landlord sees",
    setting: "Flat 2A falls vacant. An applicant comes through the property's own link, and the owner wants to know when the money lands.",
    baton: [
      ["Applicant", "public link", "Applies through the property's own address, which carries the property with it."],
      ["Reviewer one", "oea.pm@", "First of two human reviews. Records their own reason in their own words."],
      ["Reviewer two", "oea.admin@", "Second review. No automated system scores, ranks or recommends an outcome."],
      ["Properties Manager", "oea.pm@", "Drafts the lease, sets rent and escalation, activates it."],
      ["System", "—", "Raises the first demand ahead of the start date, freezing the fee split onto it."],
      ["Tenant", "oea.tenant@", "Pays. Part payment is handled — the fee splits in proportion."],
      ["Property Owner", "oea.owner@", "Sees the money and the statement. Sees no other tenant's complaints."],
    ],
    watch: [
      "The admin fee lands once, on the first demand of the tenancy — and never again, including at renewal.",
      "Change the management fee afterwards and reopen the statement. It must not have moved.",
      "As the landlord, go looking for the request queue. You should not find it.",
    ],
  },
];

async function main() {
  const I = {
    warn: await C.iconPng(FiAlertTriangle, C.RED_DEEP),
    check: await C.iconPng(FiCheckCircle, C.OK),
    clock: await C.iconPng(FiClock, C.RED_DEEP),
    users: await C.iconPng(FiUsers, C.RED_DEEP),
  };

  const pres = new pptxgen();
  pres.layout = "LAYOUT_WIDE";
  const h = C.helpers(pres);
  const { PAPER, CREAM, INK, INK_SOFT, LINE, RED, RED_DEEP, RED_SOFT, OK_SOFT, CHARCOAL, TITLE_FONT, BODY_FONT, W, H } = C;
  let page = 0;
  const P = (s) => h.pageNum(s, ++page);

  // ── Title ────────────────────────────────────────────────────────────────
  {
    const s = pres.addSlide();
    h.darkBg(s);
    s.addShape("ellipse", { x: 9.6, y: -2.6, w: 7, h: 7, fill: { color: CHARCOAL, transparency: 25 }, line: { type: "none" } });
    s.addShape("ellipse", { x: 11.2, y: 4.8, w: 4.4, h: 4.4, fill: { color: RED, transparency: 83 }, line: { type: "none" } });
    s.addText("ORA EGBUNIKE & ASSOCIATES · USER ACCEPTANCE TESTING", {
      x: 0.9, y: 1.6, w: 11, h: 0.4, fontFace: BODY_FONT, fontSize: 12.5, bold: true, color: RED, charSpacing: 1.6, margin: 0, valign: "top" });
    s.addText("Three days in the life", {
      x: 0.85, y: 2.1, w: 11.5, h: 1.1, fontFace: TITLE_FONT, fontSize: 52, bold: true, color: PAPER, margin: 0, valign: "top" });
    s.addText("One situation a day, carried across every role it touches", {
      x: 0.9, y: 3.35, w: 11, h: 0.55, fontFace: BODY_FONT, fontSize: 19, color: "C9CBD8", italic: true, margin: 0, valign: "top" });
    s.addShape("line", { x: 0.9, y: 4.2, w: 2.2, h: 0, line: { color: RED, width: 2 } });
    s.addText("Companion to the three-day walkthrough — run these after the scripted exercises", {
      x: 0.9, y: 4.4, w: 10, h: 0.4, fontFace: BODY_FONT, fontSize: 13, color: "E4E5EC", margin: 0, valign: "top" });
    s.addNotes("These scenarios are the second half of each day. The walkthrough teaches the screens; these prove the handovers — the moments where work passes from one person to another and something can be dropped.");
  }

  // ── How to run one ───────────────────────────────────────────────────────
  {
    const s = pres.addSlide();
    h.lightBg(s);
    h.kicker(s, "Before you start");
    h.title(s, "How to run a scenario");
    h.lede(s, "Six to eight people, one screen each, one situation moving between them in real time.");

    const rules = [
      ["Assign the seats first", "One person per role in the baton, signed in and ready before the scenario starts."],
      ["Do not skip ahead", "Wait for the handover. The delay is part of what you are testing."],
      ["Say what you see", "Out loud, as you go — the person before you cannot see your screen."],
      ["Try the refusals", "Each scenario names something that should fail. Attempt it properly."],
    ];
    let x = 0.7, y = 2.45;
    rules.forEach(([t, d], i) => {
      const cx = x + (i % 2) * 6.08;
      const cy = y + Math.floor(i / 2) * 1.85;
      h.card(s, cx, cy, 5.85, 1.6);
      h.disc(s, cx + 0.3, cy + 0.28, i + 1, { d: 0.4, size: 13 });
      s.addText(t, { x: cx + 0.85, y: cy + 0.24, w: 4.7, h: 0.42, fontFace: TITLE_FONT, fontSize: 17, bold: true, color: INK, valign: "middle", margin: 0 });
      s.addText(d, { x: cx + 0.3, y: cy + 0.82, w: 5.25, h: 0.65, fontFace: BODY_FONT, fontSize: 11.5, color: INK_SOFT, margin: 0, valign: "top" });
    });

    h.card(s, 0.7, 6.15, 11.93, 0.85, { fill: OK_SOFT, line: "CBE3D6" });
    s.addImage({ data: I.check, x: 1.0, y: 6.38, w: 0.28, h: 0.28 });
    s.addText("Allow 45 minutes per scenario, plus 15 to talk about what happened. The conversation afterwards is where the findings come from.", {
      x: 1.42, y: 6.15, w: 10.95, h: 0.85, fontFace: BODY_FONT, fontSize: 12, color: INK, valign: "middle", margin: 0,
    });
    P(s);
    s.addNotes("The temptation is to let one confident person drive the whole thing. Resist it — the point is the handover, and a single driver never experiences one.");
  }

  // ── Per scenario: setup slide + baton slide ──────────────────────────────
  SCENARIOS.forEach((sc) => {
    // Setup
    {
      const s = pres.addSlide();
      h.darkBg(s);
      s.addShape("ellipse", { x: 10.2, y: -2.2, w: 6, h: 6, fill: { color: CHARCOAL, transparency: 30 }, line: { type: "none" } });
      s.addText(`DAY ${sc.day} · SCENARIO`, {
        x: 0.9, y: 1.7, w: 6, h: 0.4, fontFace: BODY_FONT, fontSize: 12.5, bold: true, color: RED, charSpacing: 2.4, margin: 0, valign: "top" });
      s.addText(sc.title, {
        x: 0.85, y: 2.15, w: 11.3, h: 1.4, fontFace: TITLE_FONT, fontSize: 40, bold: true, color: PAPER, margin: 0, valign: "top" });
      s.addText(sc.setting, {
        x: 0.9, y: 3.75, w: 10.6, h: 1.0, fontFace: BODY_FONT, fontSize: 17, color: "C9CBD8", italic: true, margin: 0, valign: "top" });
      s.addShape("line", { x: 0.9, y: 4.78, w: 2.2, h: 0, line: { color: RED, width: 2 } });
      s.addText(`${sc.baton.length} people · about 45 minutes`, {
        x: 0.9, y: 4.96, w: 8, h: 0.34, fontFace: BODY_FONT, fontSize: 13, color: "E4E5EC", margin: 0, valign: "top" });

      // "Watch for" lives here, not on the baton slide: the baton table runs to
      // the bottom of that slide, and squeezing this underneath it left a
      // quarter-inch box for three lines of text.
      s.addShape("roundRect", {
        x: 0.85, y: 5.5, w: 11.6, h: 1.45, rectRadius: 0.08,
        fill: { color: CHARCOAL }, line: { color: "3A3C55", width: 1 },
      });
      s.addImage({ data: I.warn, x: 1.15, y: 5.72, w: 0.24, h: 0.24 });
      s.addText("Watch for", {
        x: 1.5, y: 5.66, w: 2.4, h: 0.34, fontFace: TITLE_FONT, fontSize: 14, bold: true,
        color: PAPER, valign: "middle", margin: 0,
      });
      s.addText(sc.watch.map((t, i) => ({ text: t, options: { bullet: true, breakLine: i < sc.watch.length - 1 } })), {
        x: 1.5, y: 6.02, w: 10.7, h: 0.82, fontFace: BODY_FONT, fontSize: 10.5,
        color: "D5D7E2", paraSpaceAfter: 3, margin: 0, valign: "top" });
      P(s);
      s.addNotes("Read the setting out loud before anyone touches a keyboard. People behave differently when the situation feels real, and that is the behaviour worth testing.");
    }

    // Baton
    {
      const s = pres.addSlide();
      h.creamBg(s);
      h.kicker(s, `Day ${sc.day} · The baton`);
      h.title(s, "Who picks it up, and when");

      let y = 2.05;
      const rowH = sc.baton.length > 6 ? 0.55 : 0.62;
      sc.baton.forEach(([who, login, what], i) => {
        s.addShape("roundRect", {
          x: 0.7, y, w: 11.93, h: rowH, rectRadius: 0.05,
          fill: { color: PAPER }, line: { color: LINE, width: 1 },
        });
        h.disc(s, 0.92, y + (rowH - 0.34) / 2, i + 1, { d: 0.34, size: 11 });
        s.addText(who, { x: 1.42, y, w: 2.3, h: rowH, fontFace: BODY_FONT, fontSize: 12, bold: true, color: INK, valign: "middle", margin: 0 });
        s.addText(login, { x: 3.75, y, w: 2.25, h: rowH, fontFace: BODY_FONT, fontSize: 10.5, color: RED_DEEP, valign: "middle", margin: 0 });
        s.addText(what, { x: 6.1, y, w: 6.35, h: rowH, fontFace: BODY_FONT, fontSize: 11, color: INK_SOFT, valign: "middle", margin: 0 });
        y += rowH + 0.09;
      });

      s.addText("Wait for the handover. The pause between rows is part of what you are testing.", {
        x: 0.7, y: y + 0.18, w: 11.93, h: 0.36, fontFace: BODY_FONT, fontSize: 11.5,
        color: INK_SOFT, italic: true, margin: 0, valign: "top" });
      P(s);
      s.addNotes(
        "Facilitator: keep this slide up while the scenario runs, so people can see whose turn is next.\n\n" +
        "The 'watch for' items are the ones to raise in the discussion afterwards if nobody noticed them at the time."
      );
    }
  });

  // ── What good looks like ─────────────────────────────────────────────────
  {
    const s = pres.addSlide();
    h.lightBg(s);
    h.kicker(s, "Afterwards");
    h.title(s, "What we are listening for");
    h.lede(s, "Three kinds of finding, all of them useful.");

    const kinds = [
      ["It stopped me, and I understood why", "The control worked and the wording explained it. Tell us anyway — this is the bar for every other refusal.", OK_SOFT, "CBE3D6"],
      ["It stopped me, and I did not understand why", "The rule may be right and the message wrong. Almost always a real fix, and a cheap one.", RED_SOFT, "F0D4D4"],
      ["It let me do something it should not have", "The most valuable finding in the room. Say so immediately, not at the end of the day.", CREAM, LINE],
    ];
    let x = 0.7;
    kinds.forEach(([t, d, fill, line]) => {
      h.card(s, x, 2.5, 3.9, 2.7, { fill, line });
      s.addText(t, { x: x + 0.32, y: 2.78, w: 3.28, h: 0.95, fontFace: TITLE_FONT, fontSize: 16, bold: true, color: INK, margin: 0, valign: "top" });
      s.addText(d, { x: x + 0.32, y: 3.82, w: 3.28, h: 1.2, fontFace: BODY_FONT, fontSize: 11.5, color: INK_SOFT, margin: 0, valign: "top" });
      x += 4.06;
    });

    h.card(s, 0.7, 5.5, 11.93, 1.2);
    s.addImage({ data: I.users, x: 1.0, y: 5.82, w: 0.3, h: 0.3 });
    s.addText([
      { text: "And one question for every role: ", options: { bold: true } },
      { text: "could you do your actual job with this, on a normal day, without asking anyone for help? If not, what is missing?", options: {} },
    ], { x: 1.45, y: 5.5, w: 10.9, h: 1.2, fontFace: BODY_FONT, fontSize: 13, color: INK, valign: "middle", margin: 0 });
    P(s);
    s.addNotes("End every scenario with the question at the bottom. It surfaces the gaps that no scripted exercise ever reaches, because scripted exercises only test what we already thought of.");
  }

  await pres.writeFile({ fileName: OUT });
  console.log("wrote", OUT, "·", page + 1, "slides");
}

main().catch((e) => { console.error(e); process.exit(1); });
