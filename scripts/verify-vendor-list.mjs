// The vendor register is searchable and sortable, and the rank means one thing.
//
// Exercises `lib/vendor-list.ts` — the SAME module the page imports, not a copy
// of its rules — against the org's real vendors and their real scores.
//
// The claims that matter:
//   • the score rank is fixed on the score ordering and does not move when the
//     list is re-sorted by name or by evaluation count
//   • an UNEVALUATED vendor sorts last in BOTH score directions. "Worst first"
//     asks about performance, and a vendor nobody has scored has not performed
//     badly — it has not been measured
//   • search matches the company name AND the trade, case-insensitively
//   • nothing a search or sort does can lose a vendor
//
// Usage: npx tsx scripts/verify-vendor-list.mjs [--world dev|staging]
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";
import { createClient } from "@supabase/supabase-js";

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const worldFlag = process.argv.indexOf("--world");
const world = worldFlag === -1 ? null : process.argv[worldFlag + 1];

const env = {};
config({
  path: path.join(rootDir, world ? `.env.${world}.local` : ".env.local"),
  processEnv: world ? env : process.env,
});
if (!world) Object.assign(env, process.env);

let failures = 0;
const ok = (m) => console.log(`  \x1b[32mPASS\x1b[0m ${m}`);
const bad = (m) => { failures++; console.log(`  \x1b[31mFAIL\x1b[0m ${m}`); };
const note = (m) => console.log(`  \x1b[33mNOTE\x1b[0m ${m}`);

console.log(`\x1b[1mWorld: ${world ?? ".env.local"}\x1b[0m`);

// ⚠️ MUST be run with `tsx`, not bare `node` — it imports a `.ts` module, and
// that is the whole point: this exercises the rules the page SHIPS rather than
// a paraphrase of them. `npm run verify` uses tsx for every suite, and
// verify-all's own header records why (three other suites are in the same
// position).
const { filterVendors, sortVendors, VENDOR_SORTS } = await import("../lib/vendor-list.ts");

const svc = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

const { data: orgs } = await svc.from("orgs").select("id, slug").is("deleted_at", null);
const oea = orgs.find((o) => o.slug === "oea");
if (!oea) { console.log("\x1b[31mno OEA org\x1b[0m"); process.exit(1); }

const [{ data: vendorRows }, { data: scored }] = await Promise.all([
  svc.from("vendors").select("id, name, service_category").eq("org_id", oea.id).order("name"),
  svc.from("vendor_evaluation_tickets").select("vendor_id, composite_score"),
]);

const byVendor = new Map();
for (const r of scored ?? []) {
  const list = byVendor.get(r.vendor_id) ?? [];
  list.push(r.composite_score);
  byVendor.set(r.vendor_id, list);
}

// Mirrors the page's own derivation: nulls discarded, not counted as zero.
const avgOf = (scores) => {
  const real = (scores ?? []).map(Number).filter((n) => Number.isFinite(n));
  return real.length ? real.reduce((a, b) => a + b, 0) / real.length : null;
};

const base = (vendorRows ?? []).map((v) => {
  const scores = byVendor.get(v.id) ?? [];
  return {
    id: v.id,
    name: v.name,
    serviceCategory: v.service_category,
    avg: avgOf(scores),
    count: scores.length,
  };
});

const ranked = [...base].sort((a, b) => (b.avg ?? -1) - (a.avg ?? -1))
  .map((v, i) => ({ ...v, rank: i + 1 }));

console.log(`\n\x1b[1m§A The register\x1b[0m`);
ranked.length > 0
  ? ok(`${ranked.length} vendor(s), ${ranked.filter((v) => v.avg != null).length} of them evaluated`)
  : note("no vendors in this org — the checks below have nothing to bite on");
if (!ranked.length) process.exit(0);

// ── B. Nothing is lost ──────────────────────────────────────────────────────
console.log(`\n\x1b[1m§B No sort or search loses a vendor\x1b[0m`);
for (const key of Object.keys(VENDOR_SORTS)) {
  const out = sortVendors(ranked, key);
  out.length === ranked.length && new Set(out.map((v) => v.id)).size === ranked.length
    ? ok(`${key}: all ${out.length} vendors still present, none duplicated`)
    : bad(`${key}: returned ${out.length} of ${ranked.length}`);
}
{
  const out = filterVendors(ranked, "");
  out.length === ranked.length
    ? ok("an empty search returns everything")
    : bad(`an empty search returned ${out.length} of ${ranked.length}`);
}

// ── C. The rank does not move ───────────────────────────────────────────────
console.log(`\n\x1b[1m§C The rank means one thing\x1b[0m`);
{
  const byScore = sortVendors(ranked, "score_desc");
  const byName = sortVendors(ranked, "name_asc");
  const rankOf = (list) => new Map(list.map((v) => [v.id, v.rank]));
  const a = rankOf(byScore), b = rankOf(byName);
  const moved = [...a.entries()].filter(([id, r]) => b.get(id) !== r);
  moved.length === 0
    ? ok("every vendor keeps the same rank when the list is re-sorted by name")
    : bad(`${moved.length} vendor(s) changed rank when sorted by name — the badge is a row index`);

  // And the score order really is the rank order.
  const scoredOnly = byScore.filter((v) => v.avg != null);
  const monotonic = scoredOnly.every((v, i) => i === 0 || scoredOnly[i - 1].rank < v.rank);
  monotonic
    ? ok("ranks ascend down the score ordering (1 is the best-scoring vendor)")
    : bad("the score ordering does not agree with the ranks");
}

// ── D. Unevaluated is not 'worst' ───────────────────────────────────────────
console.log(`\n\x1b[1m§D An unevaluated vendor is not the worst vendor\x1b[0m`);
{
  const unscored = ranked.filter((v) => v.avg == null);
  if (!unscored.length) {
    note("every vendor here is evaluated — nothing to place");
  } else {
    for (const key of ["score_asc", "score_desc"]) {
      const out = sortVendors(ranked, key);
      const firstUnscored = out.findIndex((v) => v.avg == null);
      const lastScored = out.map((v) => v.avg != null).lastIndexOf(true);
      firstUnscored > lastScored
        ? ok(`${key}: all ${unscored.length} unevaluated vendor(s) sort after every scored one`)
        : bad(`${key}: an unevaluated vendor appears at position ${firstUnscored + 1}, before a scored one`);
    }
  }
}

// ── E. Search ───────────────────────────────────────────────────────────────
console.log(`\n\x1b[1m§E Search matches the name and the trade\x1b[0m`);
{
  const sample = ranked[0];
  const frag = sample.name.slice(0, Math.min(4, sample.name.length));
  const byName = filterVendors(ranked, frag.toUpperCase());
  byName.some((v) => v.id === sample.id)
    ? ok(`"${frag.toUpperCase()}" finds ${sample.name} — case-insensitive on the name`)
    : bad(`"${frag}" did not find ${sample.name}`);

  const withTrade = ranked.find((v) => v.serviceCategory);
  if (withTrade) {
    const hits = filterVendors(ranked, withTrade.serviceCategory.toUpperCase());
    hits.some((v) => v.id === withTrade.id)
      ? ok(`"${withTrade.serviceCategory}" finds vendors by trade`)
      : bad(`trade "${withTrade.serviceCategory}" matched nothing`);
  } else {
    note("no vendor carries a service category");
  }

  filterVendors(ranked, "zzz-no-such-vendor-zzz").length === 0
    ? ok("a search matching nothing returns nothing (rather than everything)")
    : bad("a non-matching search returned rows");
}

// ── F. The sort does not mutate its input ───────────────────────────────────
console.log(`\n\x1b[1m§F The caller's array is not reordered\x1b[0m`);
{
  const before = ranked.map((v) => v.id).join(",");
  sortVendors(ranked, "name_desc");
  sortVendors(ranked, "evaluations");
  const after = ranked.map((v) => v.id).join(",");
  before === after
    ? ok("sorting leaves the source array untouched — it is a React prop")
    : bad("sortVendors mutated its input; the prop array was reordered");
}

console.log(
  failures === 0
    ? "\n\x1b[32mAll checks passed.\x1b[0m"
    : `\n\x1b[31m${failures} check(s) failed.\x1b[0m`
);
process.exit(failures === 0 ? 0 : 1);
