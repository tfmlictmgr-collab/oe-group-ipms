// The production bootstrap refuses everything it should.
//
// ⚠️ This suite proves the GUARDS, not the happy path, and that is deliberate.
// The happy path needs an empty production project, which by definition exists
// once and is then no longer empty. What can be proven on any world — and what
// actually matters — is that the script refuses to run on a world that has
// people in it, and that it cannot reach a seeder.
//
// Run it wherever you are. It creates nothing, writes nothing, and asserts that
// the script it tests does the same when pointed at a world like this one.
//
// Usage: node scripts/verify-bootstrap.mjs
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";
import { createClient } from "@supabase/supabase-js";

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
config({ path: path.join(rootDir, ".env.local") });

let failures = 0;
const ok = (m) => console.log(`  \x1b[32mPASS\x1b[0m ${m}`);
const bad = (m) => { failures++; console.log(`  \x1b[31mFAIL\x1b[0m ${m}`); };
const note = (m) => console.log(`  \x1b[33mNOTE\x1b[0m ${m}`);

/** Source with whole-line comments and block comments removed. */
const codeOnly = (text) =>
  text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split(/\r?\n/)
    .filter((l) => !/^\s*\/\//.test(l))
    .join("\n");

const SCRIPT = path.join(rootDir, "scripts", "bootstrap-production.mjs");
const src = fs.readFileSync(SCRIPT, "utf8");
const URL_ = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const ref = URL_.match(/^https:\/\/([a-z0-9]{20})\.supabase\.co/i)?.[1] ?? "";

/**
 * Run the bootstrap and hand back its exit code and combined output.
 *
 * `envOverride` replaces variables in the child's environment. It works
 * because `bootstrap-production.mjs` loads `.env.local` with plain `dotenv`,
 * which does NOT overwrite a variable already present in `process.env` — so a
 * value set here wins over the file.
 */
function run(args, envOverride = {}) {
  try {
    const out = execFileSync("node", [SCRIPT, ...args], {
      cwd: rootDir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...envOverride },
    });
    return { code: 0, out };
  } catch (e) {
    return { code: e.status ?? 1, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}

// ⚠️ A project ref that is deliberately NOT on the never-list (20 chars, the
// Supabase shape). Added 20 Sept 2026 after the first real run of this suite.
//
// The three flag guards below — --confirm missing, --confirm mismatched,
// --email missing — are UNREACHABLE on any world this suite is safe to run on,
// because `bootstrap-production.mjs` checks the never-list FIRST and dies
// there. Pointed at dev or staging, all three checks therefore observed the
// never-list refusal instead of the guard they name, and reported FAIL for a
// script that was behaving perfectly. The suite passed against stubs and could
// not have passed against a real world.
//
// So the flag guards are exercised against a world the never-list does not
// know, which is the only way to reach them.
//
// ⚠️ Every case below dies at a FLAG check, which happens before the first
// network call (`svc.from("orgs")`). Never pass this ref a matching --confirm
// AND an --email together: that combination passes every flag guard and would
// try to reach a project that does not exist.
const UNKNOWN_REF = "zzzzzzzzzzzzzzzzzzzz";
const asUnknownWorld = (args) =>
  run(args, { NEXT_PUBLIC_SUPABASE_URL: `https://${UNKNOWN_REF}.supabase.co` });

console.log("Production bootstrap — it refuses everything it should\n");

// ── A. It cannot be aimed at a world we know is not production ─────────────
console.log("A. The never-list");
{
  const never = [...src.matchAll(/^\s{2}([a-z0-9]{20}):\s*"([^"]+)"/gm)].map((m) => [m[1], m[2]]);
  never.length >= 3
    ? ok(`${never.length} world(s) are refused absolutely: ${never.map(([, n]) => n.replace(/^the /, "")).join(", ")}`)
    : bad(`the never-list has only ${never.length} entries — demo, dev and staging should all be in it`);

  // ⚠️ The two files must agree. `use-env.mjs` is where a new world gets added,
  // and a world added there but not here is a hole in this guard that nothing
  // else would report.
  //
  // ⚠️ Every world is read, not a named three (fixed 20 Sept 2026). This
  // previously matched `/(demo|dev|staging):/` — which is every world that
  // existed when it was written, and therefore could never catch the thing it
  // says it catches: a NEW world added to `use-env.mjs` and forgotten here
  // would not match the pattern, so the check would pass by not looking. A
  // guard against additions must not enumerate what exists today.
  const envSrc = fs.readFileSync(path.join(rootDir, "scripts", "use-env.mjs"), "utf8");
  const declared = [...envSrc.matchAll(/^\s{2}([a-z][a-z0-9_]*):\s*(?:"([a-z0-9]{20})"|null)/gm)]
    .map((m) => [m[1], m[2] ?? null]);

  // ⚠️ Prove the PARSE before trusting what it found. `WORLDS` in use-env.mjs
  // is the authoritative list of worlds; if the HOSTS parse above did not
  // account for every one of them, this check is reading a subset and would
  // pass by not looking — the same failure as the enumerated pattern it
  // replaced, arrived at a different way. A ref written with unexpected
  // indentation, or not exactly 20 characters, would do it.
  const worlds = envSrc.match(/const WORLDS = \[([^\]]*)\]/)?.[1];
  const worldNames = worlds ? [...worlds.matchAll(/"([a-z][a-z0-9_]*)"/g)].map((m) => m[1]) : [];
  const unparsed = worldNames.filter((w) => !declared.some(([n]) => n === w));
  worldNames.length > 0 && unparsed.length === 0
    ? ok(`every world use-env.mjs declares was parsed (${worldNames.join(", ")})`)
    : bad(
        worldNames.length === 0
          ? "could not read WORLDS from use-env.mjs — this check cannot confirm it saw every world"
          : `use-env.mjs declares worlds this check did not parse, so it is reading a subset: ${unparsed.join(", ")}`
      );

  // `prod` is the one world this script is FOR, so it must never be refused.
  const known = declared.filter(([n, r]) => n !== "prod" && r);
  const missing = known.filter(([, r]) => !never.some(([nr]) => nr === r));
  missing.length === 0
    ? ok(`every non-production world in use-env.mjs is on the never-list (${known.length} checked, of ${declared.length} declared)`)
    : bad(`use-env.mjs knows worlds the bootstrap would happily run on: ${missing.map(([n]) => n).join(", ")}`);

  // The mirror image, and the failure nobody would diagnose quickly: if prod's
  // ref ever reaches the never-list, this script refuses the only target it
  // exists to serve, and says the project is dev/demo/staging while doing it.
  const prodRef = declared.find(([n]) => n === "prod")?.[1];
  !prodRef || !never.some(([nr]) => nr === prodRef)
    ? ok("production is not on the never-list — the script can still reach its only valid target")
    : bad("use-env.mjs's prod ref is on the never-list: bootstrap-production.mjs would refuse production itself");

  src.includes("There is no override")
    ? ok("the refusal states it has no override")
    : bad("the never-list refusal offers an escape hatch — it should not");
}

// ── B. It cannot reach a seeder ────────────────────────────────────────────
console.log("\nB. No path to a seeder");
{
  // 0208: seed.mjs truncates users and orgs, destroying oe-group and sc-client
  // — two organisations a migration created and will never re-create. The only
  // safe relationship between this script and the seeders is no relationship.
  const imports = [...src.matchAll(/^import\s.*?from\s+["']([^"']+)["']/gm)].map((m) => m[1]);
  const local = imports.filter((i) => i.startsWith(".") || i.startsWith("/"));
  local.length === 0
    ? ok(`it imports only node and package modules (${imports.length} imports, 0 local)`)
    : bad(`it imports local modules, any of which could reach a seeder: ${local.join(", ")}`);

  /seed/i.test(src.replace(/^\s*\/\/.*$/gm, ""))
    ? bad("the word 'seed' appears in executable code, not just commentary")
    : ok("nothing in its executable code mentions a seeder");
}

// ── C. Pointed at THIS world, it refuses ───────────────────────────────────
console.log("\nC. Against the world this checkout is pointed at");
if (!ref) {
  note("no Supabase project in .env.local — cannot exercise the script");
} else {
  const probe = "bootstrap-probe@oegroup.test";

  // ⚠️ The flag guards are exercised against UNKNOWN_REF, not this world — see
  // its note above. Against dev or staging the never-list fires first and none
  // of these three could ever be observed.
  //
  // First, prove the premise rather than assuming it: if UNKNOWN_REF ever
  // reached the never-list, these three would silently go back to testing
  // nothing, which is exactly the failure being fixed here.
  !new RegExp(`^\\s{2}${UNKNOWN_REF}:`, "m").test(src)
    ? ok("the flag guards are exercised against a world the never-list does not know")
    : bad(`${UNKNOWN_REF} is on the never-list — the three checks below would test nothing`);

  const noConfirm = asUnknownWorld(["--email", probe]);
  noConfirm.code !== 0 && /--confirm/.test(noConfirm.out)
    ? ok("refuses without --confirm")
    : bad(`ran, or refused for the wrong reason, without --confirm: ${noConfirm.out.slice(0, 160)}`);

  const wrongConfirm = asUnknownWorld(["--confirm", "aaaaaaaaaaaaaaaaaaaa", "--email", probe]);
  wrongConfirm.code !== 0 && /did not match/.test(wrongConfirm.out)
    ? ok("refuses when --confirm names a different project")
    : bad(`accepted a --confirm that did not match the project .env.local names: ${wrongConfirm.out.slice(0, 160)}`);

  const noEmail = asUnknownWorld(["--confirm", UNKNOWN_REF]);
  noEmail.code !== 0 && /--email/.test(noEmail.out)
    ? ok("refuses without --email")
    : bad(`ran without being told whose account to create: ${noEmail.out.slice(0, 160)}`);

  // The real one: correct flags, wrong world.
  const armed = run(["--confirm", ref, "--email", probe]);
  if (armed.code === 0) {
    bad(`!!! IT RAN. With correct flags against ${ref} it exited 0 — this world was not refused`);
  } else if (/FROZEN POC DEMO|PHASE-1 DEV|STAGING project/.test(armed.out)) {
    ok("refuses this world by name — it is on the never-list");
  } else if (/already has organisations|already has accounts/.test(armed.out)) {
    ok("refuses this world because it already has organisations or accounts");
  } else if (/no platform operator/.test(armed.out)) {
    note("refused because no operator org exists here — run the migrations to exercise the later guards");
  } else {
    bad(`refused, but for a reason this suite does not recognise:\n         ${armed.out.trim().split("\n")[0]}`);
  }
}

// ── D. What it would create, described rather than created ─────────────────
console.log("\nD. The account it would create");
{
  src.includes("email_confirm: true") ? ok("the account is created already confirmed — no mail round-trip at cutover")
                                      : bad("the account would need email confirmation before first use");
  /app_metadata:\s*\{[^}]*org_id/.test(src) && /role:\s*"admin"/.test(src)
    ? ok("org, brand and role are stamped into app_metadata — B1's second isolation layer")
    : bad("app_metadata is not stamped, so the signed JWT would carry no org or role");
  // ⚠️ This read `/generateLink/.test(src)` until 22 Sept 2026, and when
  // `generateLink` was removed the check kept PASSING — because the word
  // survived in a comment explaining why it had gone. A regex over source
  // cannot tell code from prose, so an assertion worded as "this API is
  // called" is really "this string appears somewhere", which is a different
  // and much weaker claim. Asserted on the behaviour instead.
  /printLink\(/.test(src) && !new RegExp("console\\.log\\([^)]*randomPassword").test(src)
    ? ok("a one-time link is issued and the password is never printed")
    : bad("a password is printed, stored or transmitted somewhere");
  /operator\.bootstrapped/.test(src)
    ? ok("the act is written to the audit trail")
    : bad("nothing records that an operator admin was created");
  /deleteUser/.test(src)
    ? ok("a half-created account is rolled back rather than left able to sign in")
    : bad("a failed profile insert would leave an auth account resolving to no org");
}

// ── E. The link it issues is one the app can actually consume ──────────────
//
// ⚠️ Added 22 Sept 2026, after the first real run of the happy path this suite
// says it cannot cover. The script issued a SUPABASE AUTH recovery link, whose
// session arrives in the URL FRAGMENT; `0139` built password reset on this
// app's OWN token instead, and the confirm page reads a QUERY parameter. Two
// mechanisms for one page, and the script used the one the page does not
// implement — so every link it ever printed landed on "Missing reset link".
//
// Nothing compared the two ends, so nothing could have caught it. This does.
console.log("\nE. The link it issues is one the confirm page can read");
{
  const formPath = path.join(rootDir, "app", "reset-password", "confirm", "ConfirmResetForm.tsx");
  const actionsPath = path.join(rootDir, "app", "reset-password", "actions.ts");
  const form = fs.existsSync(formPath) ? fs.readFileSync(formPath, "utf8") : "";
  const actions = fs.existsSync(actionsPath) ? fs.readFileSync(actionsPath, "utf8") : "";

  // Prove the premise before trusting the comparison.
  form && actions
    ? ok("read the confirm page and the reset actions to compare against")
    : bad("could not read the confirm page or reset actions — every check below is vacuous");

  const readsQueryToken = /params\.get\(\s*"token"\s*\)/.test(form);
  readsQueryToken
    ? ok('the confirm page reads a QUERY parameter named "token"')
    : bad("the confirm page no longer reads ?token= — this suite's premise has changed");

  /\/reset-password\/confirm\?token=/.test(src)
    ? ok("the script builds a link with ?token= — the shape the page reads")
    : bad("the script does not build a ?token= link, so the page will say \"Missing reset link\"");

  // The regression itself, named so it cannot come back quietly.
  //
  // ⚠️ Tested against CODE, not the file. The check above this one was
  // rewritten today for exactly this reason, and writing this one naively
  // reproduced the fault within the hour: `bootstrap-production.mjs` now
  // carries a comment EXPLAINING that it no longer calls the recovery API,
  // and a regex over the whole file matched that sentence and failed. A
  // suite that cannot tell an explanation from an instruction will eventually
  // assert the opposite of what it means.
  //
  // Whole-line comments only: `https://` appears inside real strings here, so
  // stripping every `//` would mangle the code this is trying to read.
  !/auth\.admin\.generateLink/.test(codeOnly(src))
    ? ok("it does not use Supabase Auth's recovery link, whose session arrives in the fragment")
    : bad("auth.admin.generateLink is back: its session arrives in the URL fragment, which the confirm page cannot read");

  // The token must be storable and checkable by the SAME rule the app uses.
  // If the app changed its hashing, the bootstrap link would silently stop
  // working while both halves still looked correct on their own.
  const appHash = /createHash\("([a-z0-9]+)"\)/.exec(actions)?.[1];
  const scriptHash = /createHash\("([a-z0-9]+)"\)/.exec(src)?.[1];
  appHash && scriptHash && appHash === scriptHash
    ? ok(`both hash the token with ${appHash} — a link from the script is checkable by the app`)
    : bad(`hash mismatch: the app uses ${appHash ?? "(none found)"}, the script uses ${scriptHash ?? "(none found)"}`);

  /password_resets/.test(src)
    ? ok("the token is recorded in password_resets, which confirmPasswordReset reads")
    : bad("nothing is written to password_resets, so the token could never be redeemed");

  new RegExp("token_hash:").test(src) && !new RegExp("token:\\s*token").test(src)
    ? ok("only the HASH is stored — a database read alone cannot be replayed as a reset")
    : bad("the raw token appears to be stored, which makes a database read a working reset link");

  /\.is\("used_at", null\)/.test(src)
    ? ok("re-issuing invalidates the previous link rather than leaving two live")
    : bad("a re-issued link leaves the earlier one working, so an old terminal scrollback still grants a password change");
}

console.log(
  failures === 0
    ? "\n\x1b[32mALL CHECKS PASSED\x1b[0m — the bootstrap refuses every world it should, and cannot reach a seeder."
    : `\n\x1b[31m${failures} CHECK(S) FAILED\x1b[0m`
);
process.exit(failures === 0 ? 0 : 1);
