// One unit row can stand for many units, and the bill knows it.
//
// 0198 let a single row represent 12 stalls. The number it added is not
// decoration: occupied space is recorded PER unit, so the row's weight in a
// service-charge apportionment is `space x quantity`. Recording the quantity
// while apportioning the single-unit area would give eleven stalls a free ride
// and redistribute their share across their neighbours — silently, and in a
// direction nobody chose.
//
// The claims:
//   • the pure function weights by quantity, and an absent/invalid quantity
//     resolves to 1 rather than erasing the row from the split
//   • a set of shares still sums EXACTLY to the budget once quantity is in play
//     — the rounding residual lands on the largest EFFECTIVE weight
//   • the database agrees with the TypeScript: property_summary.total_factor
//     equals sum(space x quantity), so the screen and the invoice cannot
//     disagree about what a property weighs
//   • the quantity is constrained to a positive whole number
//   • two rows of the same type coexist when described differently, and an
//     identical duplicate is still refused — the 0056 protection, re-keyed
//
// Usage: node scripts/verify-unit-quantity.mjs
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { apportion, effectiveFactor } from "../lib/apportionment.ts";

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

console.log("One row, many units — and the bill knows it\n");

// ── A. The weighting rule itself ──────────────────────────────────────────
console.log("A. Occupied space is per unit, so quantity multiplies it");
{
  effectiveFactor({ factor: 20, quantity: 12 }) === 240
    ? ok("12 stalls at 20 m² weigh 240 m², not 20")
    : bad(`12 x 20 gave ${effectiveFactor({ factor: 20, quantity: 12 })}`);

  effectiveFactor({ factor: 85.5, quantity: 1 }) === 85.5
    ? ok("an ordinary single flat is unchanged")
    : bad("a single flat's weight moved");

  // Every row written before 0198 has no quantity at all. If that read as 0
  // the row would vanish from the split and every neighbour would silently pay
  // more — the failure mode this default exists to prevent.
  effectiveFactor({ factor: 100, quantity: null }) === 100 &&
  effectiveFactor({ factor: 100, quantity: undefined }) === 100
    ? ok("an absent quantity means 1, so pre-0198 rows are untouched")
    : bad("an absent quantity does not resolve to 1");

  effectiveFactor({ factor: 100, quantity: 0 }) === 100 &&
  effectiveFactor({ factor: 100, quantity: -5 }) === 100
    ? ok("a zero or negative quantity resolves to 1 rather than erasing the row")
    : bad("a non-positive quantity does not fail safe");
}

// ── B. The split still balances ───────────────────────────────────────────
console.log("\nB. The shares still sum exactly to the budget");
{
  const units = [
    { id: "a", label: "Terrace", factor: 100, quantity: 1 },
    { id: "b", label: "Stall", factor: 20, quantity: 12 },   // weighs 240
    { id: "c", label: "Kiosk", factor: 33.33, quantity: 3 }, // weighs 99.99
  ];
  const budget = 10_000_000;
  const shares = apportion(budget, units);

  const sum = shares.reduce((s, x) => s + x.amount, 0);
  Math.abs(sum - budget) < 0.005
    ? ok(`three rows, 16 units, ₦${budget.toLocaleString()} splits to exactly ₦${sum.toLocaleString()}`)
    : bad(`the shares sum to ${sum}, not ${budget}`);

  const stalls = shares.find((x) => x.id === "b");
  const terrace = shares.find((x) => x.id === "a");
  stalls.amount > terrace.amount
    ? ok("12 stalls carry more than one terrace — the quantity reached the money")
    : bad("the stalls did not outweigh the terrace, so quantity was ignored");

  const totalWeight = 100 + 240 + 99.99;
  Math.abs(stalls.pct - 240 / totalWeight) < 1e-9
    ? ok("each share is its own weight over the total weight")
    : bad(`stall share was ${stalls.pct}, expected ${240 / totalWeight}`);
}

// ── C. A quantity that would have been silently ignored ───────────────────
console.log("\nC. The regression this exists to catch");
{
  // Precisely the pre-0198 behaviour: weight by `factor` alone.
  const units = [
    { id: "a", label: "Flat", factor: 50, quantity: 1 },
    { id: "b", label: "Stall", factor: 50, quantity: 9 },
  ];
  const shares = apportion(1000, units);
  const flat = shares.find((x) => x.id === "a");

  Math.abs(flat.amount - 500) > 0.005
    ? ok(`the single flat pays ₦${flat.amount} of ₦1,000, not the ₦500 an unweighted split would charge it`)
    : bad("the flat paid half — quantity is being ignored, which is the whole defect");
}

// ── D. The database agrees with the TypeScript ────────────────────────────
// The half that would otherwise drift. If property_summary sums the raw space
// while apportion() weights by quantity, the properties list and the invoice
// describe two different buildings, and the list is what someone trusts.
console.log("\nD. property_summary weights the same way");
{
  const { data: rows, error } = await svc
    .from("units")
    .select("property_id, apportionment_factor, unit_quantity")
    .is("deleted_at", null);

  if (error) {
    bad(`could not read units: ${error.message}`);
  } else {
    const expected = new Map();
    for (const u of rows ?? []) {
      const w = effectiveFactor({
        factor: Number(u.apportionment_factor),
        quantity: Number(u.unit_quantity ?? 1),
      });
      expected.set(u.property_id, (expected.get(u.property_id) ?? 0) + w);
    }

    const { data: summary, error: sErr } = await svc
      .from("property_summary")
      .select("id, name, unit_count, unit_total, total_factor");

    if (sErr) {
      bad(`could not read property_summary: ${sErr.message}`);
    } else {
      let mismatched = 0;
      for (const p of summary ?? []) {
        const want = expected.get(p.id) ?? 0;
        if (Math.abs(Number(p.total_factor) - want) > 0.005) {
          mismatched++;
          if (mismatched <= 3) {
            bad(`${p.name}: view says ${p.total_factor}, units say ${want}`);
          }
        }
      }
      mismatched === 0
        ? ok(`all ${(summary ?? []).length} properties: the view's total_factor equals space x quantity`)
        : bad(`${mismatched} propert(ies) disagree with the units beneath them`);

      const multi = (summary ?? []).filter((p) => Number(p.unit_total) > Number(p.unit_count));
      ok(
        multi.length > 0
          ? `${multi.length} propert(y/ies) hold a row standing for more than one unit`
          : "no multi-unit rows filed yet — unit_total equals unit_count everywhere, which is correct for pre-0198 data"
      );
    }
  }
}

// ── E. The constraints hold ───────────────────────────────────────────────
console.log("\nE. The database refuses what the form refuses");
{
  const { data: prop } = await svc
    .from("properties").select("id, org_id").is("deleted_at", null).limit(1).maybeSingle();

  if (!prop) {
    bad("no property to test constraints against");
  } else {
    const base = { org_id: prop.org_id, property_id: prop.id, apportionment_factor: 10 };
    const tag = `ZZ-probe-${Math.random().toString(36).slice(2, 7)}`;

    const { error: zeroErr } = await svc
      .from("units").insert({ ...base, label: tag, unit_quantity: 0 });
    zeroErr ? ok("a quantity of zero is refused") : bad("A QUANTITY OF ZERO WAS ACCEPTED");

    const { error: negErr } = await svc
      .from("units").insert({ ...base, label: tag, unit_quantity: -3 });
    negErr ? ok("a negative quantity is refused") : bad("A NEGATIVE QUANTITY WAS ACCEPTED");

    // Two of the same type, described differently — the ordinary case that the
    // pre-0198 index made impossible.
    const { error: firstErr } = await svc
      .from("units").insert({ ...base, label: tag, description: "Block A" });
    const { error: secondErr } = await svc
      .from("units").insert({ ...base, label: tag, description: "Block B" });
    !firstErr && !secondErr
      ? ok("two rows of one type coexist when described differently")
      : bad(`a building cannot hold two of one type: ${firstErr?.message ?? secondErr?.message}`);

    // ...but an identical row is still refused. This is 0056's protection.
    const { error: dupErr } = await svc
      .from("units").insert({ ...base, label: tag, description: "Block A" });
    dupErr
      ? ok("an identical duplicate is still refused — 0056's protection survives the re-key")
      : bad("AN IDENTICAL DUPLICATE WAS ACCEPTED — a property's share can now be doubled");

    await svc.from("units").delete().eq("property_id", prop.id).eq("label", tag);
    console.log("\n(probe rows removed)");
  }
}

console.log("");
if (failures > 0) {
  console.log(`\x1b[31m${failures} CHECK(S) FAILED\x1b[0m`);
  process.exit(1);
}
console.log("\x1b[32mALL CHECKS PASSED\x1b[0m — a row of twelve stalls pays for twelve stalls.");
