// The on-disk format a backup takes when it leaves this machine, and the only
// implementation of it.
//
// Extracted from `backup-database.mjs` on 23 Sept 2026, when
// `backup-storage.mjs` needed the same format. Copying it would have been
// faster and is the thing to avoid: two implementations of one file format
// diverge silently, and the way you find out is that a backup taken by one
// script cannot be read by the other — at the moment you are trying to read
// it, which is the moment you are already having a bad day.
//
// ⚠️ THE PASSPHRASE IS AS UNRECOVERABLE AS `GATEWAY_CREDENTIAL_KEY`. Lose it
// and the backup is a pile of random bytes. Escrow it the same way — sealed,
// two holders, written in the runbook — and never in the same envelope as the
// thing it protects.
//
// AES-256-GCM, key derived with scrypt from a passphrase. GCM is
// authenticated: a file altered by one byte fails to decrypt rather than
// decrypting into quiet nonsense.
//
// Layout: MAGIC(8) VERSION(1) SALT(16) IV(12) CIPHERTEXT… TAG(16, at the end)
// The tag trails because GCM only knows it once the last byte is encrypted,
// and the file is streamed rather than held in memory — a backup outgrows a
// buffer long before it outgrows a disk.
import fs from "node:fs";
import crypto from "node:crypto";
import readline from "node:readline";
import { pipeline } from "node:stream/promises";

export const MAGIC = Buffer.from("OEIPMSB1", "ascii");
export const HEADER_LEN = 37; // MAGIC + version + salt + iv
export const TAG_LEN = 16;

// N=2^15 costs 128*N*r = 32 MiB per derivation, which is deliberate — it is
// what makes guessing the passphrase expensive. `maxmem` must be raised to
// allow it: node defaults to exactly 32 MiB and refuses its own parameters.
const SCRYPT = { N: 1 << 15, r: 8, p: 1, keylen: 32, maxmem: 64 * 1024 * 1024 };

const deriveKey = (pass, salt) =>
  crypto.scryptSync(pass, salt, SCRYPT.keylen, {
    N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, maxmem: SCRYPT.maxmem,
  });

/**
 * Read a passphrase without echoing it. Throws rather than exiting, so the
 * calling script decides how to report it — these run in different contexts
 * and one of them may be mid-archive with a temporary file to clean up.
 */
export async function passphrase(confirm) {
  const fromEnv = process.env.BACKUP_PASSPHRASE;
  if (fromEnv) {
    console.log("  using BACKUP_PASSPHRASE from the environment");
    return fromEnv;
  }
  if (!process.stdin.isTTY) {
    throw new Error(
      "No passphrase. Run this in a terminal, or set BACKUP_PASSPHRASE for an unattended run."
    );
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
  if (a.length < 12) {
    throw new Error(
      "Use at least 12 characters. This is the only thing standing between the file and whoever finds it."
    );
  }
  if (!confirm) return a;
  const b = await ask("  again     : ");
  if (a !== b) throw new Error("The two passphrases do not match. Nothing has been written.");
  return a;
}

export async function encryptFile(src, dest, pass) {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", deriveKey(pass, salt), iv);
  const out = fs.createWriteStream(dest);
  out.write(Buffer.concat([MAGIC, Buffer.from([1]), salt, iv]));
  await pipeline(fs.createReadStream(src), cipher, out, { end: false });
  await new Promise((res, rej) => out.end(cipher.getAuthTag(), (e) => (e ? rej(e) : res())));
}

export async function decryptFile(src, dest, pass) {
  const total = fs.statSync(src).size;
  if (total < HEADER_LEN + TAG_LEN) {
    throw new Error(`${src} is too small to be a backup this script wrote.`);
  }
  const head = Buffer.alloc(HEADER_LEN);
  const fd = fs.openSync(src, "r");
  fs.readSync(fd, head, 0, HEADER_LEN, 0);
  const tag = Buffer.alloc(TAG_LEN);
  fs.readSync(fd, tag, 0, TAG_LEN, total - TAG_LEN);
  fs.closeSync(fd);
  if (!head.subarray(0, 8).equals(MAGIC)) {
    throw new Error(`${src} is not a backup this script wrote.`);
  }
  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    deriveKey(pass, head.subarray(9, 25)),
    head.subarray(25, HEADER_LEN)
  );
  decipher.setAuthTag(tag);
  await pipeline(
    fs.createReadStream(src, { start: HEADER_LEN, end: total - TAG_LEN - 1 }),
    decipher,
    fs.createWriteStream(dest)
  );
}

/** SHA-256 of a file, streamed. */
export function sha256File(file) {
  const hash = crypto.createHash("sha256");
  hash.update(fs.readFileSync(file));
  return hash.digest("hex");
}
