// Every PostgREST embed the application actually asks for, run against the real
// schema.
//
// ⚠️ Written after a live 404. A user filled in the asset register, was
// redirected to the new asset, and got "This page could not be found" — for a
// row that existed, that they could read, and that RLS was perfectly happy to
// return.
//
// The cause was `PGRST201`. `assets` has TWO foreign keys to `properties` —
// `assets_property_id_fkey` and the composite `assets_property_same_org_fk`
// (0057) — so `properties(name, address)` is ambiguous and PostgREST refuses to
// guess. The asset LIST was broken the same way, and had been for as long as
// that constraint has existed.
//
// 📌 Two things made it invisible for so long, and both matter more than the
// bug:
//
//   1. The page discarded the error. `const { data: asset } = await ...` throws
//      the `error` half away, so a schema-level failure arrived as `null` and
//      became `notFound()`. The product said "this page does not exist" when it
//      meant "this query is malformed" — sending anyone debugging it to look
//      for a missing route.
//   2. No suite touched it. Every asset suite queries the table directly,
//      because that is what testing RLS needs. None of them asks for the
//      SHAPE the page asks for, so the join could break without a single check
//      going red.
//
// This closes (2): the embeds are extracted from the source and executed, so an
// ambiguous relationship fails here rather than in front of a user.
//
// Usage: node scripts/verify-embeds.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";
import { createClient } from "@supabase/supabase-js";

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
config({ path: path.join(rootDir, ".env.local") });

const svc = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);

let failures = 0;
const ok = (m) => console.log(`  \x1b[32mPASS\x1b[0m ${m}`);
const bad = (m) => { failures++; console.log(`  \x1b[31mFAIL\x1b[0m ${m}`); };

/** Walk the app and lib trees for .ts/.tsx sources. */
function sources(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === "node_modules" || e.name === ".next") continue;
      sources(p, out);
    } else if (/\.tsx?$/.test(e.name)) out.push(p);
  }
  return out;
}

// `.from("x")` … `.select("…")` — the select may sit on a later line, so the
// gap is allowed to span whitespace, comments and chained calls.
const CALL = /\.from\(\s*"([a-z_]+)"\s*\)[\s\S]{0,400}?\.select\(\s*(["'`])([\s\S]*?)\2/g;

const found = new Map();   // "table::select" -> [files]
for (const file of [...sources(path.join(rootDir, "app")), ...sources(path.join(rootDir, "lib"))]) {
  const src = fs.readFileSync(file, "utf8");
  for (const m of src.matchAll(CALL)) {
    const [, table, , select] = m;
    // Only selects containing an EMBED are interesting; a plain column list
    // cannot be ambiguous, and running every one of them would be noise.
    if (!/\w\s*\(/.test(select)) continue;
    // Template literals with interpolation cannot be replayed verbatim.
    if (select.includes("${")) continue;
    const key = `${table}::${select.replace(/\s+/g, " ").trim()}`;
    if (!found.has(key)) found.set(key, []);
    found.get(key).push(path.relative(rootDir, file).replace(/\\/g, "/"));
  }
}

console.log(`Embeds — every join the application asks for, against the real schema\n`);
console.log(`${found.size} distinct embed(s) found in app/ and lib/\n`);

for (const [key, files] of [...found.entries()].sort()) {
  const idx = key.indexOf("::");
  const table = key.slice(0, idx);
  const select = key.slice(idx + 2);

  // ⚠️ `limit(1)`, NOT `head: true`.
  //
  // The first version used `{ head: true, count: "exact" }` on the reasoning
  // that it resolves the join without returning rows. It does — but a HEAD
  // response carries NO BODY, so PostgREST's error document never arrives and
  // supabase-js hands back an error with an empty `message` and no `code`. All
  // four genuinely broken embeds therefore fell through to the "anything else"
  // branch and were printed as harmless NOTEs, and this suite reported ALL
  // CHECKS PASSED while looking straight at them.
  //
  // A row limit keeps the response cheap and the error document intact. An
  // empty table is not a risk here: an ambiguous or missing relationship is
  // rejected during planning, before any row is considered.
  const { error } = await svc.from(table).select(select).limit(1);

  if (!error) {
    ok(`${table} — ${select.length > 68 ? select.slice(0, 68) + "…" : select}`);
  } else if (error.code === "PGRST201") {
    // The one this suite exists for: more than one relationship, so PostgREST
    // refuses. Always a real break — the query cannot succeed for anybody.
    bad(
      `${table} (${files.join(", ")}): AMBIGUOUS EMBED — ${error.message.slice(0, 90)}\n` +
      `         ${error.hint ?? ""}`
    );
  } else if (error.code === "PGRST200") {
    bad(`${table} (${files.join(", ")}): NO SUCH RELATIONSHIP — ${error.message.slice(0, 100)}`);
  } else if (error.code === "42703" || /column .* does not exist/i.test(error.message)) {
    bad(`${table} (${files.join(", ")}): MISSING COLUMN — ${error.message.slice(0, 100)}`);
  } else {
    // Anything else (a permission quirk on a view, say) is reported but not
    // failed: this suite is about the SHAPE of the query, and inventing
    // failures outside that would make it noisy enough to be ignored.
    console.log(`  \x1b[33mNOTE\x1b[0m ${table}: ${error.code ?? "?"} ${error.message.slice(0, 80)}`);
  }
}

console.log(
  failures === 0
    ? "\n\x1b[32mALL CHECKS PASSED\x1b[0m — every embed resolves to exactly one relationship."
    : `\n\x1b[31m${failures} BROKEN EMBED(S)\x1b[0m — each one is a page that fails for every user.`
);
process.exit(failures === 0 ? 0 : 1);
