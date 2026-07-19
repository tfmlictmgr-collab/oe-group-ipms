// Creates (or finds) the single demo org used by the Foundation POC.
// Prints the org id — put it in .env.local / Vercel as DEMO_ORG_ID.
// Usage: node scripts/seed-demo-org.mjs
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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

await client.connect();
try {
  const { rows: existing } = await client.query(
    `select id from orgs where name = 'OE Group — Foundation POC' limit 1;`
  );
  if (existing.length > 0) {
    console.log(`Demo org already exists: ${existing[0].id}`);
  } else {
    const { rows } = await client.query(
      `insert into orgs (name, delivery_brand) values ('OE Group — Foundation POC', 'direct') returning id;`
    );
    console.log(`Demo org created: ${rows[0].id}`);
  }
} finally {
  await client.end();
}
