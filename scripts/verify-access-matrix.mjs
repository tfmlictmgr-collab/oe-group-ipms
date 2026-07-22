// Day 14: full access-matrix verification against the B7 matrix, for all roles
// and all brand orgs, at the RLS layer (the enforced security boundary — the UI
// nav gating sits on top of this). Impersonates each user exactly as PostgREST
// does (role `authenticated` + request JWT claims) and asserts:
//   A. ORG ISOLATION — every row a user can read belongs to their own org.
//      (The critical multi-tenant / cross-brand guarantee.)
//   B. ROLE SCOPING — privileged roles see more than restricted roles in-org.
//   C. CROSS-BRAND — TFML and OEA users read disjoint data.
// Usage: node scripts/verify-access-matrix.mjs
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";
import pg from "pg";

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
config({ path: path.join(rootDir, ".env.local") });

const client = new pg.Client({
  host: process.env.SUPABASE_DB_HOST,
  port: Number(process.env.SUPABASE_DB_PORT || 5432),
  database: process.env.SUPABASE_DB_NAME,
  user: process.env.SUPABASE_DB_USER,
  password: process.env.SUPABASE_DB_PASSWORD,
  ssl: { rejectUnauthorized: false },
});

const TABLES = [
  "tickets",
  "service_charges",
  "payments",
  "vendors",
  "vendor_evaluations",
  "sc_budgets",
  "properties",
  "units",
  "audit_log",
  "notifications",
];

let failures = 0;
const pass = (m) => console.log(`  \x1b[32mPASS\x1b[0m ${m}`);
const fail = (m) => {
  failures++;
  console.log(`  \x1b[31mFAIL\x1b[0m ${m}`);
};

async function asUser(uid, fn) {
  await client.query("begin");
  try {
    await client.query("set local role authenticated");
    await client.query(
      `set local request.jwt.claims = '${JSON.stringify({ sub: uid, role: "authenticated" })}'`
    );
    return await fn();
  } finally {
    await client.query("rollback");
  }
}

await client.connect();
try {
  const { rows: users } = await client.query(`
    select u.id, u.role, u.email, u.org_id, o.name as org_name, o.delivery_brand
    from users u join orgs o on o.id = u.org_id
    order by o.delivery_brand, u.role;`);

  // ── A. ORG ISOLATION ──────────────────────────────────────────────────────
  console.log("A. ORG ISOLATION — every readable row belongs to the caller's org");
  const visibleCounts = {}; // uid -> {table -> count}
  for (const u of users) {
    visibleCounts[u.id] = {};
    let leaked = false;
    for (const table of TABLES) {
      const rows = await asUser(u.id, async () => {
        const r = await client.query(
          `select count(*)::int as n,
                  count(*) filter (where org_id <> $1)::int as foreign
           from ${table}`,
          [u.org_id]
        );
        return r.rows;
      });
      visibleCounts[u.id][table] = rows[0].n;
      if (rows[0].foreign > 0) {
        leaked = true;
        fail(`${u.email} (${u.role}) can read ${rows[0].foreign} ${table} rows from ANOTHER org`);
      }
    }
    if (!leaked) pass(`${u.email.padEnd(24)} (${u.role}) — no cross-org rows in any table`);
  }

  // ── B. ROLE SCOPING (within the POC org) ─────────────────────────────────
  console.log("\nB. ROLE SCOPING — restricted roles see less than admin, in-org");
  const pocUsers = users.filter((u) => u.org_name.includes("Foundation POC"));
  const admin = pocUsers.find((u) => u.role === "admin");
  const tenant = pocUsers.find((u) => u.role === "tenant");
  const vendor = pocUsers.find((u) => u.role === "vendor");
  const finance = pocUsers.find((u) => u.role === "finance_approver");

  if (admin && tenant) {
    const a = visibleCounts[admin.id].tickets;
    const t = visibleCounts[tenant.id].tickets;
    t < a ? pass(`tenant sees ${t} tickets < admin ${a}`) : fail(`tenant sees ${t} tickets, admin ${a} (not scoped)`);
    const ta = visibleCounts[tenant.id].payments;
    ta === 0 ? pass(`tenant sees 0 payments`) : fail(`tenant sees ${ta} payments (should be 0)`);
    const taudit = visibleCounts[tenant.id].audit_log;
    // tenant may see own-action audit rows; assert far less than admin
    taudit < visibleCounts[admin.id].audit_log
      ? pass(`tenant audit ${taudit} < admin ${visibleCounts[admin.id].audit_log}`)
      : fail(`tenant audit not scoped`);
  }
  if (admin && vendor) {
    const v = visibleCounts[vendor.id].vendors;
    v <= 1 ? pass(`vendor sees ${v} vendor record(s) (own only)`) : fail(`vendor sees ${v} vendors (should be own only)`);
    const vsc = visibleCounts[vendor.id].service_charges;
    vsc === 0 ? pass(`vendor sees 0 service charges`) : fail(`vendor sees ${vsc} SC rows (should be 0)`);
  }
  if (finance && admin) {
    const f = visibleCounts[finance.id].payments;
    const a = visibleCounts[admin.id].payments;
    f === a ? pass(`finance sees all ${f} payments (= admin)`) : fail(`finance payments ${f} != admin ${a}`);
  }

  // Property scoping: FM sees managed-property tickets/budgets only; owner sees
  // owned-property only; both strictly less than admin.
  const fm = pocUsers.find((u) => u.role === "facility_manager");
  const owner = pocUsers.find((u) => u.role === "property_owner");
  if (fm && admin) {
    const ft = visibleCounts[fm.id].tickets;
    const at = visibleCounts[admin.id].tickets;
    ft > 0 && ft < at
      ? pass(`FM sees ${ft} tickets (managed properties) < admin ${at}`)
      : fail(`FM tickets ${ft} not property-scoped (admin ${at})`);
    const fb = visibleCounts[fm.id].sc_budgets;
    fb > 0 && fb < visibleCounts[admin.id].sc_budgets
      ? pass(`FM sees ${fb} budgets (managed) < admin ${visibleCounts[admin.id].sc_budgets}`)
      : fail(`FM budgets ${fb} not property-scoped`);
  }
  if (owner && admin) {
    const ot = visibleCounts[owner.id].tickets;
    ot > 0 && ot < visibleCounts[admin.id].tickets
      ? pass(`owner sees ${ot} tickets (owned property) < admin ${visibleCounts[admin.id].tickets}`)
      : fail(`owner tickets ${ot} not property-scoped`);
    const osc = visibleCounts[owner.id].service_charges;
    osc > 0
      ? pass(`owner sees ${osc} SC rows (owned portfolio)`)
      : fail(`owner sees 0 SC rows (portfolio should have data)`);
  }
  // FM sees fewer tickets than... owner+ikoyi? FM (Lekki+Ikoyi) > owner (Lekki).
  if (fm && owner) {
    visibleCounts[fm.id].tickets > visibleCounts[owner.id].tickets
      ? pass(`FM tickets ${visibleCounts[fm.id].tickets} > owner ${visibleCounts[owner.id].tickets} (FM manages more)`)
      : fail(`FM/owner ticket scoping unexpected`);
  }

  // ── C. CROSS-BRAND ────────────────────────────────────────────────────────
  console.log("\nC. CROSS-BRAND — TFML and OEA read disjoint data");
  const tfml = users.find((u) => u.delivery_brand === "TFML");
  const oea = users.find((u) => u.delivery_brand === "OEA");
  if (tfml && oea) {
    // TFML user should see only TFML-org tickets, and none of OEA's.
    const tfmlSees = await asUser(tfml.id, async () =>
      (await client.query(`select org_id from tickets`)).rows.map((r) => r.org_id)
    );
    const oeaSees = await asUser(oea.id, async () =>
      (await client.query(`select org_id from tickets`)).rows.map((r) => r.org_id)
    );
    const tfmlOnlyOwn = tfmlSees.every((o) => o === tfml.org_id);
    const oeaOnlyOwn = oeaSees.every((o) => o === oea.org_id);
    const disjoint = !tfmlSees.some((o) => o === oea.org_id) && !oeaSees.some((o) => o === tfml.org_id);
    tfmlOnlyOwn ? pass(`TFML user reads only TFML tickets (${tfmlSees.length})`) : fail("TFML user reads non-TFML tickets");
    oeaOnlyOwn ? pass(`OEA user reads only OEA tickets (${oeaSees.length})`) : fail("OEA user reads non-OEA tickets");
    disjoint ? pass("TFML and OEA ticket visibility is disjoint") : fail("cross-brand ticket leak");
  } else {
    fail("TFML/OEA brand users not found — run seed-brands.mjs");
  }

  console.log(
    `\n${failures === 0 ? "\x1b[32mALL CHECKS PASSED\x1b[0m" : `\x1b[31m${failures} FAILURE(S)\x1b[0m`}`
  );
} finally {
  await client.end();
}

process.exit(failures === 0 ? 0 : 1);
