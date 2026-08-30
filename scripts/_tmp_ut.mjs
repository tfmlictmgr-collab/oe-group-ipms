import path from "node:path"; import { fileURLToPath } from "node:url";
import { config } from "dotenv"; import pg from "pg";
const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
config({ path: path.join(rootDir, ".env.local") });
const c=new pg.Client({host:process.env.SUPABASE_DB_HOST,port:+(process.env.SUPABASE_DB_PORT||5432),
 user:process.env.SUPABASE_DB_USER,password:process.env.SUPABASE_DB_PASSWORD,
 database:process.env.SUPABASE_DB_NAME||"postgres",ssl:{rejectUnauthorized:false}});
await c.connect();
const {rows:cols}=await c.query(`select column_name,data_type,is_nullable,column_default from information_schema.columns where table_name='unit_types' order by ordinal_position`);
console.log("unit_types columns:"); cols.forEach(r=>console.log(`  ${r.column_name.padEnd(18)} ${r.data_type.padEnd(26)} null=${r.is_nullable} ${r.column_default??""}`));
const {rows:pol}=await c.query(`select policyname,cmd,qual,with_check from pg_policies where tablename='unit_types'`);
console.log("\npolicies:"); pol.forEach(r=>console.log(`  ${r.cmd.padEnd(7)} ${r.policyname}\n     USING ${r.qual??"-"}\n     CHECK ${r.with_check??"-"}`));
const {rows:idx}=await c.query(`select indexdef from pg_indexes where tablename='unit_types'`);
console.log("\nindexes:"); idx.forEach(r=>console.log("  "+r.indexdef));
const {rows:d}=await c.query(`select category,count(*)::int n, min(label) sample from unit_types group by category`);
console.log("\nrows by category:"); d.forEach(r=>console.log(`  ${r.category}: ${r.n} (e.g. ${r.sample})`));
await c.end();
