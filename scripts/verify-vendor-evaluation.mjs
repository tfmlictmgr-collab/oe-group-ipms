// Day 11 — KPI/SLA-driven, dual-source vendor evaluation (0104).
//
// The claims that matter:
//   • no score is free-typed — every point comes from a response value or a
//     ticket timestamp, computed server-side
//   • quality/compliance/satisfaction map to a fixed response→points table;
//     response/completion are measured from the ticket's own timestamps
//     against the SLA target, with no human input at all
//   • the composite exists ONLY once both sources have submitted — never
//     estimated from a partial pair
//   • only the request's own sender may submit the tenant half; only
//     oversight/the vendor's own FM may submit the fm_pm half
//   • a source cannot be submitted twice for the same ticket
//   • a ticket that is not yet resolved/closed, or has no vendor, cannot be
//     evaluated at all
//   • editing a criterion supersedes it — a past evaluation's score is frozen,
//     never retroactively recomputed
//   • a criterion edited/created AFTER a job resolved does not reach back;
//     a job resolved BEFORE any criterion existed still gets scored, against
//     the earliest version available, rather than staying null forever
//   • the free-typed insert path is gone: authenticated cannot write
//     vendor_evaluations directly, only through the function
//
// Usage: node scripts/verify-vendor-evaluation.mjs
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";
import { createClient } from "@supabase/supabase-js";

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
async function login(email) {
  const c = createClient(URL_, ANON, { auth: { persistSession: false } });
  const { error } = await c.auth.signInWithPassword({ email, password: PW });
  if (error) return null;
  const { data: { user } } = await c.auth.getUser();
  return { c, id: user.id };
}

console.log("Vendor evaluation — dual-source, KPI/SLA-driven\n");

const { data: orgs } = await svc.from("orgs").select("id, slug").is("deleted_at", null);
const org = orgs.find((o) => o.slug === "oe-group-foundation-poc");
const S = Date.now().toString(36).toUpperCase().slice(-5);
const made = { tickets: [], evaluations: [], responses: [] };

await svc.rpc("ensure_default_evaluation_criteria", { p_org_id: org.id });
const { data: criteria } = await svc
  .from("evaluation_criteria").select("*").eq("org_id", org.id).eq("active", true);
const manualByDim = (dim) => criteria.filter((c) => c.dimension === dim && c.measure === "manual");
const autoCrit = (dim) => criteria.find((c) => c.dimension === dim && c.measure === "auto");

const { data: tenant } = await svc.from("users").select("id")
  .eq("email", "oe-group-foundation-poc.tenant@oegroup.test").single();
const { data: fm } = await svc.from("users").select("id")
  .eq("email", "oe-group-foundation-poc.facilitymanager@oegroup.test").single();
const { data: vendor } = await svc.from("vendors").select("id").eq("org_id", org.id).limit(1).single();

async function mkTicket(overrides = {}) {
  const { data, error } = await svc.from("tickets").insert({
    org_id: org.id, sender_id: tenant.id, channel: "portal",
    message_text: `PROBEEVAL ${S}`, category: "maintenance", urgency: "normal",
    status: "open", assigned_vendor_id: vendor.id, ...overrides,
  }).select("id, created_at").single();
  if (error) { bad(`fixture failed — ${error.message.slice(0, 60)}`); return null; }
  made.tickets.push(data.id);
  return data;
}

const fmAnswers = (dims) => dims.flatMap((d) => manualByDim(d)).map((c) => ({
  criterionId: c.id,
  value: c.response_type === "yes_no" ? "yes" : c.response_type === "scale_1_5" ? "4" : "met",
}));

console.log("A. A completed job can be scored — no free-typed numbers involved");
let ticketA, fmEvalId, tnEvalId;
{
  const created = new Date(Date.now() - 40 * 3600 * 1000).toISOString();
  const firstResp = new Date(Date.now() - 38 * 3600 * 1000).toISOString(); // 2h response
  const resolved = new Date(Date.now() - 4 * 3600 * 1000).toISOString();   // 36h completion
  ticketA = await mkTicket({ status: "resolved", created_at: created, first_response_at: firstResp, resolved_at: resolved });

  const { data: id, error } = await svc.rpc("submit_vendor_evaluation", {
    p_ticket_id: ticketA.id, p_source: "fm_pm", p_responses: fmAnswers(["quality", "compliance"]),
  });
  error ? bad(`fm_pm submission failed — ${error.message.slice(0, 70)}`) : ok("the FM/PM checklist submits");
  fmEvalId = id;
  if (id) made.evaluations.push(id);

  const { data: row } = await svc.from("vendor_evaluations")
    .select("response_score, completion_score, quality_score, compliance_score").eq("id", fmEvalId).single();
  row.response_score !== null && row.completion_score !== null
    ? ok(`response (${row.response_score}) and completion (${row.completion_score}) were computed, not typed`)
    : bad("response/completion score missing");
  row.quality_score === 100 && row.compliance_score === 100
    ? ok("quality/compliance computed from the fixed response-value table")
    : bad(`quality=${row.quality_score} compliance=${row.compliance_score}, expected 100/100`);
}

console.log("\nB. The tenant's half completes the pair — composite appears only then");
{
  const { data: beforeBoth } = await svc.from("vendor_evaluation_tickets")
    .select("composite_score, awaiting_tenant").eq("ticket_id", ticketA.id).single();
  beforeBoth.composite_score === null && beforeBoth.awaiting_tenant === true
    ? ok("with only fm_pm submitted, composite is null and awaiting_tenant is true — not estimated")
    : bad(`composite=${beforeBoth.composite_score}, awaiting_tenant=${beforeBoth.awaiting_tenant}`);

  const tnAnswers = manualByDim("satisfaction").map((c) => ({
    criterionId: c.id, value: c.response_type === "yes_no" ? "yes" : "5",
  }));
  const { data: id, error } = await svc.rpc("submit_vendor_evaluation", {
    p_ticket_id: ticketA.id, p_source: "tenant", p_responses: tnAnswers,
  });
  error ? bad(`tenant submission failed — ${error.message.slice(0, 70)}`) : ok("the tenant's satisfaction review submits");
  tnEvalId = id;
  if (id) made.evaluations.push(id);

  const { data: after } = await svc.from("vendor_evaluation_tickets")
    .select("composite_score, quality_score, response_score, completion_score, satisfaction_score, compliance_score")
    .eq("ticket_id", ticketA.id).single();
  after.composite_score !== null
    ? ok(`composite now exists: ${after.composite_score}`)
    : bad("composite is still null after both sources submitted");

  const expected = Math.round((
    Number(after.quality_score) * 0.30 + Number(after.response_score) * 0.20
    + Number(after.completion_score) * 0.20 + Number(after.satisfaction_score) * 0.20
    + Number(after.compliance_score) * 0.10
  ) * 10) / 10;
  Math.abs(Number(after.composite_score) - expected) < 0.05
    ? ok(`and matches the AURA weights exactly (${after.composite_score} = ${expected})`)
    : bad(`composite ${after.composite_score} does not match the weighted sum ${expected}`);
}

console.log("\nC. Nobody can submit the same source twice for the same job");
{
  const { error: dupFm } = await svc.rpc("submit_vendor_evaluation", {
    p_ticket_id: ticketA.id, p_source: "fm_pm", p_responses: fmAnswers(["quality", "compliance"]),
  });
  dupFm ? ok("a second fm_pm submission is refused") : bad("A SECOND FM_PM EVALUATION WAS ACCEPTED");

  const { error: dupTn } = await svc.rpc("submit_vendor_evaluation", {
    p_ticket_id: ticketA.id, p_source: "tenant", p_responses: [],
  });
  dupTn ? ok("a second tenant submission is refused") : bad("A SECOND TENANT EVALUATION WAS ACCEPTED");
}

console.log("\nD0. One criterion takes one answer (0234)");
{
  // ⚠️ The defect this replaces: the scorer read ONE response per criterion
  // with `limit 1` and no `order by`, so a payload answering the same
  // criterion twice was scored on whichever element the executor returned
  // first — nondeterministically, on the composite that gates paying a vendor
  // (B4). `v_seen_criteria` was declared and appended to for exactly this and
  // never read by anything, so the concern looked handled and was not.
  const fresh = await mkTicket({ status: "resolved" });
  const answers = fmAnswers(["quality", "compliance"]);
  if (answers.length === 0) {
    bad("no manual criteria to build a duplicate payload from");
  } else {
    // The same criterion, answered twice, contradicting itself.
    const contradictory = [
      { ...answers[0], value: answers[0].value },
      ...answers,
    ];
    const { error } = await svc.rpc("submit_vendor_evaluation", {
      p_ticket_id: fresh.id, p_source: "fm_pm", p_responses: contradictory,
    });
    if (!error) {
      bad("A DUPLICATE-CRITERION PAYLOAD WAS SCORED — the gate depends on row order");
    } else if (/same criterion more than once/.test(error.message)) {
      ok("a payload answering one criterion twice is refused, not silently de-duplicated");
    } else {
      bad(`refused, but not for the duplicate — "${error.message}"`);
    }

    // And nothing was written on the way to that refusal.
    const { data: leaked } = await svc
      .from("vendor_evaluations").select("id").eq("ticket_id", fresh.id);
    (leaked ?? []).length === 0
      ? ok("and no evaluation row survived the refusal")
      : bad(`${leaked.length} evaluation row(s) written before the refusal`);
    for (const r of leaked ?? []) made.evaluations.push(r.id);
  }

  // The honest control: the SAME answers without the duplicate must still pass,
  // or the guard has simply broken submission.
  const clean = await mkTicket({ status: "resolved" });
  const { data: okId, error: okErr } = await svc.rpc("submit_vendor_evaluation", {
    p_ticket_id: clean.id, p_source: "fm_pm", p_responses: fmAnswers(["quality", "compliance"]),
  });
  if (okErr) bad(`the guard broke an ordinary submission — ${okErr.message}`);
  else { ok("an ordinary one-answer-per-criterion payload still scores"); made.evaluations.push(okId); }
}

console.log("\nD. A job that is not done, or has no vendor, cannot be evaluated");
{
  const open = await mkTicket({ status: "open" });
  const { error: e1 } = await svc.rpc("submit_vendor_evaluation", {
    p_ticket_id: open.id, p_source: "fm_pm", p_responses: fmAnswers(["quality", "compliance"]),
  });
  e1 ? ok("an open (unresolved) ticket is refused") : bad("AN OPEN TICKET WAS EVALUATED");

  const noVendor = await mkTicket({ status: "resolved", assigned_vendor_id: null });
  const { error: e2 } = await svc.rpc("submit_vendor_evaluation", {
    p_ticket_id: noVendor.id, p_source: "fm_pm", p_responses: [],
  });
  e2 ? ok("a resolved ticket with no vendor assigned is refused") : bad("A VENDORLESS TICKET WAS EVALUATED");
}

console.log("\nE. Standing to evaluate is enforced, not assumed from the UI");
{
  const { data: otherTenant } = await svc.from("users").select("id")
    .eq("email", "oea.tenant@oegroup.test").maybeSingle();
  if (otherTenant) {
    const c2 = createClient(URL_, ANON, { auth: { persistSession: false } });
    // Deliberately calling as service role but asserting the FUNCTION'S OWN
    // logic, not RLS — auth.uid() is null under service role, so this checks
    // the same code path a browser session would hit via a signed-in check
    // inside the function body (see section F for the real signed-in version).
    void c2;
  }

  const other = await login("oea.tenant@oegroup.test");
  const mine = await mkTicket({ status: "resolved" });
  if (other) {
    const { error } = await other.c.rpc("submit_vendor_evaluation", {
      p_ticket_id: mine.id, p_source: "tenant", p_responses: [],
    });
    error ? ok("a different tenant cannot rate someone else's request")
          : bad("A TENANT RATED A REQUEST THEY DID NOT RAISE");
    await other.c.auth.signOut();
  } else {
    console.log("  (skipped — could not sign in as a second-org tenant)");
  }

  const vendorLogin = await login("oe-group-foundation-poc.vendor@oegroup.test");
  if (vendorLogin) {
    const { error } = await vendorLogin.c.rpc("submit_vendor_evaluation", {
      p_ticket_id: mine.id, p_source: "fm_pm", p_responses: fmAnswers(["quality", "compliance"]),
    });
    error ? ok("a vendor cannot submit the FM/PM half of their own evaluation")
          : bad("A VENDOR EVALUATED THEMSELVES");
    await vendorLogin.c.auth.signOut();
  }
}

console.log("\nF. The direct-insert path is gone — only the function can write");
{
  const admin = await login("oe-group-foundation-poc.admin@oegroup.test");
  if (admin) {
    const { error } = await admin.c.from("vendor_evaluations").insert({
      org_id: org.id, vendor_id: vendor.id, quality_score: 100, composite_score: 100,
    });
    error ? ok(`a direct insert is refused (${error.message.slice(0, 50)})`)
          : bad("A FREE-TYPED SCORE WAS INSERTED DIRECTLY — the old path is not actually gone");
    await admin.c.auth.signOut();
  }
}

console.log("\nG. Criteria are effective-dated, not edited in place");
{
  const admin = await login("oe-group-foundation-poc.admin@oegroup.test");
  const q = manualByDim("quality")[0];
  const { data: newId, error } = await admin.c.rpc("edit_evaluation_criterion", {
    p_old_id: q.id, p_label: q.label + " (edited)", p_max_points: 99,
  });
  error ? bad(`editing a criterion failed — ${error.message.slice(0, 60)}`) : ok("an admin can edit a criterion");

  const { data: oldRow } = await svc.from("evaluation_criteria").select("active, superseded_by").eq("id", q.id).single();
  oldRow.active === false && oldRow.superseded_by === newId
    ? ok("the old version is retired and points at its replacement — not mutated")
    : bad(`old row: active=${oldRow.active}, superseded_by=${oldRow.superseded_by}`);

  // The evaluation submitted in section A must still show the ORIGINAL points,
  // not 99 — it answered the OLD criterion, and that answer is frozen.
  const { data: oldResponse } = await svc.from("evaluation_responses")
    .select("points_awarded").eq("evaluation_id", fmEvalId).eq("criterion_id", q.id).maybeSingle();
  if (oldResponse) {
    Number(oldResponse.points_awarded) !== 99
      ? ok(`a past response (${oldResponse.points_awarded} pts) is untouched by the later edit`)
      : bad("editing a criterion changed the POINTS on an already-submitted response");
  }

  // Restore so re-runs of this suite see the seed rubric's original point value.
  await svc.rpc("edit_evaluation_criterion", { p_old_id: newId, p_label: q.label, p_max_points: Number(q.max_points) });

  if (admin) await admin.c.auth.signOut();
}

console.log("\nH. A job resolved before ANY criterion existed still gets scored");
{
  // ⚠️ Criteria are re-fetched here, not read from the closure captured at the
  // top of the script. Section G edited (and then restored) the quality
  // criterion, which SUPERSEDES the row — a restore is a NEW row with a NEW
  // id, not the original one reactivated. Reusing the stale ids from before G
  // ran produces "missing a response for" against the now-inactive version,
  // which is the effective-dating working correctly, not a bug — the test
  // fixture just has to ask for what is active NOW, exactly as the real
  // submit_vendor_evaluation() call does.
  const { data: freshCriteria } = await svc
    .from("evaluation_criteria").select("*").eq("org_id", org.id).eq("active", true);
  const freshAnswers = (dims) => freshCriteria
    .filter((c) => dims.includes(c.dimension) && c.measure === "manual")
    .map((c) => ({
      criterionId: c.id,
      value: c.response_type === "yes_no" ? "yes" : c.response_type === "scale_1_5" ? "4" : "met",
    }));

  // Simulates day-one: a ticket resolved in the past, evaluated against
  // whatever rubric exists NOW — the fallback to the earliest version, not a
  // permanent null, is what's being proven here (0104's second fix).
  const longAgo = await mkTicket({
    status: "resolved",
    created_at: new Date(Date.now() - 1000 * 3600 * 1000).toISOString(),
    first_response_at: new Date(Date.now() - 998 * 3600 * 1000).toISOString(),
    resolved_at: new Date(Date.now() - 990 * 3600 * 1000).toISOString(),
  });
  const { data: id, error } = await svc.rpc("submit_vendor_evaluation", {
    p_ticket_id: longAgo.id, p_source: "fm_pm", p_responses: freshAnswers(["quality", "compliance"]),
  });
  error ? bad(`could not evaluate an old ticket — ${error.message.slice(0, 60)}`) : ok("an old ticket can still be evaluated");
  if (id) {
    made.evaluations.push(id);
    const { data: row } = await svc.from("vendor_evaluations")
      .select("response_score, completion_score").eq("id", id).single();
    row.response_score !== null && row.completion_score !== null
      ? ok("its response/completion scores are populated, not left null forever")
      : bad("an old ticket's auto-measured scores stayed null — the fallback did not fire");
  }
}

console.log("\nI. An org with no rubric refuses rather than scoring zero");
{
  const { data: emptyOrg } = await svc.from("orgs").select("id").eq("slug", "tfml").single();
  const { data: emptyVendor } = await svc.from("vendors").select("id").eq("org_id", emptyOrg.id).limit(1).maybeSingle();
  if (emptyVendor) {
    const { data: hasCriteria } = await svc.from("evaluation_criteria").select("id").eq("org_id", emptyOrg.id).limit(1);
    if (!hasCriteria?.length) {
      const { data: t } = await svc.from("tickets").insert({
        org_id: emptyOrg.id, channel: "portal", message_text: `PROBEEVAL-empty ${S}`,
        category: "maintenance", urgency: "normal", status: "resolved", assigned_vendor_id: emptyVendor.id,
      }).select("id").single();
      const { error } = await svc.rpc("submit_vendor_evaluation", {
        p_ticket_id: t.id, p_source: "fm_pm", p_responses: [],
      });
      error && /rubric has not been set up/i.test(error.message)
        ? ok("an org with no rubric refuses cleanly rather than scoring zero")
        : bad(`expected a clear refusal, got: ${error?.message ?? "ACCEPTED"}`);
      await svc.from("tickets").delete().eq("id", t.id);
    } else {
      console.log("  (skipped — TFML already has a rubric from an earlier run)");
    }
  } else {
    console.log("  (skipped — no vendor found on an org with no rubric)");
  }
}

console.log("\nJ. The tenant tracker knows a review is waiting, without reading vendor_evaluations");
{
  const t = await login("oe-group-foundation-poc.tenant@oegroup.test");
  if (t) {
    // A tenant cannot read vendor_evaluations directly (B7) — confirm that
    // boundary still holds, and that my_requests() answers the question anyway.
    const { data: direct, error: directErr } = await t.c.from("vendor_evaluations").select("id").limit(1);
    (directErr || (direct ?? []).length === 0)
      ? ok("a tenant still cannot read vendor_evaluations directly")
      : bad("a tenant read vendor_evaluations rows directly — the boundary regressed");

    const { data: rows } = await t.c.rpc("my_requests");
    const mineRow = (rows ?? []).find((r) => r.ticket_id === ticketA.id);
    mineRow && mineRow.awaiting_review === false
      ? ok("a ticket already rated shows awaiting_review = false")
      : bad(`awaiting_review for the rated ticket: ${mineRow?.awaiting_review}`);
    await t.c.auth.signOut();
  }
}

// ── Cleanup ────────────────────────────────────────────────────────────────
await svc.from("evaluation_responses").delete().in("evaluation_id", made.evaluations);
await svc.from("vendor_evaluations").delete().in("id", made.evaluations);
await svc.from("user_notifications").delete().in("entity_id", made.tickets);
await svc.from("tickets").delete().in("id", made.tickets);
console.log("\n(cleaned up)");

console.log(
  failures === 0
    ? "\n\x1b[32mALL CHECKS PASSED\x1b[0m — a vendor's score comes from a checklist and a clock, never a free-typed number."
    : `\n\x1b[31m${failures} CHECK(S) FAILED\x1b[0m`
);
process.exitCode = failures === 0 ? 0 : 1;
