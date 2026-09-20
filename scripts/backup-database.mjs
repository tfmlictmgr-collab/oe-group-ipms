// Take an off-platform backup of the database this checkout points at, and
// PROVE it is readable before claiming it succeeded.
//
// ── Why this exists alongside Supabase's own daily backups ─────────────────
//
// The backup posture decided at build-plan §2.5 is: Supabase Pro's included
// daily backups are the baseline (7-day retention, ~24h RPO), and PITR is
// deliberately NOT purchased — a day of ledger entries is reconstructible from
// gateway records and the bank statement, which is what makes that RPO
// acceptable, and PITR covers Postgres only, so it would not have protected a
// single identity document or payment proof anyway.
//
// What the daily backup cannot do is give you a copy taken AT A MOMENT YOU
// CHOOSE — before a migration, before a bulk correction, before anything you
// would want to undo. That is what this is for. It is also the only copy that
// leaves Supabase's control, which is a genuinely different control: a daily
// backup held inside the account does not protect against losing the account.
//
// ⚠️ **Why this is a script and not a button in the product.** A serverless
// function assembling a full database export has a hard execution limit, and
// the way it fails when the database outgrows that limit is by producing a
// TRUNCATED FILE THAT LOOKS LIKE A SUCCESS. That is the worst failure mode a
// backup can have, and this repository already has a scar of exactly that
// shape: the 90-day purge was "specified, built, tested — and never ran", and
// nothing said so. A backup you cannot verify is not a backup, it is a belief.
//
// So the work runs where it can be checked, and this script refuses to say
// "done" until `pg_restore --list` has read the archive back.
//
// Usage:
//   npm run backup                 # into ./backups
//   npm run backup -- --out /path  # somewhere else (an external disk, say)
//
// ⚠️ THE FILE IT WRITES CONTAINS EVERY PERSONAL RECORD IN THE SYSTEM.
// Treat it as the database itself: encrypted disk, never a shared drive, never
// email, and deleted when the reason for taking it has passed. It is a
// processing record under NDPA like any other copy.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";
import pg from "pg";

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const env = {};
config({ path: path.join(rootDir, ".env.local"), processEnv: env });

const argv = process.argv.slice(2);
const flag = (n) => { const i = argv.indexOf(`--${n}`); return i === -1 ? null : argv[i + 1]; };

const die = (msg) => { console.error(`\n${msg}\n`); process.exit(1); };
const ok = (m) => console.log(`  \x1b[32m✓\x1b[0m ${m}`);

// ── Which world are we about to copy? ──────────────────────────────────────
//
// The same two-halves check `migrate.mjs` makes, and for the same reason: on
// 6 Aug 2026 the REST half and the SUPABASE_DB_* half silently disagreed, and
// 117 migrations went into the wrong database. A backup aimed at the wrong
// world is quieter still — it succeeds, and you keep it believing it is
// something it is not.
const restRef = (env.NEXT_PUBLIC_SUPABASE_URL ?? "")
  .match(/^https:\/\/([a-z0-9]{20})\.supabase\.co/i)?.[1];
const dbHost = env.SUPABASE_DB_HOST ?? "";
const dbUser = env.SUPABASE_DB_USER ?? "";
const dbRef =
  dbHost.match(/^db\.([a-z0-9]{20})\.supabase\.co$/i)?.[1] ??
  dbUser.match(/^postgres\.([a-z0-9]{20})$/i)?.[1];

if (!dbHost || !env.SUPABASE_DB_NAME || !dbUser) {
  die(
    "SUPABASE_DB_HOST, SUPABASE_DB_NAME and SUPABASE_DB_USER must be set in .env.local.\n" +
    "  They are the direct Postgres connection, separate from the REST keys.\n" +
    "  Supabase dashboard -> Project Settings -> Database -> Connection info."
  );
}
if (restRef && dbRef && restRef !== dbRef) {
  die(
    `Refusing to back up: .env.local points at two different Supabase projects.\n\n` +
    `  SUPABASE_DB_*            -> ${dbRef}   (this script would copy HERE)\n` +
    `  NEXT_PUBLIC_SUPABASE_URL -> ${restRef}   (the app reads HERE)\n\n` +
    `A backup of the wrong database is worse than none, because you would keep it.`
  );
}

const WORLDS = { egqzjrmzxqqxrrqpdwbt: "demo", uszwigxdvjlwcwkjsjmc: "dev", tjboghjzbalxwhhatogl: "staging" };
const world = WORLDS[dbRef ?? ""] ?? (dbRef ? "PRODUCTION (or an unrecorded project)" : "unknown");

console.log(`\nBacking up: ${world}  ${dbRef ? `(${dbRef})` : ""}\n`);

// ── pg_dump must exist, and must be new enough for the server ──────────────
const pgDump = flag("pg-dump") ?? "pg_dump";
const version = spawnSync(pgDump, ["--version"], { encoding: "utf8" });
if (version.error) {
  die(
    `Cannot run \`${pgDump}\`. PostgreSQL client tools are not installed, or not on PATH.\n\n` +
    `  macOS:   brew install libpq && brew link --force libpq\n` +
    `  Ubuntu:  sudo apt install postgresql-client\n` +
    `  Windows: install PostgreSQL and add its bin\\ directory to PATH\n\n` +
    `  Or point at one directly:  npm run backup -- --pg-dump /full/path/to/pg_dump`
  );
}
ok(version.stdout.trim());

// ── Where it goes ──────────────────────────────────────────────────────────
const outDir = path.resolve(flag("out") ?? path.join(rootDir, "backups"));
fs.mkdirSync(outDir, { recursive: true });

const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const base = `${world.split(" ")[0].toLowerCase()}-${dbRef ?? "unknown"}-${stamp}`;
const dumpFile = path.join(outDir, `${base}.dump`);
const manifestFile = path.join(outDir, `${base}.manifest.json`);

// ── What the database says about itself, BEFORE the dump ───────────────────
//
// Recorded so a future restore can be checked against something rather than
// eyeballed. A dump that restores without error but is missing half the
// payments is still a failed backup.
const client = new pg.Client({
  host: env.SUPABASE_DB_HOST,
  port: Number(env.SUPABASE_DB_PORT || 5432),
  database: env.SUPABASE_DB_NAME,
  user: env.SUPABASE_DB_USER,
  password: env.SUPABASE_DB_PASSWORD,
  ssl: { rejectUnauthorized: false },
});

const COUNTED = [
  "orgs", "users", "properties", "units", "leases", "tickets",
  "payments", "remittances", "rent_charges", "service_charges",
  "tenant_applications", "audit_log",
];

let schemaVersion = null;
const counts = {};
try {
  await client.connect();
  const mig = await client.query("select max(name) as latest from _migrations");
  schemaVersion = mig.rows[0]?.latest ?? null;
  for (const t of COUNTED) {
    try {
      const r = await client.query(`select count(*)::bigint as n from ${t}`);
      counts[t] = Number(r.rows[0].n);
    } catch {
      counts[t] = null; // table absent on this schema version — not an error
    }
  }
  ok(`schema at ${schemaVersion ?? "(unknown)"}, ${Object.values(counts).filter((n) => n !== null).length} tables counted`);
} catch (err) {
  die(`Could not read the database before dumping: ${err.message}`);
} finally {
  await client.end().catch(() => {});
}

// ── The dump ───────────────────────────────────────────────────────────────
//
// Custom format: compressed, and `pg_restore --list` can read its table of
// contents WITHOUT restoring anything — which is the whole basis of the
// verification below. A plain .sql file can only be verified by reading all of
// it, and a truncated one looks fine until the last line.
console.log("\n  dumping… (this is the slow part)");
const dumpArgs = [
  "--format=custom",
  "--no-owner",
  "--no-privileges",
  // Supabase's own internal schemas are not ours to restore and a dump of them
  // fails on permissions half way through. The app's data lives in `public`;
  // `storage` metadata is excluded deliberately — see the manifest note.
  "--schema=public",
  `--file=${dumpFile}`,
  `--host=${env.SUPABASE_DB_HOST}`,
  `--port=${env.SUPABASE_DB_PORT || 5432}`,
  `--username=${env.SUPABASE_DB_USER}`,
  `--dbname=${env.SUPABASE_DB_NAME}`,
];
const run = spawnSync(pgDump, dumpArgs, {
  encoding: "utf8",
  env: { ...process.env, PGPASSWORD: env.SUPABASE_DB_PASSWORD, PGSSLMODE: "require" },
  maxBuffer: 1024 * 1024 * 64,
});
if (run.status !== 0) {
  // Clean up a partial file rather than leave something that looks like a backup.
  fs.rmSync(dumpFile, { force: true });
  die(
    `pg_dump failed (exit ${run.status}).\n\n${(run.stderr || "").trim()}\n\n` +
    `  If this says "server version mismatch", your pg_dump is older than the\n` +
    `  server. Install a client at least as new as the Supabase Postgres version\n` +
    `  and re-run — an older pg_dump cannot safely dump a newer server.\n\n` +
    `  The partial file has been deleted, so nothing here can be mistaken for a backup.`
  );
}

// ── Prove it is readable. This is the point of the script. ─────────────────
console.log("\n  verifying…");
if (!fs.existsSync(dumpFile)) die("pg_dump reported success but wrote no file.");
const bytes = fs.statSync(dumpFile).size;
if (bytes < 1024) {
  fs.rmSync(dumpFile, { force: true });
  die(`The dump is only ${bytes} bytes — that is not a database. Deleted.`);
}

let toc = "";
try {
  toc = execFileSync(flag("pg-restore") ?? "pg_restore", ["--list", dumpFile], {
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 64,
  });
} catch (err) {
  fs.rmSync(dumpFile, { force: true });
  die(
    `The archive could not be read back by pg_restore --list, so it is NOT a usable backup.\n\n` +
    `${String(err.stderr ?? err.message).trim()}\n\n` +
    `  The file has been deleted rather than kept as something that looks like a backup.`
  );
}
const tableData = (toc.match(/^\d+;.*TABLE DATA /gm) ?? []).length;
if (tableData === 0) {
  fs.rmSync(dumpFile, { force: true });
  die("The archive is readable but contains no table data. Deleted.");
}
ok(`${(bytes / 1048576).toFixed(1)} MB, readable by pg_restore, ${tableData} tables of data`);

const sha256 = crypto.createHash("sha256").update(fs.readFileSync(dumpFile)).digest("hex");

// ── The manifest: what a future restore is checked AGAINST ─────────────────
const manifest = {
  takenAt: new Date().toISOString(),
  world,
  projectRef: dbRef ?? null,
  schemaVersion,
  file: path.basename(dumpFile),
  bytes,
  sha256,
  tablesOfData: tableData,
  rowCounts: counts,
  restoreWith: `pg_restore --clean --if-exists --no-owner --no-privileges -d "<target>" "${path.basename(dumpFile)}"`,
  covers: "The `public` schema of Postgres only.",
  doesNotCover: [
    "Storage buckets — identity documents, work-order media, vendor KYC, payment proofs and payout evidence are NOT in this file.",
    "Auth users (the `auth` schema) — sign-in identities are not restored by this.",
    "Edge functions, project settings, environment variables.",
  ],
};
fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2) + "\n");
ok(`manifest written beside it`);

// ── Record that it happened, where the system itself can be asked ──────────
//
// So "when was the last backup taken?" is answerable from the audit trail
// rather than from whoever remembers. Best-effort: a trail write that fails
// must not invalidate a backup that succeeded.
try {
  const c2 = new pg.Client({
    host: env.SUPABASE_DB_HOST,
    port: Number(env.SUPABASE_DB_PORT || 5432),
    database: env.SUPABASE_DB_NAME,
    user: env.SUPABASE_DB_USER,
    password: env.SUPABASE_DB_PASSWORD,
    ssl: { rejectUnauthorized: false },
  });
  await c2.connect();
  const org = await c2.query("select id from orgs where is_platform_operator limit 1");
  if (org.rows[0]?.id) {
    await c2.query(
      `insert into audit_log (org_id, actor_id, action, entity_type, after_state)
       values ($1, null, 'operator.backup_taken', 'database', $2::jsonb)`,
      [org.rows[0].id, JSON.stringify({
        world, projectRef: dbRef, schemaVersion, bytes, sha256, tablesOfData: tableData,
      })]
    );
    ok("recorded in the audit trail as operator.backup_taken");
  }
  await c2.end();
} catch (err) {
  console.log(`  \x1b[33m!\x1b[0m backup succeeded, but the audit row could not be written: ${err.message}`);
}

console.log(`\n\x1b[32mBackup verified.\x1b[0m  ${dumpFile}\n`);
console.log("  ⚠️  This file contains every personal record in the system.");
console.log("      Encrypted disk only. Never a shared drive, never email.");
console.log("      Delete it once the reason you took it has passed.\n");
console.log("  ⚠️  It does NOT contain the storage buckets — identity documents,");
console.log("      payment proofs and payout evidence are not in this file.");
console.log("      See docs/BACKUP_AND_RESTORE.md for what covers those.\n");
