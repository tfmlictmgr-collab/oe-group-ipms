// Which database credential actually authenticates — and which does not.
//
//   node scripts/check-db-connection.mjs --world prod
//   node scripts/check-db-connection.mjs               → whatever .env.local points at
//
// Written on 21 Sept 2026, at Stage 3.3, after `npm run migrate` against the
// new production project failed twice with `28P01 password authentication
// failed for user "postgres"` while every local check on the backing file came
// back clean — 16 characters in, 16 characters out, no `#`, no quoting, no
// stray whitespace.
//
// 📌 That is the shape of failure this script exists for. `migrate.mjs` is a
// migration runner: when it cannot connect, it says so and stops, which is
// correct for a migration runner and useless as a diagnosis. Its message
// cannot distinguish a wrong password from a right password against the wrong
// port, a stale pooler, or a tenant that resolved to somewhere else — and
// re-running it to find out means pointing the real migrator at production
// again, on a guess, which is the one thing a cutover should not be doing.
//
// So: connect, several plausible ways, report which combinations the server
// accepts, and write nothing. It never prints the password, it never issues
// anything but `select 1`, and it is safe to run against any world at any
// time.
import path from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";
import pg from "pg";

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const worldFlag = process.argv.indexOf("--world");
const world = worldFlag === -1 ? null : process.argv[worldFlag + 1];
if (worldFlag !== -1 && !world) {
  console.error("--world needs a value: demo | dev | staging | prod");
  process.exit(1);
}

const envFile = world ? `.env.${world}.local` : ".env.local";
const envPath = path.join(rootDir, envFile);
if (!existsSync(envPath)) {
  console.error(`Missing ${envFile}.`);
  process.exit(1);
}

// Into a private object, never process.env — the same reasoning migrate.mjs
// gives: a `--world` run inside a shell that happens to carry SUPABASE_DB_*
// would otherwise test whatever those name rather than the file asked for.
const env = {};
config({ path: envPath, processEnv: env });

const ok = (m) => console.log(`  \x1b[32mPASS\x1b[0m ${m}`);
const bad = (m) => console.log(`  \x1b[31mFAIL\x1b[0m ${m}`);
const note = (m) => console.log(`  \x1b[33mNOTE\x1b[0m ${m}`);

const host = env.SUPABASE_DB_HOST ?? "";
const user = env.SUPABASE_DB_USER ?? "";
const password = env.SUPABASE_DB_PASSWORD ?? "";
const database = env.SUPABASE_DB_NAME || "postgres";
const configuredPort = Number(env.SUPABASE_DB_PORT || 5432);

console.log(`Database connectivity — ${envFile}\n`);

// ── What the file says, without saying the secret ───────────────────────────
console.log("A. What the file describes");
const restRef = (env.NEXT_PUBLIC_SUPABASE_URL ?? "").match(/^https:\/\/([a-z0-9]{20})\.supabase\.co/i)?.[1];
const userRef = user.match(/^postgres\.([a-z0-9]{20})$/i)?.[1];
const hostRef = host.match(/^db\.([a-z0-9]{20})\.supabase\.co$/i)?.[1];
const pooled = /\.pooler\.supabase\.com$/i.test(host);

console.log(`  host     : ${host || "(unset)"}`);
console.log(`  port     : ${configuredPort}`);
console.log(`  user     : ${user || "(unset)"}`);
console.log(`  database : ${database}`);
console.log(`  password : ${password ? `${password.length} characters` : "(unset)"}`);
console.log("");

password
  ? ok("a password is present")
  : bad("no password — nothing below can succeed");

// The two halves must agree, for the reason migrate.mjs documents at length:
// on 6 Aug 2026 they silently named different projects and 117 migrations went
// to the wrong database.
const dbRef = userRef ?? hostRef;
if (restRef && dbRef) {
  restRef === dbRef
    ? ok(`both halves name the same project (${dbRef})`)
    : bad(`the two halves DISAGREE: REST says ${restRef}, the DB credential says ${dbRef}`);
} else {
  note("could not derive a ref from one half — cannot compare the two");
}

// A pooler host wants `postgres.<ref>`; a direct host wants plain `postgres`.
// Crossing them is the documented `tenant/user not found` of BUILD_AUDIT_0806.
if (pooled && !userRef) {
  bad(`a pooler host wants the tenant in the username ("postgres.${restRef ?? "<ref>"}"), but the user is "${user}"`);
} else if (!pooled && hostRef && userRef) {
  bad(`a direct host wants a plain "postgres" username, but the user carries a tenant ("${user}")`);
} else if (pooled) {
  ok("pooler host paired with a tenant-qualified username");
}

// ⚠️ Corrected 21 Sept 2026. This first read "6543 is transaction mode —
// migrate.mjs issues explicit BEGIN/COMMIT and needs SESSION mode", which is
// wrong twice over: Supavisor's transaction mode DOES support explicit
// transactions (it pins the server connection for their duration), and what it
// actually withholds is session state held BETWEEN transactions, which this
// runner holds none of. The claim mattered because the very case this script
// exists to find — 5432 refused, 6543 accepted — ends with an operator setting
// 6543 on purpose, and being told that is broken when it is not.
//
// It is still worth flagging rather than passing silently, because the port
// affects more than the migrator: `pg_dump` in backup-database.mjs does want
// session mode.
if (pooled && configuredPort === 6543) {
  note("port 6543 is TRANSACTION mode. Fine for migrate.mjs — each migration commits with its");
  note("  own ledger row, so an interruption leaves a clean prefix and re-running resumes — but");
  note("  set it back to 5432 afterwards, because pg_dump in backup-database.mjs wants session mode.");
} else if (pooled && configuredPort === 5432) {
  ok("port 5432 — session mode, which is what pg_dump needs and the migrator is happy with");
}

// ── Does the server accept it ───────────────────────────────────────────────
//
// Several attempts, because the point is to LOCATE the failure rather than
// re-observe it. If 5432 is refused and 6543 is accepted with the identical
// credential, the password is right and the problem is the port or the pooler
// mode — a completely different fix from "reset the password again".
async function attempt(label, overrides) {
  const client = new pg.Client({
    host, port: configuredPort, database, user, password,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 15000,
    ...overrides,
  });
  try {
    await client.connect();
    await client.query("select 1");
    await client.end();
    return { ok: true };
  } catch (e) {
    try { await client.end(); } catch { /* already down */ }
    return { ok: false, code: e.code, message: e.message };
  }
}

console.log("\nB. What the server says");

const attempts = [
  [`as configured (port ${configuredPort})`, {}],
];
// Only worth trying the other pooler port when this is a pooler host at all.
if (pooled && configuredPort !== 6543) attempts.push(["same credential on port 6543 (transaction mode)", { port: 6543 }]);
if (pooled && configuredPort !== 5432) attempts.push(["same credential on port 5432 (session mode)", { port: 5432 }]);

const results = [];
for (const [label, overrides] of attempts) {
  const r = await attempt(label, overrides);
  results.push([label, r]);
  r.ok ? ok(`${label} — connected, select 1 returned`)
       : bad(`${label} — ${r.code ?? "no code"}: ${r.message}`);
}

// ── What that combination means ─────────────────────────────────────────────
console.log("\nC. Reading that");

const primary = results[0][1];
const anyOk = results.some(([, r]) => r.ok);
const authFailures = results.filter(([, r]) => r.code === "28P01");

if (primary.ok) {
  console.log("  The configured credential works. If a migration still fails, the");
  console.log("  cause is downstream of connecting — read that error on its own terms.");
} else if (anyOk && authFailures.length > 0) {
  console.log("  The PASSWORD IS CORRECT — one port accepted it, and a wrong password");
  console.log("  cannot authenticate anywhere. Do NOT reset it again.");
  console.log("");
  console.log("  Supavisor runs session mode (5432) and transaction mode (6543) as");
  console.log("  separate services, each caching tenant credentials. The usual reason one");
  console.log("  accepts a credential the other refuses is that a recent password reset");
  console.log("  has reached one and not yet the other. Wait ten minutes and re-run this");
  console.log("  script before changing anything.");
  console.log("");
  console.log("  If it persists, run the migration on the port that works and set the");
  console.log("  port back to 5432 afterwards — see the note in section A.");
} else if (authFailures.length === results.length) {
  console.log("  Every attempt was refused with 28P01, which is the server saying the");
  console.log("  password is wrong — not the file being malformed, since the value was");
  console.log("  read and sent. The usual causes, in order:");
  console.log("");
  console.log("    1. The reset dialog was never confirmed, so the old password stands.");
  console.log("    2. The password was copied from the CONNECTION STRING, where it is");
  console.log("       percent-encoded, rather than from the reset dialog.");
  console.log("    3. The reset has not yet reached the pooler. Wait a minute, retry.");
  console.log("");
  console.log("  Reset it once more from the dashboard, copy from the dialog itself,");
  console.log("  paste straight into the backing file, and re-run this script — NOT");
  console.log("  the migrator. Nothing here writes.");
} else {
  console.log("  Not an authentication failure — so the password is not the thing to");
  console.log("  change. Read the code above:");
  console.log("");
  console.log("    ENOTFOUND            the hostname is wrong or does not resolve.");
  console.log("    'timeout expired'    the host resolved but never answered — most");
  console.log("    / ETIMEDOUT          often a db.<ref>.supabase.co direct host on an");
  console.log("                         IPv4-only network, since direct connections are");
  console.log("                         IPv6-only without the paid add-on. Use the pooler.");
  console.log("    Tenant or user       the ref in the username names no project this");
  console.log("    not found            pooler serves — check the region in the host.");
}

console.log("");
process.exit(results[0][1].ok ? 0 : 1);
