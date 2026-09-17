// Builds docs/OE_Group_IPMS_Demo_Readiness.pptx — where the build actually
// stands, for a board/UAT audience.
//
// Deliberately a NEW deck rather than an edit of
// OE_Group_Phase1_Progress.UPDATED.v2.pptx. That one is a day-by-day progress
// narrative frozen at 5 Aug (through Day 11); this answers a different
// question — "is it ready to show, and what is still owed" — and rewriting 31
// designed slides to ask it would lose the original and answer neither well.
import pptxgen from "pptxgenjs";

const NAVY = "1E2761";
const ICE = "CADCFC";
const WHITE = "FFFFFF";
const INK = "16233F";
const MUTED = "5B6B8C";
const GOOD = "1B7F5A";
const WARN = "B4690E";
const LINE = "DFE6F5";

const pres = new pptxgen();
pres.layout = "LAYOUT_WIDE"; // 13.3 x 7.5
pres.author = "OE Group";
pres.company = "OE Group";
pres.title = "OE Group IPMS — Demo Readiness";

const H = "Cambria";
const B = "Calibri";

/** Dark slide, for the open and the close. */
function dark(title, kicker) {
  const s = pres.addSlide();
  s.background = { color: NAVY };
  if (kicker) {
    s.addText(kicker, {
      x: 0.7, y: 0.65, w: 11.9, h: 0.3, margin: 0,
      fontFace: B, fontSize: 12, bold: true, color: ICE, charSpacing: 2,
    });
  }
  s.addText(title, {
    x: 0.7, y: 1.0, w: 11.9, h: 1.1, margin: 0,
    fontFace: H, fontSize: 40, bold: true, color: WHITE,
  });
  return s;
}

/** Light content slide. */
function light(title, subtitle) {
  const s = pres.addSlide();
  s.background = { color: WHITE };
  s.addText(title, {
    x: 0.7, y: 0.5, w: 11.9, h: 0.6, margin: 0,
    fontFace: H, fontSize: 30, bold: true, color: NAVY,
  });
  if (subtitle) {
    s.addText(subtitle, {
      x: 0.7, y: 1.12, w: 11.9, h: 0.5, margin: 0,
      fontFace: B, fontSize: 14, color: MUTED,
    });
  }
  return s;
}

/** A card with a heading and body — the deck's one repeated motif. */
function card(s, { x, y, w, h, heading, body, accent = NAVY, tag }) {
  s.addShape(pres.ShapeType.roundRect, {
    x, y, w, h, rectRadius: 0.08,
    fill: { color: "F7F9FE" }, line: { color: LINE, width: 1 },
  });
  if (tag) {
    s.addText(tag, {
      x: x + 0.28, y: y + 0.22, w: w - 0.56, h: 0.24, margin: 0,
      fontFace: B, fontSize: 10, bold: true, color: accent, charSpacing: 1.5,
    });
  }
  s.addText(heading, {
    x: x + 0.28, y: y + (tag ? 0.5 : 0.26), w: w - 0.56, h: 0.42, margin: 0,
    fontFace: H, fontSize: 15, bold: true, color: INK,
  });
  s.addText(body, {
    x: x + 0.28, y: y + (tag ? 0.95 : 0.72), w: w - 0.56, h: h - (tag ? 1.2 : 0.98),
    margin: 0, fontFace: B, fontSize: 11.5, color: MUTED, lineSpacingMultiple: 1.15,
  });
}

/** Big-number stat. */
function stat(s, { x, y, w, value, label, sub, color = NAVY }) {
  s.addText(String(value), {
    x, y, w, h: 0.85, margin: 0,
    fontFace: H, fontSize: 46, bold: true, color,
  });
  s.addText(label, {
    x, y: y + 0.82, w, h: 0.3, margin: 0,
    fontFace: B, fontSize: 12.5, bold: true, color: INK,
  });
  if (sub) {
    s.addText(sub, {
      x, y: y + 1.1, w, h: 0.5, margin: 0,
      fontFace: B, fontSize: 10.5, color: MUTED,
    });
  }
}

// ── 1. Title ──────────────────────────────────────────────────────────────
{
  const s = dark("Demo Readiness", "BOARD CONFIDENTIAL · OE GROUP IPMS");
  s.addText(
    "Where the unified property & facilities platform stands, what changed at the August board, and what is still owed before go-live.",
    { x: 0.7, y: 2.25, w: 8.6, h: 0.9, margin: 0, fontFace: B, fontSize: 15, color: ICE }
  );
  s.addText("24 August 2026  ·  Master Build Prompt v3.5", {
    x: 0.7, y: 3.3, w: 8.6, h: 0.3, margin: 0,
    fontFace: B, fontSize: 12, bold: true, color: WHITE,
  });

  const items = [
    ["All 6 AURA modules", "built and verified"],
    ["Dev + staging", "level at migration 0190"],
    ["90 verification suites", "run against the live database"],
  ];
  items.forEach(([k, v], i) => {
    s.addShape(pres.ShapeType.roundRect, {
      x: 0.7 + i * 4.0, y: 4.35, w: 3.7, h: 1.15, rectRadius: 0.08,
      fill: { color: "2C3A72" }, line: { color: "3E4F8E", width: 1 },
    });
    s.addText(k, {
      x: 0.95, y: 4.55, w: 3.2, h: 0.3, margin: 0,
      fontFace: H, fontSize: 14, bold: true, color: WHITE,
    });
    s.addText(v, {
      x: 0.95, y: 4.88, w: 3.2, h: 0.4, margin: 0,
      fontFace: B, fontSize: 11, color: ICE,
    });
  });
  s.addNotes(
    "Framing: this is a readiness review, not a progress report. The build is functionally complete across all six modules; what follows is what the August board changed, what that cost, and the short list of things still owed before real client data lands."
  );
}

// ── 2. Where it stands ────────────────────────────────────────────────────
{
  const s = light("Where the build stands", "Counted from the live database and the verification suites, not from a plan.");
  stat(s, { x: 0.7, y: 1.9, w: 2.6, value: "209", label: "migrations applied", sub: "dev and staging identical" });
  stat(s, { x: 3.9, y: 1.9, w: 2.6, value: "13", label: "roles, each scoped", sub: "every one with a home screen" });
  stat(s, { x: 7.1, y: 1.9, w: 2.6, value: "85", label: "suites passing", sub: "of 90 · 4 outstanding, 1 needs a running server", color: GOOD });
  stat(s, { x: 10.3, y: 1.9, w: 2.6, value: "3", label: "money tracks live", sub: "ledger · collect · remit" });

  card(s, {
    x: 0.7, y: 4.0, w: 5.9, h: 2.5, accent: GOOD, tag: "READY TO DEMONSTRATE",
    heading: "The end-to-end money path",
    body: "A tenant pays rent on their phone → the client-funds ledger splits the fee from the landlord's share → a contractor invoices against the job card → the invoice climbs three pairs of hands → finance releases it. Every step refuses to be skipped, and refuses in words a person can act on.",
  });
  card(s, {
    x: 6.9, y: 4.0, w: 5.7, h: 2.5, accent: WARN, tag: "NEEDS A DECISION",
    heading: "Before real data lands",
    body: "Opening balances must be posted on the real cutover date. Approval thresholds are unset on TFML and OEA. Production is not yet provisioned. None of these are build work — they are the numbers and the go/no-go that only the board can supply.",
  });
  s.addNotes("The 4 outstanding suites: two exceed the parallel runner's time limit but pass when run on their own, one needs a running dev server, and one belongs to an uncommitted admin-fee migration from a separate workstream. None is a defect in this branch.");
}

// ── 3. What the August board changed ──────────────────────────────────────
{
  const s = light("What the August board changed", "Four decisions, v3.4 → v3.5. Each one narrowed something that was too wide.");
  const rows = [
    ["18", "FM and PM become two roles", "OEA now employs facilities managers alongside property managers. One role wearing a brand-aware label could not tell them apart — they share a brand.", NAVY],
    ["19", "A request reaches one desk", "Finance stopped reading the operational queue. Landlords stopped seeing their tenants' complaints. Org-wide sight is three roles.", NAVY],
    ["20", "A location is a state", "36 states + FCT, offered as a list. 25 seeded cities was a sample, not a set — and free text produced three spellings of Port Harcourt.", NAVY],
    ["21", "A generator is serviced by the hour", "Running hours, not a calendar. A 500-hour interval is six weeks of grid instability or nine months of standby duty.", NAVY],
  ];
  rows.forEach(([n, head, body], i) => {
    const y = 1.85 + i * 1.3;
    s.addShape(pres.ShapeType.ellipse, {
      x: 0.7, y: y + 0.08, w: 0.62, h: 0.62,
      fill: { color: NAVY }, line: { color: NAVY, width: 0 },
    });
    s.addText(n, {
      x: 0.7, y: y + 0.08, w: 0.62, h: 0.62, margin: 0,
      align: "center", valign: "middle", fontFace: H, fontSize: 16, bold: true, color: WHITE,
    });
    s.addText(head, {
      x: 1.55, y: y, w: 4.3, h: 0.42, margin: 0,
      fontFace: H, fontSize: 15, bold: true, color: INK,
    });
    s.addText(body, {
      x: 6.0, y: y - 0.02, w: 6.6, h: 0.9, margin: 0,
      fontFace: B, fontSize: 11.5, color: MUTED, lineSpacingMultiple: 1.12,
    });
  });
  s.addNotes("Decision 17 (vendor self-service) was taken on 17 Aug and its UI has now been built — covered later in this deck.");
}

// ── 4. The landlord leak ──────────────────────────────────────────────────
{
  const s = light(
    "The finding worth naming",
    "Nobody wrote this policy. It is what four correct rules added up to."
  );
  card(s, {
    x: 0.7, y: 1.95, w: 5.9, h: 2.15, accent: WARN, tag: "BEFORE",
    heading: "A landlord read every tenant complaint",
    body: "The place-scoping resolver answers for an owner exactly as it does for a manager — by design, and correctly, since an owner reaches their own statements and payments through it. The service-request rule simply never said which of the two it was for.",
  });
  card(s, {
    x: 6.9, y: 1.95, w: 5.7, h: 2.15, accent: GOOD, tag: "AFTER",
    heading: "A landlord sees what they raised",
    body: "The board's access matrix has always shown a dash in that cell. The scoping was right and the consumer was wrong, so the rule now states which roles it serves. Owners keep their payments, statements and portfolio in full.",
  });
  s.addShape(pres.ShapeType.roundRect, {
    x: 0.7, y: 4.45, w: 11.9, h: 2.1, rectRadius: 0.08,
    fill: { color: NAVY }, line: { color: NAVY, width: 0 },
  });
  s.addText("Why it survived a year of testing", {
    x: 1.05, y: 4.7, w: 11.2, h: 0.35, margin: 0,
    fontFace: H, fontSize: 16, bold: true, color: WHITE,
  });
  s.addText(
    "Two verification suites asserted it as a feature. Both required a landlord to see some tickets, so both passed while describing the leak. A test that encodes the bug is worse than no test — it converts a defect into evidence of correctness. Both are now inverted, and a third suite was written that enumerates every role rather than checking the two that changed.",
    { x: 1.05, y: 5.1, w: 11.2, h: 1.2, margin: 0, fontFace: B, fontSize: 12.5, color: ICE, lineSpacingMultiple: 1.15 }
  );
  s.addNotes("This is the single most important slide for an auditor. The mechanism — correct rules composing into an unintended outcome, with tests that ratified it — is the failure mode worth watching for, not the instance.");
}

// ── 5. Who sees a service request now ─────────────────────────────────────
{
  const s = light("Who sees a service request", "Everyone sees what is specifically theirs. Nothing else.");
  const cols = [
    ["Raised it", "Tenant, landlord, staff", "Anyone who reports a problem follows it to resolution.", NAVY],
    ["Dispatched to them", "Ops staff, contractors", "The job in their hand, and their company's other jobs.", NAVY],
    ["Their place", "FM · PM · Regional", "Everything on properties they manage — triage depends on it.", NAVY],
    ["Money at their desk", "Finance · Payment approver", "Only once the payment attached to it has climbed to them.", WARN],
    ["Everything", "Admin · Executive · Payment auditor", "The auditor is here because stage 2 checks the invoice against the job card.", GOOD],
  ];
  cols.forEach(([head, who, body, accent], i) => {
    const x = 0.7 + i * 2.44;
    s.addShape(pres.ShapeType.roundRect, {
      x, y: 1.95, w: 2.24, h: 3.6, rectRadius: 0.08,
      fill: { color: "F7F9FE" }, line: { color: LINE, width: 1 },
    });
    s.addShape(pres.ShapeType.ellipse, {
      x: x + 0.9, y: 2.2, w: 0.44, h: 0.44,
      fill: { color: accent }, line: { color: accent, width: 0 },
    });
    s.addText(String(i + 1), {
      x: x + 0.9, y: 2.2, w: 0.44, h: 0.44, margin: 0,
      align: "center", valign: "middle", fontFace: H, fontSize: 12, bold: true, color: WHITE,
    });
    s.addText(head, {
      x: x + 0.2, y: 2.78, w: 1.84, h: 0.5, margin: 0, align: "center",
      fontFace: H, fontSize: 13.5, bold: true, color: INK,
    });
    s.addText(who, {
      x: x + 0.2, y: 3.3, w: 1.84, h: 0.55, margin: 0, align: "center",
      fontFace: B, fontSize: 10.5, bold: true, color: accent,
    });
    s.addText(body, {
      x: x + 0.2, y: 3.9, w: 1.84, h: 1.4, margin: 0, align: "center",
      fontFace: B, fontSize: 10.5, color: MUTED, lineSpacingMultiple: 1.1,
    });
  });
  s.addText(
    "An FM/PM now lands on “Assigned to me”. The property-wide view stays one click away, because reviewing a fresh request before it is dispatched is their job and removing it would leave nobody able to triage.",
    { x: 0.7, y: 5.85, w: 11.9, h: 0.6, margin: 0, fontFace: B, fontSize: 12, italic: true, color: MUTED }
  );
}

// ── 6. The payment chain ──────────────────────────────────────────────────
{
  const s = light("Three pairs of hands, then finance", "Corrected this month: stage 1 was being called an approval, and it is not one.");
  const stages = [
    ["1", "Work completed\nand signed off", "FM · PM · Regional", "Confirms the work was DONE. No spending limit, no tier.", NAVY],
    ["2", "Audit\nverification", "Payment auditor", "Checks the invoice against the job card and the evidence.", NAVY],
    ["3", "Final\napproval", "Approver · Exec · Admin", "The only stage bounded by an amount rather than a place.", NAVY],
    ["4", "Release\nof funds", "Finance approver only", "Not an approval, and cannot stand in for a missing one.", GOOD],
  ];
  stages.forEach(([n, title, who, body, accent], i) => {
    const x = 0.7 + i * 3.06;
    s.addShape(pres.ShapeType.roundRect, {
      x, y: 2.0, w: 2.8, h: 2.9, rectRadius: 0.08,
      fill: { color: i === 3 ? "EFF8F3" : "F7F9FE" },
      line: { color: i === 3 ? "BFE3D0" : LINE, width: 1 },
    });
    s.addText(n, {
      x: x + 0.25, y: 2.2, w: 0.5, h: 0.45, margin: 0,
      fontFace: H, fontSize: 24, bold: true, color: accent,
    });
    s.addText(title, {
      x: x + 0.25, y: 2.72, w: 2.3, h: 0.75, margin: 0,
      fontFace: H, fontSize: 14, bold: true, color: INK,
    });
    s.addText(who, {
      x: x + 0.25, y: 3.5, w: 2.3, h: 0.3, margin: 0,
      fontFace: B, fontSize: 10.5, bold: true, color: accent,
    });
    s.addText(body, {
      x: x + 0.25, y: 3.85, w: 2.3, h: 0.9, margin: 0,
      fontFace: B, fontSize: 10.5, color: MUTED, lineSpacingMultiple: 1.1,
    });
  });
  card(s, {
    x: 0.7, y: 5.15, w: 5.9, h: 1.55, accent: NAVY,
    heading: "The approval ladder now has both rungs visible",
    body: "The lower threshold had been read by the system and set by no screen, sitting at its default everywhere. Both are now editable, with a mandatory reason recorded against the organisation.",
  });
  card(s, {
    x: 6.9, y: 5.15, w: 5.7, h: 1.55, accent: NAVY,
    heading: "The approver who could never approve",
    body: "A dead button offered an approval the system had already automated, and refused the one role that exists to give it. Removed — the chain is the only approval surface.",
  });
  s.addNotes("Stage 1 was named 'Job sign-off and approval for payment'. The second half made 'Requires Tier 2' appear above a stage no tier applies to, and invited the reading that an FM is the first of three approvers rather than the person whose evidence the approvers check.");
}

// ── 7. Vendor self-service ────────────────────────────────────────────────
{
  const s = light("A contractor administers themselves", "The last thing owed on decision 17. The database has been ready since 17 August; the screens are now built.");
  card(s, {
    x: 0.7, y: 1.95, w: 3.85, h: 2.4, accent: NAVY, tag: "THE COMPANY",
    heading: "More than one login",
    body: "A contractor's cleaner, office manager and director are three people, not one shared password. Four fixed capabilities decide who may invoice, who may invite, who may sign contracts.",
  });
  card(s, {
    x: 4.75, y: 1.95, w: 3.85, h: 2.4, accent: NAVY, tag: "THE PACK",
    heading: "Registration in proportion",
    body: "Standard asks for four documents; enhanced adds five more. A two-man contractor sees four. A thirteen-section form is how a small firm ends up unregistered, not how they get vetted harder.",
  });
  card(s, {
    x: 8.8, y: 1.95, w: 3.8, h: 2.4, accent: GOOD, tag: "THE MONEY",
    heading: "Stated, never actionable",
    body: "Last four digits plus the bank's own letter. No path exists from the registration into the payout system — finance reads the number off the evidence and registers it once with the gateway.",
  });
  s.addShape(pres.ShapeType.roundRect, {
    x: 0.7, y: 4.65, w: 11.9, h: 1.9, rectRadius: 0.08,
    fill: { color: "FBF6EC" }, line: { color: "EBD9B4", width: 1 },
  });
  s.addText("Registration does not gate a payment", {
    x: 1.05, y: 4.9, w: 11.2, h: 0.35, margin: 0,
    fontFace: H, fontSize: 16, bold: true, color: WARN,
  });
  s.addText(
    "An incomplete pack is a reason to chase a contractor, never a reason to withhold money for work already done. The contractor's own screen says so in those words. This was a deliberate board position and the build honours it — the registration reports, and refuses nothing.",
    { x: 1.05, y: 5.3, w: 11.2, h: 1.0, margin: 0, fontFace: B, fontSize: 12.5, color: "6B5322", lineSpacingMultiple: 1.15 }
  );
}

// ── 8. Security ───────────────────────────────────────────────────────────
{
  const s = light("Security findings closed this month", "Each was found by a check, not by an incident.");
  const rows = [
    ["Two functions callable anonymously", "One of them provisions organisations. Neither was exploitable alone — an inner check refused an anonymous caller — which is exactly why it survived: the inner check makes the outer one look unnecessary.", GOOD],
    ["A drifted permission grant", "A landlord role held org-wide request sight in the operator organisation. Nil blast radius — that org holds no client data — recorded because the failure mode outlives the instance.", GOOD],
    ["A settings write with no reason attached", "Threshold changes bypassed the audited path, skipping the mandatory explanation and the before/after record. Never an authority hole; an accountability one.", GOOD],
    ["A dispatch check that skipped itself", "A guarded test block silently stopped running when its fixture went missing, and reported PASS for a rule it never exercised.", GOOD],
  ];
  rows.forEach(([head, body], i) => {
    const y = 1.9 + i * 1.24;
    s.addShape(pres.ShapeType.ellipse, {
      x: 0.7, y: y + 0.12, w: 0.4, h: 0.4,
      fill: { color: GOOD }, line: { color: GOOD, width: 0 },
    });
    s.addText("✓", {
      x: 0.7, y: y + 0.12, w: 0.4, h: 0.4, margin: 0,
      align: "center", valign: "middle", fontFace: B, fontSize: 14, bold: true, color: WHITE,
    });
    s.addText(head, {
      x: 1.3, y: y, w: 4.2, h: 0.6, margin: 0,
      fontFace: H, fontSize: 14, bold: true, color: INK,
    });
    s.addText(body, {
      x: 5.7, y: y - 0.02, w: 6.9, h: 1.1, margin: 0,
      fontFace: B, fontSize: 11.5, color: MUTED, lineSpacingMultiple: 1.12,
    });
  });
  s.addNotes("The common thread: every one was found because something enumerated the rule rather than checking the diff. That is the practice worth funding, not the individual fixes.");
}

// ── 9. What is still owed ─────────────────────────────────────────────────
{
  const s = light("What is still owed", "Nothing here is blocked on build work.");
  card(s, {
    x: 0.7, y: 1.9, w: 3.85, h: 2.35, accent: WARN, tag: "BOARD / FINANCE",
    heading: "Opening balances",
    body: "The real balance on the real cutover date. Left unset, every reconciliation is permanently out by that amount. Zero is correct for staging and wrong for production.",
  });
  card(s, {
    x: 4.75, y: 1.9, w: 3.85, h: 2.35, accent: WARN, tag: "BOARD",
    heading: "Approval thresholds",
    body: "TFML and OEA have none set. Until they do, the above-threshold path — the one with two pairs of hands on it — cannot be rehearsed on either brand.",
  });
  card(s, {
    x: 8.8, y: 1.9, w: 3.8, h: 2.35, accent: WARN, tag: "OPERATIONS",
    heading: "Production environment",
    body: "Not yet provisioned. Schema-only at cutover, never seeded — every row must arrive through real onboarding.",
  });
  card(s, {
    x: 0.7, y: 4.5, w: 5.9, h: 2.1, accent: NAVY, tag: "COMPLIANCE",
    heading: "Retention for director identification",
    body: "Enhanced-tier packs carry government ID for named individuals and there is no purge job yet. Standard tier does not collect it, so standard onboarding is unblocked — this is owed before enhanced onboarding opens to real contractors.",
  });
  card(s, {
    x: 6.9, y: 4.5, w: 5.7, h: 2.1, accent: NAVY, tag: "ACCESS",
    heading: "Deployment credentials",
    body: "The account currently linked to the deployment tooling can read the projects but is refused on publish. A team owner needs to raise its role, or deploy under their own login.",
  });
}

// ── 10. Close ─────────────────────────────────────────────────────────────
{
  const s = dark("Ready to demonstrate", "WHERE THIS LEAVES US");
  s.addText(
    "All six modules are built, verified against the live database, and running on two isolated environments. What remains is not code — it is three numbers, one environment, and a go/no-go.",
    { x: 0.7, y: 2.2, w: 8.4, h: 1.0, margin: 0, fontFace: B, fontSize: 16, color: ICE, lineSpacingMultiple: 1.2 }
  );
  const asks = [
    ["Confirm", "the approval thresholds for TFML and OEA"],
    ["Supply", "opening balances and the cutover date"],
    ["Approve", "provisioning the production environment"],
  ];
  asks.forEach(([verb, rest], i) => {
    const y = 3.75 + i * 0.85;
    s.addShape(pres.ShapeType.roundRect, {
      x: 0.7, y, w: 11.9, h: 0.68, rectRadius: 0.06,
      fill: { color: "2C3A72" }, line: { color: "3E4F8E", width: 1 },
    });
    s.addText(
      [
        { text: verb + "  ", options: { bold: true, color: WHITE } },
        { text: rest, options: { color: ICE } },
      ],
      { x: 1.0, y, w: 11.3, h: 0.68, margin: 0, valign: "middle", fontFace: B, fontSize: 14 }
    );
  });
  s.addNotes("Close on the three asks. Everything else on the outstanding list is work already scheduled and not a decision the board needs to make in the room.");
}

await pres.writeFile({ fileName: "docs/OE_Group_IPMS_Demo_Readiness.pptx" });
console.log("wrote docs/OE_Group_IPMS_Demo_Readiness.pptx");
