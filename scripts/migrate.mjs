// One-shot migration runner: applies every .sql file in supabase/migrations,
// in filename order, against the Supabase Postgres instance.
// Usage: node scripts/migrate.mjs
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { config } from 'dotenv';
import pg from 'pg';

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
config({ path: path.join(rootDir, '.env.local') });

const client = new pg.Client({
  host: process.env.SUPABASE_DB_HOST,
  port: Number(process.env.SUPABASE_DB_PORT || 5432),
  database: process.env.SUPABASE_DB_NAME,
  user: process.env.SUPABASE_DB_USER,
  password: process.env.SUPABASE_DB_PASSWORD,
  ssl: { rejectUnauthorized: false },
});

const migrationsDir = path.join(rootDir, 'supabase', 'migrations');
const files = readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort();

await client.connect();
try {
  for (const file of files) {
    const sql = readFileSync(path.join(migrationsDir, file), 'utf8');
    console.log(`Applying ${file}...`);
    await client.query(sql);
    console.log(`  done.`);
  }
} finally {
  await client.end();
}
