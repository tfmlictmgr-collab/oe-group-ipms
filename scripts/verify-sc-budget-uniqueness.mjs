// Audit 0805-C1 — one service-charge budget per property per period, enforced
// by the database rather than by a read-then-insert check in the action.
//
// The finding: `createBudget` SELECTs for a clashing budget and refuses if it
// finds one, but nothing holds the gap between that SELECT and its INSERT. Two
// submissions landing together both read "no clash" and both insert — and a
// duplicate budget is not a cosmetic extra row: `sc/[id]/actions.ts` apportions
// each budget across every unit and raises a real invoice per unit, so the
// second one bills every tenant in that property a second time through the
// ordinary path, with no error anywhere.
//
// Section C is the one that matters: it fires genuinely concurrent inserts and
// counts the survivors. It is written so that it FAILS against the pre-fix
// state — section E proves that claim rather than asserting it, by dropping
// the index, re-running the same race, and showing two rows land.
//
// Usage: node scripts/verify-sc-budget-uniqueness.mjs
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";
import { createClient } from "@supabase/supabase-js";
import pg from "pg";

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

const MARK = "PROBEC1";
const stamp = Date.now().toString(36).toUpperCase().slice(-5);
const INDEX = "sc_budgets_one_per_property_period_uidx";
const INDEX_DDL =
  `create unique index ${INDEX} on sc_budgets (property_id, lower(btrim(period)))`;

// Start-of-run sweep — a run that dies before its own cleanup must not leave
// debris the next run cannot see (the lesson from 0805's own stray-fixture
// findings).
{
  const { data: strays } = await svc
    .from("sc_budgets").select("id").like("description", `${MARK}%`);
  if (strays?.length) {
    await svc.from("sc_budgets").delete().in("id", strays.map((s) => s.id));
    console.log(`(swept ${strays.length} stray budget(s) left by an earlier run)`);
  }
}

// A real property to hang the fixtures on. Read, never created — this suite
// tests a constraint, not the property register.
const { data: prop, error: propErr } = await svc
  .from("properties").select("id, org_id").limit(1).single();
if (propErr) throw new Error(`could not load a property to test against: ${propErr.message}`);

const made = [];
const budget = (period, extra = {}) => ({
  org_id: prop.org_id,
  property_id: prop.id,
  period,
  description: `${MARK}-${stamp}`,
  total_amount: 1000,
  status: "draft",
  ...extra,
});

async function insert(period, extra) {
  const res = await svc.from("sc_budgets").insert(budget(period, extra)).select("id").single();
  if (res.data) made.push(res.data.id);
  return res;
}

/** Fire N inserts of the same period without awaiting between them. */
async function race(period, n = 4) {
  const results = await Promise.allSettled(
    Array.from({ length: n }, () =>
      svc.from("sc_budgets").insert(budget(period)).select("id").single()
    )
  );
  const won = [];
  for (const r of results) {
    const id = r.status === "fulfilled" ? r.value.data?.id : null;
    if (id) { won.push(id); made.push(id); }
  }
  return won;
}

const pgClient = new pg.Client({
  host: process.env.SUPABASE_DB_HOST,
  port: Number(process.env.SUPABASE_DB_PORT || 5432),
  database: process.env.SUPABASE_DB_NAME,
  user: process.env.SUPABASE_DB_USER,
  password: process.env.SUPABASE_DB_PASSWORD,
  ssl: { rejectUnauthorized: false },
});
await pgClient.connect();

try {
  console.log("\nA. The index exists, and is keyed on the NORMALISED period");
  {
    const { rows } = await pgClient.query(
      `select indexdef from pg_indexes where tablename = 'sc_budgets' and indexname = $1`,
      [INDEX]
    );
    rows.length === 1 ? ok("the unique index is present") : bad("the unique index is missing entirely");
    if (rows.length) {
      /lower\(btrim\(period\)\)/i.test(rows[0].indexdef)
        ? ok("keyed on lower(btrim(period)), so FY2026 and fy2026 cannot both exist")
        : bad(`keyed on the raw text, case variants still collide: ${rows[0].indexdef}`);
      /property_id/.test(rows[0].indexdef)
        ? ok("scoped to the property, not global")
        : bad("not scoped to property_id");
    }
  }

  console.log("\nB. A straightforward second budget for the same property + period is refused");
  {
    const first = await insert(`${stamp}-B`);
    first.error
      ? bad(`the FIRST budget should insert cleanly: ${first.error.message}`)
      : ok("the first budget for a period inserts cleanly");

    const second = await insert(`${stamp}-B`);
    second.error?.code === "23505"
      ? ok("the second is refused by the database with 23505, not silently accepted")
      : bad(`expected 23505, got ${second.error ? second.error.code + " " + second.error.message : "a successful insert"}`);
  }

  console.log("\nC. THE RACE — concurrent submissions produce exactly one budget");
  {
    const won = await race(`${stamp}-C`, 4);
    won.length === 1
      ? ok("4 simultaneous inserts, exactly 1 survived — the double-invoice is impossible")
      : bad(`expected exactly 1 winner, got ${won.length} — every unit of this property would be invoiced ${won.length} times`);

    const { count } = await svc
      .from("sc_budgets")
      .select("id", { count: "exact", head: true })
      .eq("property_id", prop.id).eq("period", `${stamp}-C`);
    count === 1
      ? ok("confirmed against the table itself: 1 row, not just 1 non-error response")
      : bad(`table holds ${count} rows for that period`);
  }

  console.log("\nD. Case and whitespace variants are the same period, not new ones");
  {
    await insert(`FY${stamp}`);
    const lower = await insert(`fy${stamp}`);
    lower.error?.code === "23505"
      ? ok("'fy…' is refused when 'FY…' exists — a human reads these as one period, and so does the index now")
      : bad(`case variant was accepted (${lower.error?.code ?? "no error"}) — 'FY' and 'fy' would both invoice`);

    const padded = await insert(`  FY${stamp}  `);
    padded.error?.code === "23505"
      ? ok("a whitespace-padded spelling is refused too")
      : bad(`padded variant was accepted (${padded.error?.code ?? "no error"})`);
  }

  console.log("\nE. The same race against the PRE-FIX state — proving section C tests something");
  {
    // Restoring in `finally` (not after the assertions) so a throw here can
    // never leave the dev database without its money guard.
    //
    // The duplicates this section deliberately creates must be removed BEFORE
    // the index is rebuilt — a unique index cannot be created over rows that
    // already violate it, so skipping this would leave the table permanently
    // unprotected and the failure would surface here rather than where the
    // damage was done.
    let preFixWinners = null;
    try {
      await pgClient.query(`drop index ${INDEX}`);
      preFixWinners = await race(`${stamp}-E`, 4);
    } finally {
      await pgClient.query(
        `delete from sc_budgets where property_id = $1 and period = $2`,
        [prop.id, `${stamp}-E`]
      );
      await pgClient.query(INDEX_DDL);
    }

    preFixWinners && preFixWinners.length > 1
      ? ok(`without the index the identical race wrote ${preFixWinners.length} budgets — the finding reproduced, so section C is a real test`)
      : bad(`expected the pre-fix race to write >1 budget, it wrote ${preFixWinners?.length ?? 0} — section C may be passing for the wrong reason`);

    const { rows } = await pgClient.query(
      `select 1 from pg_indexes where tablename = 'sc_budgets' and indexname = $1`, [INDEX]
    );
    rows.length === 1
      ? ok("the index was restored afterwards — the database is left protected")
      : bad("THE INDEX WAS NOT RESTORED — re-run `npm run migrate` before anything else");
  }

  console.log("\nF. The constraint is not over-broad");
  {
    const otherPeriod = await insert(`${stamp}-F-other`);
    otherPeriod.error
      ? bad(`a DIFFERENT period on the same property must still be allowed: ${otherPeriod.error.message}`)
      : ok("a different period on the same property is still allowed");

    const { data: otherProp } = await svc
      .from("properties").select("id, org_id").neq("id", prop.id).limit(1).maybeSingle();
    if (otherProp) {
      const res = await svc.from("sc_budgets").insert({
        org_id: otherProp.org_id, property_id: otherProp.id, period: `${stamp}-B`,
        description: `${MARK}-${stamp}`, total_amount: 1000, status: "draft",
      }).select("id").single();
      if (res.data) made.push(res.data.id);
      res.error
        ? bad(`the SAME period on a DIFFERENT property must be allowed: ${res.error.message}`)
        : ok("the same period on a different property is allowed — properties bill independently");
    } else {
      console.log("  (skipped the second-property check — only one property in this database)");
    }
  }

  console.log("\nG. Deleting a budget frees its period again (no soft-delete trap)");
  {
    const { data: row } = await svc.from("sc_budgets").select("id")
      .eq("property_id", prop.id).eq("period", `${stamp}-F-other`).single();
    await svc.from("sc_budgets").delete().eq("id", row.id);

    const again = await insert(`${stamp}-F-other`);
    again.error
      ? bad(`a period should be reusable once its budget is deleted: ${again.error.message}`)
      : ok("the period is reusable after deletion — sc_budgets is hard-deleted, so no dead row holds the slot");
  }
} finally {
  // ── Cleanup ──────────────────────────────────────────────────────────────
  if (made.length) await svc.from("sc_budgets").delete().in("id", made);
  const { data: left } = await svc
    .from("sc_budgets").select("id").like("description", `${MARK}%`);
  if (left?.length) await svc.from("sc_budgets").delete().in("id", left.map((r) => r.id));
  await pgClient.end();
  console.log("\n(cleaned up)");
}

console.log(
  failures === 0
    ? "\n\x1b[32mALL CHECKS PASSED\x1b[0m — one budget per property per period, enforced by the database; concurrent submissions cannot double-invoice a property."
    : `\n\x1b[31m${failures} CHECK(S) FAILED\x1b[0m`
);
process.exit(failures === 0 ? 0 : 1);
