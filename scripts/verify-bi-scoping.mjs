// Verifies B7 role scoping by impersonating each role at the DB level so RLS
// actually applies (the pooler user bypasses RLS, so we switch to the
// `authenticated` role and set the request JWT claims, exactly as PostgREST does).
// Usage: node scripts/verify-bi-scoping.mjs
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

// Mirrors biScope() in app/dashboard/bi/page.tsx
function biScope(role) {
  switch (role) {
    case "admin":
      return "ops + financial + portfolio";
    case "facility_manager":
      return "ops only";
    case "finance_approver":
      return "financial only";
    case "property_owner":
      return "portfolio only";
    default:
      return "NO ACCESS";
  }
}

const TABLES = ["tickets", "service_charges", "payments", "vendors", "sc_budgets", "audit_log"];

await client.connect();
try {
  // ⚠️ ONE user per role, not every account.
  //
  // This walked every active user × 6 tables, each in its own transaction with
  // a role switch — around 1,800 round trips to a pooled remote Postgres. It
  // was tolerable when the demo pool was a handful of accounts; adding 28
  // org-scoped logins pushed it past a 15-minute timeout, and the output was
  // one unreadable row per account.
  //
  // What this suite asserts is that BI figures scope BY ROLE. A second
  // administrator adds a row and proves nothing, so `distinct on (role)` keeps
  // the assertion intact, makes the table readable, and takes seconds.
  const { rows: users } = await client.query(
    `select distinct on (role) id, role, email from users
      where deactivated_at is null      -- retired accounts cannot sign in
      order by role, email;`
  );

  // Ordered for reading: broadest access first, so a narrowing pattern is
  // visible down the column rather than scattered.
  const RANK = {
    admin: 1, facility_manager: 2, regional_manager: 3, finance_approver: 4,
    executive: 5, property_owner: 6, fm_ops_staff: 7, vendor: 8, tenant: 9,
  };
  users.sort((a, b) => (RANK[a.role] ?? 99) - (RANK[b.role] ?? 99));

  const header = ["role".padEnd(18), ...TABLES.map((t) => t.slice(0, 9).padStart(10))].join("");
  console.log(header);
  console.log("-".repeat(header.length));

  for (const u of users) {
    const counts = [];
    for (const table of TABLES) {
      await client.query("begin");
      try {
        await client.query("set local role authenticated");
        await client.query(`set local request.jwt.claims = '${JSON.stringify({ sub: u.id, role: "authenticated" })}'`);
        const { rows } = await client.query(`select count(*)::int as n from ${table}`);
        counts.push(rows[0].n);
      } catch {
        counts.push("err");
      } finally {
        await client.query("rollback");
      }
    }
    console.log(
      u.role.padEnd(18) + counts.map((c) => String(c).padStart(10)).join("")
    );
  }

  console.log("\nBI dashboard widget scope (UI layer, mirrors B7):");
  for (const u of users) {
    console.log(`  ${u.role.padEnd(18)} ${biScope(u.role)}`);
  }
} finally {
  await client.end();
}
