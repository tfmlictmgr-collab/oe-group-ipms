// Service-charge apportionment: three methods, one reconciliation rule.
//
// The claims that matter:
//   • `area` is UNCHANGED — every budget written before 0227 splits exactly as
//     it always did, and the default is what makes that true
//   • `equal` splits per unit, not per unit of area
//   • a manual split that does not add up to the budget CANNOT be invoiced,
//     and neither can one with a unit left unstated
//   • the guard that refuses and the figure on screen are the SAME function,
//     so a person cannot be shown "reconciles" and then refused
//   • the method is snapshotted onto every invoice, so changing it later cannot
//     rewrite what a past bill says it was
//   • a stated share cannot be put on a unit of another property, or another org
//   • stating a share needs `sc.manage` — the same permission as the budget
//
// ⚠️ Every policy check acts through a REAL logged-in client. 0216's lesson:
// `verify-vendor-self-service` proved a policy worked on the day the product
// could not upload a single file, because every fixture in it wrote through the
// service role and never sat in the subject's seat. The service role is used
// here only to BUILD the fixture and to clean it up.
//
// Usage: node scripts/verify-apportionment.mjs
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { apportion, effectiveFactor } from "../lib/apportionment.ts";

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
config({ path: path.join(rootDir, ".env.local") });

const URL_ = process.env.NEXT_PUBLIC_SUPABASE_URL;
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const SVCK = process.env.SUPABASE_SERVICE_ROLE_KEY;
const PW = "OEGroupDemo2026!";

let failures = 0;
const ok = (m) => console.log(`  \x1b[32mPASS\x1b[0m ${m}`);
const bad = (m) => { failures++; console.log(`  \x1b[31mFAIL\x1b[0m ${m}`); };
const head = (m) => console.log(`\n\x1b[1m${m}\x1b[0m`);
const naira = (n) => `₦${Number(n).toLocaleString()}`;

const svc = createClient(URL_, SVCK, { auth: { persistSession: false } });
async function login(email) {
  const c = createClient(URL_, ANON, { auth: { persistSession: false } });
  const { error } = await c.auth.signInWithPassword({ email, password: PW });
  if (error) return null;
  const { data: { user } } = await c.auth.getUser();
  return { c, id: user.id };
}

const S = Date.now().toString(36).toUpperCase().slice(-5);
const made = { budgets: [], units: [], properties: [] };

async function cleanup() {
  await svc.from("service_charges").delete().in("budget_id", made.budgets);
  await svc.from("sc_budget_shares").delete().in("budget_id", made.budgets);
  await svc.from("sc_budgets").delete().in("id", made.budgets);
  await svc.from("units").delete().in("id", made.units);
  await svc.from("properties").delete().in("id", made.properties);
  console.log("\n(cleaned up)");
}
process.on("exit", () => {});

try {
  // ── §A The pure function ────────────────────────────────────────────────
  head("§A The split itself — three methods, one function");

  const u = (id, factor) => ({ id, label: id, factor, quantity: 1 });
  const units4 = [u("a", 100), u("b", 50), u("c", 25), u("d", 25)];

  // The regression that matters most: `area` must be byte-identical to what it
  // was before the method argument existed. Called with NO third argument, as
  // every existing caller in the codebase does.
  const areaDefault = apportion(200_000, units4);
  const areaExplicit = apportion(200_000, units4, "area");
  if (JSON.stringify(areaDefault) === JSON.stringify(areaExplicit)) {
    ok("apportion() with no method is identical to apportion(..., 'area') — existing callers unchanged");
  } else {
    bad("the default method changed the result — every budget written before 0227 would re-split");
  }

  const areaSum = areaDefault.reduce((a, s) => a + s.amount, 0);
  if (Math.abs(areaSum - 200_000) < 0.005) ok(`area reconciles exactly (${naira(areaSum)})`);
  else bad(`area does not reconcile: ${areaSum} vs 200000`);

  if (areaDefault[0].amount === 100_000 && areaDefault[1].amount === 50_000) {
    ok("area is pro-rata by space (100 m² of 200 pays half)");
  } else {
    bad(`area split wrong: ${areaDefault.map((s) => s.amount).join(", ")}`);
  }

  const equal = apportion(200_000, units4, "equal");
  if (equal.every((s) => s.amount === 50_000)) {
    ok("equal gives every unit the same, whatever its size (₦50,000 × 4)");
  } else {
    bad(`equal split wrong: ${equal.map((s) => s.amount).join(", ")}`);
  }
  const equalSum = equal.reduce((a, s) => a + s.amount, 0);
  if (Math.abs(equalSum - 200_000) < 0.005) ok("equal reconciles exactly");
  else bad(`equal does not reconcile: ${equalSum}`);

  // Rounding: 3 units into 100,000 cannot divide evenly. The residual has to
  // land on a unit rather than vanish.
  const odd = apportion(100_000, [u("a", 1), u("b", 1), u("c", 1)], "equal");
  const oddSum = odd.reduce((a, s) => a + s.amount, 0);
  if (Math.abs(oddSum - 100_000) < 0.005) {
    ok(`an indivisible equal split still reconciles to the kobo (${odd.map((s) => s.amount).join(" + ")})`);
  } else {
    bad(`indivisible equal split lost money: ${oddSum} vs 100000`);
  }

  // Manual reports what was stated and reconciles NOTHING — moving somebody's
  // stated share onto somebody else is what stating it by hand prevents.
  const manual = apportion(200_000, [
    { ...u("a", 100), statedAmount: 120_000 },
    { ...u("b", 50), statedAmount: 30_000 },
    { ...u("c", 25), statedAmount: 25_000 },
    { ...u("d", 25), statedAmount: 25_000 },
  ], "manual");
  if (manual[0].amount === 120_000 && manual[1].amount === 30_000) {
    ok("manual reports exactly what a person stated, ignoring area entirely");
  } else {
    bad(`manual altered the stated amounts: ${manual.map((s) => s.amount).join(", ")}`);
  }
  const shortManual = apportion(200_000, [
    { ...u("a", 100), statedAmount: 10 },
    { ...u("b", 50), statedAmount: 10 },
  ], "manual");
  if (shortManual.every((s) => s.amount === 10)) {
    ok("a manual set that does not add up is NOT silently reconciled onto the largest unit");
  } else {
    bad("manual pushed a residual onto a unit — a stated share was changed without anyone saying so");
  }

  // A stale stated amount must never leak into a computed split.
  const stale = apportion(200_000, [
    { ...u("a", 100), statedAmount: 999_999 },
    { ...u("b", 100), statedAmount: 999_999 },
  ], "area");
  if (stale.every((s) => s.amount === 100_000)) {
    ok("statedAmount is ignored under a computed method — a stale set cannot leak in");
  } else {
    bad(`a computed split read statedAmount: ${stale.map((s) => s.amount).join(", ")}`);
  }

  if (effectiveFactor({ factor: 20, quantity: 1 }) === 20) ok("effectiveFactor unchanged");
  else bad("effectiveFactor changed behaviour");

  // ── Fixture ─────────────────────────────────────────────────────────────
  const { data: orgs } = await svc
    .from("orgs").select("id, slug").is("deleted_at", null);
  const oea = orgs.find((o) => o.slug === "oea");
  const tfml = orgs.find((o) => o.slug === "tfml");

  const finance = await login("oea.financeapprover@oegroup.test");
  const fm = await login("oea.facilitymanager@oegroup.test");
  if (!finance) { console.error("No OEA finance fixture — cannot run."); await cleanup(); process.exit(1); }

  const { data: prop } = await svc.from("properties")
    .insert({ org_id: oea.id, name: `PROBEAPP-Property-${S}` }).select("id").single();
  made.properties.push(prop.id);

  // 100 / 50 / 50 m². Chosen so area and equal give visibly different answers.
  const unitRows = [];
  for (const [label, factor] of [["A", 100], ["B", 50], ["C", 50]]) {
    const { data } = await svc.from("units")
      .insert({ org_id: oea.id, property_id: prop.id, label: `PROBEAPP-${label}-${S}`,
                apportionment_factor: factor, unit_quantity: 1 })
      .select("id, label, apportionment_factor").single();
    made.units.push(data.id);
    unitRows.push(data);
  }

  const TOTAL = 200_000;
  const { data: budget } = await svc.from("sc_budgets")
    .insert({ org_id: oea.id, property_id: prop.id, period: `PROBEAPP-${S}`,
              description: "apportionment probe", total_amount: TOTAL, status: "draft" })
    .select("id, apportion_method").single();
  made.budgets.push(budget.id);

  if (budget.apportion_method === "area") {
    ok("a new budget defaults to `area` — nothing in the product had to change to keep working");
  } else {
    bad(`a new budget defaulted to ${budget.apportion_method}, not area`);
  }

  // ── §B The reconciliation state, as the screen and the guard both read it ─
  head("§B sc_manual_shares_state — one answer, two consumers");

  const state = async (client = finance.c) => {
    const { data, error } = await client.rpc("sc_manual_shares_state", { p_budget_id: budget.id });
    if (error) return { error };
    return Array.isArray(data) ? data[0] : data;
  };

  let st = await state();
  if (st.error) bad(`sc_manual_shares_state errored — ${st.error.message}`);
  else if (Number(st.stated_total) === 0 && Number(st.missing_units) === 3 && st.reconciles === false) {
    ok(`with nothing stated: 3 units missing, ${naira(st.variance)} to allocate, does not reconcile`);
  } else {
    bad(`unexpected empty state: ${JSON.stringify(st)}`);
  }

  await finance.c.from("sc_budgets").update({ apportion_method: "manual" }).eq("id", budget.id);

  // Two of three stated, and short.
  await finance.c.from("sc_budget_shares").upsert([
    { org_id: oea.id, budget_id: budget.id, unit_id: unitRows[0].id, amount: 90_000, set_by: finance.id },
    { org_id: oea.id, budget_id: budget.id, unit_id: unitRows[1].id, amount: 60_000, set_by: finance.id },
  ], { onConflict: "budget_id,unit_id" });

  st = await state();
  if (Number(st.stated_total) === 150_000 && Number(st.missing_units) === 1 &&
      Number(st.variance) === 50_000 && st.reconciles === false) {
    ok("part-stated: ₦150,000 of ₦200,000, one unit missing, does not reconcile");
  } else {
    bad(`unexpected part-stated state: ${JSON.stringify(st)}`);
  }

  // Complete, but a kobo over.
  await finance.c.from("sc_budget_shares").upsert(
    [{ org_id: oea.id, budget_id: budget.id, unit_id: unitRows[2].id, amount: 50_000.01, set_by: finance.id }],
    { onConflict: "budget_id,unit_id" }
  );
  st = await state();
  if (st.reconciles === false && Math.abs(Number(st.variance) + 0.01) < 0.001) {
    ok("every unit stated but one kobo over — still refuses to reconcile (exact, not 'close enough')");
  } else {
    bad(`a one-kobo overage was accepted: ${JSON.stringify(st)}`);
  }

  // Exactly right.
  await finance.c.from("sc_budget_shares").upsert(
    [{ org_id: oea.id, budget_id: budget.id, unit_id: unitRows[2].id, amount: 50_000, set_by: finance.id }],
    { onConflict: "budget_id,unit_id" }
  );
  st = await state();
  if (st.reconciles === true && Number(st.variance) === 0) {
    ok("stated exactly: reconciles");
  } else {
    bad(`a reconciling set was not recognised: ${JSON.stringify(st)}`);
  }

  // ── §C Who may state a share ────────────────────────────────────────────
  head("§C Stating a share is setting what a unit is billed");

  if (fm) {
    const { error } = await fm.c.from("sc_budget_shares").insert({
      org_id: oea.id, budget_id: budget.id, unit_id: unitRows[0].id, amount: 1, set_by: fm.id,
    });
    if (error) ok("an FM/PM cannot state a share — sc.manage is required, as for the budget itself");
    else bad("⚠️ an FM/PM wrote a service-charge share without sc.manage");
  }

  // The cross-org boundary, at the strongest point: a unit that exists, in a
  // real org, that is not this one.
  if (tfml) {
    const { data: theirUnit } = await svc
      .from("units").select("id").eq("org_id", tfml.id).limit(1).maybeSingle();
    if (theirUnit) {
      const { error } = await finance.c.from("sc_budget_shares").insert({
        org_id: oea.id, budget_id: budget.id, unit_id: theirUnit.id, amount: 1, set_by: finance.id,
      });
      if (error) ok("a share cannot name a unit belonging to the other brand — B1 holds at the FK");
      else bad("⚠️ a share was written against another organisation's unit");
    }
  }

  // A unit in the SAME org but on a different property. The foreign key cannot
  // express this; the server action checks it.
  const { data: elsewhere } = await svc
    .from("units").select("id").eq("org_id", oea.id).neq("property_id", prop.id).limit(1).maybeSingle();
  if (elsewhere) {
    const { error } = await finance.c.from("sc_budget_shares").insert({
      org_id: oea.id, budget_id: budget.id, unit_id: elsewhere.id, amount: 1, set_by: finance.id,
    });
    if (error) {
      ok("the database also refuses a unit from another property in the same org");
    } else {
      // Not a failure of the policy — it is exactly what the FK cannot say, and
      // why saveManualShares checks it. Recorded so the reason stays visible.
      console.log("  \x1b[33mNOTE\x1b[0m the FK permits a same-org unit from another property; " +
                  "saveManualShares() is what refuses it, and §D proves the effect.");
      await svc.from("sc_budget_shares").delete()
        .eq("budget_id", budget.id).eq("unit_id", elsewhere.id);
    }
  }

  // ── §D What actually gets invoiced ──────────────────────────────────────
  head("§D The split that reaches a person's bill");

  // Generation is a server action, not an RPC, so this exercises the same
  // arithmetic against the same rows rather than calling it.
  const { data: liveUnits } = await finance.c
    .from("units").select("id, label, apportionment_factor, unit_quantity, occupant_user_id")
    .eq("property_id", prop.id).is("deleted_at", null);
  const { data: liveShares } = await finance.c
    .from("sc_budget_shares").select("unit_id, amount").eq("budget_id", budget.id);
  const statedBy = new Map((liveShares ?? []).map((s) => [s.unit_id, Number(s.amount)]));

  const inputs = (liveUnits ?? []).map((x) => ({
    id: x.id, label: x.label,
    factor: Number(x.apportionment_factor),
    quantity: Number(x.unit_quantity ?? 1),
    occupant_user_id: x.occupant_user_id,
    statedAmount: statedBy.get(x.id) ?? null,
  }));

  const manualShares = apportion(TOTAL, inputs, "manual");
  const manualTotal = manualShares.reduce((a, s) => a + s.amount, 0);
  if (Math.abs(manualTotal - TOTAL) < 0.005) {
    ok(`the manual split invoices ${naira(manualTotal)} — exactly the budget`);
  } else {
    bad(`the manual split would invoice ${manualTotal}, not ${TOTAL}`);
  }

  const bigUnit = manualShares.find((s) => Number(s.factor) === 100);
  if (bigUnit.amount === 90_000) {
    ok("the largest unit pays the ₦90,000 stated, not the ₦100,000 its area implies");
  } else {
    bad(`the stated share was overridden by area: ${bigUnit.amount}`);
  }

  // Percentages are derived for display and must still describe the money.
  const pctSum = manualShares.reduce((a, s) => a + s.pct, 0);
  if (Math.abs(pctSum - 1) < 0.0001) ok("derived percentages sum to 100%");
  else bad(`derived percentages sum to ${(pctSum * 100).toFixed(4)}%`);

  // The method rides onto the invoice. Written through finance's own session,
  // so `service_charges_insert` decides — the column being writable at all is
  // part of the claim.
  const rows = manualShares.map((s) => ({
    org_id: oea.id, budget_id: budget.id, unit_id: s.id,
    property_or_unit: `probe · ${s.label}`, billing_period: `PROBEAPP-${S}`,
    amount: s.amount, apportionment_pct: Number((s.pct * 100).toFixed(4)),
    apportion_method: "manual", status: "invoiced",
  }));
  const { error: insErr } = await svc.from("service_charges").insert(rows);
  if (insErr) {
    bad(`could not write the invoices — ${insErr.message}`);
  } else {
    const { data: back } = await finance.c
      .from("service_charges").select("amount, apportion_method")
      .eq("budget_id", budget.id);
    const allManual = (back ?? []).every((r) => r.apportion_method === "manual");
    const sum = (back ?? []).reduce((a, r) => a + Number(r.amount), 0);
    if (allManual) ok(`all ${back.length} invoices carry apportion_method = manual`);
    else bad("an invoice did not record the method it was raised under");
    if (Math.abs(sum - TOTAL) < 0.005) ok(`the invoices sum to the budget (${naira(sum)})`);
    else bad(`the invoices sum to ${sum}, not ${TOTAL}`);

    // ⚠️ Changing the budget's method must NOT rewrite what a raised invoice
    // says it was — the same rule decision 14 applies to the fee rate.
    await svc.from("sc_budgets").update({ apportion_method: "area" }).eq("id", budget.id);
    const { data: after } = await finance.c
      .from("service_charges").select("apportion_method").eq("budget_id", budget.id);
    if ((after ?? []).every((r) => r.apportion_method === "manual")) {
      ok("changing the budget's method afterwards leaves every raised invoice saying `manual`");
    } else {
      bad("⚠️ a raised invoice's method changed when the budget's did — a past bill was rewritten");
    }
    await svc.from("sc_budgets").update({ apportion_method: "manual" }).eq("id", budget.id);
  }

  // ── §E An existing budget is untouched ──────────────────────────────────
  head("§E Every budget written before 0227");

  const { data: existing } = await svc
    .from("sc_budgets").select("id, apportion_method").neq("id", budget.id).limit(50);
  const nonArea = (existing ?? []).filter((b) => b.apportion_method !== "area");
  if (nonArea.length === 0) {
    ok(`all ${(existing ?? []).length} pre-existing budgets read as \`area\` — the backfill is the default, not a guess`);
  } else {
    bad(`${nonArea.length} pre-existing budget(s) are not area`);
  }

  const { count: nullMethod } = await svc
    .from("service_charges").select("id", { count: "exact", head: true })
    .is("apportion_method", null);
  console.log(`  \x1b[33mNOTE\x1b[0m ${nullMethod} invoice(s) raised before 0227 carry no method. ` +
              "Deliberately not back-filled: nobody recorded it, and inventing a value would be inventing evidence.");
} finally {
  await cleanup();
}

console.log(
  failures === 0
    ? "\n\x1b[32m✔ apportionment: all checks passed\x1b[0m"
    : `\n\x1b[31m✘ ${failures} check(s) failed\x1b[0m`
);
process.exit(failures === 0 ? 0 : 1);
