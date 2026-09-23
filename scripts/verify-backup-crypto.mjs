// A backup that leaves this machine is ciphertext, and can be read back.
//
// This suite runs the REAL encryption on real bytes, because the property in
// question is not "the code says AES" — it is "the file this produces can be
// turned back into the file that went in, and refuses when it should". A
// static read cannot answer that.
//
// It touches no database, no network and no credentials, so it runs anywhere.
//
// Usage: node scripts/verify-backup-crypto.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { encryptFile, decryptFile, sha256File, MAGIC, HEADER_LEN, TAG_LEN } from "./lib/backup-crypto.mjs";

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

let failures = 0;
const ok = (m) => console.log(`  \x1b[32mPASS\x1b[0m ${m}`);
const bad = (m) => { failures++; console.log(`  \x1b[31mFAIL\x1b[0m ${m}`); };

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "verify-backup-"));
const PASS = "a passphrase of sufficient length";

console.log("A backup that leaves this machine is ciphertext, and reads back\n");

console.log("A. One implementation of the format, not two");
{
  // ⚠️ The whole reason lib/backup-crypto.mjs exists. Two copies of one file
  // format diverge silently, and you find out when a backup taken by one
  // script cannot be read by the other — at the moment you are trying to read
  // it, which is the moment you are already having a bad day.
  const scripts = ["backup-database.mjs", "backup-storage.mjs"];
  for (const f of scripts) {
    const src = fs.readFileSync(path.join(rootDir, "scripts", f), "utf8");
    /from "\.\/lib\/backup-crypto\.mjs"/.test(src)
      ? ok(`${f} imports the shared format`)
      : bad(`${f} does not import lib/backup-crypto.mjs`);
    // Comments may mention these; a local definition is the thing to catch.
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split(/\r?\n/).filter((l) => !/^\s*\/\//.test(l)).join("\n");
    !/createCipheriv|createDecipheriv|scryptSync/.test(code)
      ? ok(`${f} defines no cipher of its own`)
      : bad(`${f} builds its own cipher — the format now has two implementations`);
  }
}

console.log("\nB. A real round trip, on bytes big enough to stream");
{
  // 3 MiB: the file is piped rather than buffered, and a one-chunk test would
  // not exercise that at all.
  const plain = path.join(dir, "plain.bin");
  fs.writeFileSync(plain, crypto.randomBytes(3 * 1024 * 1024));
  const want = sha256File(plain);
  const enc = path.join(dir, "a.enc");
  const back = path.join(dir, "back.bin");

  await encryptFile(plain, enc, PASS);
  const head = Buffer.alloc(8);
  const fd = fs.openSync(enc, "r");
  fs.readSync(fd, head, 0, 8, 0);
  fs.closeSync(fd);

  head.equals(MAGIC)
    ? ok("the file starts with this project's magic bytes")
    : bad("the header is not the format this repository writes");

  fs.statSync(enc).size === fs.statSync(plain).size + HEADER_LEN + TAG_LEN
    ? ok("size is exactly plaintext + header + tag — nothing padded, nothing lost")
    : bad(`unexpected size: ${fs.statSync(enc).size} for a ${fs.statSync(plain).size}-byte input`);

  !fs.readFileSync(enc).subarray(HEADER_LEN, HEADER_LEN + 4096).equals(fs.readFileSync(plain).subarray(0, 4096))
    ? ok("the body is not the plaintext — it is actually encrypted")
    : bad("the first 4 KiB of the body match the plaintext: this is not encrypted");

  await decryptFile(enc, back, PASS);
  sha256File(back) === want
    ? ok("decrypts back byte-identical")
    : bad("the round trip did not return the same bytes");
}

console.log("\nC. It refuses what it should");
{
  const plain = path.join(dir, "small.bin");
  fs.writeFileSync(plain, crypto.randomBytes(4096));
  const enc = path.join(dir, "b.enc");
  await encryptFile(plain, enc, PASS);

  const refuses = async (label, file, pass, expect) => {
    const out = path.join(dir, `out-${crypto.randomUUID()}.bin`);
    try {
      await decryptFile(file, out, pass);
      bad(`${label} was ACCEPTED`);
    } catch (e) {
      expect && !expect.test(e.message)
        ? bad(`${label} was refused, but the message does not say why: ${e.message}`)
        : ok(`${label} is refused`);
    }
  };

  await refuses("a wrong passphrase", enc, "the wrong passphrase entirely");

  const tampered = path.join(dir, "tampered.enc");
  const buf = fs.readFileSync(enc);
  buf[HEADER_LEN + 10] ^= 0x01;
  fs.writeFileSync(tampered, buf);
  await refuses("a single flipped byte in the body", tampered, PASS);

  // GCM authenticates the tag too, so truncation is caught rather than
  // producing a shorter "valid" file.
  const truncated = path.join(dir, "truncated.enc");
  fs.writeFileSync(truncated, fs.readFileSync(enc).subarray(0, fs.statSync(enc).size - 8));
  await refuses("a truncated file", truncated, PASS);

  const foreign = path.join(dir, "foreign.enc");
  fs.writeFileSync(foreign, crypto.randomBytes(512));
  await refuses("a file this script did not write", foreign, PASS, /not a backup this script wrote/);

  const tiny = path.join(dir, "tiny.enc");
  fs.writeFileSync(tiny, crypto.randomBytes(10));
  await refuses("a file too short to hold a header", tiny, PASS, /too small/);
}

console.log("\nD. The archive format is one any machine can open");
{
  // The storage backup is an ordinary tar on purpose: a backup can outlive the
  // script that wrote it, and `tar -xf` needs no part of this repository.
  const src = fs.readFileSync(path.join(rootDir, "scripts", "backup-storage.mjs"), "utf8");
  /spawnSync\("tar", \["-cf"/.test(src)
    ? ok("backup-storage writes a plain tar rather than a private container")
    : bad("the archive is not a tar — a backup that needs this script to read it is a hostage");

  /spawnSync\("tar", \["-tf"/.test(src)
    ? ok("it reads the archive back before reporting success")
    : bad("nothing reads the archive back — 'a backup you cannot verify is a belief'");

  /Refusing to write a partial backup/.test(src)
    ? ok("a failed download fails the whole run rather than shipping a partial archive")
    : bad("a partial archive could be written and reported as a success");

  /already exists[\s\S]{0,400}--force/.test(src)
    ? ok("--decrypt refuses to overwrite an existing destination")
    : bad("a failed decrypt could delete a good file left by an earlier run");

  if (spawnSync("tar", ["--version"], { encoding: "utf8" }).status === 0) {
    const stage = path.join(dir, "stage", "objects", "b");
    fs.mkdirSync(stage, { recursive: true });
    fs.writeFileSync(path.join(stage, "f.bin"), "contents");
    fs.writeFileSync(path.join(dir, "stage", "manifest.json"), "{}");
    const tarFile = path.join(dir, "s.tar");
    spawnSync("tar", ["-cf", tarFile, "-C", path.join(dir, "stage"), "."]);
    const listed = spawnSync("tar", ["-tf", tarFile], { encoding: "utf8" }).stdout
      .split(/\r?\n/).map((l) => l.replace(/^\.\//, "").trim()).filter(Boolean);
    listed.includes("manifest.json") && listed.includes("objects/b/f.bin")
      ? ok("a tar built the same way lists the paths the manifest would name")
      : bad(`tar listing does not match the manifest's path shape: ${listed.join(", ")}`);
  } else {
    console.log("  \x1b[33mNOTE\x1b[0m tar is not on PATH here — the listing check was skipped");
  }
}

fs.rmSync(dir, { recursive: true, force: true });
console.log("");
console.log(
  failures === 0
    ? "\x1b[32mALL CHECKS PASSED\x1b[0m — the format round-trips, refuses tampering, and opens without this repo."
    : `\x1b[31m${failures} check(s) failed.\x1b[0m`
);
process.exit(failures === 0 ? 0 : 1);
