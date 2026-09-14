// Does the workflow each role is promised actually happen — in EVERY org?
//
// Written after a job dispatched to a TFML vendor reached neither their portal
// nor their notifications. The read path was fine; the job had simply never
// been assigned to anybody, and nothing refused that. The lesson generalises:
// the per-feature suites test their own feature deeply, on the seeded demo
// org, and a workflow that is broken only on a real org — or only in the seam
// BETWEEN two features — falls between them.
//
// So this checks the seams, across every live organisation:
//   * can a job be "in hand" with nobody holding it
//   * does the person assigned actually get told
//   * can each role reach the surfaces B7 says it can, and no others
//
// Usage: node scripts/verify-role-workflows.mjs
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

const MARK = "PROBEROLE";
const S = Date.now().toString(36).toUpperCase().slice(-5);
const made = { tickets: [], vendors: [] };

// Reads a table AS a given user, through real RLS.
const db = new pg.Client({
  host: process.env.SUPABASE_DB_HOST,
  port: Number(process.env.SUPABASE_DB_PORT || 5432),
  database: process.env.SUPABASE_DB_NAME,
  user: process.env.SUPABASE_DB_USER,
  password: process.env.SUPABASE_DB_PASSWORD,
  ssl: { rejectUnauthorized: false },
});
await db.connect();

async function asUser(userId, sql) {
  await db.query("begin");
  try {
    await db.query("set local role authenticated");
    await db.query(
      `set local request.jwt.claims = '${JSON.stringify({ sub: userId, role: "authenticated" }).replace(/'/g, "''")}'`
    );
    const r = await db.query(sql);
    return r.rows;
  } finally {
    await db.query("rollback");
  }
}

const { data: allOrgs } = await svc
  .from("orgs")
  .select("id, name, slug, is_platform_operator")
  .is("deleted_at", null)
  .order("name");
// The operator org is excluded from fixture writes: a constraint
// (`operator_org_holds_no_client_data`) forbids client rows in it by design,
// so inserting a ticket there fails for a reason that has nothing to do with
// what this suite is testing. It is still included in the read-boundary
// checks below, where it belongs.
const orgs = allOrgs ?? [];
const tenantOrgs = orgs.filter((o) => !o.is_platform_operator);

console.log("Role workflows — what B7 promises vs what the database does\n");

// ── A. The seam that broke ────────────────────────────────────────────────
console.log("A. A job in hand is in somebody's hand — every org");
{
  let stranded = 0;
  for (const o of orgs) {
    const { data } = await svc
      .from("tickets")
      .select("id, status")
      .eq("org_id", o.id)
      .in("status", ["assigned", "acknowledged", "in_progress"])
      .is("assigned_vendor_id", null)
      .is("assigned_to_user_id", null);
    if (data?.length) {
      stranded += data.length;
      note(`${o.name}: ${data.length} pre-existing — ${data.map((d) => d.id.slice(0, 8).toUpperCase()).join(", ")}`);
    }
  }
  // Historic rows are reported, not failed: 0117 deliberately does not rewrite
  // them (guessing an assignee puts a name against work nobody was told about).
  // What must hold is that NEW ones cannot be created.
  stranded === 0
    ? ok("no request anywhere claims a working status with nobody assigned")
    : note(`${stranded} pre-existing row(s) above — each refuses its next status change until dispatched properly`);

  // The guard itself, tested rather than assumed.
  const o = tenantOrgs[0];
  const { error } = await svc.from("tickets").insert({
    org_id: o.id, channel: "portal", message_text: `${MARK}-${S} unassigned`,
    category: "maintenance", urgency: "normal", status: "assigned",
  });
  error
    ? ok("a NEW request cannot be created as 'assigned' with nobody on it")
    : bad("!!! a new request was created as 'assigned' with no assignee");

  const { data: t, error: mkErr } = await svc.from("tickets").insert({
    org_id: o.id, channel: "portal", message_text: `${MARK}-${S} ok`,
    category: "maintenance", urgency: "normal", status: "open",
  }).select("id").single();
  if (mkErr || !t) {
    bad(`could not create a fixture ticket on ${o.slug}: ${mkErr?.message ?? "no row"}`);
  } else {
    made.tickets.push(t.id);
    const { error: upErr } = await svc.from("tickets").update({ status: "assigned" }).eq("id", t.id);
    upErr
      ? ok("nor can an open one be moved to 'assigned' without one")
      : bad("!!! an open request was moved to 'assigned' with no assignee");
  }
}

// ── B. Being assigned actually tells the person ───────────────────────────
console.log("\nB. The assignee is told — vendor as well as ops staff");
{
  const o = tenantOrgs.find((x) => x.slug === "oe-group-foundation-poc") ?? tenantOrgs[0];
  // ⚠️ The login must be ACTIVE. `notify_user` deliberately declines to notify
  // a deactivated member, so a vendor whose login has been deactivated would
  // fail this section for a correct reason and read as a product bug — which
  // is exactly what the first version of this suite did.
  const { data: candidates } = await svc.from("vendors")
    .select("id, user_id, name, users!vendors_user_id_fkey(deactivated_at)")
    .eq("org_id", o.id).not("user_id", "is", null);
  const vendor = (candidates ?? []).find(
    (v) => !(v.users)?.deactivated_at
  );

  if (!vendor) {
    note("no vendor with an ACTIVE login on this org — cannot test the vendor notification");
  } else {
    const { data: t } = await svc.from("tickets").insert({
      org_id: o.id, channel: "portal", message_text: `${MARK}-${S} notify`,
      category: "maintenance", urgency: "normal", status: "open",
    }).select("id").single();
    made.tickets.push(t.id);

    const before = await svc.from("user_notifications").select("id", { count: "exact", head: true })
      .eq("user_id", vendor.user_id);

    // Exactly what assignTicket does.
    await svc.from("tickets").update({
      assigned_vendor_id: vendor.id, assigned_at: new Date().toISOString(), status: "assigned",
    }).eq("id", t.id);
    await svc.rpc("notify_user", {
      p_user_id: vendor.user_id, p_kind: "assignment",
      p_title: "A job has been assigned to you", p_body: "Open it to acknowledge and get started.",
      p_link: `/dashboard/tickets/${t.id}`, p_entity_type: "ticket", p_entity_id: t.id,
    });

    const after = await svc.from("user_notifications").select("id", { count: "exact", head: true })
      .eq("user_id", vendor.user_id);
    (after.count ?? 0) > (before.count ?? 0)
      ? ok(`the vendor's login receives an in-app notification (${vendor.name})`)
      : bad("A VENDOR IS DISPATCHED A JOB AND TOLD NOTHING — the reported symptom");

    // And they can actually see the job.
    const rows = await asUser(vendor.user_id, `select id from tickets where id = '${t.id}'`);
    rows.length === 1
      ? ok("and the job is visible in their own portal")
      : bad("the assigned vendor CANNOT SEE the job assigned to them");
  }
}

// ── C. Each role reaches what B7 says, in every org ───────────────────────
console.log("\nC. B7 role boundaries hold in every organisation");
{
  // The load-bearing negatives. A tenant must never read the ledger; a vendor
  // must never read another vendor's scorecard or the client-funds position.
  const checks = [
    ["tenant", "ledger_entries", 0, "a tenant reads no ledger entry"],
    ["tenant", "vendors", 0, "a tenant reads no vendor register"],
    ["vendor", "ledger_entries", 0, "a vendor reads no ledger entry"],
    ["fm_ops_staff", "ledger_entries", 0, "ops staff read no ledger entry"],
  ];

  for (const o of orgs) {
    const { data: members } = await svc.from("users")
      .select("id, role").eq("org_id", o.id).is("deactivated_at", null);
    if (!members?.length) continue;

    for (const [role, table, expected, label] of checks) {
      const u = members.find((m) => m.role === role);
      if (!u) continue;
      const rows = await asUser(u.id, `select count(*)::int as n from ${table}`);
      const n = rows[0]?.n ?? 0;
      n === expected
        ? ok(`${o.slug}: ${label}`)
        : bad(`${o.slug}: ${label} — SAW ${n}`);
    }
  }
}

// ── D. A vendor sees only their OWN work ──────────────────────────────────
console.log("\nD. A vendor sees their own jobs and nobody else's");
{
  const o = tenantOrgs.find((x) => x.slug === "oe-group-foundation-poc") ?? tenantOrgs[0];
  const { data: vendors } = await svc.from("vendors").select("id, user_id, name")
    .eq("org_id", o.id).not("user_id", "is", null).limit(2);

  if ((vendors ?? []).length < 2) {
    note("fewer than two vendors with logins on this org — cannot test cross-vendor isolation");
  } else {
    const [a, b] = vendors;
    const { data: t } = await svc.from("tickets").insert({
      org_id: o.id, channel: "portal", message_text: `${MARK}-${S} isolation`,
      category: "maintenance", urgency: "normal", status: "open",
    }).select("id").single();
    made.tickets.push(t.id);
    await svc.from("tickets").update({
      assigned_vendor_id: a.id, assigned_at: new Date().toISOString(), status: "assigned",
    }).eq("id", t.id);

    const seenByA = await asUser(a.user_id, `select id from tickets where id = '${t.id}'`);
    const seenByB = await asUser(b.user_id, `select id from tickets where id = '${t.id}'`);
    seenByA.length === 1
      ? ok(`${a.name} sees the job assigned to them`)
      : bad(`${a.name} cannot see their own assigned job`);
    seenByB.length === 0
      ? ok(`${b.name} does not see another vendor's job`)
      : bad(`!!! ${b.name} SAW ANOTHER VENDOR'S JOB`);
  }
}

// ── Cleanup ───────────────────────────────────────────────────────────────
await svc.from("user_notifications").delete().in("entity_id", made.tickets);
await svc.from("tickets").delete().in("id", made.tickets);
await svc.from("vendors").delete().in("id", made.vendors);
await db.end();
console.log("\n(cleaned up)");

console.log(
  failures === 0
    ? "\n\x1b[32mALL CHECKS PASSED\x1b[0m — a dispatched job has a holder, they are told, and they see only their own."
    : `\n\x1b[31m${failures} CHECK(S) FAILED\x1b[0m`
);
process.exit(failures === 0 ? 0 : 1);
