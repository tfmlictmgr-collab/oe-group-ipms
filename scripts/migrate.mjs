// Migration runner: applies every .sql file in supabase/migrations in filename
// order, skipping any already recorded in the _migrations ledger. Idempotent —
// safe to re-run.
//
//   node scripts/migrate.mjs                    → whatever .env.local points at
//   node scripts/migrate.mjs --world staging    → .env.staging.local, directly
//
// ⚠️ **Prefer `--world`.** `use-env.mjs` migrates a different world by REWRITING
// `.env.local`, and that file is not this script's private property — a running
// `next dev` reads it too. On 25 Aug 2026 switching it to staging mid-session
// redirected a live dev server there for four minutes and wrote ~18 audit rows
// into a world nobody meant to touch. That is the third stale-environment
// incident in this repo (see INCIDENT_2026-08-05_PROD_ALIAS and
// INCIDENT_2026-08-06_DEMO_DB_MIGRATED).
//
// 📌 The lesson is not "be careful with use-env". It is that **a tool needing a
// different world should read that world's file, not edit the shared one.**
// Mutating global state to parameterise one command is the mechanism at fault,
// and `--world` removes the need for it.
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
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
  console.error(
    `Missing ${envFile}.\n` +
    (world
      ? "  It holds that world's secrets and is gitignored — create it from that " +
        "project's own dashboard, never by copying another world's file."
      : "  Point it at a world first:  npm run use-env dev")
  );
  process.exit(1);
}

// ⚠️ Read into a private object rather than process.env when a world is named.
// dotenv does not overwrite variables that are already set, so a `--world`
// run inside a shell that happens to carry SUPABASE_DB_* would silently apply
// to whatever those name — the 6 Aug failure in a new costume.
const env = {};
config({ path: envPath, processEnv: world ? env : process.env });
if (!world) Object.assign(env, process.env);

console.log(`Migrating: ${envFile}\n`);

const client = new pg.Client({
  host: env.SUPABASE_DB_HOST,
  port: Number(env.SUPABASE_DB_PORT || 5432),
  database: env.SUPABASE_DB_NAME,
  user: env.SUPABASE_DB_USER,
  password: env.SUPABASE_DB_PASSWORD,
  ssl: { rejectUnauthorized: false },
});

const migrationsDir = path.join(rootDir, "supabase", "migrations");
const files = readdirSync(migrationsDir)
  .filter((f) => f.endsWith(".sql"))
  .sort();

// Two files once shared the number 0040. Nothing broke — they still sorted
// deterministically, and both were recorded — but the ordering between them was
// then decided by the rest of the filename rather than by intent, and the next
// person to add "0040_something" would have had no warning. Migrations are
// applied once, in order, forever; ambiguity about that order is not a thing to
// leave lying around.
//
// Suffixed numbers (0040a, 0040b) are fine and deliberate: they state the order.
// Two files claiming the SAME identifier are not.
{
  const byNumber = new Map();
  for (const f of files) {
    const id = f.match(/^(\d+[a-z]?)_/)?.[1];
    if (!id) {
      throw new Error(`Migration "${f}" does not start with a number — it cannot be ordered.`);
    }
    if (byNumber.has(id)) {
      throw new Error(
        `Two migrations claim "${id}": ${byNumber.get(id)} and ${f}.\n` +
        `Give one a suffixed number (e.g. ${id}a, ${id}b) so the order is stated rather than inferred.\n` +
        `If either has already been applied, rename its row in _migrations to match.`
      );
    }
    byNumber.set(id, f);
  }
}

// ── The two halves of .env.local must describe the SAME Supabase project ────
//
// This runner connects with SUPABASE_DB_*. Everything else in the codebase —
// the app itself, every verify-*.mjs suite — connects with
// NEXT_PUBLIC_SUPABASE_URL. Nothing ever compared them, and on 6 Aug 2026 they
// silently disagreed on PC2: the REST half pointed at the Phase-1 dev project,
// the SUPABASE_DB_* half at the frozen POC demo project. A routine
// `npm run migrate` therefore applied 117 migrations (0011–0109) to the demo
// database, which had deliberately sat at 0010 since 24 July, while the
// database the app actually uses received nothing.
//
// Both failure directions are silent and neither is obvious from the output:
// migrating the wrong database looks exactly like a successful catch-up, and
// the fix you just wrote appears to have been applied when it has not.
//
// So: derive the project ref from each half and refuse to run when they
// disagree. A direct connection carries it as `db.<ref>.supabase.co`; a pooled
// one carries it in the username as `postgres.<ref>`. If either ref cannot be
// derived (a local Postgres, a self-hosted instance) this says nothing and
// proceeds — the check exists to catch a mismatch it can actually prove, not
// to insist on one topology.
{
  const restRef = (env.NEXT_PUBLIC_SUPABASE_URL ?? "")
    .match(/^https:\/\/([a-z0-9]{20})\.supabase\.co/i)?.[1];

  const dbHost = env.SUPABASE_DB_HOST ?? "";
  const dbUser = env.SUPABASE_DB_USER ?? "";
  const dbRef =
    dbHost.match(/^db\.([a-z0-9]{20})\.supabase\.co$/i)?.[1] ??
    dbUser.match(/^postgres\.([a-z0-9]{20})$/i)?.[1];

  // ── The frozen POC demo project is never a migration target ──────────────
  //
  // The check below is RELATIONAL: it refuses when the two halves disagree. It
  // says nothing when they AGREE on the wrong project — and a `.env.local` with
  // both halves pointing at the demo database would sail straight through it,
  // re-violating Standing Rule #1 by a different route than the one that
  // actually happened on 6 Aug. Raised as a residual gap in build audit 0806
  // and closed here.
  //
  // Deliberately absolute and deliberately without an escape hatch: there is no
  // legitimate reason for this checkout to migrate the frozen demo. If that
  // ever genuinely changes, it should be a considered edit to this list with a
  // reason attached, not an environment variable somebody exports at 5am.
  const FROZEN_DEMO_REF = "egqzjrmzxqqxrrqpdwbt";
  if (restRef === FROZEN_DEMO_REF || dbRef === FROZEN_DEMO_REF) {
    throw new Error(
      `Refusing to migrate: ${FROZEN_DEMO_REF} is the FROZEN POC DEMO project.\n\n` +
      `  SUPABASE_DB_*            -> ${dbRef ?? "(underivable)"}\n` +
      `  NEXT_PUBLIC_SUPABASE_URL -> ${restRef ?? "(underivable)"}\n\n` +
      `That database backs the live demo at oe-group-ipms.vercel.app and is deliberately\n` +
      `held at an old schema. It was migrated by accident once already (see\n` +
      `docs/INCIDENT_2026-08-06_DEMO_DB_MIGRATED.md); this check exists so that cannot\n` +
      `recur through a .env.local whose two halves AGREE on the wrong project.\n\n` +
      `Point .env.local at the Phase-1 project and re-run. There is no override.`
    );
  }

  if (restRef && dbRef && restRef !== dbRef) {
    const escape = "ALLOW_MIGRATE_TARGET_MISMATCH";
    if (process.env[escape] !== "1") {
      throw new Error(
        `Refusing to migrate: .env.local points at two different Supabase projects.\n\n` +
        `  SUPABASE_DB_*            -> ${dbRef}   (this runner would write HERE)\n` +
        `  NEXT_PUBLIC_SUPABASE_URL -> ${restRef}   (the app and every verify script read HERE)\n\n` +
        `Migrating ${dbRef} would change a database nothing else in this checkout talks to,\n` +
        `and would leave ${restRef} — the one the app serves — without these migrations.\n\n` +
        `Fix .env.local so both halves name the same project, then re-run.\n` +
        `If the split is genuinely intended, set ${escape}=1 to proceed.`
      );
    }
    console.warn(
      `WARNING: migrating ${dbRef} while the app reads ${restRef} (${escape}=1 was set).`
    );
  }
}

await client.connect();
try {
  await client.query(
    `create table if not exists _migrations (name text primary key, applied_at timestamptz not null default now());`
  );

  // Adopt pre-ledger migrations: if the core schema already exists (0001 ran
  // before this ledger did), record 0001/0002 as applied without re-running.
  const { rows: hasOrgs } = await client.query(
    `select to_regclass('public.orgs') is not null as exists;`
  );
  if (hasOrgs[0].exists) {
    await client.query(
      `insert into _migrations (name) values ('0001_init_schema.sql'), ('0002_realtime_tickets.sql') on conflict do nothing;`
    );
  }

  const { rows: applied } = await client.query(`select name from _migrations;`);
  const appliedSet = new Set(applied.map((r) => r.name));

  for (const file of files) {
    if (appliedSet.has(file)) {
      console.log(`Skipping ${file} (already applied).`);
      continue;
    }
    const sql = readFileSync(path.join(migrationsDir, file), "utf8");
    console.log(`Applying ${file}...`);
    await client.query("begin");
    try {
      await client.query(sql);
      await client.query(`insert into _migrations (name) values ($1);`, [file]);
      await client.query("commit");
      console.log(`  done.`);
    } catch (e) {
      await client.query("rollback");
      throw e;
    }
  }
} finally {
  await client.end();
}
