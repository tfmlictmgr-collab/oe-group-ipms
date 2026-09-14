// Every function's ACTUAL execute grants, checked against what its migration
// said it was granting.
//
// ⚠️ This exists because that gap was invisible for the entire build. Every
// migration used:
//
//     revoke all on function f(...) from public;
//     grant execute on function f(...) to service_role;
//
// and every one of them was wrong in the same way. `PUBLIC` is the pseudo-role
// meaning "everyone by default"; Supabase's default privileges write EXPLICIT
// grants to `anon` and `authenticated` at creation time, and revoking from
// PUBLIC does not touch those. The revoke ran, succeeded, and removed nothing.
// 101 of 103 SECURITY DEFINER functions were callable by anon — including
// `record_collection`, which has no auth check of its own because it was
// never supposed to need one.
//
// Nothing in the codebase could have caught that by reading the SQL: the SQL
// was right about its intent and wrong about its effect. Only the live grant
// tells the truth, so that is what this compares.
//
// Usage: node scripts/verify-function-grants.mjs
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";
import pg from "pg";

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
config({ path: path.join(rootDir, ".env.local") });

let failures = 0;
const ok = (m) => console.log(`  \x1b[32mPASS\x1b[0m ${m}`);
const bad = (m) => { failures++; console.log(`  \x1b[31mFAIL\x1b[0m ${m}`); };

// ── What the migrations SAY each function should be granted ────────────────
const migrationsDir = path.join(rootDir, "supabase", "migrations");
const intent = new Map();
for (const file of fs.readdirSync(migrationsDir).filter((f) => f.endsWith(".sql"))) {
  const sql = fs.readFileSync(path.join(migrationsDir, file), "utf8");
  const re = /grant\s+execute\s+on\s+function\s+([a-z_0-9]+)\s*\([^)]*\)\s+to\s+([a-z_,\s]+?)\s*;/gi;
  let m;
  while ((m = re.exec(sql))) {
    const name = m[1].toLowerCase();
    if (!intent.has(name)) intent.set(name, new Set());
    for (const role of m[2].toLowerCase().split(",").map((s) => s.trim()).filter(Boolean)) {
      intent.get(name).add(role);
    }
  }
}

const client = new pg.Client({
  host: process.env.SUPABASE_DB_HOST,
  port: Number(process.env.SUPABASE_DB_PORT || 5432),
  database: process.env.SUPABASE_DB_NAME,
  user: process.env.SUPABASE_DB_USER,
  password: process.env.SUPABASE_DB_PASSWORD,
  ssl: { rejectUnauthorized: false },
});
await client.connect();

const { rows } = await client.query(`
  select p.proname,
         pg_get_function_identity_arguments(p.oid) as args,
         p.prosecdef,
         has_function_privilege('anon', p.oid, 'EXECUTE') as anon_can,
         has_function_privilege('authenticated', p.oid, 'EXECUTE') as auth_can
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.prokind = 'f'
   order by p.proname
`);

console.log("Function execute grants — what is granted vs what was declared\n");

console.log("A. No function is reachable by a role its migration never granted it to");
{
  const over = [];
  for (const r of rows) {
    const want = intent.get(r.proname);
    if (!want) continue; // no declared grant: extension internals and triggers
    if (r.anon_can && !want.has("anon")) over.push(`${r.proname} → anon`);
    if (r.auth_can && !want.has("authenticated")) over.push(`${r.proname} → authenticated`);
  }
  over.length === 0
    ? ok(`all ${intent.size} declared functions match their migrations exactly`)
    : bad(`${over.length} over-granted: ${over.slice(0, 8).join(", ")}${over.length > 8 ? " …" : ""}`);
}

console.log("\nB. The functions that were provably exploitable are closed");
{
  // Each of these was reached by an anonymous caller before 0114.
  // `append_reporter_message` actually wrote a row.
  for (const name of [
    "record_collection", "record_remittance_sent", "claim_remittance_for_sending",
    "append_reporter_message", "resolve_chat_sender", "conversation_context",
    "conversation_transcript", "remember_conversation",
  ]) {
    const r = rows.find((x) => x.proname === name);
    if (!r) { bad(`${name} not found`); continue; }
    !r.anon_can && !r.auth_can
      ? ok(`${name} — service_role only, as its migration always claimed`)
      : bad(`${name} STILL reachable (anon=${r.anon_can} authenticated=${r.auth_can})`);
  }
}

console.log("\nC. The public flows that SHOULD be anonymous still are");
{
  // The other half of the risk: an over-broad fix would silently break
  // tenancy applications and invitation acceptance, which are anonymous by
  // design and would fail only when a real applicant tried to use them.
  for (const name of [
    "org_public_branding", "start_tenant_application", "resume_application",
    "save_application_draft", "submit_tenant_application", "invitation_preview",
    "org_branding_by_host", "confirm_vendor_application_email",
  ]) {
    const r = rows.find((x) => x.proname === name);
    if (!r) { bad(`${name} not found`); continue; }
    r.anon_can
      ? ok(`${name} — still anonymous, as the public flow requires`)
      : bad(`${name} WAS REVOKED TOO FAR — a real applicant would be refused`);
  }
}

console.log("\nD. A signed-in user still has what the app needs");
{
  for (const name of ["my_requests", "my_tenancies", "my_rent_charges", "has_permission", "submit_vendor_evaluation"]) {
    const r = rows.find((x) => x.proname === name);
    if (!r) { bad(`${name} not found`); continue; }
    r.auth_can
      ? ok(`${name} — reachable by a signed-in user`)
      : bad(`${name} lost its authenticated grant — the app will break`);
  }
}

await client.end();

console.log(
  failures === 0
    ? "\n\x1b[32mALL CHECKS PASSED\x1b[0m — a function is reachable by exactly the roles its migration granted, no more."
    : `\n\x1b[31m${failures} CHECK(S) FAILED\x1b[0m`
);
process.exit(failures === 0 ? 0 : 1);
