// A rent roll arrives as a file (0265).
//
// The claims that matter:
//   • the tenant of record has a NAME even with no portal account, and the
//     schedule shows it — the workbook column that is never blank
//   • a portal account, when there is one, WINS over the name on the lease
//   • `import_tenancies` runs as the CALLER, so RLS refuses a property they do
//     not hold — no second copy of `leases_write`
//   • it is ALL OR NOTHING: one bad row imports nothing at all
//   • rows are inserted as drafts and ACTIVATED, so a unit's occupant follows
//     its tenancy exactly as it does for a hand-entered one
//   • the validator catches what the constraint cannot: `leases_no_overlap`
//     only excludes ACTIVE leases, so a draft re-upload would silently double
//     the rent roll
//   • the 500-row ceiling, and the anon revoke a create-or-replace re-opens
//
// Usage: node scripts/verify-tenancy-import.mjs
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { validateTenancyCsv, tenancyTemplateCsv } from "../lib/tenancy-import.ts";

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
config({ path: path.join(rootDir, ".env.local") });

const URL_ = process.env.NEXT_PUBLIC_SUPABASE_URL;
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const PW = "ProbeImport!2026";

let failures = 0;
const ok = (m) => console.log(`  \x1b[32mPASS\x1b[0m ${m}`);
const bad = (m) => { failures++; console.log(`  \x1b[31mFAIL\x1b[0m ${m}`); };
const refused = (m, e) =>
  e ? ok(`${m} — refused: ${e.message.slice(0, 70)}`) : bad(`${m} — NOT REFUSED`);

const svc = createClient(URL_, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

const orgRes = await svc.from("orgs").select("id, delivery_brand").is("deleted_at", null);
if (orgRes.error) { console.error("db unreachable:", orgRes.error.message); process.exit(1); }
const oea = orgRes.data.find((o) => o.delivery_brand === "OEA");

const S = Date.now().toString(36).toUpperCase().slice(-5);
const madeProps = [], madeUnits = [], madeUsers = [], madeLeases = [];

const mkProperty = async (name) => {
  const { data, error } = await svc.from("properties")
    .insert({ org_id: oea.id, name }).select("id").single();
  if (error) throw new Error(error.message);
  madeProps.push(data.id);
  return data.id;
};
const mkUnit = async (propertyId, label) => {
  const { data, error } = await svc.from("units")
    .insert({ org_id: oea.id, property_id: propertyId, label, apportionment_factor: 1 })
    .select("id").single();
  if (error) throw new Error(error.message);
  madeUnits.push(data.id);
  return data.id;
};
const mkUser = async (role, tag, attachTo) => {
  const email = `probeimport.${tag}.${S}@example.com`;
  const { data: created, error } = await svc.auth.admin.createUser({
    email, password: PW, email_confirm: true,
  });
  if (error) throw new Error(error.message);
  madeUsers.push(created.user.id);
  await svc.from("users").upsert({
    id: created.user.id, org_id: oea.id, email, full_name: `Probe ${tag}`, role,
  });
  if (attachTo) {
    await svc.from("property_stakeholders").insert({
      org_id: oea.id, property_id: attachTo, user_id: created.user.id, relation: "manager",
    });
  }
  return { id: created.user.id, email };
};
const login = async (email) => {
  const c = createClient(URL_, ANON, { auth: { persistSession: false } });
  const { error } = await c.auth.signInWithPassword({ email, password: PW });
  if (error) throw new Error(`${email}: ${error.message}`);
  return c;
};

console.log("0265 — a rent roll arrives as a file\n");

const propA = await mkProperty(`PROBEIMP-A-${S}`);
const propB = await mkProperty(`PROBEIMP-B-${S}`);   // deliberately NOT theirs
const unitA1 = await mkUnit(propA, `A1-${S}`);
const unitA2 = await mkUnit(propA, `A2-${S}`);
const unitB1 = await mkUnit(propB, `B1-${S}`);

// A property manager holding ONLY propA.
const pm = await mkUser("property_manager", "pm", propA);
// A tenant WITH a portal account, so the coalesce can be tested both ways.
const portalTenant = await mkUser("tenant", "tenant", null);

const nextYear = new Date().getUTCFullYear() + 1;
const term = { start: `${nextYear}-01-01`, end: `${nextYear}-12-31` };

const csv = (rows) =>
  [
    "property_name,unit_label,tenant_name,tenant_phone,tenant_email,start_date,end_date,rent_amount,deposit_amount,escalation_pct,status,remark",
    ...rows,
  ].join("\n");

// The context the server action builds, as this PM would see it.
const contextFor = async (propertyIds) => {
  const { data: props } = await svc.from("properties").select("id, name").in("id", propertyIds);
  const { data: units } = await svc.from("units").select("id, label, property_id").in("property_id", propertyIds);
  const { data: live } = await svc.from("leases")
    .select("unit_id, start_date, end_date").is("deleted_at", null).in("status", ["active", "renewed"]);
  const pairs = (props ?? []).map((p) => [p.name.toLowerCase(), p.id]);
  const occupied = new Map();
  for (const l of live ?? []) {
    const list = occupied.get(l.unit_id) ?? [];
    list.push({ start: l.start_date, end: l.end_date });
    occupied.set(l.unit_id, list);
  }
  return {
    propertiesByName: new Map(pairs),
    ambiguousPropertyNames: new Set(
      pairs.map(([n]) => n).filter((n, i, all) => all.indexOf(n) !== i)
    ),
    unitsByKey: new Map((units ?? []).map((u) => [`${u.property_id}::${u.label.toLowerCase()}`, u.id])),
    tenantsByEmail: new Map([[portalTenant.email.toLowerCase(), portalTenant.id]]),
    occupiedRanges: occupied,
  };
};

// ---------------------------------------------------------------------------
console.log("A. The validator refuses what the write would refuse");
// ---------------------------------------------------------------------------
{
  const ctx = await contextFor([propA]);   // NOT propB
  const { rows } = validateTenancyCsv(
    csv([
      `PROBEIMP-A-${S},A1-${S},Adaeze Okonkwo,+2348010000001,,${term.start},${term.end},4500000,450000,5,active,`,
      `PROBEIMP-B-${S},B1-${S},Someone Else,,,${term.start},${term.end},1000000,0,0,active,`,
      `PROBEIMP-A-${S},NO-SUCH-UNIT,Nobody,,,${term.start},${term.end},1000000,0,0,active,`,
      `PROBEIMP-A-${S},A2-${S},Bad Dates,,,${term.end},${term.start},1000000,0,0,active,`,
      `PROBEIMP-A-${S},A2-${S},No Rent,,,${term.start},${term.end},0,0,0,active,`,
      `PROBEIMP-A-${S},A2-${S},Bad Status,,,${term.start},${term.end},1000000,0,0,pending,`,
    ]),
    ctx
  );

  rows[0].valid ? ok("a clean row passes") : bad(`a clean row failed: ${JSON.stringify(rows[0].issues)}`);
  /do not manage/i.test(rows[1].issues[0]?.message ?? "")
    ? ok("a property the caller does not hold is refused, and says so")
    : bad(`unmanaged property gave: ${rows[1].issues[0]?.message}`);
  /No unit/i.test(rows[2].issues[0]?.message ?? "")
    ? ok("a unit that is not on that property is refused")
    : bad(`unknown unit gave: ${rows[2].issues[0]?.message}`);
  rows[3].issues.some((i) => /end after it starts/i.test(i.message))
    ? ok("a term that ends before it starts is refused")
    : bad("a backwards term was accepted");
  rows[4].issues.some((i) => /greater than zero/i.test(i.message))
    ? ok("a rent of zero is refused")
    : bad("a zero rent was accepted");
  rows[5].issues.some((i) => /not a status/i.test(i.message))
    ? ok("an unknown status is refused rather than coerced")
    : bad("an unknown status was silently accepted");

  // ⚠️ Row numbers are the PHYSICAL lines of the file. An importer that says
  // "row 4" about row 6 is worse than one that says nothing.
  rows[0].rowNumber === 2
    ? ok("row numbers are the lines in the user's own file")
    : bad(`first data row reported as line ${rows[0].rowNumber}, expected 2`);
}

// ---------------------------------------------------------------------------
console.log("\nA2. The template round-trips, guidance row and all");
// ---------------------------------------------------------------------------
{
  // ⚠️ The one file every first-time user starts from. Its comment lines and
  // its guidance row must both survive being left in — a template that reports
  // an error against its own instructions reads as a broken importer, and
  // "delete this row first" is not an instruction people follow.
  const ctx = await contextFor([propA]);
  const filled = tenancyTemplateCsv([`PROBEIMP-A-${S}`])
    .replace(/Osborne Towers/g, `PROBEIMP-A-${S}`)
    .replace(/Flat 4/g, `A1-${S}`);
  const { rows, headerIssues } = validateTenancyCsv(filled, ctx);
  headerIssues.length === 0
    ? ok("the template's own headers are exactly the ones the importer wants")
    : bad(`the shipped template has header issues: ${headerIssues.join("; ")}`);
  rows.length === 1
    ? ok("its comment lines and guidance row are skipped, leaving the example")
    : bad(`the template produced ${rows.length} data rows, expected 1`);
  rows[0]?.valid
    ? ok("and the example row it ships validates")
    : bad(`the shipped example fails: ${JSON.stringify(rows[0]?.issues)}`);
}

// ---------------------------------------------------------------------------
console.log("\nB. A file can collide with itself, and with what is already let");
// ---------------------------------------------------------------------------
{
  const ctx = await contextFor([propA]);
  const { rows } = validateTenancyCsv(
    csv([
      `PROBEIMP-A-${S},A1-${S},First Claim,,,${term.start},${term.end},4500000,0,0,active,`,
      `PROBEIMP-A-${S},A1-${S},Second Claim,,,${nextYear}-06-01,${nextYear + 1}-05-31,4500000,0,0,active,`,
      `PROBEIMP-A-${S},A1-${S},After It Ends,,,${nextYear + 1}-01-01,${nextYear + 1}-12-31,4500000,0,0,active,`,
    ]),
    ctx
  );
  rows[0].valid ? ok("the first claim on a unit stands") : bad("the first claim was rejected");
  rows[1].issues.some((i) => /Another row in this file/i.test(i.message))
    ? ok("a second row overlapping the first is caught — a file can collide with itself")
    : bad("two overlapping rows in one file were both accepted");
  rows[2].valid
    ? ok("and a later, non-overlapping term on the same unit is fine")
    : bad(`a non-overlapping renewal was rejected: ${JSON.stringify(rows[2].issues)}`);
}

// ---------------------------------------------------------------------------
console.log("\nC. Two properties of the same name are refused, not guessed at");
// ---------------------------------------------------------------------------
{
  const twin = await mkProperty(`PROBEIMP-A-${S}`);   // same name, different row
  await mkUnit(twin, `A1-${S}`);
  const ctx = await contextFor([propA, twin]);
  const { rows } = validateTenancyCsv(
    csv([`PROBEIMP-A-${S},A1-${S},Ambiguous,,,${term.start},${term.end},1000000,0,0,active,`]),
    ctx
  );
  /More than one property/i.test(rows[0].issues[0]?.message ?? "")
    ? ok("an ambiguous property name is refused — a Map would have silently picked one")
    : bad(`ambiguous name gave: ${rows[0].issues[0]?.message ?? "NO ISSUE — a tenancy would be filed against a guess"}`);
}

// ---------------------------------------------------------------------------
console.log("\nD. The import runs as the CALLER — RLS, not a second policy");
// ---------------------------------------------------------------------------
{
  const c = await login(pm.email);

  const rowOnB = () => ({
    row: "2", property_id: propB, unit_id: unitB1,
    tenant_name: "Not Theirs", start_date: term.start, end_date: term.end,
    rent_amount: 1000000, activate: false,
  });

  // A property they do not hold. The validator would have caught it; this
  // proves the DATABASE does too, which is what makes the validator advisory.
  const { error: outside } = await c.rpc("import_tenancies", { p_rows: [rowOnB()] });
  refused("a property the caller does not manage is refused", outside);

  const { count: leaked } = await svc.from("leases")
    .select("id", { count: "exact", head: true }).eq("property_id", propB);
  (leaked ?? 0) === 0
    ? ok("and nothing was written to it")
    : bad(`${leaked} lease(s) landed on a property the caller does not manage`);

  // 📌 The first draft of this section called that refusal "refused by RLS" and
  // it was not: the message was `That unit does not exist`, raised by 0225's
  // trigger, whose own SELECT on `units` runs as the caller and finds nothing
  // on a property they do not hold. A true refusal, at a layer one earlier than
  // the one being named — which is a check passing for a reason unrelated to
  // its claim, exactly what this file's own section E fixed in the offer suite.
  //
  // So prove the SCOPE is what decides, by moving it: stake them to propB, and
  // the identical row lands. Nothing else about the call changes.
  await svc.from("property_stakeholders").insert({
    org_id: oea.id, property_id: propB, user_id: pm.id, relation: "manager",
  });
  const { data: nowAllowed, error: nowErr } = await c.rpc("import_tenancies", {
    p_rows: [rowOnB()],
  });
  !nowErr && nowAllowed?.inserted === 1
    ? ok("staked to that property, the identical row lands — the SCOPE is what decides")
    : bad(`the same row still failed after staking: ${nowErr?.message.slice(0, 80)}`);

  await svc.from("leases").delete().eq("property_id", propB);
  await svc.from("property_stakeholders")
    .delete().eq("user_id", pm.id).eq("property_id", propB);

  const { error: outsideAgain } = await c.rpc("import_tenancies", { p_rows: [rowOnB()] });
  refused("and un-staked, it is refused again", outsideAgain);

  await c.auth.signOut();
}

// ---------------------------------------------------------------------------
console.log("\nE. All or nothing");
// ---------------------------------------------------------------------------
{
  const c = await login(pm.email);
  const good = {
    row: "2", property_id: propA, unit_id: unitA1,
    tenant_name: "Would Have Landed", start_date: term.start, end_date: term.end,
    rent_amount: 4500000, activate: false,
  };
  const bogus = { ...good, row: "3", unit_id: unitA2, rent_amount: -1 };

  const { error } = await c.rpc("import_tenancies", { p_rows: [good, bogus] });
  refused("a file with one impossible row is refused whole", error);
  /row 3/i.test(error?.message ?? "")
    ? ok("and the refusal names the row")
    : bad(`the refusal did not name the row: ${error?.message}`);

  const { count } = await svc.from("leases")
    .select("id", { count: "exact", head: true }).eq("property_id", propA);
  (count ?? 0) === 0
    ? ok("nothing at all was imported — not even the good row")
    : bad(`${count} lease(s) survived a failed import; a half rent roll is worse than none`);

  await c.auth.signOut();
}

// ---------------------------------------------------------------------------
console.log("\nF. What a clean import actually does");
// ---------------------------------------------------------------------------
{
  const c = await login(pm.email);
  const { data, error } = await c.rpc("import_tenancies", {
    p_rows: [
      {
        row: "2", property_id: propA, unit_id: unitA1,
        tenant_name: "Adaeze Okonkwo", tenant_phone: "+2348010000001",
        start_date: term.start, end_date: term.end,
        rent_amount: 4500000, deposit_amount: 450000, escalation_pct: 5,
        remark: "Paid and remitted", activate: true,
      },
      {
        row: "3", property_id: propA, unit_id: unitA2,
        tenant_name: "Ignored Because Linked", tenant_user_id: portalTenant.id,
        start_date: term.start, end_date: term.end,
        rent_amount: 3000000, activate: true,
      },
    ],
  });
  !error ? ok("a clean file imports") : bad(`import failed — ${error.message.slice(0, 90)}`);
  data?.inserted === 2 && data?.activated === 2
    ? ok("both rows recorded and both activated")
    : bad(`inserted=${data?.inserted} activated=${data?.activated}`);
  for (const id of data?.lease_ids ?? []) madeLeases.push(id);

  const { data: leases } = await svc.from("leases")
    .select("id, unit_id, status, tenant_name, tenant_phone, tenant_user_id, rent_amount, deposit_amount, notes, created_by")
    .eq("property_id", propA).order("rent_amount", { ascending: false });

  leases[0].status === "active"
    ? ok("status is active — inserted as a draft, then put through activate_lease")
    : bad(`status is ${leases[0].status}`);
  leases[0].created_by === pm.id
    ? ok("and attributed to the person who imported it")
    : bad(`created_by=${leases[0].created_by}, expected the importer`);
  Number(leases[0].rent_amount) === 4500000 && Number(leases[0].deposit_amount) === 450000
    ? ok("rent and deposit carried across")
    : bad(`rent=${leases[0].rent_amount} deposit=${leases[0].deposit_amount}`);
  leases[0].notes === "Paid and remitted"
    ? ok("and the workbook's REMARK column with them")
    : bad(`remark is ${leases[0].notes}`);

  // ⚠️ The gap this migration had to close first: a tenancy with no portal
  // account rendered with NO TENANT on the one report whose purpose is to say
  // who is in which unit.
  // ⚠️ Read as the MANAGER, not through the service role. `tenancy_schedule` is
  // `security_invoker` and its predicate is "oversight, or a property you
  // hold" — and the service role is neither, so `svc` sees ZERO rows and every
  // assertion below would read `undefined` and fail as though the feature were
  // broken. That is what the first run of this suite did.
  const { data: sched } = await c.from("tenancy_schedule")
    .select("unit_label, tenant_name, tenant_phone, tenant_user_id, remark")
    .eq("property_name", `PROBEIMP-A-${S}`);
  (sched ?? []).length === 2
    ? ok("the schedule returns both imported tenancies to the manager who holds the property")
    : bad(`the schedule returned ${(sched ?? []).length} row(s), expected 2`);
  const noAccount = (sched ?? []).find((r) => !r.tenant_user_id);
  noAccount?.tenant_name === "Adaeze Okonkwo"
    ? ok("the schedule names a tenant who has no portal account")
    : bad(`schedule shows tenant_name=${noAccount?.tenant_name} for a tenancy with no account`);
  noAccount?.tenant_phone === "+2348010000001"
    ? ok("and carries their phone, as the workbook does")
    : bad(`phone is ${noAccount?.tenant_phone}`);

  // ⚠️ And the other direction: a real account must WIN over the name typed on
  // the lease, or the lease becomes a second source of truth for an identity.
  const linked = (sched ?? []).find((r) => r.tenant_user_id);
  linked?.tenant_name === "Probe tenant"
    ? ok("a linked portal account wins over the name on the lease")
    : bad(`linked row shows ${linked?.tenant_name}, expected the account's own name`);

  // Occupancy follows the tenancy, but only where there is a person to record.
  const { data: units } = await svc.from("units")
    .select("id, occupant_user_id").in("id", [unitA1, unitA2]);
  units.find((u) => u.id === unitA2)?.occupant_user_id === portalTenant.id
    ? ok("the linked tenant occupies their unit")
    : bad("activation did not set the occupant for a linked tenant");
  units.find((u) => u.id === unitA1)?.occupant_user_id === null
    ? ok("and a tenancy with no account leaves the occupant unset, as activate_lease always has")
    : bad("an occupant was invented for a tenancy with no portal user");

  await c.auth.signOut();
}

// ---------------------------------------------------------------------------
console.log("\nG. A re-upload does not double the rent roll");
// ---------------------------------------------------------------------------
{
  // ⚠️ `leases_no_overlap` only excludes ACTIVE/renewed rows, so it cannot be
  // relied on to make a re-import idempotent — a draft would sail straight
  // past it. The validator carries that check itself.
  const ctx = await contextFor([propA]);
  const { rows } = validateTenancyCsv(
    csv([`PROBEIMP-A-${S},A1-${S},Adaeze Okonkwo,,,${term.start},${term.end},4500000,0,0,active,`]),
    ctx
  );
  /already let over those dates/i.test(rows[0].issues[0]?.message ?? "")
    ? ok("re-uploading the same sheet reports the row as already recorded")
    : bad(`a duplicate row gave: ${rows[0].issues[0]?.message ?? "NO ISSUE — the rent roll would double"}`);
  /re-uploading/i.test(rows[0].issues[0]?.message ?? "")
    ? ok("and says what has probably happened, rather than naming a constraint")
    : bad("the message names the problem but not the likely cause");
}

// ---------------------------------------------------------------------------
console.log("\nH. The ceiling, and who may call it at all");
// ---------------------------------------------------------------------------
{
  const c = await login(pm.email);
  const many = Array.from({ length: 501 }, (_, i) => ({
    row: String(i + 2), property_id: propA, unit_id: unitA1,
    tenant_name: "Too Many", start_date: term.start, end_date: term.end,
    rent_amount: 1, activate: false,
  }));
  const { error: capped } = await c.rpc("import_tenancies", { p_rows: many });
  capped && /at most 500/i.test(capped.message)
    ? ok("more than 500 tenancies in one transaction is refused, and says the limit")
    : bad(`the 500 ceiling gave: ${capped?.message ?? "NO ERROR"}`);

  const { error: empty } = await c.rpc("import_tenancies", { p_rows: [] });
  refused("an empty file is refused rather than reported as a success", empty);
  await c.auth.signOut();

  // ⚠️ 0204/0209/0210/0264: `create or replace` re-applies Supabase's default
  // grants, and `anon` is the one people remember while `authenticated` is the
  // one that gets left standing. Here authenticated is CORRECT — a signed-in
  // manager calls this — so anon is what must be gone.
  const anonC = createClient(URL_, ANON, { auth: { persistSession: false } });
  const { error: anonErr } = await anonC.rpc("import_tenancies", { p_rows: [] });
  anonErr && /permission denied|not find the function|schema cache/i.test(anonErr.message)
    ? ok("import_tenancies is unreachable by anon")
    : bad(`ANON CAN CALL import_tenancies: ${anonErr?.message ?? "no error at all"}`);

  // ⚠️ 0254's own guard, re-asserted because 0265 does a `create or replace
  // view` and that re-applies Supabase's defaults. Asked against a live anon
  // client rather than read out of information_schema — 0210's lesson is that
  // the client is what catches this.
  const { error: viewErr } = await anonC.from("tenancy_schedule").select("lease_id").limit(1);
  viewErr
    ? ok(`the schedule view is unreachable by anon — ${viewErr.message.slice(0, 50)}`)
    : bad("ANON CAN READ tenancy_schedule — the replace re-opened it");
}

// ---------------------------------------------------------------------------
// Teardown
// ---------------------------------------------------------------------------
await svc.from("leases").delete().in("property_id", madeProps);
await svc.from("units").update({ occupant_user_id: null }).in("id", madeUnits);
await svc.from("units").delete().in("id", madeUnits);
await svc.from("property_stakeholders").delete().in("user_id", madeUsers);
await svc.from("properties").delete().in("id", madeProps);
for (const id of madeUsers) {
  await svc.from("users").delete().eq("id", id);
  await svc.auth.admin.deleteUser(id).catch(() => {});
}
console.log("\n(cleaned up)");

console.log(
  failures === 0
    ? "\n\x1b[32mALL CHECKS PASSED\x1b[0m — a rent roll imports whole, scoped to the caller's own buildings, or not at all."
    : `\n\x1b[31m${failures} CHECK(S) FAILED\x1b[0m`
);
process.exit(failures === 0 ? 0 : 1);
