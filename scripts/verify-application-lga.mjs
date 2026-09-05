// The LGA is chosen from the state above it, and the applicant can say something.
//
// The claims that matter:
//   • all 774 LGAs are present, across 37 states, with no duplicates — a
//     partial list is decision 20's "sample, not a set" and sends the applicant
//     back to free text
//   • every key in the LGA map matches a state the form actually offers; a key
//     that does not match yields an EMPTY dropdown rather than an error
//   • an LGA resolves only for its own state, so the form cannot offer Ikeja
//     under Kano
//   • changing the state clears an LGA that no longer belongs to it — the
//     impossible pair a dependent dropdown manufactures if nobody writes it
//   • the applicant's written statement is a plain form field: it saves, it
//     survives a resume, and the REVIEWER can see it
//   • it is not compulsory, so it cannot block the completeness check
//
// Usage: node scripts/verify-application-lga.mjs
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";
import { createClient } from "@supabase/supabase-js";
import fs from "node:fs";
// ⚠️ `nigeria-lgas.ts` is imported for real — it has no imports of its own, so
// Node's type-stripper resolves it. `application-form.ts` is NOT: it imports
// `./nigeria-lgas` extensionless, which the stripper refuses (the same
// pre-existing limitation that stops verify-reconciliation running), and
// adding an extension to production source to satisfy a test is the wrong way
// round. Its schema is asserted from the source text instead — which for the
// reviewer-page check below is what we would have to do anyway.
import { LGA_BY_STATE, lgasFor, lgaBelongsTo, TOTAL_LGAS } from "../lib/nigeria-lgas.ts";

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
config({ path: path.join(rootDir, ".env.local") });

let failures = 0;
const ok = (m) => console.log(`  \x1b[32mPASS\x1b[0m ${m}`);
const bad = (m) => { failures++; console.log(`  \x1b[31mFAIL\x1b[0m ${m}`); };

const svc = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);

// ── A ──────────────────────────────────────────────────────────────────────
console.log("\n\x1b[1m§A The set is closed, and complete\x1b[0m");
TOTAL_LGAS === 774
  ? ok("774 local government areas — the constitutional set, entire")
  : bad(`${TOTAL_LGAS} LGAs, expected 774; a partial list sends the applicant back to free text`);

Object.keys(LGA_BY_STATE).length === 37
  ? ok("across 37 states — the 36 plus the FCT")
  : bad(`${Object.keys(LGA_BY_STATE).length} states, expected 37`);

let dupes = 0;
for (const [state, list] of Object.entries(LGA_BY_STATE)) {
  const seen = new Set();
  for (const l of list) { if (seen.has(l)) { dupes++; bad(`${state} lists "${l}" twice`); } seen.add(l); }
  if (list.length === 0) bad(`${state} has no LGAs at all`);
}
dupes === 0 ? ok("no state repeats an LGA") : null;

// ⚠️ The failure this catches is silent: a key that does not match a state the
// form offers produces an EMPTY dropdown, not an error. The applicant just
// cannot proceed, and nothing anywhere says why.
const formSrc = fs.readFileSync(path.join(rootDir, "lib/application-form.ts"), "utf8");
const statesBlock = formSrc.slice(formSrc.indexOf("const NIGERIAN_STATES = ["));
const offeredStates = [...statesBlock.slice(0, statesBlock.indexOf("];")).matchAll(/"([^"]+)"/g)].map((m) => m[1]);
const lgaSrc = formSrc.slice(formSrc.indexOf('key: "lga"'), formSrc.indexOf('key: "lga"') + 400);
const lgaField = {
  type: /type:\s*"(\w+)"/.exec(lgaSrc)?.[1],
  optionsFrom: /optionsFrom:\s*"(\w+)"/.exec(lgaSrc)?.[1],
};
const unmatched = Object.keys(LGA_BY_STATE).filter((k) => !offeredStates.includes(k));
const uncovered = offeredStates.filter((s) => !LGA_BY_STATE[s]);
unmatched.length === 0
  ? ok("every LGA key names a state the form offers")
  : bad(`LGA keys matching no offered state: ${unmatched.join(", ")}`);
uncovered.length === 0
  ? ok("and every offered state has an LGA list")
  : bad(`states offered with no LGAs: ${uncovered.join(", ")}`);

// ── B ──────────────────────────────────────────────────────────────────────
console.log("\n\x1b[1m§B The LGA is decided by the state\x1b[0m");
lgaField?.type === "select"
  ? ok("the LGA field is a select, not free text")
  : bad(`the LGA field is "${lgaField?.type}" — the spellings come back`);
lgaField?.optionsFrom === "state_of_origin"
  ? ok("and takes its options from the state of origin above it")
  : bad(`optionsFrom is "${lgaField?.optionsFrom}", expected state_of_origin`);

lgasFor("Lagos").includes("Ikeja")
  ? ok("Lagos offers Ikeja")
  : bad("Lagos does not offer Ikeja");
!lgasFor("Kano").includes("Ikeja")
  ? ok("and Kano does not — the pair the old free-text field could not prevent")
  : bad("Kano offers Ikeja");
lgasFor("FCT — Abuja").length === 6
  ? ok("the FCT offers its 6 area councils, under the exact key the form uses")
  : bad(`FCT resolves ${lgasFor("FCT — Abuja").length} entries, expected 6`);
lgasFor("Nowhere").length === 0 && lgasFor(null).length === 0
  ? ok("an unknown or absent state offers nothing rather than everything")
  : bad("an unknown state resolved options");

// ── C ──────────────────────────────────────────────────────────────────────
//
// The impossible pair. This is what the form's `set()` uses to decide whether
// to clear the LGA when the state changes.
console.log("\n\x1b[1m§C Changing the state drops an LGA that no longer fits\x1b[0m");
lgaBelongsTo("Lagos", "Ikeja")
  ? ok("Ikeja belongs to Lagos, so choosing Lagos keeps it")
  : bad("Ikeja rejected under Lagos");
!lgaBelongsTo("Kano", "Ikeja")
  ? ok("Ikeja does NOT belong to Kano, so switching to Kano clears it")
  : bad("Ikeja accepted under Kano — the form would submit a pair that exists nowhere");
lgaBelongsTo("Kano", "")
  ? ok("an empty LGA is always acceptable — clearing is not a validation failure")
  : bad("an empty LGA was rejected");

// ── D ──────────────────────────────────────────────────────────────────────
console.log("\n\x1b[1m§D The applicant can say something, and it is read\x1b[0m");
const stmtSrc = formSrc.slice(formSrc.indexOf("APPLICANT_STATEMENT_FIELD"));
const stmtBlock = stmtSrc.slice(0, stmtSrc.indexOf("};") + 2);
const STMT_KEY = /key:\s*"([^"]+)"/.exec(stmtBlock)?.[1];
/type:\s*"textarea"/.test(stmtBlock) && !/required:\s*true/.test(stmtBlock)
  ? ok("the statement is optional free text, beside the documents it explains")
  : bad("the statement is required or is not a textarea");

// ⚠️ NOT sensitive. Decision 10's `sensitive` column is for special-category
// data stored apart and never sent to a model; a free-text box cannot be
// classified in advance by a flag, so the field asks narrowly instead.
!/sensitive:\s*true/.test(stmtBlock)
  ? ok("and is not flagged sensitive — a flag cannot predict what someone types")
  : bad("the statement is flagged sensitive, which mis-stores every ordinary note");
/health, religious/i.test(stmtBlock)
  ? ok("its hint asks the applicant not to volunteer special-category detail")
  : bad("the hint does not steer the applicant away from sensitive detail");

// It must not become compulsory — that would block the completeness check the
// screening job runs, on a field nobody has to fill.
// The screening job builds its compulsory list from the SECTIONS; the statement
// belongs to none, so it can never enter that list. Asserted by its absence
// from every section body rather than by re-deriving the job's logic.
!formSrc.slice(0, formSrc.indexOf("APPLICANT_STATEMENT_FIELD")).includes(STMT_KEY)
  ? ok("it is not compulsory, so the completeness check cannot fail on it")
  : bad("the statement appears inside a section — the screening job would demand it");

// And the reviewer's page must actually render it. The page walks `sections`,
// and this field is in none of them, so the check is that the source names it
// explicitly rather than that it happens to appear.
const reviewerPage = fs.readFileSync(
  path.join(rootDir, "app/dashboard/people/tenancy/[id]/page.tsx"), "utf8");
reviewerPage.includes("APPLICANT_STATEMENT_FIELD")
  ? ok("the reviewer's page renders it explicitly — it belongs to no section")
  : bad("the reviewer's page never reads the statement; the applicant writes into a void");

// ── E ──────────────────────────────────────────────────────────────────────
//
// The round trip: it is an ordinary key in `form`, so it saves and resumes with
// everything else and needs no column of its own.
console.log("\n\x1b[1m§E It survives the draft it is written in\x1b[0m");
const { data: orgs } = await svc.from("orgs").select("id, slug").is("deleted_at", null);
const oea = orgs.find((o) => o.slug === "oea");
const S = Date.now().toString(36).toUpperCase().slice(-5);
const statement = "Attaching a tenancy reference in my maiden name; the ID is in my married name.";
const { data: app, error } = await svc.from("tenant_applications").insert({
  org_id: oea.id, type: "individual", status: "draft",
  applicant_name: `Probe LGA ${S}`, applicant_email: `probe-lga-${S}@example.com`,
  consent_given_at: new Date().toISOString(), consent_statement: "probe consent",
  form: { state_of_origin: "Lagos", lga: "Ikeja", [STMT_KEY]: statement },
}).select("id, form").single();

if (error) {
  bad(`could not write the draft: ${error.message}`);
} else {
  app.form.lga === "Ikeja" && app.form.state_of_origin === "Lagos"
    ? ok("the state and its LGA round-trip through the draft together")
    : bad("the state/LGA pair did not survive the write");
  app.form[STMT_KEY] === statement
    ? ok("and the statement with them, as an ordinary form key")
    : bad("the statement did not survive the write");
  lgaBelongsTo(app.form.state_of_origin, app.form.lga)
    ? ok("and the stored pair is one that actually exists")
    : bad("a stored pair that exists nowhere");
  await svc.from("tenant_applications").delete().eq("id", app.id);
  console.log("\n(cleaned up)");
}

console.log(
  failures
    ? `\n\x1b[31m✖ ${failures} check(s) failed\x1b[0m`
    : "\n\x1b[32m✔ LGA and applicant statement: all checks passed\x1b[0m"
);
process.exit(failures ? 1 : 0);
