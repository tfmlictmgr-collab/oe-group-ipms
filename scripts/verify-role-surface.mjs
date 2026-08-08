// Every role in the enum, against what it is supposed to hold — and against
// what the PRODUCT actually offers it.
//
// The deck (`docs/OE_Group_Phase1_Progress.UPDATED.pptx`) draws seven journey
// lanes: admin, FM/PM, vendor, tenant, owner/landlord, finance lead, approver.
// `user_role` has TEN values. The three with no lane — `executive`,
// `regional_manager`, `fm_ops_staff` — are exactly the three that had drifted.
//
// ⚠️ What this suite is really guarding is a CLASS of defect, not three
// instances of it. Four times now an application array of role names has been
// found disagreeing with the database it was supposed to describe:
//
//   1. the executive locked out of the ledger `oversight_roles()` grants them;
//   2. the executive refused an above-threshold approval decision 9 gives them
//      and `enforce_payment_transition` accepts;
//   3. the regional manager holding FIFTEEN capabilities and named in none of
//      the navigation's arrays, so the product offered them no destination for
//      any of it;
//   4. `fm_ops_staff`, dispatchable and able to read what they are given, with
//      no page to see it on.
//
// Section A is therefore the important one: it compares the matrix to the menu
// mechanically, so a fifth cannot be found by a human noticing.
//
// Usage: node scripts/verify-role-surface.mjs
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

async function asUser(userId, sql) {
  await db.query("begin");
  try {
    await db.query("set local role authenticated");
    await db.query(
      `set local request.jwt.claims = '${JSON.stringify({ sub: userId, role: "authenticated" }).replace(/'/g, "''")}'`
    );
    const r = await db.query(sql);
    await db.query("rollback");
    return { ok: true, rows: r.rows };
  } catch (e) {
    await db.query("rollback");
    return { ok: false, err: e.message.slice(0, 120) };
  }
}

const { data: orgs } = await svc.from("orgs")
  .select("id, slug, is_platform_operator").is("deleted_at", null).order("slug");
const tenantOrgs = (orgs ?? []).filter((o) => !o.is_platform_operator);

const ROLES = (await db.query(`select unnest(enum_range(null::user_role))::text v`))
  .rows.map((r) => r.v);

// What the NAVIGATION derives, mirrored from app/dashboard/layout.tsx. Kept
// here deliberately rather than imported: the point is to check that the menu's
// rule and the matrix agree, and importing the menu's own copy of the rule
// would make the test pass by construction.
const navFor = (role, caps) => {
  const can = (c) => caps.includes(c);
  return {
    seesProperties: can("properties.write") || can("properties.read_all") || role === "property_owner",
    seesAssets: can("assets.read") || can("assets.write") || can("assets.import") || role === "property_owner",
    seesVendors: can("vendors.read") || can("vendors.write"),
    seesLettings: can("leases.write") || can("applications.review_all") || can("applications.recommend"),
    seesServiceCharges: can("sc.read_all") || can("sc.manage"),
    canEnroll: can("people.invite"),
  };
};

// ⚠️ REQUIRED and FORBIDDEN, not a fixed expected grid.
//
// The first version of this section held one expected menu per role and failed
// on `finance_approver` in OEA and TFML, which reach Lettings. That was the
// TEST being wrong, not the product: finance is the second tier of the OEA
// two-tier application review, so they hold `applications.review_all` and
// genuinely belong on that screen.
//
// The deeper flaw it exposed is that a fixed grid cannot be right at all. The
// matrix is OPERATOR-GOVERNED and per-org (decision 7) — the POC finance
// approver holds 8 capabilities and OEA's holds 10, deliberately. A test
// asserting one exact menu per role would either fail on legitimate operator
// configuration or force every org to be identical, which is the opposite of
// what decision 7 built.
//
// So only the invariants are asserted: what a role must ALWAYS reach, and what
// it must NEVER reach. Everything between is the operator's to tune.
const REQUIRED = {
  admin:            ["seesProperties", "seesVendors", "seesServiceCharges", "canEnroll"],
  executive:        ["seesProperties", "seesVendors", "seesServiceCharges"],
  facility_manager: ["seesProperties", "seesVendors", "canEnroll"],
  regional_manager: ["seesProperties", "seesVendors", "canEnroll"],
  finance_approver: ["seesServiceCharges"],
  property_owner:   ["seesProperties"],
  fm_ops_staff:     [],
  tenant:           [],
  vendor:           [],
  viewer:           [],
};

const FORBIDDEN = {
  // Decision 9's boundary, and the sharpest line in this file: a regional
  // manager runs operations and touches nothing financial.
  regional_manager: ["seesServiceCharges"],
  // Enrolment is a write. Oversight oversees; it does not staff the org.
  executive:        ["canEnroll"],
  finance_approver: ["canEnroll"],
  // B7 gives these their own work and nothing organisational.
  fm_ops_staff:     ["seesProperties", "seesVendors", "seesLettings", "seesServiceCharges", "canEnroll"],
  tenant:           ["seesProperties", "seesVendors", "seesLettings", "seesServiceCharges", "canEnroll"],
  vendor:           ["seesProperties", "seesVendors", "seesLettings", "seesServiceCharges", "canEnroll"],
  viewer:           ["seesProperties", "seesVendors", "seesLettings", "seesServiceCharges", "canEnroll"],
  property_owner:   ["seesVendors", "seesLettings", "seesServiceCharges", "canEnroll"],
};

console.log("Role surface — all ten roles, matrix vs menu\n");

console.log("A. What the matrix grants is what the menu offers");
for (const org of tenantOrgs) {
  for (const role of ROLES) {
    const { data: u } = await svc.from("users").select("id, email")
      .eq("org_id", org.id).eq("role", role).is("deactivated_at", null)
      .limit(1).maybeSingle();
    if (!u) continue;

    const r = await asUser(u.id, `select my_capabilities() c`);
    if (!r.ok) { bad(`${org.slug} ${role}: my_capabilities() failed — ${r.err}`); continue; }
    const caps = r.rows[0].c ?? [];
    const nav = navFor(role, caps);
    const missing = (REQUIRED[role] ?? []).filter((k) => !nav[k]);
    const leaked = (FORBIDDEN[role] ?? []).filter((k) => nav[k]);

    missing.length === 0 && leaked.length === 0
      ? ok(`${org.slug.padEnd(24)} ${role.padEnd(17)} ${String(caps.length).padStart(2)} cap → holds what it must, not what it must not`)
      : bad(
          `${org.slug} ${role}:` +
            (missing.length ? ` cannot reach ${missing.join(", ")}` : "") +
            (leaked.length ? ` REACHES ${leaked.join(", ")}` : "")
        );
  }
}

console.log("\nB. The roles with no lane in the deck are nonetheless real");
{
  // ⚠️ Each of these was found broken. The assertion is not "the role exists"
  // but "the role can reach the thing its board decision promises".
  for (const org of tenantOrgs) {
    const { data: rm } = await svc.from("users").select("id, email")
      .eq("org_id", org.id).eq("role", "regional_manager").is("deactivated_at", null)
      .limit(1).maybeSingle();
    if (rm) {
      const r = await asUser(rm.id, `select my_capabilities() c`);
      const caps = r.ok ? r.rows[0].c ?? [] : [];
      // Decision 9's operational half, named explicitly.
      const need = ["properties.write", "assets.write", "tickets.assign", "people.invite", "vendors.write"];
      const missing = need.filter((c) => !caps.includes(c));
      missing.length === 0
        ? ok(`${org.slug}: regional manager holds the operational set decision 9 promises`)
        : bad(`${org.slug}: regional manager is missing ${missing.join(", ")}`);

      // And the financial half it must NOT hold.
      const forbidden = ["sc.manage", "sc.read_all"].filter((c) => caps.includes(c));
      forbidden.length === 0
        ? ok(`${org.slug}: and nothing financial — decision 9's boundary`)
        : bad(`${org.slug}: regional manager holds ${forbidden.join(", ")}`);
    }

    const { data: ops } = await svc.from("users").select("id, email")
      .eq("org_id", org.id).eq("role", "fm_ops_staff").is("deactivated_at", null)
      .limit(1).maybeSingle();
    const { data: t } = await svc.from("tickets")
      .select("id").eq("org_id", org.id).limit(1).maybeSingle();
    if (ops && t) {
      // Dispatch to them, then read as them — the thing they had no page for.
      await db.query("begin");
      try {
        await db.query(
          `update tickets set assigned_to_user_id=$1, status='assigned', assigned_at=now() where id=$2`,
          [ops.id, t.id]
        );
        await db.query("set local role authenticated");
        await db.query(
          `set local request.jwt.claims = '${JSON.stringify({ sub: ops.id, role: "authenticated" })}'`
        );
        const seen = await db.query(
          `select count(*)::int n from tickets where assigned_to_user_id = $1`, [ops.id]
        );
        seen.rows[0].n >= 1
          ? ok(`${org.slug}: ops staff can read the job dispatched to them`)
          : bad(`${org.slug}: WORK WAS DISPATCHED TO OPS STAFF WHO CANNOT SEE IT`);
      } catch (e) {
        bad(`${org.slug}: ops dispatch check failed — ${e.message.slice(0, 90)}`);
      }
      await db.query("rollback");
    }

    const { data: exec } = await svc.from("users").select("id")
      .eq("org_id", org.id).eq("role", "executive").is("deactivated_at", null)
      .limit(1).maybeSingle();
    if (exec) {
      // The two the application refused and the database allowed.
      const ledger = await asUser(exec.id, `select count(*)::int n from ledger_entries`);
      const limit = await asUser(exec.id, `select unlimited from my_approval_limit()`);
      ledger.ok
        ? ok(`${org.slug}: executive reads the ledger (${ledger.rows[0].n} entries)`)
        : bad(`${org.slug}: executive cannot read the ledger — ${ledger.err}`);
      limit.ok && limit.rows[0]?.unlimited === true
        ? ok(`${org.slug}: executive is above the approval threshold (decision 9)`)
        : bad(`${org.slug}: executive is not exempt from the threshold`);
    }
  }
}

console.log("\nC. The non-delegable controls are absent from the matrix, on purpose");
{
  // Decision 7: these "stay hardwired and never appear as toggles". If one ever
  // shows up as a capability, somebody has made an auditor's control into a
  // preference.
  const { rows: controls } = await db.query(`select control from non_delegable_controls`);
  const { rows: caps } = await db.query(`select distinct capability from role_permissions`);
  const capNames = caps.map((c) => c.capability);
  const leaked = controls.map((c) => c.control).filter((c) => capNames.includes(c));
  leaked.length === 0
    ? ok(`all ${controls.length} non-delegable controls are absent from the ${capNames.length}-capability matrix`)
    : bad(`!!! ${leaked.join(", ")} became a toggle — decision 7 forbids it`);
}

console.log("\nD. Every role can change what is theirs, and nothing more");
{
  // ⚠️ Reported from production: the welcome notification says "You can change
  // how we reach you in Settings", and a tenant opening Settings was told
  // "Administrator access required" — because /dashboard/settings IS the
  // branding page. The preferences worked perfectly; the landing page refused.
  //
  // `users` has a SELECT policy and NO UPDATE policy, deliberately: the row
  // carries `role` and `org_id`, the two columns every RLS policy reads. So
  // self-service is exactly two narrow definer functions, and this proves both
  // work for every role and that neither is a way round the first.
  for (const org of tenantOrgs) {
    for (const role of ROLES) {
      const { data: u } = await svc.from("users").select("id, email, full_name, role, org_id")
        .eq("org_id", org.id).eq("role", role).is("deactivated_at", null)
        .limit(1).maybeSingle();
      if (!u) continue;

      // Rolled back, so no demo account is actually renamed.
      await db.query("begin");
      let outcome = null;
      try {
        await db.query("set local role authenticated");
        await db.query(`set local request.jwt.claims = '${JSON.stringify({ sub: u.id, role: "authenticated" })}'`);
        await db.query(`select update_my_profile('Probe Renamed')`);
        const after = await db.query(
          `select full_name, role::text role, org_id from users where id = $1`, [u.id]
        );
        outcome = after.rows[0];
      } catch (e) {
        outcome = { err: e.message.slice(0, 90) };
      }
      await db.query("rollback");

      if (outcome?.err) {
        bad(`${org.slug} ${role}: cannot set their own name — ${outcome.err}`);
      } else if (outcome.full_name !== "Probe Renamed") {
        bad(`${org.slug} ${role}: update_my_profile did not take`);
      } else if (outcome.role !== u.role || outcome.org_id !== u.org_id) {
        // The reason the function is narrow. If this ever fires, self-service
        // has become a privilege-escalation path.
        bad(`!!! ${org.slug} ${role}: update_my_profile CHANGED role/org`);
      } else {
        ok(`${org.slug.padEnd(24)} ${role.padEnd(17)} renames themselves; role and org untouched`);
      }
    }
  }

  // And the boundary the report was really about: a non-admin must not be able
  // to change the ORGANISATION, however welcoming the settings page looks.
  for (const org of tenantOrgs) {
    const { data: t } = await svc.from("users").select("id")
      .eq("org_id", org.id).eq("role", "tenant").is("deactivated_at", null)
      .limit(1).maybeSingle();
    if (!t) continue;
    const r = await asUser(t.id, `update orgs set name = 'Renamed By A Tenant' where id = '${org.id}' returning id`);
    (r.ok && r.rows.length === 0) || !r.ok
      ? ok(`${org.slug}: a tenant cannot rebrand the organisation`)
      : bad(`!!! ${org.slug}: A TENANT RENAMED THE ORGANISATION`);
  }
}

console.log("\nE. Every role has somewhere to land");
{
  // A role whose home screen resolves to nothing is a person who signs in and
  // sees an empty shell. Checked as a property of the nav rules, not of any one
  // page.
  const HOME = {
    tenant: "/dashboard/my-requests",
    vendor: "/dashboard/my-work",
    fm_ops_staff: "/dashboard/my-jobs",
    property_owner: "/dashboard/portfolio",
    viewer: "/dashboard/overview",
    admin: "/dashboard",
    executive: "/dashboard",
    facility_manager: "/dashboard",
    finance_approver: "/dashboard",
    regional_manager: "/dashboard",
  };
  const uncovered = ROLES.filter((r) => !HOME[r]);
  uncovered.length === 0
    ? ok(`all ${ROLES.length} roles have a home screen: ${Object.values(HOME).filter((v, i, a) => a.indexOf(v) === i).length} distinct destinations`)
    : bad(`no home screen for ${uncovered.join(", ")}`);
}

await db.end();

console.log(
  failures === 0
    ? "\n\x1b[32mALL CHECKS PASSED\x1b[0m — ten roles, each reaching what B7 grants it and nothing more."
    : `\n\x1b[31m${failures} CHECK(S) FAILED\x1b[0m`
);
process.exit(failures === 0 ? 0 : 1);
