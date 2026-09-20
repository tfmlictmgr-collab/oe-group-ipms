// The public vendor-application form's anti-bot guards do not refuse humans.
//
// Written 20 Sept 2026 after a real application was refused. The honeypot was
// named `company_website_alt`; Chrome's address/contact autofill matches on
// tokens in the field name, "company" and "website" are two of them, and
// Chrome ignores autocomplete="off" on a form it reads as a contact form —
// which this is, asking for a business address, contact person, email and
// phone. The browser filled the hidden field for a real person and the server
// refused them: no visible field to clear, and a message that by design cannot
// say which control tripped.
//
// The claims that matter:
//   • the honeypot's name and id contain NO token browser autofill targets
//   • it is still off-screen, untabbable, and opted out of password managers
//   • Turnstile is verified BEFORE the honeypot and timing checks, because its
//     answer decides whether those two may refuse at all
//   • a request Turnstile vouched for is never refused by the honeypot or the
//     timing check — they log instead
//   • with Turnstile unconfigured, both still refuse: they are the only
//     control left
//   • a stale form is still refused unconditionally — that is correctness, not
//     a bot heuristic
//
// Source assertions, deliberately: exercising this for real needs a browser
// and a live Cloudflare challenge, and the failure being guarded against is a
// future edit to these two files.
//
// Usage: npx tsx scripts/verify-vendor-application-guards.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
let failures = 0;
const ok = (m) => console.log(`  \x1b[32mPASS\x1b[0m ${m}`);
const bad = (m) => { failures++; console.log(`  \x1b[31mFAIL\x1b[0m ${m}`); };

const form = fs.readFileSync(path.join(rootDir, "app/apply/[orgId]/ApplyForm.tsx"), "utf8");
const action = fs.readFileSync(path.join(rootDir, "app/apply/[orgId]/actions.ts"), "utf8");

console.log("The vendor-application guards do not refuse humans\n");

// ── A. The honeypot cannot attract autofill ───────────────────────────────
console.log("A. The honeypot's name");
{
  // Every token Chrome, Safari and Firefox use to recognise a contact/address
  // field. A honeypot named after any of them will be filled for a real user.
  const MAGNETS = [
    "name", "company", "organization", "organisation", "website", "url",
    "address", "street", "email", "phone", "tel", "mobile", "city", "town",
    "country", "postal", "zip", "fax", "given", "family", "cc-", "username",
  ];
  const m = form.match(/<input\s+id="([a-z0-9_-]+)"\s+name="([a-z0-9_-]+)"/i);
  if (!m) { bad("could not find the honeypot input"); }
  else {
    const [, id, name] = m;
    const hits = MAGNETS.filter((t) => id.includes(t) || name.includes(t));
    hits.length === 0
      ? ok(`"${name}" contains no autofill token`)
      : bad(`the honeypot is named "${name}" — browsers autofill on: ${hits.join(", ")}. This refuses real applicants.`);

    id === name
      ? ok("id and name agree")
      : bad(`id "${id}" and name "${name}" differ — the label's htmlFor will not match`);
  }

  /left-\[-9999px\]/.test(form)
    ? ok("still off-screen rather than display:none — bots skip hidden inputs")
    : bad("the honeypot is no longer positioned off-screen");
  /tabIndex=\{-1\}/.test(form) ? ok("untabbable") : bad("the honeypot is reachable by Tab");
  /autoComplete="off"/.test(form) ? ok('autoComplete="off" is set') : bad("autoComplete is not off");
  /data-1p-ignore/.test(form) && /data-lpignore/.test(form)
    ? ok("opted out of 1Password and LastPass, which ignore autoComplete=off")
    : bad("no password-manager opt-out — they fill hidden fields too");
}

// ── B. Turnstile decides first ────────────────────────────────────────────
console.log("\nB. Turnstile is asked before the heuristics may refuse");
{
  const iTs = action.indexOf("verifyTurnstile(");
  const iHp = action.indexOf("input.honeypot");
  iTs > -1 && iHp > -1 && iTs < iHp
    ? ok("verifyTurnstile runs before the honeypot check")
    : bad("the honeypot is evaluated before Turnstile — its answer cannot inform the decision");

  /const\s+vouched\s*=\s*!ts\.skipped/.test(action)
    ? ok("`vouched` distinguishes 'Cloudflare judged this' from 'Turnstile is off'")
    : bad("nothing distinguishes a verified request from an unconfigured one");
}

// ── C. A vouched request is never refused by the weak checks ──────────────
console.log("\nC. What happens when the honeypot trips");
{
  // The single helper is what makes this provable by reading: both call sites
  // go through it, and it returns null (allow) whenever `vouched`.
  const helper = action.match(/const tripped = \([\s\S]*?\n  \};/);
  if (!helper) { bad("the shared `tripped` helper is gone — the two checks may have diverged"); }
  else {
    const body = helper[0];
    /if \(vouched\)[\s\S]*?return null;/.test(body)
      ? ok("a vouched request is logged and allowed, not refused")
      : bad("a vouched request can still be refused by the honeypot");
    /return fail\(/.test(body)
      ? ok("an unvouched request is still refused — the control survives where it is the only one")
      : bad("the honeypot no longer refuses anything, even with Turnstile off");
  }

  const hpUses = [...action.matchAll(/tripped\("([^"]+)"/g)].map((m) => m[1]);
  hpUses.length === 2
    ? ok(`both weak checks go through it (${hpUses.join("; ")})`)
    : bad(`expected 2 checks through the helper, found ${hpUses.length}`);
}

// ── D. Correctness checks are not weakened ────────────────────────────────
console.log("\nD. What must still refuse unconditionally");
{
  const stale = action.match(/elapsed > MAX_FORM_AGE_MS\)\s*\{\s*return fail\(/);
  stale
    ? ok("a stale form is still refused however it arrived — correctness, not a heuristic")
    : bad("the stale-form check no longer refuses unconditionally");

  /if \(!ts\.ok\)\s*\{\s*return fail\("Bot check failed/.test(action)
    ? ok("a FAILED Turnstile challenge is still a hard refusal")
    : bad("a failed Turnstile challenge no longer refuses");
}

console.log(
  failures === 0
    ? "\n\x1b[32mAll vendor-application guard checks passed.\x1b[0m"
    : `\n\x1b[31m${failures} check(s) failed.\x1b[0m`
);
process.exit(failures === 0 ? 0 : 1);
