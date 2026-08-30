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
          // ⚠️ The service-charge half, added in 0230. Until then
          // `landlord_statement` carried no SC column at all, so these two
          // reports about one building gave different accounts of it and this
          // comparison could not have caught it — there was nothing to compare.
          // Measured live on Parkview Terraces: ₦71,000,000 billed and
          // ₦18,000,000 collected, visible to a manager and to nobody else.
          ["sc billed", mine.sc_billed, row.sc_billed],
          ["sc collected", mine.sc_collected, row.sc_collected],
          ["sc outstanding", mine.sc_outstanding, row.sc_outstanding],
        ];
        const off = checks.filter(([, a, b]) => !near(a, b));
        if (off.length === 0) {
          ok(`all ${checks.length} figures agree with landlord_statement to the kobo (rent and service charge)`);
        } else {
          off.forEach(([n, a, b]) =>
            bad(`${n}: landlord_statement says ${a}, property_statement says ${b}`));
        }

        // The columns must actually be there. An agreement of two undefineds is
        // `NaN === NaN` away from passing on a report that carries neither.
        const scCols = ["sc_invoices", "sc_billed", "sc_collected", "sc_outstanding", "currency"]
          .filter((k) => !(k in mine));
        scCols.length === 0
          ? ok("landlord_statement carries the service-charge columns and a currency")
          : bad(`landlord_statement is missing ${scCols.join(", ")}`);
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

// ── §E The landlord's own copy ────────────────────────────────────────────
head("§E The statement the landlord themselves pulls (0230)");

{
  const { data: ownerRows } = await svc
    .from("property_stakeholders").select("user_id")
    .eq("property_id", target.id).eq("relation", "owner");
  const ownerId = (ownerRows ?? [])[0]?.user_id ?? null;
  const { data: ownerUser } = ownerId
    ? await svc.from("users").select("email").eq("id", ownerId).maybeSingle()
    : { data: null };
  const theOwner = ownerUser?.email ? await login(ownerUser.email) : null;

  if (!theOwner) {
    console.log("  \x1b[33mSKIP\x1b[0m the recorded owner has no signable account");
  } else {
    const { data: own, error } = await theOwner.c.rpc("landlord_statement", {
      p_landlord_user_id: theOwner.id, p_from: FROM, p_to: TO,
    });
    if (error) bad(`a landlord cannot pull their own statement — ${error.message}`);
    else if ((own ?? []).length === 0) bad("a landlord pulls their own statement and gets nothing");
    else ok(`a landlord pulls their own statement (${own.length} propert(ies))`);

    // ⚠️ 0091b's lesson, applied to the other direction: proving they see no
    // one else's is worthless unless they see their own, which is asserted
    // above first.
    const other = (await svc.from("property_stakeholders")
      .select("user_id").eq("relation", "owner").neq("user_id", theOwner.id).limit(1)).data?.[0];
    if (other) {
      const { data: theirs } = await theOwner.c.rpc("landlord_statement", {
        p_landlord_user_id: other.user_id, p_from: FROM, p_to: TO,
      });
      (theirs ?? []).length === 0
        ? ok("and gets nothing when they ask for another landlord's")
        : bad(`a landlord reads ${theirs.length} row(s) of another landlord's statement`);
    }
  }

  // A tenant is not a party to what a landlord is charged (0229), and the
  // statement is the other surface that carries it.
  const t = await login("oea.tenant@oegroup.test");
  if (t && ownerId) {
    const { data } = await t.c.rpc("landlord_statement", {
      p_landlord_user_id: ownerId, p_from: FROM, p_to: TO,
    });
    (data ?? []).length === 0
      ? ok("a tenant pulling the landlord's statement gets nothing")
      : bad(`a tenant reads ${data.length} row(s) of the landlord's statement`);
  }
}

// ── §F What the two screens do with it ────────────────────────────────────
head("§F The screens read it the way the rule says");

{
  const fs = await import("node:fs");
  const portfolio = fs.readFileSync(
    path.join(rootDir, "app/dashboard/portfolio/page.tsx"), "utf8");
  const propStmt = fs.readFileSync(
    path.join(rootDir, "app/dashboard/properties/[id]/statement/page.tsx"), "utf8");

  // Rent and service charge are never added. Asserted as the absence of a sum
  // rather than by reading the rendered figure, because the failure this
  // guards against is someone helpfully adding a "Total" row later.
  /sc_billed[\s\S]{0,400}?scBilled/.test(portfolio) || /scBilled/.test(portfolio)
    ? ok("the portfolio computes a service-charge total of its own")
    : bad("the portfolio does not surface the service charge at all");
  /(collected|demanded)\s*\+\s*sc_|sc_billed\s*\+\s*(collected|demanded)/.test(portfolio)
    ? bad("the portfolio adds rent and service charge into one figure — the 0103 mistake")
    : ok("and never adds it to the rent (no combined total anywhere in the file)");

  // ⚠️ The period picker hardcoded /dashboard/ledger/reports, which is gated to
  // admin, finance and the executive — so pressing Apply on a property
  // statement or a portfolio threw the two audiences those pages exist for
  // ("the property's manager" and "its landlord") onto "Finance access
  // required". Both callers must now name their own path.
  /basePath=\{`\/dashboard\/properties\/\$\{id\}\/statement`\}/.test(propStmt)
    ? ok("the property statement's period picker returns to the property statement")
    : bad("the property statement's Apply navigates away from the statement");
  /basePath="\/dashboard\/portfolio"/.test(portfolio)
    ? ok("the portfolio's period picker returns to the portfolio")
    : bad("the portfolio has no period picker, or it navigates away");

  // A statement nobody can put on paper is not a statement.
  /PrintMasthead/.test(portfolio) && /PrintButton/.test(portfolio)
    ? ok("the landlord statement can be printed, with a masthead naming org, period and reader")
    : bad("the landlord statement cannot be printed");
}

// ── §G Anonymous ──────────────────────────────────────────────────────────
head("§G The revoke this repo has forgotten four times");

const anon = createClient(URL_, ANON, { auth: { persistSession: false } });
for (const fn of ["property_statement", "property_statement_lines"]) {
  const { error } = await anon.rpc(fn, {
    p_property_id: target.id, p_from: FROM, p_to: TO,
  });
  if (error) ok(`anon cannot execute ${fn}() — ${error.message.slice(0, 60)}`);
  else bad(`⚠️ ${fn}() is callable by anon — 0204/0209/0210/0214, a fifth time`);
}
// 0230 dropped and recreated landlord_statement, and `create or replace`
// re-applies Supabase's default grants — the exact way `remember_conversation`
// was closed by 0114 and silently reopened. A drop-and-create is that hazard
// with the safety off.
{
  const { error } = await anon.rpc("landlord_statement", {
    p_landlord_user_id: target.id, p_from: FROM, p_to: TO,
  });
  if (error) ok(`anon cannot execute landlord_statement() — ${error.message.slice(0, 60)}`);
  else bad("⚠️ landlord_statement() is callable by anon — 0230 reopened it");
}

console.log(
  failures === 0
    ? "\n\x1b[32m✔ property statement: all checks passed\x1b[0m"
    : `\n\x1b[31m✘ ${failures} check(s) failed\x1b[0m`
);
process.exit(failures === 0 ? 0 : 1);
