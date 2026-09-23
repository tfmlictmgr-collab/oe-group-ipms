// Take an off-platform backup of the STORAGE BUCKETS this checkout points at,
// and PROVE it is readable before claiming it succeeded.
//
// ── Why this exists at all ────────────────────────────────────────────────
//
// Confirmed with Supabase on 21 Sept 2026: **the daily backup covers the
// database only. Storage objects are not in it.** `npm run backup` does not
// cover them either — `pg_dump` dumps a database, and the bytes are not in the
// database. Postgres holds `storage.objects`, a table of metadata and paths;
// the objects themselves live behind the Storage API.
//
// So until this script existed, the identity documents, the photographs taken
// inside client homes, the vendor KYC packs, the proofs of payment and the
// payee bank evidence had **no backup of any kind**.
//
// 📌 That is a different shape of risk from the one the PITR conversation was
// about. PITR would have protected a day of ledger rows — reconstructible from
// gateway and bank records, which is exactly why declining it was sound. This
// protects the one category nobody else holds a copy of. And a database-only
// restore is worse than obviously broken: every row comes back carrying a
// storage path, and every path resolves to nothing, so the system returns
// looking healthy.
//
// ⚠️ THE FILE IT WRITES CONTAINS EVERY IDENTITY DOCUMENT IN THE SYSTEM.
// Treat it the way `backup-database.mjs` says to treat its dump: encrypted
// disk, never a shared drive, never email, deleted when the reason for taking
// it has passed. It is a processing record under NDPA like any other copy.
//
// Usage:
//   npm run backup:storage                      # into ./backups
//   npm run backup:storage -- --out /path       # somewhere else
//   npm run backup:storage -- --encrypt         # AES-256-GCM before it leaves
//   npm run backup:storage -- --decrypt <file>  # read one back
//
// The archive is an ordinary `tar`, deliberately: a backup can outlive the
// script that wrote it, and `tar -xf` works on any machine without this
// repository. Encryption wraps the tar rather than replacing it.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";
import pg from "pg";
import { createClient } from "@supabase/supabase-js";
import {
  passphrase as readPassphrase,
  encryptFile,
  decryptFile,
  sha256File,
} from "./lib/backup-crypto.mjs";

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const env = {};
config({ path: path.join(rootDir, ".env.local"), processEnv: env });

const argv = process.argv.slice(2);
const flag = (n) => { const i = argv.indexOf(`--${n}`); return i === -1 ? null : argv[i + 1]; };
const has = (n) => argv.includes(`--${n}`);

const die = (msg) => { console.error(`\n${msg}\n`); process.exit(1); };
const ok = (m) => console.log(`  \x1b[32m✓\x1b[0m ${m}`);
const note = (m) => console.log(`  \x1b[33m·\x1b[0m ${m}`);

const passphrase = async (confirm) => {
  try { return await readPassphrase(confirm); } catch (e) { die(e.message); }
};

// ── `--decrypt <file>` is its own mode and needs no credentials ────────────
if (flag("decrypt")) {
  const src = path.resolve(flag("decrypt"));
  if (!fs.existsSync(src)) die(`No such file: ${src}`);
  const dest = src.endsWith(".enc") ? src.replace(/\.enc$/, "") : `${src}.decrypted`;
  // ⚠️ Refuse to write over something already there. The cleanup below deletes
  // `dest` when a decrypt fails, and that is right for a half-written file —
  // but it does not know the difference between a partial file it just made
  // and a COMPLETE one an earlier successful run left at the same path. Found
  // on 23 Sept 2026 by decrypting correctly, then re-running with a typo: the
  // good output was deleted by the failure of the bad attempt.
  if (fs.existsSync(dest) && !has("force")) {
    die(
      `${dest} already exists.\n\n` +
      `  Not overwriting it — a failed decrypt deletes its destination, so an earlier\n` +
      `  good file would go with it. Move it aside, or pass --force.`
    );
  }
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
  console.log(`  → ${dest}`);
  console.log(`  sha256 ${sha256File(dest)}`);
  console.log(`\n  Compare that against the manifest's \`sha256\`, then read it with:\n`);
  console.log(`    tar -tvf ${path.basename(dest)}     # list`);
  console.log(`    tar -xf  ${path.basename(dest)}     # extract\n`);
  process.exit(0);
}

// ── Which world is this, and can we reach both halves of it ───────────────
const URL_ = env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const KEY = env.SUPABASE_SERVICE_ROLE_KEY ?? "";
if (!URL_ || !KEY) {
  die("NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in .env.local.");
}
const ref = URL_.match(/^https:\/\/([a-z0-9]{20})\.supabase\.co/i)?.[1];
if (!ref) die(`Cannot derive a Supabase project ref from NEXT_PUBLIC_SUPABASE_URL (${URL_}).`);

// tar does the archiving, the way pg_dump does the dumping in the sibling
// script: an external tool whose output any other machine can open.
if (spawnSync("tar", ["--version"], { encoding: "utf8" }).status !== 0) {
  die("`tar` is not on PATH. It ships with Windows 10+, macOS and every Linux; this script needs it to build the archive.");
}

console.log(`\nStorage backup — project ${ref}\n`);

// ── Enumerate from the DATABASE, not from the Storage API's listing ───────
//
// `storage.objects` is the authoritative record of what exists, in one query.
// The Storage API's `list()` paginates per folder and has to be walked
// recursively, which means a backup's completeness would depend on getting
// that traversal right — and the failure mode of getting it wrong is a smaller
// archive that reports success. The database already knows the answer.
//
// It also gives the reconciliation at the end something independent to check
// against: downloaded count versus the count the database says exists. A
// listing cannot disagree with itself.
const client = new pg.Client({
  host: env.SUPABASE_DB_HOST,
  port: Number(env.SUPABASE_DB_PORT || 5432),
  database: env.SUPABASE_DB_NAME,
  user: env.SUPABASE_DB_USER,
  password: env.SUPABASE_DB_PASSWORD,
  ssl: { rejectUnauthorized: false },
});

let objects = [];
let bucketRows = [];
try {
  await client.connect();
} catch (e) {
  die(
    `Could not reach the database to enumerate storage objects: ${e.message}\n\n` +
    `  This script reads \`storage.objects\` for the authoritative list of what exists,\n` +
    `  so SUPABASE_DB_* must be set in .env.local — the same values \`npm run backup\` uses.\n` +
    `  Run \`node scripts/check-db-connection.mjs\` to see which half is wrong.`
  );
}
try {
  const dbRef =
    (env.SUPABASE_DB_HOST ?? "").match(/^db\.([a-z0-9]{20})\.supabase\.co$/i)?.[1] ??
    (env.SUPABASE_DB_USER ?? "").match(/^postgres\.([a-z0-9]{20})$/i)?.[1];
  // The same relational check migrate.mjs makes, and for the same reason: on
  // 6 Aug 2026 the two halves of .env.local silently named different projects.
  // Backing up one world's files while listing another's would produce an
  // archive that is neither.
  if (dbRef && dbRef !== ref) {
    die(
      `Refusing to back up: .env.local points at two different Supabase projects.\n\n` +
      `  SUPABASE_DB_*            -> ${dbRef}   (this script would LIST here)\n` +
      `  NEXT_PUBLIC_SUPABASE_URL -> ${ref}   (and DOWNLOAD from here)\n\n` +
      `  Fix .env.local so both halves name the same project, then re-run.`
    );
  }
  ok(`both halves of .env.local name ${ref}`);

  const { rows } = await client.query(
    `select id, name, public, file_size_limit from storage.buckets order by id;`
  );
  bucketRows = rows;
  const { rows: objs } = await client.query(
    `select bucket_id, name, coalesce((metadata->>'size')::bigint, 0) as size
       from storage.objects
      where bucket_id is not null and name is not null
      order by bucket_id, name;`
  );
  objects = objs;
} finally {
  await client.end();
}

ok(`${bucketRows.length} bucket(s): ${bucketRows.map((b) => b.id).join(", ")}`);
ok(`${objects.length} object(s) recorded in storage.objects`);

if (objects.length === 0) {
  note("nothing to back up yet — this is the expected state of a freshly-cut production project");
  note("the script still writes an archive, so the drill can be rehearsed before there is anything to lose");
}

// ── Download every one, to a staging directory ────────────────────────────
const supabase = createClient(URL_, KEY, { auth: { persistSession: false } });
const stamp = new Date().toISOString().replace(/[:.]/g, "-").replace("T", "_").slice(0, 19);
const outDir = path.resolve(flag("out") ?? path.join(rootDir, "backups"));
fs.mkdirSync(outDir, { recursive: true });

const staging = fs.mkdtempSync(path.join(os.tmpdir(), "oeipms-storage-"));
const manifest = {
  kind: "storage",
  projectRef: ref,
  takenAt: new Date().toISOString(),
  buckets: bucketRows.map((b) => ({ id: b.id, public: b.public, fileSizeLimit: b.file_size_limit })),
  objects: [],
};

let downloaded = 0;
const failures = [];
for (const o of objects) {
  const rel = path.posix.join("objects", o.bucket_id, o.name);
  const dest = path.join(staging, rel);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const { data, error } = await supabase.storage.from(o.bucket_id).download(o.name);
  if (error || !data) {
    failures.push({ bucket: o.bucket_id, name: o.name, reason: error?.message ?? "no body returned" });
    continue;
  }
  const bytes = Buffer.from(await data.arrayBuffer());
  fs.writeFileSync(dest, bytes);
  manifest.objects.push({
    bucket: o.bucket_id,
    name: o.name,
    path: rel,
    bytes: bytes.length,
    sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
  });
  downloaded += 1;
  if (downloaded % 25 === 0) process.stdout.write(`\r  downloading… ${downloaded}/${objects.length}`);
}
if (downloaded >= 25) process.stdout.write("\r");

// ⚠️ A PARTIAL ARCHIVE THAT REPORTS SUCCESS IS THE WORST OUTCOME HERE, worse
// than failing outright — it stops anyone looking again. So a single object
// that could not be fetched fails the whole run, and the staging directory is
// removed so there is nothing half-made to mistake for a backup later.
if (failures.length > 0) {
  fs.rmSync(staging, { recursive: true, force: true });
  die(
    `Refusing to write a partial backup: ${failures.length} of ${objects.length} object(s) could not be downloaded.\n\n` +
      failures.slice(0, 10).map((f) => `  ${f.bucket}/${f.name} — ${f.reason}`).join("\n") +
      (failures.length > 10 ? `\n  … and ${failures.length - 10} more` : "") +
      `\n\n  Nothing has been kept. An archive missing a document nobody notices is worse\n` +
      `  than no archive, because it stops anyone looking for one.`
  );
}
ok(`downloaded ${downloaded} object(s)`);

// ── Write the manifest, then archive ──────────────────────────────────────
fs.writeFileSync(path.join(staging, "manifest.json"), JSON.stringify(manifest, null, 2));

const base = `storage-${ref}-${stamp}.tar`;
const tarFile = path.join(outDir, base);
const tarRes = spawnSync("tar", ["-cf", tarFile, "-C", staging, "."], { encoding: "utf8" });
if (tarRes.status !== 0) {
  fs.rmSync(staging, { recursive: true, force: true });
  fs.rmSync(tarFile, { force: true });
  die(`tar failed: ${tarRes.stderr || tarRes.stdout || `exit ${tarRes.status}`}`);
}
fs.rmSync(staging, { recursive: true, force: true });

// ── Read it back before saying it worked ──────────────────────────────────
//
// The sibling script's rule, applied to a different archive format: a backup
// is not a backup until something has read it. `tar -tf` parses the whole
// archive to produce its listing, so it proves the file is structurally intact
// AND lets every manifest entry be checked for presence by name.
//
// It does NOT re-hash the contents — that would mean extracting the whole
// archive again, and the per-object SHA-256 in the manifest is what a restore
// checks each file against. Stated rather than implied, because "verified" is
// a word that should mean exactly what it did.
const list = spawnSync("tar", ["-tf", tarFile], { encoding: "utf8" });
if (list.status !== 0) {
  fs.rmSync(tarFile, { force: true });
  die(`The archive could not be read back: ${list.stderr || `exit ${list.status}`}\n\n  It has been deleted rather than left looking like a backup.`);
}
const entries = new Set(
  list.stdout.split(/\r?\n/).map((l) => l.replace(/^\.\//, "").trim()).filter(Boolean)
);
const missing = manifest.objects.filter((o) => !entries.has(o.path)).map((o) => o.path);
if (missing.length > 0 || !entries.has("manifest.json")) {
  fs.rmSync(tarFile, { force: true });
  die(
    `The archive is missing ${missing.length} file(s) the manifest names` +
    (entries.has("manifest.json") ? "" : ", and the manifest itself") +
    `:\n\n` + missing.slice(0, 10).map((m) => `  ${m}`).join("\n") +
    `\n\n  Deleted rather than kept.`
  );
}
ok(`archive read back: ${entries.size} entr(y/ies), every manifest object present`);

let finalFile = tarFile;
const plainSha = sha256File(tarFile);
const plainBytes = fs.statSync(tarFile).size;

// ── Encrypt, and prove the encryption is reversible ───────────────────────
if (has("encrypt")) {
  console.log("");
  const pass = await passphrase(true);
  const encFile = `${tarFile}.enc`;
  await encryptFile(tarFile, encFile, pass);

  // Decrypt it straight back and compare, before deleting the plaintext. An
  // encrypted backup nobody has decrypted is precisely the belief this whole
  // script refuses, and a mistyped passphrase is otherwise silent until the
  // day the file is needed.
  const check = `${tarFile}.check`;
  try {
    await decryptFile(encFile, check, pass);
  } catch (e) {
    fs.rmSync(encFile, { force: true });
    fs.rmSync(check, { force: true });
    die(`The encrypted file could not be decrypted back: ${e.message}\n\n  Nothing encrypted has been kept; the plaintext archive is still at\n  ${tarFile}`);
  }
  const back = sha256File(check);
  fs.rmSync(check, { force: true });
  if (back !== plainSha) {
    fs.rmSync(encFile, { force: true });
    die(`The encrypted file decrypted to different bytes.\n\n  expected ${plainSha}\n  got      ${back}\n\n  Nothing encrypted has been kept.`);
  }
  ok("encrypted, decrypted back, and byte-identical");
  fs.rmSync(tarFile, { force: true });
  finalFile = encFile;
}

const manifestFile = path.join(outDir, `${base}.manifest.json`);
fs.writeFileSync(
  manifestFile,
  JSON.stringify(
    {
      ...manifest,
      // ⚠️ `bytes` and `sha256` describe the PLAINTEXT tar — what you get back
      // after `--decrypt`, not the .enc file on disk.
      archive: { file: path.basename(finalFile), encrypted: has("encrypt"), bytes: plainBytes, sha256: plainSha },
    },
    null,
    2
  )
);

console.log("");
console.log(`  → ${finalFile}`);
console.log(`  → ${manifestFile}`);
console.log("");
console.log(`  ${manifest.objects.length} object(s) from ${bucketRows.length} bucket(s), ${(plainBytes / 1048576).toFixed(2)} MiB`);
console.log(`  sha256 (plaintext tar) ${plainSha}`);
if (!has("encrypt")) {
  console.log("");
  console.log("  ⚠️  NOT ENCRYPTED. This file holds identity documents, payment proofs and");
  console.log("      payout evidence in the clear. Do not put it anywhere you would not put");
  console.log("      the database itself — re-run with --encrypt for a copy that can leave");
  console.log("      this machine.");
}
console.log("");
