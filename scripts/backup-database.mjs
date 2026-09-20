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
import { pipeline } from "node:stream/promises";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";
import pg from "pg";

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const env = {};
config({ path: path.join(rootDir, ".env.local"), processEnv: env });

const argv = process.argv.slice(2);
const flag = (n) => { const i = argv.indexOf(`--${n}`); return i === -1 ? null : argv[i + 1]; };
const has = (n) => argv.includes(`--${n}`);

const die = (msg) => { console.error(`\n${msg}\n`); process.exit(1); };
const ok = (m) => console.log(`  \x1b[32m✓\x1b[0m ${m}`);

// ── Encryption, so a copy can safely leave this machine ───────────────
//
// `--encrypt` turns the dump into a file whose destination no longer has to be
// trusted. That is the whole point: an unencrypted dump in a cloud drive is
// every tenant's identity document sitting in somebody else's datacentre under
// somebody else's access controls. The same file encrypted here is ciphertext
// wherever it lands, and the storage provider becomes a place that holds bytes
// rather than a processor of personal data in any meaningful sense.
//
// AES-256-GCM, key derived with scrypt from a passphrase you supply. GCM is
// authenticated: a file that has been altered by one byte fails to decrypt
// rather than decrypting into quiet nonsense.
//
// ⚠️ THIS PASSPHRASE IS AS UNRECOVERABLE AS `GATEWAY_CREDENTIAL_KEY`. Lose it
// and the backup is a pile of random bytes. Escrow it the same way — sealed,
// two holders, written in the runbook — and never in the same envelope as the
// thing it protects.
//
// Layout: MAGIC(8) VERSION(1) SALT(16) IV(12) CIPHERTEXT… TAG(16, at the end)
// The tag trails because GCM only knows it once the last byte is encrypted,
// and the file is streamed rather than held in memory — a database backup
// outgrows a buffer long before it outgrows a disk.
const MAGIC = Buffer.from("OEIPMSB1", "ascii");
// N=2^15 costs 128*N*r = 32 MiB per derivation, which is deliberate — it is
// what makes guessing the passphrase expensive. `maxmem` must be raised to
// allow it: node defaults to exactly 32 MiB and refuses its own parameters.
const SCRYPT = { N: 1 << 15, r: 8, p: 1, keylen: 32, maxmem: 64 * 1024 * 1024 };

async function passphrase(confirm) {
  const fromEnv = process.env.BACKUP_PASSPHRASE;
  if (fromEnv) {
    console.log("  using BACKUP_PASSPHRASE from the environment");
    return fromEnv;
  }
  if (!process.stdin.isTTY) {
    die("No passphrase. Run this in a terminal, or set BACKUP_PASSPHRASE for an unattended run.");
  }
  const ask = (prompt) => new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    // Echo nothing: a passphrase on screen is a passphrase in a screenshot.
    const onData = () => rl.output.write("\x1b[2K\r" + prompt);
    rl.output.write(prompt);
    process.stdin.on("data", onData);
    rl.question("", (answer) => {
      process.stdin.removeListener("data", onData);
      rl.close();
      process.stdout.write("\n");
      resolve(answer);
    });
  });
  const a = await ask("  passphrase: ");
  if (a.length < 12) die("Use at least 12 characters. This is the only thing standing between the file and whoever finds it.");
  if (!confirm) return a;
  const b = await ask("  again     : ");
  if (a !== b) die("The two passphrases do not match. Nothing has been written.");
  return a;
}

async function encryptFile(src, dest, pass) {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = crypto.scryptSync(pass, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, maxmem: SCRYPT.maxmem });
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const out = fs.createWriteStream(dest);
  out.write(Buffer.concat([MAGIC, Buffer.from([1]), salt, iv]));
  await pipeline(fs.createReadStream(src), cipher, out, { end: false });
  await new Promise((res, rej) => out.end(cipher.getAuthTag(), (e) => (e ? rej(e) : res())));
}

async function decryptFile(src, dest, pass) {
  const total = fs.statSync(src).size;
  const head = Buffer.alloc(37);
  const fd = fs.openSync(src, "r");
  fs.readSync(fd, head, 0, 37, 0);
  const tag = Buffer.alloc(16);
  fs.readSync(fd, tag, 0, 16, total - 16);
  fs.closeSync(fd);
  if (!head.subarray(0, 8).equals(MAGIC)) die(`${src} is not a backup this script wrote.`);
  const salt = head.subarray(9, 25);
  const iv = head.subarray(25, 37);
  const key = crypto.scryptSync(pass, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, maxmem: SCRYPT.maxmem });
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  await pipeline(
    fs.createReadStream(src, { start: 37, end: total - 17 }),
    decipher,
    fs.createWriteStream(dest)
  );
}

// ── `--decrypt <file>` is its own mode and needs no database ───────────
if (flag("decrypt")) {
  const src = path.resolve(flag("decrypt"));
  if (!fs.existsSync(src)) die(`No such file: ${src}`);
  const dest = src.replace(/\.enc$/, "") + (src.endsWith(".enc") ? "" : ".decrypted");
  console.log(`\nDecrypting ${path.basename(src)}\n`);
  const pass = await passphrase(false);
  try {
    await decryptFile(src, dest, pass);
  } catch (err) {
    fs.rmSync(dest, { force: true });
    die(
      `Could not decrypt. Either the passphrase is wrong, or the file has been altered.\n\n` +
      `  ${err.message}\n\n` +
      `  AES-GCM refuses a file that does not match its authentication tag, so this\n` +
      `  is a real answer rather than a guess — the partial output has been deleted.`
    );
  }
  ok(`decrypted to ${dest}`);
  console.log(`\n  sha256 ${crypto.createHash("sha256").update(fs.readFileSync(dest)).digest("hex")}`);
  console.log("  Compare that against the manifest's `sha256` to prove it is byte-identical.\n");
  process.exit(0);
}

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

// ── Encrypt, and prove the encryption round-trips before keeping it ─────
//
// Ordering is deliberate: the dump is verified by pg_restore FIRST, then
// encrypted. Encrypting an unverified dump would produce a file that is
// provably intact and provably useless.
//
// The round-trip is the same discipline one level up. An encrypted backup
// nobody has decrypted is exactly the belief this script exists to refuse, and
// a mistyped passphrase stays silent until the day you need the file. So it is
// decrypted straight back and compared byte for byte.
let finalFile = dumpFile;
let encrypted = false;
if (has("encrypt")) {
  console.log("\n  encrypting…");
  const pass = await passphrase(true);
  const encFile = `${dumpFile}.enc`;
  await encryptFile(dumpFile, encFile, pass);

  const check = `${dumpFile}.roundtrip`;
  try {
    await decryptFile(encFile, check, pass);
  } catch (err) {
    fs.rmSync(encFile, { force: true });
    fs.rmSync(check, { force: true });
    die(`The encrypted file would not decrypt: ${err.message}\n\n  Nothing encrypted has been kept; the plaintext dump is still at ${dumpFile}.`);
  }
  const back = crypto.createHash("sha256").update(fs.readFileSync(check)).digest("hex");
  fs.rmSync(check, { force: true });
  if (back !== sha256) {
    fs.rmSync(encFile, { force: true });
    die(`The encrypted file decrypted to different bytes.\n\n  expected ${sha256}\n  got      ${back}\n\n  Nothing encrypted has been kept.`);
  }
  ok("decrypts back to the identical file — proven, not assumed");

  fs.rmSync(dumpFile, { force: true });
  finalFile = encFile;
  encrypted = true;
  ok(`plaintext removed — ${path.basename(encFile)} is the only copy on this disk`);
}

// ── The manifest: what a future restore is checked AGAINST ─────────────────
const manifest = {
  takenAt: new Date().toISOString(),
  world,
  projectRef: dbRef ?? null,
  schemaVersion,
  file: path.basename(finalFile),
  encrypted,
  // ⚠️ `bytes` and `sha256` describe the PLAINTEXT dump — what you get back
  // after decrypting — not the encrypted file. That is the number worth
  // keeping: it is what proves a restore produced the right bytes.
  bytes,
  sha256,
  tablesOfData: tableData,
  rowCounts: counts,
  restoreWith: encrypted
    ? `npm run backup -- --decrypt "${path.basename(finalFile)}"  →  pg_restore --clean --if-exists --no-owner --no-privileges -d "<target>" "${path.basename(dumpFile)}"`
    : `pg_restore --clean --if-exists --no-owner --no-privileges -d "<target>" "${path.basename(dumpFile)}"`,
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

console.log(`\n\x1b[32mBackup verified.\x1b[0m  ${finalFile}\n`);
if (encrypted) {
  console.log("  ✓  Encrypted, and proven to decrypt back to the identical file.");
  console.log("      It is ciphertext wherever it goes — a cloud drive, an external disk,");
  console.log("      a colleague's machine. The destination no longer has to be trusted.");
  console.log("");
  console.log("  ⚠️  THE PASSPHRASE IS AS UNRECOVERABLE AS GATEWAY_CREDENTIAL_KEY.");
  console.log("      Escrow it the same way — sealed, two holders, named in the runbook —");
  console.log("      and never in the same envelope as the file it protects.\n");
} else {
  console.log("  ⚠️  This file holds every personal record in the system, in the clear.");
  console.log("      Encrypted disk only. Never a shared drive, never email.");
  console.log("      Delete it once the reason you took it has passed.");
  console.log("      Add --encrypt if this copy is going to leave this machine.\n");
}
console.log("  ⚠️  It does NOT contain the storage buckets — identity documents,");
console.log("      payment proofs and payout evidence are not in this file.");
console.log("      See docs/BACKUP_AND_RESTORE.md for what covers those.\n");
