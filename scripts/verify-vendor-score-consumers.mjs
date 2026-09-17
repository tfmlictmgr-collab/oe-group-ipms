// Audit 0805-H2 — the payment gate and BI vendor-performance figure now read
// vendor_evaluation_tickets, never the raw vendor_evaluations.composite_score
// generated column directly.
//
// That generated column was written for the pre-0104 model: one row, all
// five dimensions filled in at once. 0104's dual-source design instead writes
// TWO half-populated rows per ticket (fm_pm: quality/response/completion/
// compliance; tenant: satisfaction only), and the generated column COALESCEs
// whichever half a row doesn't carry to zero — so each half-row's own
// composite_score is a structurally undercounted number, not an honest
// partial one. This suite proves it with the audit's own worked numbers: a
// genuinely perfect job (100 on every dimension, via the correct view) whose
// two RAW rows generate 80 and 20 — averaging those wrongly pulls a perfect
// vendor to 50, well under any sane payment threshold.
//
// Usage: node scripts/verify-vendor-score-consumers.mjs
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";
import { createClient } from "@supabase/supabase-js";

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
config({ path: path.join(rootDir, ".env.local") });

const svc = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);

let failures = 0;
const ok = (m) => console.log(`  \x1b[32mPASS\x1b[0m ${m}`);
const bad = (m) => { failures++; console.log(`  \x1b[31mFAIL\x1b[0m ${m}`); };

// The REAL function both consumers use — imported, not reimplemented, so this
// suite exercises the actual code path rather than a copy of its logic.
const { averageComposite } = await import("../lib/vendor-score.ts");

const MARK = "PROBEH2";
const stamp = Date.now().toString(36).toUpperCase().slice(-5);

// Start-of-run sweep.
{
  const { data: strays } = await svc.from("vendors").select("id").like("name", `${MARK}%`);
  if (strays?.length) {
    const ids = strays.map((s) => s.id);
    await svc.from("vendor_evaluations").delete().in("vendor_id", ids);
    await svc.from("tickets").delete().eq("assigned_vendor_id", ids[0]).like("message_text", `${MARK}%`);
    await svc.from("vendors").delete().in("id", ids);
    console.log(`(swept ${strays.length} stray vendor(s) left by an earlier run)`);
  }
}

const { data: poc, error: pocErr } = await svc.from("orgs").select("id").eq("slug", "oe-group-foundation-poc").single();
if (pocErr) throw new Error(`could not load the POC org: ${pocErr.message}`);
const { data: tenant, error: tenantErr } = await svc.from("users").select("id")
  .eq("email", "oe-group-foundation-poc.tenant@oegroup.test").single();
if (tenantErr) throw new Error(`could not load the fixture tenant: ${tenantErr.message}`);

const made = { vendors: [], tickets: [] };

async function makeVendor(suffix) {
  const { data, error } = await svc.from("vendors").insert({
    org_id: poc.id, name: `${MARK}-${stamp}-${suffix}`, service_category: "cleaning", status: "active",
  }).select("id").single();
  if (error) throw new Error(`fixture vendor: ${error.message}`);
  made.vendors.push(data.id);
  return data.id;
}

async function makeResolvedTicket(vendorId, suffix) {
  const { data, error } = await svc.from("tickets").insert({
    org_id: poc.id, channel: "portal", sender_id: tenant.id, assigned_vendor_id: vendorId,
    message_text: `${MARK}-${stamp}-${suffix}`, category: "maintenance", urgency: "normal",
    status: "resolved", resolved_at: new Date().toISOString(),
  }).select("id").single();
  if (error) throw new Error(`fixture ticket: ${error.message}`);
  made.tickets.push(data.id);
  return data.id;
}

/** Bypasses submit_vendor_evaluation() deliberately — service role only, to
 * write exact known numbers for a deterministic math check. The write path
 * itself (only the RPC may write as an authenticated user) is proven shut in
 * verify-vendor-evaluation.mjs section F; this suite is about what happens to
 * a row once it exists, not about how it got there. */
async function writeEval(ticketId, vendorId, source, scores) {
  const { error } = await svc.from("vendor_evaluations").insert({
    org_id: poc.id, vendor_id: vendorId, ticket_id: ticketId, source, ...scores,
  });
  if (error) throw new Error(`fixture evaluation: ${error.message}`);
}

console.log("Vendor score consumers — reading the paired view, not the raw half-rows\n");

console.log("A. A genuinely perfect job: the raw rows undercount it, the view does not");
{
  const vendorId = await makeVendor("perfect");
  const ticketId = await makeResolvedTicket(vendorId, "perfect");
  await writeEval(ticketId, vendorId, "fm_pm", {
    quality_score: 100, response_score: 100, completion_score: 100, compliance_score: 100,
  });
  await writeEval(ticketId, vendorId, "tenant", { satisfaction_score: 100 });

  const { data: raw } = await svc.from("vendor_evaluations")
    .select("composite_score").eq("vendor_id", vendorId);
  const rawScores = (raw ?? []).map((r) => Number(r.composite_score)).sort((a, b) => a - b);
  JSON.stringify(rawScores) === JSON.stringify([20, 80])
    ? ok(`the two RAW rows generate ${rawScores.join(" and ")} — confirmed undercounted, matching the audit's own worked example`)
    : bad(`expected the raw rows to be [20, 80], got ${JSON.stringify(rawScores)}`);

  const oldStyleAverage = averageComposite(raw ?? []);
  Math.abs(oldStyleAverage - 50) < 0.01
    ? ok(`the OLD query's own math: averaging those raw rows = ${oldStyleAverage} — a perfect vendor reading as barely half`)
    : bad(`expected the old-style average to be 50, got ${oldStyleAverage}`);

  const { data: paired } = await svc.from("vendor_evaluation_tickets")
    .select("composite_score, awaiting_tenant, awaiting_fm_pm").eq("vendor_id", vendorId);
  (paired ?? []).length === 1 && Number(paired[0].composite_score) === 100
    ? ok("the PAIRED view computes the correct composite once — 100, the actual AURA-weighted figure")
    : bad(`expected one paired row at composite_score 100, got ${JSON.stringify(paired)}`);

  const newStyleAverage = averageComposite(paired ?? []);
  newStyleAverage === 100
    ? ok(`runPerformanceCheck's own query, fed through its own averageComposite(): ${newStyleAverage} — correct`)
    : bad(`expected the new-style average to be 100, got ${newStyleAverage}`);
}

console.log("\nB. A half-submitted pair contributes NOTHING to the average — not a corrupted partial number");
{
  const vendorId = await makeVendor("half");
  const ticketA = await makeResolvedTicket(vendorId, "half-a");
  const ticketB = await makeResolvedTicket(vendorId, "half-b");
  // A completed pair (composite 100) AND a job still awaiting its tenant half.
  await writeEval(ticketA, vendorId, "fm_pm", {
    quality_score: 100, response_score: 100, completion_score: 100, compliance_score: 100,
  });
  await writeEval(ticketA, vendorId, "tenant", { satisfaction_score: 100 });
  await writeEval(ticketB, vendorId, "fm_pm", {
    quality_score: 100, response_score: 100, completion_score: 100, compliance_score: 100,
  });

  const { data: paired } = await svc.from("vendor_evaluation_tickets")
    .select("composite_score, awaiting_tenant").eq("vendor_id", vendorId);
  const pending = (paired ?? []).find((p) => p.awaiting_tenant);
  pending && pending.composite_score === null
    ? ok("the still-pending job's composite is null, not an 80-and-shrinking estimate")
    : bad(`the pending job should have a null composite; got ${JSON.stringify(pending)}`);

  const avg = averageComposite(paired ?? []);
  avg === 100
    ? ok(`averageComposite() over [100, null] = ${avg} — the pending half contributed nothing, not a drag toward 50`)
    : bad(`expected 100 (the pending null discarded), got ${avg}`);
}

console.log("\nC. bi_vendor_scores (the executive/BI figure) reads the same paired view, not the raw table");
{
  const vendorId = await makeVendor("bi");
  const ticketId = await makeResolvedTicket(vendorId, "bi");
  await writeEval(ticketId, vendorId, "fm_pm", {
    quality_score: 100, response_score: 100, completion_score: 100, compliance_score: 100,
  });
  await writeEval(ticketId, vendorId, "tenant", { satisfaction_score: 100 });
  // An unpaired job on the SAME vendor too, to prove it doesn't drag the figure down.
  const unpairedTicket = await makeResolvedTicket(vendorId, "bi-unpaired");
  await writeEval(unpairedTicket, vendorId, "fm_pm", {
    quality_score: 40, response_score: 40, completion_score: 40, compliance_score: 40,
  });

  const { data: bi } = await svc.from("bi_vendor_scores")
    .select("average_score, evaluations").eq("vendor_id", vendorId).maybeSingle();
  bi && Number(bi.average_score) === 100
    ? ok(`bi_vendor_scores reports ${bi.average_score} — the correct paired figure, unpolluted by the unpaired 40/40/40/40 row`)
    : bad(`expected bi_vendor_scores.average_score = 100, got ${JSON.stringify(bi)}`);
  bi && Number(bi.evaluations) === 1
    ? ok(`and counts exactly 1 completed evaluation, not 2 raw rows or a half-finished one`)
    : bad(`expected evaluations = 1, got ${bi?.evaluations}`);
}

console.log("\nD. A vendor with only unpaired evaluations does not appear at all — never a false zero, never a corrupted number");
{
  const vendorId = await makeVendor("unpaired-only");
  const ticketId = await makeResolvedTicket(vendorId, "unpaired-only");
  await writeEval(ticketId, vendorId, "fm_pm", {
    quality_score: 90, response_score: 90, completion_score: 90, compliance_score: 90,
  });

  const { data: bi } = await svc.from("bi_vendor_scores")
    .select("average_score").eq("vendor_id", vendorId).maybeSingle();
  bi === null
    ? ok("no row at all for a vendor with zero COMPLETED pairs — not a misleading 0, not the corrupted raw average")
    : bad(`expected no bi_vendor_scores row, got ${JSON.stringify(bi)}`);
}

console.log("\nE. No SCREEN reads the raw table to average a score — the check this suite was missing");
{
  // ⚠️ Why a source scan sits in a database suite.
  //
  // A–D proved the GATE and BI read the paired view. They passed for weeks
  // while three screens — the payment detail page, the vendors list and the
  // overview — still averaged the raw table, because nothing enumerated the
  // *consumers* this file is named after. The visible result: a vendor the
  // gate scored 94 was rendered "47.0 · Needs improvement" in red directly
  // beneath a green "Performance validation ✓", on the page where someone
  // decides whether to release money.
  //
  // A behavioural test cannot catch that — the wrong number is a perfectly
  // valid query. So the invariant is asserted about the SOURCE: no app file
  // may select composite_score from `vendor_evaluations` unless it is scoped
  // to the legacy pre-0104 rows (`ticket_id is null`), which genuinely carry
  // a complete composite of their own.
  const { readFileSync, readdirSync, statSync } = await import("node:fs");
  const { join } = await import("node:path");

  const walk = (dir) =>
    readdirSync(dir).flatMap((entry) => {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) return walk(full);
      return /\.(ts|tsx)$/.test(entry) ? [full] : [];
    });

  const offenders = [];
  for (const file of [...walk("app"), ...walk("lib")]) {
    const src = readFileSync(file, "utf8");
    if (!src.includes('from("vendor_evaluations")')) continue;
    // Take the statement following each raw-table read and ask whether it
    // pulls composite_score without confining itself to legacy rows.
    for (const chunk of src.split('from("vendor_evaluations")').slice(1)) {
      const stmt = chunk.slice(0, 400);
      const readsComposite = stmt.includes("composite_score");
      const legacyScoped = stmt.includes('.is("ticket_id", null)');
      if (readsComposite && !legacyScoped) offenders.push(file);
    }
  }

  offenders.length === 0
    ? ok("no screen averages the raw half-rows — every score consumer reads the paired view (or is legacy-scoped)")
    : bad(`these read composite_score from the raw table unscoped: ${[...new Set(offenders)].join(", ")}`);
}

// ── Cleanup ────────────────────────────────────────────────────────────────
await svc.from("vendor_evaluations").delete().in("vendor_id", made.vendors);
await svc.from("tickets").delete().in("id", made.tickets);
await svc.from("vendors").delete().in("id", made.vendors);
console.log("\n(cleaned up)");

console.log(
  failures === 0
    ? "\n\x1b[32mALL CHECKS PASSED\x1b[0m — the payment gate and BI read the paired composite, never the undercounted raw half-row."
    : `\n\x1b[31m${failures} CHECK(S) FAILED\x1b[0m`
);
process.exit(failures === 0 ? 0 : 1);
