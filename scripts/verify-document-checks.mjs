// Day 8.5 — AI may verify documents; it may never screen (locked decision 10).
//
// The claims that matter, in the order they would matter to a regulator:
//   • the feature is OFF by default, per org
//   • a finding cannot exist without the evidence it is about
//   • the schema has no score and no recommendation column — checked by
//     introspection, because "we didn't add one" is not a control
//   • severity admits exactly `info` and `attention`, never a verdict
//   • a reviewer cannot write findings directly (they would be manufacturing
//     the evidence their own decision cites)
//   • a finding is contestable, the contest is attributed, and the finding is
//     NOT deleted by it
//   • approving still requires the reviewer's own reason — findings never
//     substitute for it
//   • findings from another org are unreachable
//
// Usage: node scripts/verify-document-checks.mjs
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { sweepProbeProperties } from "./lib/probe-cleanup.mjs";

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
config({ path: path.join(rootDir, ".env.local") });

const URL_ = process.env.NEXT_PUBLIC_SUPABASE_URL;
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const SVCK = process.env.SUPABASE_SERVICE_ROLE_KEY;
const PW = "OEGroupDemo2026!";

let failures = 0;
const ok = (m) => console.log(`  \x1b[32mPASS\x1b[0m ${m}`);
const bad = (m) => { failures++; console.log(`  \x1b[31mFAIL\x1b[0m ${m}`); };

const svc = createClient(URL_, SVCK, { auth: { persistSession: false } });
const login = async (email) => {
  const c = createClient(URL_, ANON, { auth: { persistSession: false } });
  const { error } = await c.auth.signInWithPassword({ email, password: PW });
  return error ? null : c;
};

const orgRes = await svc.from("orgs").select("id, name, delivery_brand").is("deleted_at", null);
if (orgRes.error) { console.error("db unreachable:", orgRes.error.message); process.exit(1); }
const oea = orgRes.data.find((o) => o.delivery_brand === "OEA");
const tfml = orgRes.data.find((o) => o.delivery_brand === "TFML");

// Repair what a crashed earlier run left behind — end-of-run cleanup never
// executes when the run throws, and a probe property then reaches the public
// tenancy page. See the note in verify-application-review.
const sweptProps = await sweepProbeProperties(svc, ["PROBEDOC-"]);
if (sweptProps > 0) console.log(`(swept ${sweptProps} propert(y/ies) left by an earlier run)\n`);

const S = Date.now().toString(36).toUpperCase().slice(-5);
const made = { applications: [], attachments: [], findings: [], properties: [] };

// ── Fixtures of our own ────────────────────────────────────────────────────
//
// The first draft of this suite reached for whatever application happened to be
// in the database, and four of its seven sections silently SKIPPED when the one
// it found had no attachment — while the run still printed ALL CHECKS PASSED.
// A suite that reports success for checks it never executed is worse than no
// suite. It builds what it needs now.
const prop = await svc.from("properties")
  .insert({ org_id: oea.id, name: `PROBEDOC-Property-${S}` })
  .select("id").single();
if (prop.error) { console.error("could not create a probe property:", prop.error.message); process.exit(1); }
made.properties.push(prop.data.id);

const app = await svc.from("tenant_applications").insert({
  org_id: oea.id, type: "individual", status: "under_review",
  applicant_name: `Probe Applicant ${S}`,
  applicant_email: `probedoc.${S.toLowerCase()}@oegroup-probe.test`,
  property_id: prop.data.id,
  form: { date_of_birth: "1990-01-01" },
}).select("id").single();
if (app.error) { console.error("could not create a probe application:", app.error.message); process.exit(1); }
made.applications.push(app.data.id);

const att = await svc.from("application_attachments").insert({
  org_id: oea.id, application_id: app.data.id, kind: "national_id",
  storage_path: `probe/${S}/national_id.png`,
  file_name: "national_id.png", content_type: "image/png", size_bytes: 1024,
}).select("id").single();
if (att.error) { console.error("could not create a probe attachment:", att.error.message); process.exit(1); }
made.attachments.push(att.data.id);

const APP_ID = app.data.id;
const ATT_ID = att.data.id;

console.log("Automated document verification — support, never screening\n");

console.log("A. The feature starts OFF, per organisation");
{
  const { data: rows } = await svc
    .from("org_modules").select("org_id, enabled").eq("module", "ai_document_checks");
  (rows ?? []).length >= orgRes.data.length
    ? ok(`every organisation has an explicit ai_document_checks row (${(rows ?? []).length})`)
    : bad(`only ${(rows ?? []).length} orgs carry the flag`);

  (rows ?? []).every((r) => r.enabled === false)
    ? ok("and every one of them is off — a record, not an absence")
    : bad("SOME ORG HAS AUTOMATED CHECKS ON BY DEFAULT");

  // Both flags required, not one.
  const { data: runs } = await svc.rpc("org_runs_document_checks", { p_org_id: oea.id });
  runs === false
    ? ok("org_runs_document_checks is false for OEA while the flag is off, despite lettings being on")
    : bad(`org_runs_document_checks returned ${runs} with the flag off`);
}

console.log("\nB. The schema cannot express a conclusion");
{
  // Selecting a column that does not exist fails, which IS the assertion —
  // "we didn't add a score column" is a claim; this is a check.
  for (const forbidden of ["score", "risk_score", "recommendation", "verdict", "decision"]) {
    const { error: e } = await svc
      .from("application_document_findings").select(forbidden).limit(1);
    if (!e) bad(`THE FINDINGS TABLE HAS A "${forbidden}" COLUMN`);
  }
  ok("no score, risk_score, recommendation, verdict or decision column exists");

  const { error: verdict } = await svc.from("application_document_findings").insert({
    org_id: oea.id, application_id: APP_ID, attachment_id: ATT_ID,
    kind: "format", severity: "fail",
    summary: "This should never be accepted at all.",
    model: "probe", evidence_mode: "extracted_text",
  });
  verdict ? ok('severity "fail" is refused — there is no verdict value')
          : bad("A VERDICT SEVERITY WAS ACCEPTED");

  // Nor may evidence_mode claim a provenance that is not one of the two real
  // ones — the audit has to be able to say which happened.
  const { error: mode } = await svc.from("application_document_findings").insert({
    org_id: oea.id, application_id: APP_ID, attachment_id: ATT_ID,
    kind: "format", severity: "info",
    summary: "A finding claiming an invented provenance.",
    model: "probe", evidence_mode: "telepathy",
  });
  mode ? ok("evidence_mode admits only extracted_text or document_image")
       : bad("AN INVENTED EVIDENCE MODE WAS ACCEPTED");
}

console.log("\nC. A finding cannot exist without its evidence");
{
  const { error: noEvidence } = await svc.from("application_document_findings").insert({
    org_id: oea.id, application_id: APP_ID, attachment_id: null,
    kind: "consistency", severity: "attention",
    summary: "A finding about the applicant rather than a document.",
    model: "probe", evidence_mode: "extracted_text",
  });
  noEvidence
    ? ok("a finding with no attachment is refused — findings are about documents, not people")
    : bad("A FINDING WAS RECORDED AGAINST NO EVIDENCE");

  const { error: terse } = await svc.from("application_document_findings").insert({
    org_id: oea.id, application_id: APP_ID, attachment_id: ATT_ID,
    kind: "format", severity: "info", summary: "bad",
    model: "probe", evidence_mode: "extracted_text",
  });
  terse ? ok('a summary of "bad" is refused — a finding must be actionable and disputable')
        : bad("A ONE-WORD FINDING WAS ACCEPTED");

  // Evidence belonging to a DIFFERENT application must not be citable.
  const otherApp = await svc.from("tenant_applications").insert({
    org_id: oea.id, type: "individual", status: "submitted",
    applicant_name: `Probe Other ${S}`,
    applicant_email: `probedoc.other.${S.toLowerCase()}@oegroup-probe.test`,
  }).select("id").single();
  if (otherApp.data) {
    made.applications.push(otherApp.data.id);
    const { error: crossed } = await svc.from("application_document_findings").insert({
      org_id: oea.id, application_id: otherApp.data.id, attachment_id: ATT_ID,
      kind: "consistency", severity: "attention",
      summary: "Citing another application's document as this one's evidence.",
      model: "probe", evidence_mode: "extracted_text",
    });
    // The composite FKs prove both rows are in one org and say NOTHING about
    // whether they belong to each other — the property that actually keeps one
    // applicant's papers out of another's review. Closed by 0086b's trigger.
    crossed
      ? ok("a finding cannot cite an attachment from another application")
      : bad("A FINDING CITED ANOTHER APPLICATION'S DOCUMENT AS ITS EVIDENCE");
    if (!crossed) {
      const { data: stray } = await svc.from("application_document_findings")
        .select("id").eq("application_id", otherApp.data.id);
      for (const r of stray ?? []) made.findings.push(r.id);
    }
  }
}

console.log("\nD. A reviewer cannot manufacture findings");
{
  const c = await login("oea.admin@oegroup.test");
  if (!c) bad("could not sign in as the OEA administrator");
  else {
    const { error } = await c.from("application_document_findings").insert({
      org_id: oea.id, application_id: APP_ID, attachment_id: ATT_ID,
      kind: "consistency", severity: "attention",
      summary: "A finding written by the very person who will cite it.",
      model: "hand-written", evidence_mode: "extracted_text",
    });
    error
      ? ok("an administrator cannot insert a finding directly — no INSERT policy exists")
      : bad("A REVIEWER WROTE THEIR OWN FINDING");

    const seeded = await svc.from("application_document_findings").insert({
      org_id: oea.id, application_id: APP_ID, attachment_id: ATT_ID,
      kind: "format", severity: "info",
      summary: `Probe finding ${S} for the update and contest checks.`,
      model: "probe", evidence_mode: "extracted_text",
    }).select("id").single();
    if (seeded.error) bad(`could not seed a probe finding — ${seeded.error.message.slice(0, 70)}`);
    else {
      made.findings.push(seeded.data.id);
      const { data: updated } = await c.from("application_document_findings")
        .update({ summary: "Quietly rewritten to suit the decision." })
        .eq("id", seeded.data.id).select("id");
      (updated ?? []).length === 0
        ? ok("nor edit an existing one")
        : bad("A REVIEWER REWROTE A FINDING");

      const { data: readBack } = await c.from("application_document_findings")
        .select("id, summary").eq("id", seeded.data.id).maybeSingle();
      readBack ? ok("but they can read it — a finding they cannot see is a finding they cannot weigh")
               : bad("a reviewer could not read a finding on their own application");
    }
    await c.auth.signOut();
  }
}

console.log("\nE. A finding is contestable, attributed, and never deleted by it");
{
  const c = await login("oea.admin@oegroup.test");
  const findingId = made.findings[0];
  if (!c || !findingId) { console.log("  \x1b[33mSKIP\x1b[0m no probe finding available"); }
  else {
    const { error: tooShort } = await c.rpc("contest_document_finding", {
      p_finding_id: findingId, p_reason: "wrong",
    });
    tooShort ? ok("a contest with no real reason is refused")
             : bad("A CONTEST WAS ACCEPTED WITH A ONE-WORD REASON");

    const { error } = await c.rpc("contest_document_finding", {
      p_finding_id: findingId,
      p_reason: "The document does say this; the check misread the issuing date.",
    });
    error ? bad(`contest failed — ${error.message.slice(0, 70)}`) : ok("a reviewer can dispute a finding");

    const { data: after } = await svc.from("application_document_findings")
      .select("id, contested_by, contested_at, contest_reason, summary")
      .eq("id", findingId).maybeSingle();

    after ? ok("and the finding still exists — the evidence trail keeps its hole-free shape")
          : bad("CONTESTING DELETED THE FINDING");
    after?.contested_by ? ok("the dispute carries who recorded it") : bad("the contest is unattributed");
    after?.contest_reason?.length >= 10 ? ok("and why") : bad("the contest has no reason");
    await c.auth.signOut();
  }
}

console.log("\nF. Findings never substitute for the reviewer's own reason");
{
  // The approval path is unchanged by this feature: it must still refuse a
  // reason shorter than ten characters, whatever the findings say.
  const c = await login("oea.admin@oegroup.test");
  if (!c) { console.log("  \x1b[33mSKIP\x1b[0m"); }
  else {
    const { error } = await c.rpc("record_application_approval", {
      p_application_id: APP_ID, p_reason: "ok", p_invite_token_hash: "x".repeat(64),
    });
    error ? ok("approval with a two-character reason is still refused, whatever the findings say")
          : bad("AN APPLICATION WAS APPROVED WITHOUT A REAL REASON");
    await c.auth.signOut();
  }
}

console.log("\nG. Findings do not cross an organisation boundary");
{
  const c = await login("tfml.admin@oegroup.test");
  if (!c) { console.log("  \x1b[33mSKIP\x1b[0m no TFML admin"); }
  else {
    const { data } = await c.from("application_document_findings").select("id");
    (data ?? []).length === 0
      ? ok("a TFML administrator sees none of OEA's findings")
      : bad(`CROSS-ORG LEAK: TFML read ${(data ?? []).length} finding(s)`);

    const findingId = made.findings[0];
    if (findingId) {
      const { error } = await c.rpc("contest_document_finding", {
        p_finding_id: findingId, p_reason: "Contesting another organisation's finding entirely.",
      });
      error ? ok("nor can they contest one") : bad("TFML CONTESTED AN OEA FINDING");
    }
    await c.auth.signOut();
  }
}

// ── Cleanup ────────────────────────────────────────────────────────────────
if (made.findings.length) {
  await svc.from("application_document_findings").delete().in("id", made.findings);
}
if (made.applications.length) {
  await svc.from("application_document_findings").delete().in("application_id", made.applications);
  await svc.from("application_attachments").delete().in("application_id", made.applications);
  await svc.from("tenant_applications").delete().in("id", made.applications);
}
if (made.properties.length) {
  await svc.from("properties").delete().in("id", made.properties);
}
console.log("\n(cleaned up)");

console.log(
  failures === 0
    ? "\n\x1b[32mALL CHECKS PASSED\x1b[0m — the checks report observations against evidence, and cannot become a decision."
    : `\n\x1b[31m${failures} CHECK(S) FAILED\x1b[0m`
);
process.exit(failures === 0 ? 0 : 1);
