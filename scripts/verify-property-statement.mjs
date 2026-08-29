// The property statement (0228) — everything that happened on one building.
//
// The claims that matter:
//   • a landlord reads their OWN property's statement and no other
//   • an FM/PM reads the properties they hold and no other
//   • oversight reads any property in their own org
//   • the other brand gets NOTHING — B1, at the strongest point (an
//     administrator, who holds every permission their own org can grant)
//   • rent and service charge are never added together
//   • the summary agrees with the lines behind it, to the kobo
//   • the figures agree with `landlord_statement`, which reports the same money
//     from the owner's side — two reports about one property must not disagree
//
// ⚠️ Every read below goes through a REAL logged-in client. The service role is
// used only to establish what the answer OUGHT to be.
//
// Usage: node scripts/verify-property-statement.mjs
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";
import { createClient } from "@supabase/supabase-js";

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
config({ path: path.join(rootDir, ".env.local") });

const URL_ = process.env.NEXT_PUBLIC_SUPABASE_URL;
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const SVCK = process.env.SUPABASE_SERVICE_ROLE_KEY;
const PW = "OEGroupDemo2026!";
const FROM = "2000-01-01";
const TO = "2100-12-31";

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
  return { c, id: user.id, email };
}
const statement = async (client, propertyId) => {
  const { data, error } = await client.rpc("property_statement", {
    p_property_id: propertyId, p_from: FROM, p_to: TO,
  });
  if (error) return { error };
  return { row: (data ?? [])[0] ?? null };
};

const { data: orgs } = await svc
  .from("orgs").select("id, slug").is("deleted_at", null);
const oea = orgs.find((o) => o.slug === "oea");
const tfml = orgs.find((o) => o.slug === "tfml");

// A property with money on it, so the arithmetic has something to be right about.
const { data: props } = await svc
  .from("properties").select("id, name").eq("org_id", oea.id).is("deleted_at", null);
const { data: budgets } = await svc.from("sc_budgets").select("property_id");
const withSc = new Set((budgets ?? []).map((b) => b.property_id));
const target = (props ?? []).find((p) => withSc.has(p.id)) ?? (props ?? [])[0];
if (!target) { console.error("No OEA property — cannot run."); process.exit(1); }
console.log(`\n  property ${target.name} (${target.id})`);

const finance = await login("oea.financeapprover@oegroup.test");
const owner = await login("oea.propertyowner@oegroup.test");
const pm = await login("oea.facilitymanager@oegroup.test");
const tenant = await login("oea.tenant@oegroup.test");
const tfmlAdmin = tfml ? await login("tfml.admin@oegroup.test") : null;

// ── §A The boundary ───────────────────────────────────────────────────────
head("§A Who the statement opens for");

if (finance) {
  const { row, error } = await statement(finance.c, target.id);
  if (error) bad(`finance: the RPC errored — ${error.message}`);
  else if (row) ok(`oversight reads the statement (${row.property_name})`);
  else bad("oversight got no row for a property in their own org");
}

// The rule, not the instance — for the landlord and the manager alike, what
// they read must agree with what they hold.
for (const [who, sess, relation] of [
  ["a landlord", owner, "owner"],
  ["an FM/PM", pm, "manager"],
]) {
  if (!sess) continue;
  const { data: holds } = await svc
    .from("property_stakeholders").select("id")
    .eq("property_id", target.id).eq("relation", relation)
    .eq("user_id", sess.id).maybeSingle();
  const { row, error } = await statement(sess.c, target.id);
  if (error) { bad(`${who}: the RPC errored — ${error.message}`); continue; }
  if (Boolean(row) === Boolean(holds)) {
    ok(`${who} reads it only when they hold the property (holds: ${Boolean(holds)})`);
  } else {
    bad(`${who} ${holds ? "holds the property but got no row" : "does NOT hold the property but got a row"}`);
  }
}

// A tenant lives in a unit; the building's books are not theirs.
if (tenant) {
  const { row } = await statement(tenant.c, target.id);
  if (!row) ok("a tenant gets no property statement — B7 gives them their own charges, not the building's books");
  else bad("⚠️ a tenant read the property's full financial statement");
}

// B1, at its strongest: an administrator of the other brand.
if (tfmlAdmin) {
  const { row } = await statement(tfmlAdmin.c, target.id);
  if (!row) ok("the other brand's administrator gets no row — B1 holds");
  else bad("⚠️ the other brand's administrator read an OEA property statement");
} else {
  console.log("  \x1b[33mSKIP\x1b[0m no TFML admin fixture on this world");
}

// A property that does not exist and one they may not see answer identically.
if (finance) {
  const { row } = await statement(finance.c, "00000000-0000-0000-0000-000000000000");
  if (!row) ok("a nonexistent property id returns no row, exactly as a forbidden one does");
  else bad("a nonexistent property id returned a statement");
}

// ── §B The arithmetic ─────────────────────────────────────────────────────
head("§B The summary and the lines behind it");

if (finance) {
  const { row } = await statement(finance.c, target.id);
  const { data: lines, error: lErr } = await finance.c.rpc("property_statement_lines", {
    p_property_id: target.id, p_from: FROM, p_to: TO,
  });
  if (lErr) {
    bad(`the lines RPC errored — ${lErr.message}`);
  } else {
    const rent = (lines ?? []).filter((l) => l.kind === "rent");
    const sc = (lines ?? []).filter((l) => l.kind === "service_charge");

    const rentDemanded = rent.reduce((a, l) => a + Number(l.amount), 0);
    const rentCollected = rent.reduce((a, l) => a + Number(l.amount_paid), 0);
    const scBilled = sc.reduce((a, l) => a + Number(l.amount), 0);
    const scCollected = sc.reduce((a, l) => a + Number(l.amount_paid), 0);

    const near = (a, b) => Math.abs(Number(a) - Number(b)) < 0.005;

    if (near(row.rent_demanded, rentDemanded)) {
      ok(`rent demanded matches its lines (${naira(rentDemanded)}, ${rent.length} line(s))`);
    } else {
      bad(`rent demanded ${row.rent_demanded} disagrees with its lines ${rentDemanded}`);
    }
    if (near(row.rent_collected, rentCollected)) ok(`rent collected matches its lines (${naira(rentCollected)})`);
    else bad(`rent collected ${row.rent_collected} disagrees with its lines ${rentCollected}`);

    if (near(row.sc_billed, scBilled)) {
      ok(`service charge billed matches its lines (${naira(scBilled)}, ${sc.length} line(s))`);
    } else {
      bad(`sc billed ${row.sc_billed} disagrees with its lines ${scBilled}`);
    }
    if (near(row.sc_collected, scCollected)) ok(`service charge collected matches its lines (${naira(scCollected)})`);
    else bad(`sc collected ${row.sc_collected} disagrees with its lines ${scCollected}`);

    // ⚠️ The one thing this report must never do.
    if (near(row.sc_outstanding, Math.max(0, scBilled - scCollected))) {
      ok("service-charge outstanding is billed minus collected, and nothing from the rent side");
    } else {
      bad("sc_outstanding does not equal sc_billed - sc_collected");
    }

    // The landlord's share plus the fees taken IS what was collected. If those
    // three ever stop agreeing, a fee is being taken twice or not at all.
    const share = Number(row.landlord_share), fees = Number(row.fees_taken);
    if (near(share + fees, row.rent_collected)) {
      ok(`the landlord's share plus fees equals what was collected (${naira(share)} + ${naira(fees)})`);
    } else {
      bad(`share ${share} + fees ${fees} ≠ collected ${row.rent_collected} — a fee is counted wrong`);
    }

    // Remitted plus still-held IS the landlord's share. Money is either with
    // them or with us; there is no third place for it to be.
    if (near(Number(row.landlord_remitted) + Number(row.landlord_held), share)) {
      ok("remitted plus still-held equals the landlord's share — no money is unaccounted for");
    } else {
      bad(`remitted ${row.landlord_remitted} + held ${row.landlord_held} ≠ share ${share}`);
    }
  }
}

// ── §C It agrees with the landlord's own statement ────────────────────────
head("§C Two reports about one property must not disagree");

if (finance) {
  // ⚠️ NOT `.maybeSingle()`. A property can carry more than one owner, and
  // PostgREST answers a multi-row `maybeSingle()` with an ERROR and null data —
  // so this section skipped itself with "no recorded owner" at the exact moment
  // there were two. That is the failure `scripts/lib/org-lookup.mjs` was written
  // about, reproduced here on the first run of this suite.
  const { data: ownerRows } = await svc
    .from("property_stakeholders").select("user_id")
    .eq("property_id", target.id).eq("relation", "owner");
  const ownerRow = (ownerRows ?? [])[0] ?? null;
  if ((ownerRows ?? []).length > 1) {
    console.log(`  \x1b[33mNOTE\x1b[0m this property has ${ownerRows.length} owners; comparing against the first.`);
  }

  if (!ownerRow) {
    console.log("  \x1b[33mSKIP\x1b[0m this property has no recorded owner, so there is no landlord statement to compare");
  } else {
    const { row } = await statement(finance.c, target.id);
    const { data: ls, error } = await finance.c.rpc("landlord_statement", {
      p_landlord_user_id: ownerRow.user_id, p_from: FROM, p_to: TO,
    });
    if (error) {
      bad(`landlord_statement errored — ${error.message}`);
    } else {
      const mine = (ls ?? []).find((r) => r.property_id === target.id);
      if (!mine) {
        bad("landlord_statement does not carry a property that property_statement does");
      } else {
        const near = (a, b) => Math.abs(Number(a) - Number(b)) < 0.005;
        const checks = [
          ["collected", mine.collected, row.rent_collected],
          ["fees", mine.fees, row.fees_taken],
          ["landlord share", mine.landlord_share, row.landlord_share],
          ["remitted", mine.remitted, row.landlord_remitted],
          ["still held", mine.still_held, row.landlord_held],
        ];
        const off = checks.filter(([, a, b]) => !near(a, b));
        if (off.length === 0) {
          ok(`all ${checks.length} rent figures agree with landlord_statement to the kobo`);
        } else {
          off.forEach(([n, a, b]) =>
            bad(`${n}: landlord_statement says ${a}, property_statement says ${b}`));
        }
      }
    }
  }
}

// ── §D The register half ──────────────────────────────────────────────────
head("§D What the register says the place is");

if (finance) {
  const { row } = await statement(finance.c, target.id);
  const { count: units } = await svc
    .from("units").select("id", { count: "exact", head: true })
    .eq("property_id", target.id).is("deleted_at", null);
  const { count: live } = await svc
    .from("leases").select("id", { count: "exact", head: true })
    .eq("property_id", target.id).is("deleted_at", null)
    .in("status", ["active", "renewed"]);

  if (Number(row.unit_count) === units) ok(`unit count matches the register (${units})`);
  else bad(`statement says ${row.unit_count} units, the register says ${units}`);
  if (Number(row.live_tenancies) === live) ok(`live tenancies match the register (${live})`);
  else bad(`statement says ${row.live_tenancies} live tenancies, the register says ${live}`);

  // Occupancy comes from `unit_is_vacant` (0200) — the one rule — rather than
  // from a second count that could disagree with the property screen.
  if (Number(row.occupied_units) <= Number(row.unit_count)) {
    ok(`occupied units (${row.occupied_units}) is within the unit count, via unit_is_vacant`);
  } else {
    bad(`occupied ${row.occupied_units} exceeds unit count ${row.unit_count}`);
  }
}

// ── §E Anonymous ──────────────────────────────────────────────────────────
head("§E The revoke this repo has forgotten four times");

const anon = createClient(URL_, ANON, { auth: { persistSession: false } });
for (const fn of ["property_statement", "property_statement_lines"]) {
  const { error } = await anon.rpc(fn, {
    p_property_id: target.id, p_from: FROM, p_to: TO,
  });
  if (error) ok(`anon cannot execute ${fn}() — ${error.message.slice(0, 60)}`);
  else bad(`⚠️ ${fn}() is callable by anon — 0204/0209/0210/0214, a fifth time`);
}

console.log(
  failures === 0
    ? "\n\x1b[32m✔ property statement: all checks passed\x1b[0m"
    : `\n\x1b[31m✘ ${failures} check(s) failed\x1b[0m`
);
process.exit(failures === 0 ? 0 : 1);
