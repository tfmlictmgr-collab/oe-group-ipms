// Which Supabase world is `.env.local` pointing at, and may this script write
// to it?
//
// ⚠️ Why this exists. The seeding scripts now RE-ENABLE accounts: they lift an
// auth ban and clear `deactivated_at`, because since 0194/0195 a deactivated
// fixture is not a working login and "ensure a login for every role" has to
// mean the login works. Both of those are safe against a demo project and
// nothing like safe against production — every account they touch carries one
// hardcoded password, so pointed at the wrong world they do not seed a demo,
// they re-arm a set of known-password logins.
//
// `use-env.mjs` copies one of .env.{demo,dev,staging}.local over .env.local, so
// the safe set is exactly the URLs those files name. Read them rather than
// hardcoding project refs: an allowlist of refs in here goes stale the first
// time a project is rotated, and a stale allowlist fails in the dangerous
// direction. Production has no file in the repo at all — which is the point. It
// cannot be on the list, so it cannot pass.
import path from "node:path";
import { existsSync, readFileSync } from "node:fs";

const SAFE_FILES = [".env.demo.local", ".env.dev.local", ".env.staging.local"];

function urlIn(rootDir, file) {
  const p = path.join(rootDir, file);
  if (!existsSync(p)) return null;
  const m = readFileSync(p, "utf8").match(/^NEXT_PUBLIC_SUPABASE_URL=(.+)$/m);
  return m ? m[1].trim().replace(/^["']|["']$/g, "") : null;
}

/**
 * Exits the process unless NEXT_PUBLIC_SUPABASE_URL names a known
 * demo/dev/staging project. Returns the matching env filename so the caller can
 * say out loud which world it is about to write to — a script that seeds
 * silently is a script nobody double-checks.
 *
 * @param {string} rootDir repository root
 * @param {string} what one line on what this script does that needs the guard
 */
export function requireNonProductionTarget(rootDir, what) {
  const target = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const safe = SAFE_FILES.map((f) => [f, urlIn(rootDir, f)]).filter(([, u]) => u);
  const match = safe.find(([, u]) => u === target);

  if (!match) {
    console.error(
      "Refusing to run: .env.local does not point at a known demo/dev/staging project.\n" +
      `  target:  ${target ?? "(NEXT_PUBLIC_SUPABASE_URL unset)"}\n` +
      `  allowed: ${safe.map(([f]) => f).join(", ") || "(none found — no .env.*.local files)"}\n\n` +
      `  ${what}\n` +
      "  Switch first:  npm run use-env dev"
    );
    process.exit(1);
  }
  return match[0];
}
