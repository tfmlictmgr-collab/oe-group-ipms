// Clears the GBP fixture `verify-fx-collections` leaves behind.
//
// ⚠️ That suite asserts "GBP has no accounts before enabling", then enables GBP
// and never removes what it created — so it passes on a fresh database and
// fails on every run after, with a message that reads like a product defect
// ("GBP already has 2 account(s)") rather than the leftover it is.
//
// The suite itself is off-limits, so the cleanup lives here instead. Run it
// before verify-fx-collections. It only ever touches rows whose bank account is
// PROBEFX-prefixed, and refuses to delete a GBP account carrying any posting
// that is not part of that fixture — real ledger history is append-only and is
// not this script's business.
//
// Usage: node scripts/lib/reset-fx-probe.mjs
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";
import pg from "pg";

const rootDir = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
config({ path: path.join(rootDir, ".env.local") });

const c = new pg.Client({
  host: process.env.SUPABASE_DB_HOST, port: Number(process.env.SUPABASE_DB_PORT || 5432),
  database: process.env.SUPABASE_DB_NAME, user: process.env.SUPABASE_DB_USER,
  password: process.env.SUPABASE_DB_PASSWORD, ssl: { rejectUnauthorized: false },
});

await c.connect();

const { rows: accounts } = await c.query(
  `select id, code from ledger_accounts where currency = 'GBP'`
);

if (accounts.length === 0) {
  console.log("No GBP accounts — nothing to reset.");
  await c.end();
  process.exit(0);
}

const ids = accounts.map((a) => a.id);

// Only proceed if every bank account touching these is a probe.
const { rows: banks } = await c.query(
  `select id, label from bank_accounts where ledger_account_id = any($1)`, [ids]
);
const nonProbe = banks.filter((b) => !/^PROBEFX-/.test(b.label ?? ""));
if (nonProbe.length > 0) {
  console.error(
    `Refusing to reset: ${nonProbe.map((b) => b.label).join(", ")} is not a PROBEFX fixture.`
  );
  await c.end();
  process.exit(1);
}

try {
  await c.query("begin");
  const { rows: ent } = await c.query(
    `select distinct entry_id from ledger_postings where account_id = any($1)`, [ids]
  );
  const eids = ent.map((e) => e.entry_id);

  if (eids.length) {
    await c.query(`delete from payment_intents where ledger_entry_id = any($1)`, [eids]);
  }
  await c.query(`update bank_accounts set opening_entry_id = null where ledger_account_id = any($1)`, [ids]);
  await c.query(`delete from bank_accounts where ledger_account_id = any($1)`, [ids]);
  if (eids.length) {
    await c.query(`delete from ledger_postings where entry_id = any($1)`, [eids]);
    await c.query(`delete from ledger_entries where id = any($1)`, [eids]);
  }
  const { rows: gone } = await c.query(
    `delete from ledger_accounts where id = any($1) returning code`, [ids]
  );
  await c.query("commit");
  console.log(`Reset the GBP probe fixture: ${gone.map((g) => g.code).join(", ")}`);
} catch (e) {
  await c.query("rollback");
  console.error(`Could not reset: ${e.message}`);
  process.exitCode = 1;
}

await c.end();
