// Read-only pre-flight for the rc10 migrations that rebuild live objects by
// exactly-once text swaps (0329 to 0332). For a world, it reads each target's
// LIVE definition and counts every anchor those files will look for. A count
// other than 1 is exactly where `migrate` would refuse, found before it runs.
//
// Written 10 Oct 2026, when 0329's swap refused on production although it had
// matched on dev and staging: a function body is stored verbatim, so its layout
// is whatever the file that last wrote it on THAT world looked like.
//
// Writes nothing. Usage: node scripts/preflight-pending-swaps.mjs --world prod
import { readFileSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";
import pg from "pg";

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const wi = process.argv.indexOf("--world");
const world = wi > -1 ? process.argv[wi + 1] : null;
if (!world) { console.error("--world dev | staging | prod"); process.exit(1); }
const envPath = path.join(rootDir, `.env.${world}.local`);
if (!existsSync(envPath)) { console.error(`Missing .env.${world}.local`); process.exit(1); }
const env = {};
config({ path: envPath, processEnv: env, quiet: true });

const dir = path.join(rootDir, "supabase", "migrations");
const file = (prefix) => {
  const name = readdirSync(dir).find((f) => f.startsWith(prefix));
  return readFileSync(path.join(dir, name), "utf8").replace(/\r/g, "");
};

// ── The anchors, read from the migration files themselves ──────────────────
const checks = [];
{
  const s = file("0329_");
  const o = /o text := \$o\$([\s\S]*?)\$o\$;/.exec(s)[1];
  checks.push({ mig: "0329", kind: "function", target: "public.guard_sc_budget_update()", anchor: o });
}
{
  const s = file("0330_");
  for (const m of s.matchAll(/swap_fn\('([^']+)'::regprocedure,\s*\$o\$([\s\S]*?)\$o\$/g)) {
    checks.push({ mig: "0330", kind: "function", target: m[1], anchor: m[2] });
  }
}
{
  const s = file("0331_");
  const tables = {
    tenant_applications_staff_select: "public.tenant_applications",
    application_document_findings_select: "public.application_document_findings",
  };
  for (const m of s.matchAll(/swap_once\('(\w+)',\s*(q|pg_get_viewdef\('([^']+)'::regclass\)),\s*'([^']+)'/g)) {
    checks.push(m[2] === "q"
      ? { mig: "0331", kind: "policy", target: m[1], table: tables[m[1]], anchor: m[4] }
      : { mig: "0331", kind: "view", target: m[3], anchor: m[4] });
  }
  checks.push({ mig: "0331", kind: "storage", target: "staff read their org documents", must: "application-documents" });
  checks.push({ mig: "0331", kind: "storage", target: "vendor documents readable within the org", must: "vendor-documents" });
}
{
  const s = file("0332_");
  const o = /o text := \$o\$([\s\S]*?)\$o\$;/.exec(s)[1];
  checks.push({ mig: "0332", kind: "function", target: "public.retire_service_charges_for_regenerate(uuid)", anchor: o });
}

// ── Count them against the live catalogue ──────────────────────────────────
const c = new pg.Client({
  host: env.SUPABASE_DB_HOST, port: Number(env.SUPABASE_DB_PORT || 5432),
  database: env.SUPABASE_DB_NAME, user: env.SUPABASE_DB_USER,
  password: env.SUPABASE_DB_PASSWORD, ssl: { rejectUnauthorized: false },
});
await c.connect();
await c.query("set session characteristics as transaction read only");

const count = (hay, needle) => (hay.length - hay.split(needle).join("").length) / needle.length;
const show = (hay, needle) => {
  // The live lines around the anchor's first non-blank line, whitespace visible.
  const key = needle.split("\n").map((l) => l.trim()).find(Boolean);
  const lines = hay.split("\n");
  const i = lines.findIndex((l) => l.includes(key));
  if (i < 0) return `      (no live line contains ${JSON.stringify(key)})`;
  return lines.slice(Math.max(0, i - 2), i + 4).map((l) => "      live: " + JSON.stringify(l)).join("\n")
    + "\n" + needle.split("\n").map((l) => "      want: " + JSON.stringify(l)).join("\n");
};

let bad = 0;
console.log(`Pre-flight of 0329-0332's swaps on ${world}\n`);
for (const k of checks) {
  let live = null;
  if (k.kind === "function") {
    live = (await c.query("select replace(pg_get_functiondef($1::regprocedure), E'\\r', '') d", [k.target])).rows[0]?.d;
  } else if (k.kind === "policy") {
    live = (await c.query("select pg_get_expr(polqual, polrelid) d from pg_policy where polrelid = $1::regclass and polname = $2", [k.table, k.target])).rows[0]?.d;
  } else if (k.kind === "view") {
    live = (await c.query("select pg_get_viewdef($1::regclass) d", [k.target])).rows[0]?.d;
  } else if (k.kind === "storage") {
    live = (await c.query("select pg_get_expr(polqual, polrelid) d from pg_policy where polrelid = 'storage.objects'::regclass and polname = $1", [k.target])).rows[0]?.d;
    const okk = live && live.includes(k.must) && !live.includes("storage_path");
    console.log(`${okk ? "OK  " : "FAIL"} ${k.mig} storage policy "${k.target}"${okk ? "" : live ? " (changed already, or no bucket name)" : " (missing)"}`);
    if (!okk) bad++;
    continue;
  }
  if (live == null) { console.log(`FAIL ${k.mig} ${k.kind} ${k.target}: not found`); bad++; continue; }
  const n = count(live, k.anchor);
  const label = `${k.mig} ${k.kind} ${k.target}: "${k.anchor.split("\n").map((l) => l.trim()).find(Boolean).slice(0, 60)}"`;
  if (n === 1) console.log(`OK   ${label}`);
  else { bad++; console.log(`FAIL ${label} found ${n} time(s)\n${show(live, k.anchor)}`); }
}
await c.end();
console.log(bad ? `\n${bad} anchor(s) would refuse on ${world}.` : `\nEvery anchor matches exactly once on ${world}.`);
process.exit(bad ? 1 : 0);
