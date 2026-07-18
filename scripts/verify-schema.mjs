// Verifies Day 1's "Done When" criteria: all tables exist, RLS is enabled,
// and querying with the anon key returns no rows (no session = no access).
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from 'dotenv';
import pg from 'pg';
import { createClient } from '@supabase/supabase-js';

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

await client.connect();

const { rows: tables } = await client.query(`
  select tablename, rowsecurity
  from pg_tables
  where schemaname = 'public'
  order by tablename;
`);
console.log('Tables in public schema:');
for (const t of tables) {
  console.log(`  ${t.tablename} — RLS enabled: ${t.rowsecurity}`);
}

const { rows: policies } = await client.query(`
  select tablename, count(*) as policy_count
  from pg_policies
  where schemaname = 'public'
  group by tablename
  order by tablename;
`);
console.log('\nPolicy counts:');
for (const p of policies) {
  console.log(`  ${p.tablename}: ${p.policy_count} polic${p.policy_count == 1 ? 'y' : 'ies'}`);
}

await client.end();

console.log('\nQuerying `tickets` with the anon key (no session)...');
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
);
const { data, error } = await supabase.from('tickets').select('*');
if (error) {
  console.log(`  Query returned an error (also acceptable): ${error.message}`);
} else {
  console.log(`  Rows returned: ${data.length} (expected: 0)`);
}
