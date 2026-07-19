// Migration runner: applies every .sql file in supabase/migrations in filename
// order, skipping any already recorded in the _migrations ledger. Idempotent —
// safe to re-run. Usage: node scripts/migrate.mjs
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
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

const migrationsDir = path.join(rootDir, "supabase", "migrations");
const files = readdirSync(migrationsDir)
  .filter((f) => f.endsWith(".sql"))
  .sort();

await client.connect();
try {
  await client.query(
    `create table if not exists _migrations (name text primary key, applied_at timestamptz not null default now());`
  );

  // Adopt pre-ledger migrations: if the core schema already exists (0001 ran
  // before this ledger did), record 0001/0002 as applied without re-running.
  const { rows: hasOrgs } = await client.query(
    `select to_regclass('public.orgs') is not null as exists;`
  );
  if (hasOrgs[0].exists) {
    await client.query(
      `insert into _migrations (name) values ('0001_init_schema.sql'), ('0002_realtime_tickets.sql') on conflict do nothing;`
    );
  }

  const { rows: applied } = await client.query(`select name from _migrations;`);
  const appliedSet = new Set(applied.map((r) => r.name));

  for (const file of files) {
    if (appliedSet.has(file)) {
      console.log(`Skipping ${file} (already applied).`);
      continue;
    }
    const sql = readFileSync(path.join(migrationsDir, file), "utf8");
    console.log(`Applying ${file}...`);
    await client.query("begin");
    try {
      await client.query(sql);
      await client.query(`insert into _migrations (name) values ($1);`, [file]);
      await client.query("commit");
      console.log(`  done.`);
    } catch (e) {
      await client.query("rollback");
      throw e;
    }
  }
} finally {
  await client.end();
}
