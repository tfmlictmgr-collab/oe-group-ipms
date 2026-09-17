// Throwaway: removes one row from the _migrations ledger on a named world so a
// migration written minutes ago and applied only to staging can be corrected
// and re-applied. Never used against a world anyone else depends on.
import path from "node:path";
import { config } from "dotenv";
import pg from "pg";

const world = process.argv[3] ?? "staging";
config({ path: path.join("C:/projects/oe-group-ipms", `.env.${world}.local`) });

const c = new pg.Client({
  host: process.env.SUPABASE_DB_HOST,
  port: Number(process.env.SUPABASE_DB_PORT || 5432),
  database: process.env.SUPABASE_DB_NAME,
  user: process.env.SUPABASE_DB_USER,
  password: process.env.SUPABASE_DB_PASSWORD,
  ssl: { rejectUnauthorized: false },
});
await c.connect();
const r = await c.query(`delete from _migrations where name = $1`, [process.argv[2]]);
console.log(`removed ${r.rowCount} ledger row(s) for ${process.argv[2]} on ${world}`);
await c.end();
