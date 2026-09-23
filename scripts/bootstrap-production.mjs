// Create the FIRST operator admin on a freshly-migrated production project.
//
// This is the single highest-risk moment of the cutover and until now it had no
// tooling. `0088` creates the operator org `oe-group` by migration, so the org
// is handled — but every script in this repository that creates a USER is a
// demo seeder, and `0208` records what `seed.mjs` does on the way past:
//
//     truncate table ... users, orgs restart identity cascade;
//
// which destroys `oe-group` and `sc-client`, two organisations a migration
// created and a migration will never re-create. So reaching for a seeder here
// does not merely add test data to production — it removes the control plane.
//
// ⚠️ This file imports NOTHING from seed.mjs or anything it touches. That is a
// deliberate constraint, not an accident of structure: the only safe
// relationship between this script and the seeders is no relationship.
//
// Usage:
//   node scripts/bootstrap-production.mjs --confirm <project-ref> --email you@oegroup.com
//   node scripts/bootstrap-production.mjs --confirm <project-ref> --email you@oegroup.com --reissue-link
//
// It is idempotent. A second run against a bootstrapped project creates
// nothing; pass --reissue-link if the first sign-in link expired.
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";
import { createClient } from "@supabase/supabase-js";

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
config({ path: path.join(rootDir, ".env.local") });

const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? null : argv[i + 1];
};
const has = (name) => argv.includes(`--${name}`);

const die = (msg) => { console.error(`\n${msg}\n`); process.exit(1); };
const ok = (m) => console.log(`  \x1b[32m✓\x1b[0m ${m}`);

// ── The world we are pointed at ─────────────────────────────────────────────
const URL_ = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
if (!URL_ || !KEY) die("NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in .env.local.");

const ref = URL_.match(/^https:\/\/([a-z0-9]{20})\.supabase\.co/i)?.[1];
if (!ref) die(`Cannot derive a Supabase project ref from NEXT_PUBLIC_SUPABASE_URL (${URL_}).`);

// ⚠️ Absolute, and deliberately without an escape hatch — the same shape
// `migrate.mjs` applies to the frozen demo, and for the same reason: there is
// no legitimate way for THIS script to run against a world that already has
// people in it. An environment variable somebody exports at 5am is not a
// safeguard.
const NEVER = {
  egqzjrmzxqqxrrqpdwbt: "the FROZEN POC DEMO project",
  uszwigxdvjlwcwkjsjmc: "the PHASE-1 DEV project",
  tjboghjzbalxwhhatogl: "the STAGING project",
};
if (NEVER[ref]) {
  die(
    `Refusing to bootstrap: ${ref} is ${NEVER[ref]}.\n\n` +
    `This script creates the first operator admin on an EMPTY production project.\n` +
    `Point .env.local at production (node scripts/use-env.mjs prod) and re-run.\n` +
    `There is no override.`
  );
}

// ── The operator types the ref, which proves they read it ───────────────────
const confirmed = flag("confirm");
if (confirmed !== ref) {
  die(
    `Refusing to bootstrap: --confirm did not match the project this .env.local points at.\n\n` +
    `  .env.local points at : ${ref}\n` +
    `  --confirm given      : ${confirmed ?? "(absent)"}\n\n` +
    `Re-run with --confirm ${ref} once you have checked that is production.`
  );
}

const email = (flag("email") ?? "").trim().toLowerCase();
if (!email || !email.includes("@")) die("--email <address> is required: the first operator admin's own address.");

const svc = createClient(URL_, KEY, { auth: { persistSession: false } });

console.log(`\nBootstrap production — project ${ref}\n`);

// ── Guard 1: the migrations have run, and the control plane exists ──────────
const { data: orgs, error: orgErr } = await svc
  .from("orgs").select("id, slug, name, is_platform_operator").is("deleted_at", null);
if (orgErr) die(`Cannot read orgs: ${orgErr.message}`);

const operator = (orgs ?? []).find((o) => o.is_platform_operator);
if (!operator) {
  die(
    `Refusing to bootstrap: no platform operator organisation.\n\n` +
    `Run the migrations first (npm run migrate). 0088 creates 'oe-group' and\n` +
    `marks it as the operator; without it there is nothing to attach an admin to.`
  );
}
ok(`operator org present: ${operator.slug} (${operator.name})`);

// ── Guard 2: orgs contains ONLY what the migrations created ────────────────
//
// Exactly two, per 0208: `oe-group` (the operator, 0088) and `sc-client` (the
// service-charge client, 0094). A third organisation means this project has
// been used — provisioned, seeded, or restored — and is not a fresh production
// target whatever its name says.
const EXPECTED = new Set(["oe-group", "sc-client"]);
const extra = (orgs ?? []).map((o) => o.slug).filter((s) => !EXPECTED.has(s));
if (extra.length > 0) {
  die(
    `Refusing to bootstrap: this project already has organisations the migrations did not create.\n\n` +
    `  unexpected: ${extra.join(", ")}\n\n` +
    `A freshly-migrated project holds exactly ${[...EXPECTED].join(" and ")} (0088, 0094).\n` +
    `Anything else means somebody has used this database. Bootstrapping it would add an\n` +
    `operator admin to a live world.`
  );
}
ok(`orgs are exactly what the migrations created (${(orgs ?? []).map((o) => o.slug).sort().join(", ")})`);

// ── Guard 3: nobody is here yet ────────────────────────────────────────────
//
// No migration creates a `users` row — every `insert into users` in
// supabase/migrations sits inside a function body (accept_invitation and its
// relatives), never a migration-time data step. Checked, not assumed. So on a
// freshly-migrated project this count is 0, and any other number means people
// are already using it.
const { count: userCount, error: uErr } = await svc
  .from("users").select("id", { count: "exact", head: true });
if (uErr) die(`Cannot count users: ${uErr.message}`);

const { data: authList, error: aErr } = await svc.auth.admin.listUsers({ perPage: 200 });
if (aErr) die(`Cannot list auth users: ${aErr.message}`);
const authUsers = authList?.users ?? [];

const existingAdmin = authUsers.find((u) => u.email?.toLowerCase() === email);

if ((userCount ?? 0) > 0 || authUsers.length > 0) {
  // Idempotence: if the ONLY thing here is the admin we were asked to create,
  // this is a re-run, not a populated world.
  const onlyOurs = (userCount ?? 0) <= 1 && authUsers.length === 1 && existingAdmin;
  if (!onlyOurs) {
    die(
      `Refusing to bootstrap: this project already has accounts.\n\n` +
      `  users table : ${userCount ?? "?"}\n` +
      `  auth users  : ${authUsers.length}\n\n` +
      `This script only ever runs on an empty production project. If these accounts are\n` +
      `expected, you are pointed at the wrong world.`
    );
  }

  console.log(`\n  Already bootstrapped — ${email} exists. Creating nothing.\n`);
  if (has("reissue-link")) {
    const link = await issueLink(existingAdmin.id);
    printLink(link, email, "Re-issued");
  } else {
    console.log(`  Pass --reissue-link if the first sign-in link expired.\n`);
  }
  process.exit(0);
}
ok("no users and no auth accounts — this project is empty");

// ── Create exactly one account ─────────────────────────────────────────────
//
// ⚠️ The password is random and is NEVER printed, stored, or transmitted.
// Nobody — including whoever runs this — ever learns it. The operator sets
// their own password through the one-time link below, which is strictly
// stronger than printing a temporary one to a terminal that may be logged,
// screen-shared, or scrolled back.
//
// `app_metadata` is not decoration: org, brand and role ride inside the SIGNED
// JWT and `middleware` stamps them onto the forwarded request. It is B1's
// second isolation layer, and it is admin-only writable, which is what makes
// the claim trustworthy.
const randomPassword = `${crypto.randomUUID()}${crypto.randomUUID()}`;
const { data: created, error: cErr } = await svc.auth.admin.createUser({
  email,
  password: randomPassword,
  email_confirm: true,
  app_metadata: { org_id: operator.id, delivery_brand: "direct", role: "admin" },
});
if (cErr) die(`Could not create the auth account: ${cErr.message}`);
const uid = created.user.id;
ok(`auth account created: ${email}`);

const { error: pErr } = await svc.from("users").insert({
  id: uid, org_id: operator.id, role: "admin", email, full_name: flag("name") ?? "Operator Admin",
});
if (pErr) {
  // Leave nothing half-created: an auth account with no profile can sign in and
  // resolve to no organisation, which is worse than no account at all.
  await svc.auth.admin.deleteUser(uid).catch(() => {});
  die(`Could not create the profile row, so the auth account was removed: ${pErr.message}`);
}
ok(`profile created: admin of ${operator.slug}`);

// ── Name the act in the trail ──────────────────────────────────────────────
//
// `actor_id` is null on purpose: this was done by a migration-time operator
// with no signed-in identity, which is the same shape 0287 used for its repair.
// The reason lives in after_state, because a trigger row shows WHAT changed and
// this one has to show WHY.
await svc.from("audit_log").insert({
  org_id: operator.id, actor_id: null,
  action: "operator.bootstrapped", entity_type: "user", entity_id: uid,
  before_state: null,
  after_state: {
    email, role: "admin", org: operator.slug,
    reason: "First operator admin created by scripts/bootstrap-production.mjs on an empty production project.",
    project_ref: ref, at: new Date().toISOString(),
  },
});
ok("recorded in the audit trail as operator.bootstrapped");

const link = await issueLink(uid);
printLink(link, email, "Created");

// ⚠️ Rewritten 22 Sept 2026, on the first real run of this script's happy
// path — which is also the last time it can be run, since a bootstrapped
// project is no longer empty. `verify-bootstrap.mjs` says in its own header
// that it proves the GUARDS and not this, for exactly that reason. This is
// what it could not cover.
//
// It previously called `svc.auth.admin.generateLink({ type: "recovery" })`.
// That issues a SUPABASE AUTH recovery link, which after verification
// redirects carrying its session in the URL **fragment**
// (`#access_token=...`). But `0139` deliberately built password reset on this
// application's OWN token path rather than Supabase Auth's, and
// `ConfirmResetForm.tsx:14` reads `params.get("token")` — a QUERY parameter,
// checked against `password_resets`. A fragment is not a query parameter and
// never reaches that code, so the link landed on "Missing reset link" every
// time.
//
// Two mechanisms for the same page, and the script used the one the page does
// not implement. So this now mints the app's own token: the identical shape
// `requestPasswordReset` produces, consumed by the identical
// `confirmPasswordReset` — 32 random bytes shown once, only its SHA-256 hash
// stored, so a database read alone can never be replayed as a working reset.
const RESET_TOKEN_BYTES = 32;
const RESET_EXPIRY_HOURS = 1;

async function issueLink(userId) {
  const site = process.env.NEXT_PUBLIC_SITE_URL?.trim();
  if (!site) {
    console.error(
      `\n  ⚠️  NEXT_PUBLIC_SITE_URL is not set, so there is nowhere to send you.\n\n` +
      `     Add it to .env.prod.local — NOT only to Vercel, which this script cannot\n` +
      `     read — then re-run with --reissue-link. The account is unaffected.\n`
    );
    process.exit(2);
  }

  // Re-issuing means the previous link stops working. Without this, every run
  // of --reissue-link would leave another live token granting a password
  // change on the operator account, and a link printed to a terminal an hour
  // ago is exactly the kind of thing that gets scrolled back to.
  await svc
    .from("password_resets")
    .update({ used_at: new Date().toISOString() })
    .eq("user_id", userId)
    .is("used_at", null);

  const token = crypto.randomBytes(RESET_TOKEN_BYTES).toString("base64url");
  const tokenHash = crypto.createHash("sha256").update(token).digest("hex");

  const { error } = await svc.from("password_resets").insert({
    user_id: userId,
    token_hash: tokenHash,
    expires_at: new Date(Date.now() + RESET_EXPIRY_HOURS * 3600_000).toISOString(),
  });
  if (error) {
    console.error(`\n  ⚠️  The account exists but a sign-in link could not be created: ${error.message}\n`);
    process.exit(2);
  }

  return `${site.replace(/\/$/, "")}/reset-password/confirm?token=${token}`;
}

function printLink(url, addr, verb) {
  console.log(
    `\n${verb} the first operator admin.\n\n` +
    `  ${addr}\n\n` +
    `ONE-TIME SIGN-IN LINK — shown once, stored nowhere:\n\n  ${url}\n\n` +
    `Open it within ${RESET_EXPIRY_HOURS} hour and set a password.\n` +
    `The account's current password is random and is known to nobody, including this script.\n` +
    `Re-running with --reissue-link invalidates this one and prints a fresh link.\n`
  );
}
