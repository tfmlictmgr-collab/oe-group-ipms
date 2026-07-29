// Smoke checks for a DEPLOYED environment, run after migrating.
//
// These assert properties of the schema that no single migration owns, and that
// a partial apply would silently break. Each one exists because a real defect
// or a real audit finding showed the invariant can be lost between migrations
// rather than within one.
//
// Usage: npx tsx scripts/verify-deployment-safety.mjs
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";
import pg from "pg";

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
config({ path: path.join(rootDir, ".env.local") });

let failures = 0;
const ok = (m) => console.log(`  \x1b[32mPASS\x1b[0m ${m}`);
const bad = (m) => { failures++; console.log(`  \x1b[31mFAIL\x1b[0m ${m}`); };

const client = new pg.Client({
  host: process.env.SUPABASE_DB_HOST,
  port: Number(process.env.SUPABASE_DB_PORT || 5432),
  database: process.env.SUPABASE_DB_NAME,
  user: process.env.SUPABASE_DB_USER,
  password: process.env.SUPABASE_DB_PASSWORD,
  ssl: { rejectUnauthorized: false },
});
await client.connect();

console.log("Deployment safety — schema invariants no single migration owns\n");

console.log("A. No matrix-governed table carries a FOR ALL policy");
{
  // D-1: 0051/0052 created write policies as FOR ALL, which also grants SELECT —
  // so holding `*.write` silently re-granted read past the permission matrix.
  // 0055 split them. An environment applied only through 0054 has the leak back,
  // and nothing in the app would show it.
  const { rows } = await client.query(`
    select tablename, policyname from pg_policies
     where schemaname = 'public'
       and cmd = 'ALL'
       and tablename in ('vendors','properties','units','sc_budgets','assets',
                         'service_charges','vendor_evaluations')
     order by tablename`);
  rows.length === 0
    ? ok("no FOR ALL policies on matrix-governed tables")
    : bad(`FOR ALL policy grants SELECT past the matrix: ${rows.map((r) => `${r.tablename}.${r.policyname}`).join(", ")}`);
}

console.log("\nB. Every tenant-scoped table has RLS enabled");
{
  const { rows } = await client.query(`
    select c.relname from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity
       and exists (select 1 from information_schema.columns
                    where table_schema = 'public' and table_name = c.relname
                      and column_name = 'org_id')
     order by c.relname`);
  rows.length === 0
    ? ok("every table carrying org_id has RLS on")
    : bad(`RLS OFF on tenant-scoped table(s): ${rows.map((r) => r.relname).join(", ")}`);
}

console.log("\nC. The payment gate is enforced in the database");
{
  // S-1: the amount threshold was the one gate condition that lived only in a
  // server action, so a direct PATCH bypassed it.
  const { rows } = await client.query(
    `select prosrc from pg_proc where proname = 'enforce_payment_transition'`
  );
  const src = rows[0]?.prosrc ?? "";
  /approval_threshold_amount/.test(src)
    ? ok("the approval threshold is checked in enforce_payment_transition()")
    : bad("the amount threshold is NOT in the trigger — a direct PATCH bypasses it");
  /only finance\/admin may remit/.test(src)
    ? ok("remittance is role-gated in the trigger")
    : bad("the remit role check is missing from the trigger");
}

console.log("\nD. A property reference cannot cross an organisation");
{
  const { rows } = await client.query(`
    select conrelid::regclass::text as tbl from pg_constraint
     where conname in ('units_property_same_org_fk','assets_property_same_org_fk')`);
  rows.length === 2
    ? ok("units and assets both carry the composite org FK")
    : bad(`composite org FK missing on: ${["units","assets"].filter((t) => !rows.some((r) => r.tbl === t)).join(", ") || "one of them"}`);
}

console.log("\nE. Soft-delete is intact and still exempts the service role");
{
  const { rows } = await client.query(
    `select prosrc from pg_proc where proname = 'block_hard_delete'`
  );
  const src = rows[0]?.prosrc ?? "";
  /auth\.uid\(\) is not null/.test(src)
    ? ok("block_hard_delete() exempts the service role")
    : bad("block_hard_delete() raises unconditionally — seeds and cleanup will fail");
}

console.log("\nF. Aggregate views do not fan out");
{
  // property_summary once left-joined units AND assets, multiplying both counts.
  const { rows } = await client.query(`
    select viewname, definition from pg_views
     where schemaname = 'public' and viewname in ('property_summary','bi_financials')`);
  for (const v of rows) {
    /join\s+units[\s\S]*join\s+assets|join\s+assets[\s\S]*join\s+units/i.test(v.definition)
      ? bad(`${v.viewname} joins units AND assets — counts will be multiplied`)
      : ok(`${v.viewname} aggregates without fanning out`);
  }
}

console.log("\nG. Channel credentials are unreachable by any client role");
{
  const { rows } = await client.query(
    `select policyname from pg_policies where schemaname='public' and tablename='channel_routes'`
  );
  rows.length === 0
    ? ok("channel_routes has no client-facing policy")
    : bad(`channel_routes exposes a policy (${rows.map((r) => r.policyname).join(", ")}) — external_id is a webhook credential`);
}

await client.end();

console.log(
  failures === 0
    ? "\n\x1b[32mALL CHECKS PASSED\x1b[0m — safe to point traffic at this environment."
    : `\n\x1b[31m${failures} CHECK(S) FAILED\x1b[0m — do NOT go live until resolved.`
);
process.exit(failures === 0 ? 0 : 1);
