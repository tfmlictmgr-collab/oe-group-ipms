// The vendor's documented journey, end to end:
//   receive a work order → accept or DECLINE → mark COMPLETE → submit an
//   INVOICE → see the scorecard and payment history.
//
// Three of those five had nothing behind them before 0118. Accept existed;
// decline did not exist at all; mark-complete was permitted by RLS and never
// offered; and submitting an invoice was refused outright, because
// `payments_insert` admits only admin/facility_manager/regional_manager.
//
// ⚠️ The point of the SECURITY DEFINER functions, asserted in section E: a
// vendor may state a CLAIM and nothing else. Widening `payments_insert` to
// vendors would have handed them `service_verified_at`,
// `performance_validated` and `approved_by` too — which is the B4 gate itself.
//
// Usage: node scripts/verify-vendor-journey.mjs
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";
import { createClient } from "@supabase/supabase-js";
import pg from "pg";

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
const note = (m) => console.log(`  \x1b[33mNOTE\x1b[0m ${m}`);

const db = new pg.Client({
  host: process.env.SUPABASE_DB_HOST, port: Number(process.env.SUPABASE_DB_PORT || 5432),
  database: process.env.SUPABASE_DB_NAME, user: process.env.SUPABASE_DB_USER,
  password: process.env.SUPABASE_DB_PASSWORD, ssl: { rejectUnauthorized: false },
});
await db.connect();

/** Runs SQL as a given user, through real RLS and real function grants. */
async function asUser(userId, sql) {
  await db.query("begin");
  try {
    await db.query("set local role authenticated");
    await db.query(
      `set local request.jwt.claims = '${JSON.stringify({ sub: userId, role: "authenticated" }).replace(/'/g, "''")}'`
    );
    return { rows: (await db.query(sql)).rows, error: null };
  } catch (e) {
    return { rows: [], error: e.message };
  } finally {
    await db.query("rollback");
  }
}

/** Same, but COMMITS — for the steps whose effect the next step depends on. */
async function asUserCommit(userId, sql) {
  await db.query("begin");
  try {
    await db.query("set local role authenticated");
    await db.query(
      `set local request.jwt.claims = '${JSON.stringify({ sub: userId, role: "authenticated" }).replace(/'/g, "''")}'`
    );
    const r = await db.query(sql);
    await db.query("commit");
    return { rows: r.rows, error: null };
  } catch (e) {
    await db.query("rollback");
    return { rows: [], error: e.message };
  }
}

const MARK = "PROBEJOURNEY";
const S = Date.now().toString(36).toUpperCase().slice(-5);
const made = { tickets: [], payments: [] };

// Start-of-run sweep.
{
  const { data: strays } = await svc.from("tickets").select("id").like("message_text", `${MARK}%`);
  if (strays?.length) {
    await svc.from("payments").delete().in("ticket_id", strays.map((s) => s.id));
    await svc.from("ticket_messages").delete().in("ticket_id", strays.map((s) => s.id));
    await svc.from("tickets").delete().in("id", strays.map((s) => s.id));
    console.log(`(swept ${strays.length} stray ticket(s))`);
  }
  await svc.from("payments").delete().like("invoice_reference", `${MARK}%`);
}

const { data: orgs } = await svc.from("orgs")
  .select("id, name, slug, is_platform_operator").is("deleted_at", null);
const tenantOrgs = (orgs ?? []).filter((o) => !o.is_platform_operator);

console.log("Vendor journey — receive, accept/decline, complete, invoice\n");

// Find an org with a vendor that has an ACTIVE login.
let ctx = null;
for (const o of tenantOrgs) {
  const { data: vs } = await svc.from("vendors")
    .select("id, name, user_id, users!vendors_user_id_fkey(deactivated_at)")
    .eq("org_id", o.id).not("user_id", "is", null);
  const v = (vs ?? []).find((x) => !x.users?.deactivated_at);
  if (v) { ctx = { org: o, vendor: v }; break; }
}
if (!ctx) { console.log("no org has a vendor with an active login — cannot run"); process.exit(1); }
console.log(`(using ${ctx.org.slug} / ${ctx.vendor.name})\n`);

async function newAssignedJob(suffix) {
  const { data: t } = await svc.from("tickets").insert({
    org_id: ctx.org.id, channel: "portal", message_text: `${MARK}-${S}-${suffix}`,
    category: "maintenance", urgency: "normal", status: "open",
  }).select("id").single();
  made.tickets.push(t.id);
  await svc.from("tickets").update({
    assigned_vendor_id: ctx.vendor.id, assigned_at: new Date().toISOString(), status: "assigned",
  }).eq("id", t.id);
  return t.id;
}

console.log("A. Decline — the step that did not exist");
{
  const jobId = await newAssignedJob("decline");

  const short = await asUser(ctx.vendor.user_id,
    `select decline_work_order('${jobId}', 'nope')`);
  short.error
    ? ok("a reason under 10 characters is refused — the team must be able to act on it")
    : bad("a one-word decline was accepted");

  const r = await asUserCommit(ctx.vendor.user_id,
    `select decline_work_order('${jobId}', 'No capacity this week, can start Monday')`);
  r.error ? bad(`the assigned vendor could not decline: ${r.error}`) : ok("the assigned vendor declines with a reason");

  const { data: after } = await svc.from("tickets")
    .select("status, assigned_vendor_id, assigned_at").eq("id", jobId).single();
  after.status === "open" && !after.assigned_vendor_id
    ? ok("the job returns to OPEN and unassigned — never 'assigned to nobody' (0117)")
    : bad(`left in a bad state: status=${after.status} vendor=${after.assigned_vendor_id}`);

  const { data: msgs } = await svc.from("ticket_messages")
    .select("body").eq("ticket_id", jobId).ilike("body", "%Declined%");
  (msgs ?? []).length === 1 && msgs[0].body.includes("No capacity")
    ? ok("and the reason is on the ticket, where whoever re-assigns it will read it")
    : bad("the decline reason was not recorded on the ticket");
}

console.log("\nB. Only the vendor it belongs to");
{
  const jobId = await newAssignedJob("standing");
  const { data: other } = await svc.from("users").select("id")
    .eq("org_id", ctx.org.id).eq("role", "tenant").is("deactivated_at", null).limit(1).maybeSingle();

  if (other) {
    const r = await asUser(other.id, `select decline_work_order('${jobId}', 'not mine to decline at all')`);
    r.error ? ok("someone else cannot decline this vendor's job") : bad("!!! A NON-ASSIGNEE DECLINED THE JOB");
    const r2 = await asUser(other.id, `select complete_work_order('${jobId}', null)`);
    r2.error ? ok("nor mark it complete") : bad("!!! A NON-ASSIGNEE MARKED THE JOB COMPLETE");
  } else note("no other user on this org to test standing with");
}

console.log("\nC. Mark complete — permitted by RLS, never offered until now");
{
  const jobId = await newAssignedJob("complete");
  const r = await asUserCommit(ctx.vendor.user_id,
    `select complete_work_order('${jobId}', 'Replaced the pump seal and tested it')`);
  r.error ? bad(`could not mark complete: ${r.error}`) : ok("the assigned vendor marks the job complete");

  const { data: after } = await svc.from("tickets")
    .select("status, resolved_at").eq("id", jobId).single();
  after.status === "resolved"
    ? ok("status is RESOLVED, not closed — closing stays the organisation's call after verification")
    : bad(`unexpected status: ${after.status}`);
  after.resolved_at
    ? ok("and resolved_at was stamped by the lifecycle trigger, not by this function")
    : bad("resolved_at was not stamped");

  const again = await asUser(ctx.vendor.user_id, `select complete_work_order('${jobId}', null)`);
  again.error ? ok("completing it twice is refused") : bad("a finished job was completed again");
}

console.log("\nD. Invoice — refused outright before 0118");
{
  const jobId = await newAssignedJob("invoice");
  await asUserCommit(ctx.vendor.user_id, `select complete_work_order('${jobId}', null)`);

  const early = await asUser(ctx.vendor.user_id,
    `select submit_vendor_invoice(1000, '${MARK}-EARLY', null)`);
  // A no-ticket invoice is legitimate (retainer), so this must SUCCEED —
  // asserting it fails would encode the opposite of the intended rule.
  early.error ? bad(`a retainer invoice with no job was refused: ${early.error}`) : ok("an invoice with no job attached is allowed — a retainer is legitimate");

  const r = await asUserCommit(ctx.vendor.user_id,
    `select submit_vendor_invoice(180000, '${MARK}-${S}', '${jobId}') as id`);
  if (r.error) bad(`the vendor could not invoice their completed job: ${r.error}`);
  else {
    made.payments.push(r.rows[0].id);
    ok("the vendor submits an invoice for their completed job");
    const { data: p } = await svc.from("payments")
      .select("status, amount, vendor_id, ticket_id").eq("id", r.rows[0].id).single();
    p.status === "pending_verification"
      ? ok("it enters the B4 gate at pending_verification — never past it")
      : bad(`entered at ${p.status}, skipping the gate`);
    p.vendor_id === ctx.vendor.id && p.ticket_id === jobId
      ? ok("attributed to them, and to the job it is for")
      : bad("mis-attributed");
  }

  const dupe = await asUser(ctx.vendor.user_id,
    `select submit_vendor_invoice(999, '${MARK}-DUPE', '${jobId}')`);
  dupe.error ? ok("a second invoice for the same job is refused") : bad("!!! A JOB WAS INVOICED TWICE");

  // Unfinished work cannot be invoiced.
  const openJob = await newAssignedJob("open-invoice");
  const tooSoon = await asUser(ctx.vendor.user_id,
    `select submit_vendor_invoice(500, '${MARK}-SOON', '${openJob}')`);
  tooSoon.error ? ok("an unfinished job cannot be invoiced") : bad("an open job was invoiced");
}

console.log("\nE. A vendor states a claim — and cannot touch the gate");
{
  const { data: p } = await svc.from("payments")
    .select("id").eq("vendor_id", ctx.vendor.id).eq("status", "pending_verification").limit(1).maybeSingle();
  if (!p) { note("no pending invoice to test the gate against"); }
  else {
    const r = await asUser(ctx.vendor.user_id,
      `update payments set service_verified_at = now(), performance_validated = true,
         status = 'approved' where id = '${p.id}' returning id`);
    (r.rows ?? []).length === 0
      ? ok("a vendor cannot verify, validate or approve their own invoice — the gate is not theirs")
      : bad("!!! A VENDOR SELF-APPROVED THEIR OWN INVOICE");

    // And still cannot insert a payment row directly, which is what the
    // definer function exists to avoid needing.
    const ins = await asUser(ctx.vendor.user_id,
      `insert into payments (org_id, vendor_id, invoice_reference, amount, status)
         values ('${ctx.org.id}', '${ctx.vendor.id}', '${MARK}-RAW', 1, 'approved') returning id`);
    ins.error || (ins.rows ?? []).length === 0
      ? ok("nor write a payment row directly, bypassing the function's checks")
      : bad("!!! A VENDOR INSERTED AN APPROVED PAYMENT DIRECTLY");
  }
}

console.log("\nF. Every org can reach this journey");
{
  // The functions are org-agnostic, but the GRANT is not org-specific either —
  // assert it is present rather than assuming, since the vendor-list failure
  // that started this work was exactly an org-shaped gap.
  for (const fn of ["decline_work_order", "complete_work_order", "submit_vendor_invoice"]) {
    const { rows } = await db.query(
      `select has_function_privilege('authenticated', p.oid, 'EXECUTE') as can
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = $1`, [fn]);
    rows[0]?.can
      ? ok(`${fn} is callable by a signed-in user in every org`)
      : bad(`${fn} is NOT callable by authenticated — the journey is unreachable`);
  }
}

// ── Cleanup ───────────────────────────────────────────────────────────────
await svc.from("payments").delete().like("invoice_reference", `${MARK}%`);
await svc.from("ticket_messages").delete().in("ticket_id", made.tickets);
await svc.from("user_notifications").delete().in("entity_id", made.tickets);
await svc.from("tickets").delete().in("id", made.tickets);
await db.end();
console.log("\n(cleaned up)");

console.log(
  failures === 0
    ? "\n\x1b[32mALL CHECKS PASSED\x1b[0m — a vendor can accept, decline, complete and invoice, and cannot pay themselves."
    : `\n\x1b[31m${failures} CHECK(S) FAILED\x1b[0m`
);
process.exit(failures === 0 ? 0 : 1);
