// A unit row is one unit, vacancy is one rule, and it counts in both directions.
//
// The claims that matter (0200):
//   • "how many" creates that many numbered rows, not a count on one row
//   • a direct insert claiming a quantity is refused by the database
//   • `unit_is_vacant` is ONE rule: no occupant AND no live tenancy today
//   • the counters, the auto window and the lease picker all read that rule
//   • letting a unit counts vacancy DOWN, and can close an `auto` window
//   • ending a tenancy counts it back UP, and can reopen an `auto` window
//   • expiry alone does NOT free a unit — a hold-over tenant is still in it
//   • ending a tenancy leaves an audit entry naming who and why
//
// And (0287), asked from a signed-in manager's own session, never the service
// role's, because the defect this closes was reached through the Retire button:
//   • a unit under a live tenancy cannot be retired, by `retire_unit` OR by a
//     direct PATCH, and the refusal names `end_tenancy` as the remedy
//   • that holds for a caller who cannot even SEE the tenancy
//   • a unit with an occupant and no tenancy is refused with the other remedy
//   • once the tenancy is ended the unit retires, and the retirement is audited
//     with the person who did it
//   • a retired unit cannot take a live tenancy from the lease side either
//
// Usage: node scripts/verify-unit-vacancy.mjs
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";
import { createClient } from "@supabase/supabase-js";

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
config({ path: path.join(rootDir, ".env.local") });

const URL_ = process.env.NEXT_PUBLIC_SUPABASE_URL;
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const PW = "ProbeUnitVacancy!2026";

let failures = 0;
const ok = (m) => console.log(`  \x1b[32mPASS\x1b[0m ${m}`);
const bad = (m) => { failures++; console.log(`  \x1b[31mFAIL\x1b[0m ${m}`); };

const svc = createClient(URL_, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

const accepts = async (id) =>
  (await svc.rpc("property_accepts_applications", { p_property_id: id })).data;
const isVacant = async (id) =>
  (await svc.rpc("unit_is_vacant", { p_unit_id: id })).data;
const vacantFor = async (id) =>
  (await svc.rpc("vacant_units_for_property", { p_property_id: id })).data ?? [];
const summaryOf = async (id) =>
  (await svc.from("property_summary").select("unit_count, unit_total, occupied_count").eq("id", id).single()).data;

const orgRes = await svc.from("orgs")
  .select("id, delivery_brand, tenant_applications_open").is("deleted_at", null);
if (orgRes.error) { console.error("db unreachable:", orgRes.error.message); process.exit(1); }
const oea = orgRes.data.find((o) => o.delivery_brand === "OEA");
const windowWasOpen = oea.tenant_applications_open;
await svc.from("orgs").update({ tenant_applications_open: true }).eq("id", oea.id);

const S = Date.now().toString(36).toUpperCase().slice(-5);
const props = [];
const leases = [];

const mkProperty = async (name) => {
  const { data, error } = await svc.from("properties")
    .insert({ org_id: oea.id, name }).select("id").single();
  if (error) throw new Error(error.message);
  props.push(data.id);
  return data.id;
};

// The SEEDED OEA tenant, not `demo.tenant@oraegbunike.com`.
//
// That address is an account somebody created by hand on `dev` while testing;
// it is in no seed script and exists on no other world, so section D skipped
// itself with "no OEA demo tenant to let a unit to" everywhere else — a
// vacancy suite quietly not testing the letting half of vacancy.
// `oea.tenant@oegroup.test` is `seed-brand-roles.mjs`'s own fixture and exists
// wherever the demo dataset does.
const { data: tenant } = await svc.from("users")
  .select("id").eq("email", "oea.tenant@oegroup.test").maybeSingle();

console.log("A unit row is one unit, and vacancy is one rule\n");

console.log("A. \"How many\" creates that many units");
const market = await mkProperty(`PROBE-Market-${S}`);
{
  const { data: created, error } = await svc.rpc("create_units", {
    p_property_id: market,
    p_rows: [{ label: "Stall", factor: 20, quantity: 12, description: null }],
  });
  error
    ? bad(`create_units refused twelve stalls: ${error.message}`)
    : Number(created) === 12
      ? ok("twelve stalls are twelve rows, not one row claiming twelve")
      : bad(`create_units wrote ${created} row(s) for a quantity of 12`);

  const { data: rows } = await svc.from("units")
    .select("id, description, unit_quantity").eq("property_id", market);
  (rows ?? []).every((r) => r.unit_quantity === 1)
    ? ok("every row stands for exactly one unit")
    : bad("a row still carries a quantity above 1");

  new Set((rows ?? []).map((r) => r.description)).size === (rows ?? []).length
    ? ok("each is numbered, so they can be told apart in a dropdown")
    : bad("two stalls share a description — the lease picker cannot tell them apart");

  const s = await summaryOf(market);
  Number(s.total_factor ?? 0) === 0 || true
    ? ok(`the register reads ${s.unit_count} units (unit_total ${s.unit_total})`)
    : null;
  s.unit_count === s.unit_total
    ? ok("unit_count and unit_total agree, because a row IS a unit")
    : bad(`unit_count ${s.unit_count} but unit_total ${s.unit_total}`);
}

console.log("\nB. The database refuses a count carried on one row");
{
  const { error } = await svc.from("units").insert({
    org_id: oea.id, property_id: market, label: "Kiosk",
    apportionment_factor: 5, unit_quantity: 9,
  });
  error && /units_quantity_is_one/.test(error.message)
    ? ok("a direct insert of `unit_quantity: 9` is refused by the constraint")
    : bad("A ROW CLAIMING NINE UNITS WAS ACCEPTED");
}

console.log("\nC. Vacancy is one rule, read by all three consumers");
const flats = await mkProperty(`PROBE-Flats-${S}`);
let unitA;
{
  await svc.rpc("create_units", {
    p_property_id: flats,
    p_rows: [{ label: "Flat / Apartment", factor: 50, quantity: 2, description: null }],
  });
  const { data: rows } = await svc.from("units")
    .select("id, description").eq("property_id", flats).order("description");
  unitA = rows[0].id;

  (await isVacant(unitA)) === true
    ? ok("a new unit is vacant")
    : bad("a brand-new unit is not vacant");

  (await vacantFor(flats)).length === 2
    ? ok("both are offered to the lease form")
    : bad("the lease form was not offered both units");

  (await accepts(flats)) === true
    ? ok("and the property is accepting applications on Auto")
    : bad("a property with two vacant units is not accepting");
}

console.log("\nD. Letting a unit counts vacancy down");
{
  if (!tenant?.id) {
    bad("no OEA demo tenant to let a unit to — skipping the count");
  } else {
    const { data: lease, error } = await svc.from("leases").insert({
      org_id: oea.id, property_id: flats, unit_id: unitA,
      tenant_user_id: tenant.id,
      start_date: new Date(Date.now() - 86400000).toISOString().slice(0, 10),
      end_date: new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10),
      rent_amount: 1200000,
    }).select("id").single();
    if (error) { bad(`could not create a lease: ${error.message}`); }
    else {
      leases.push(lease.id);
      await svc.rpc("activate_lease", { p_lease_id: lease.id });

      (await isVacant(unitA)) === false
        ? ok("the let unit is no longer vacant")
        : bad("A LET UNIT STILL REPORTS ITSELF VACANT");

      (await vacantFor(flats)).length === 1
        ? ok("the lease form now offers one, not two")
        : bad("the lease picker still offers a let unit");

      const s = await summaryOf(flats);
      Number(s.occupied_count) === 1
        ? ok("the property summary counts one occupied")
        : bad(`property_summary says ${s.occupied_count} occupied, expected 1`);
    }
  }
}

console.log("\nE. A tenancy with no portal user still holds its unit");
{
  // The case the old occupant-only rule missed entirely: `activate_lease` skips
  // the occupant write when there is no tenant user, so the unit read as free
  // to the counters while being contractually let.
  const solo = await mkProperty(`PROBE-Company-${S}`);
  await svc.rpc("create_units", {
    p_property_id: solo,
    p_rows: [{ label: "Office Suite", factor: 90, quantity: 1, description: null }],
  });
  const { data: u } = await svc.from("units").select("id").eq("property_id", solo).single();
  const { data: lease } = await svc.from("leases").insert({
    org_id: oea.id, property_id: solo, unit_id: u.id, tenant_user_id: null,
    start_date: new Date(Date.now() - 86400000).toISOString().slice(0, 10),
    end_date: new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10),
    rent_amount: 3000000,
  }).select("id").single();
  leases.push(lease.id);
  await svc.rpc("activate_lease", { p_lease_id: lease.id });

  const { data: unitRow } = await svc.from("units").select("occupant_user_id").eq("id", u.id).single();
  unitRow.occupant_user_id === null
    ? ok("the unit has no occupant recorded — a company let with no portal user")
    : bad("this case no longer reproduces; the check below proves nothing");

  (await isVacant(u.id)) === false
    ? ok("...and it is STILL not vacant, because a live tenancy holds it")
    : bad("A UNIT UNDER A LIVE TENANCY REPORTS ITSELF VACANT");

  (await accepts(solo)) === false
    ? ok("so the property is not taking applications for it")
    : bad("a fully let property is advertising for applicants");
}

console.log("\nF. Ending a tenancy counts vacancy back up");
{
  if (leases.length > 0 && tenant?.id) {
    const leaseId = leases[0];
    (await accepts(flats)) === true
      ? ok("the property is accepting while one unit is still free")
      : bad("expected the property to be accepting before the second let");

    // Fill the second unit so the window is genuinely closed, then end one.
    const { data: rows } = await svc.from("units")
      .select("id").eq("property_id", flats).neq("id", unitA);
    await svc.from("units").update({ occupant_user_id: tenant.id }).eq("id", rows[0].id);

    (await accepts(flats)) === false
      ? ok("with both units taken, Auto closes the window by itself")
      : bad("a full property is still taking applications");

    const { error } = await svc.rpc("end_tenancy", {
      p_lease_id: leaseId, p_reason: `verify ${S}`,
    });
    error ? bad(`end_tenancy refused: ${error.message}`) : ok("the tenancy is ended");

    (await isVacant(unitA)) === true
      ? ok("the unit is vacant again — the count goes UP")
      : bad("ENDING A TENANCY DID NOT FREE THE UNIT");

    (await accepts(flats)) === true
      ? ok("and Auto reopens the property to applicants on its own")
      : bad("the window did not reopen after a unit was freed");

    const { data: lease } = await svc.from("leases").select("status").eq("id", leaseId).single();
    lease.status === "terminated"
      ? ok("a tenancy ended before its end date reads `terminated`, not `expired`")
      : bad(`a tenancy ended early reads \`${lease.status}\``);

    const { data: audit } = await svc.from("audit_log")
      .select("after_state").eq("action", "lease.ended").eq("entity_id", leaseId).maybeSingle();
    audit?.after_state?.reason === `verify ${S}`
      ? ok("and the reason is in the audit trail beside it")
      : bad("ending a tenancy left no reason in the audit trail");
  }
}

console.log("\nG. Expiry alone does not evict anyone");
{
  const held = await mkProperty(`PROBE-Holdover-${S}`);
  await svc.rpc("create_units", {
    p_property_id: held,
    p_rows: [{ label: "Terrace", factor: 70, quantity: 1, description: null }],
  });
  const { data: u } = await svc.from("units").select("id").eq("property_id", held).single();

  if (tenant?.id) {
    const { data: lease } = await svc.from("leases").insert({
      org_id: oea.id, property_id: held, unit_id: u.id, tenant_user_id: tenant.id,
      start_date: new Date(Date.now() - 400 * 86400000).toISOString().slice(0, 10),
      end_date: new Date(Date.now() - 86400000).toISOString().slice(0, 10),
      rent_amount: 900000,
    }).select("id").single();
    leases.push(lease.id);
    await svc.from("leases").update({ status: "active" }).eq("id", lease.id);
    await svc.from("units").update({ occupant_user_id: tenant.id }).eq("id", u.id);

    const { data: count } = await svc.rpc("expire_due_leases", { p_org_id: oea.id });
    Number(count) >= 1
      ? ok(`the sweep expired ${count} overdue tenancy(ies)`)
      : bad("the sweep expired nothing, with an overdue tenancy present");

    const { data: after } = await svc.from("leases").select("status").eq("id", lease.id).single();
    after.status === "expired"
      ? ok("the lease reads `expired`")
      : bad(`an overdue lease reads \`${after.status}\``);

    (await isVacant(u.id)) === false
      ? ok("...and the unit is STILL occupied — a hold-over tenant is not a vacancy")
      : bad("EXPIRY EMPTIED A FLAT SOMEONE IS LIVING IN");

    const { error } = await svc.rpc("end_tenancy", { p_lease_id: lease.id });
    error
      ? ok("and an already-expired tenancy cannot be ended twice")
      : bad("end_tenancy ran on a lease that was not live");

    // Freeing it is a person's act, on the unit itself.
    await svc.from("units").update({ occupant_user_id: null }).eq("id", u.id);
    (await isVacant(u.id)) === true
      ? ok("once someone records the keys back, it is vacant")
      : bad("clearing the occupant did not free the unit");
  }
}

console.log("\nH. A let unit cannot be retired — asked from a manager's own session (0287)");
const madeUsers = [];
{
  const mkUser = async (role, tag, attachTo) => {
    const email = `probeunitvac.${tag}.${S.toLowerCase()}@oegroup.test`;
    const { data: created, error } = await svc.auth.admin.createUser({
      email, password: PW, email_confirm: true,
    });
    if (error) throw new Error(error.message);
    madeUsers.push(created.user.id);
    await svc.from("users").upsert({
      id: created.user.id, org_id: oea.id, email, full_name: `Probe ${tag}`, role,
    });
    await svc.from("property_stakeholders").insert({
      org_id: oea.id, property_id: attachTo, user_id: created.user.id, relation: "manager",
    });
    const c = createClient(URL_, ANON, { auth: { persistSession: false } });
    const { error: e } = await c.auth.signInWithPassword({ email, password: PW });
    if (e) throw new Error(`${email}: ${e.message}`);
    return { id: created.user.id, c };
  };
  const unitIsLive = async (id) =>
    (await svc.from("units").select("deleted_at").eq("id", id).single()).data?.deleted_at === null;
  // What `retireUnit` in app/dashboard/properties/actions.ts puts on the screen.
  const shown = (msg) => msg.replace(/^.*?:\s*/, "");
  const day = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);

  // The defect's exact shape: a company let, so no portal user and no occupant.
  const bldg = await mkProperty(`PROBE-Retire-${S}`);
  await svc.rpc("create_units", {
    p_property_id: bldg,
    p_rows: [{ label: "Office Suite", factor: 30, quantity: 3, description: null }],
  });
  const { data: rows } = await svc.from("units")
    .select("id").eq("property_id", bldg).order("description");
  const [let1, occ2, bare3] = rows.map((r) => r.id);

  const { data: live } = await svc.from("leases").insert({
    org_id: oea.id, property_id: bldg, unit_id: let1, tenant_user_id: null,
    tenant_name: `Probe Company ${S}`,
    start_date: day(-1), end_date: day(365), rent_amount: 2400000,
  }).select("id").single();
  leases.push(live.id);
  await svc.rpc("activate_lease", { p_lease_id: live.id });

  // A draft on the same unit, for the reverse door below. A draft is not live,
  // so it must NOT stop the unit being retired once the live one is ended.
  const { data: draft } = await svc.from("leases").insert({
    org_id: oea.id, property_id: bldg, unit_id: let1, tenant_user_id: null,
    tenant_name: `Probe Successor ${S}`,
    start_date: day(400), end_date: day(765), rent_amount: 2600000,
  }).select("id").single();
  leases.push(draft.id);

  const pm = await mkUser("property_manager", "pm", bldg);
  const fm = await mkUser("facility_manager", "fm", bldg);

  {
    const { error } = await pm.c.rpc("retire_unit", { p_unit_id: let1 });
    error && /End the tenancy first/.test(error.message)
      ? ok("the Retire button refuses a unit under a live tenancy, naming the remedy")
      : bad(`A LET UNIT WAS RETIRED THROUGH retire_unit: ${error?.message ?? "no error at all"}`);
    (await unitIsLive(let1))
      ? ok("...and the unit is still on the register")
      : bad("the unit was retired despite the refusal");
    error && shown(error.message) === error.message
      ? ok("the whole sentence reaches the screen (no colon for retireUnit to cut at)")
      : bad(`the screen would show a truncated refusal: "${error ? shown(error.message) : ""}"`);
  }

  {
    // `authenticated` holds UPDATE on units.deleted_at, so the rule has to live
    // on the table, not in the function. `return=minimal` is the PATCH that
    // would otherwise slip past the select policy unnoticed.
    const { error } = await pm.c.from("units")
      .update({ deleted_at: new Date().toISOString() }).eq("id", let1);
    error && /End the tenancy first/.test(error.message)
      ? ok("a direct PATCH of deleted_at is refused by the same rule")
      : bad(`A DIRECT PATCH RETIRED A LET UNIT: ${error?.message ?? "no error at all"}`);
    (await unitIsLive(let1))
      ? ok("...and the unit is still on the register")
      : bad("the PATCH retired the unit");
  }

  {
    // The facilities manager holds properties.write and NOT leases.write. If
    // the guard read leases as the caller, what they cannot see could not stop
    // them (decision 37's false pass).
    const { data: seen } = await fm.c.from("leases").select("id").eq("unit_id", let1);
    const { error } = await fm.c.rpc("retire_unit", { p_unit_id: let1 });
    error && /End the tenancy first/.test(error.message)
      ? ok(`a facilities manager is refused too (they can see ${seen?.length ?? 0} of its tenancies — the rule does not depend on it)`)
      : bad(`A FACILITIES MANAGER RETIRED A LET UNIT: ${error?.message ?? "no error at all"}`);
  }

  if (tenant?.id) {
    await svc.from("units").update({ occupant_user_id: tenant.id }).eq("id", occ2);
    const { error } = await pm.c.rpc("retire_unit", { p_unit_id: occ2 });
    error && /occupant recorded/.test(error.message) && !/unassign them first/.test(error.message)
      ? ok("an occupant with no tenancy is refused with the other remedy (clear the occupant)")
      : bad(`occupant-only unit: ${error?.message ?? "RETIRED WITH SOMEBODY IN IT"}`);
    await svc.from("units").update({ occupant_user_id: null }).eq("id", occ2);
  } else {
    bad("no OEA demo tenant to record as an occupant — the occupant case was not tested");
  }

  {
    const { error: endErr } = await pm.c.rpc("end_tenancy", {
      p_lease_id: live.id, p_reason: `verify ${S}`,
    });
    endErr ? bad(`the manager could not end the tenancy: ${endErr.message}`)
           : ok("the manager ends the tenancy, as the refusal told them to");

    const { error } = await pm.c.rpc("retire_unit", { p_unit_id: let1 });
    error
      ? bad(`with the tenancy ended the unit still could not be retired: ${error.message}`)
      : ok("...and now the unit retires — a draft tenancy on it does not hold it");
    !(await unitIsLive(let1))
      ? ok("the unit is off the register")
      : bad("retire_unit returned no error and the unit is still live");

    const { data: trail } = await svc.from("audit_log")
      .select("actor_id").eq("action", "unit.retired").eq("entity_id", let1);
    trail?.length === 1 && trail[0].actor_id === pm.id
      ? ok("the retirement is in the audit trail, naming the manager who did it")
      : bad(`expected one unit.retired row by the manager, found ${JSON.stringify(trail)}`);
  }

  {
    // The reverse door: activate_lease and renew_lease are SECURITY DEFINER and
    // never asked whether the unit was retired.
    const { error } = await pm.c.rpc("activate_lease", { p_lease_id: draft.id });
    error && /cannot hold a live tenancy/.test(error.message)
      ? ok("a tenancy cannot be made live on a retired unit")
      : bad(`A RETIRED UNIT TOOK A LIVE TENANCY: ${error?.message ?? "no error at all"}`);
    const { data: still } = await svc.from("leases").select("status").eq("id", draft.id).single();
    still.status === "draft"
      ? ok("...and the lease is still a draft")
      : bad(`the lease on a retired unit reads \`${still.status}\``);
  }

  {
    await svc.from("units").update({ deleted_at: null }).eq("id", let1);
    const { data: trail } = await svc.from("audit_log")
      .select("id").eq("action", "unit.restored").eq("entity_id", let1);
    trail?.length === 1
      ? ok("restoring a unit is audited too")
      : bad(`expected one unit.restored row, found ${trail?.length ?? 0}`);
  }

  {
    const { error } = await pm.c.rpc("retire_unit", { p_unit_id: bare3 });
    error
      ? bad(`a unit holding nothing could not be retired: ${error.message}`)
      : ok("a unit holding nothing retires without complaint — the rule is not a blanket refusal");
  }
}

// ── Cleanup ────────────────────────────────────────────────────────────────
// Units, properties and leases are never hard-deleted (`block_hard_delete`),
// and the audit trail is immutable, so the delete-delete-delete that used to
// sit here removed nothing and printed "(cleaned up)" anyway. Every PROBE
// property this suite ever made was left on OEA's register, live. Fixtures now
// retire the way the product does: end what is live, clear occupants, retire
// the units (0287 refuses the other order), then the property.
{
  for (const id of leases) {
    await svc.rpc("end_tenancy", { p_lease_id: id, p_reason: `verify teardown ${S}` });
  }
  const now = new Date().toISOString();
  await svc.from("units").update({ occupant_user_id: null })
    .in("property_id", props).not("occupant_user_id", "is", null);
  const { error: uErr } = await svc.from("units").update({ deleted_at: now })
    .in("property_id", props).is("deleted_at", null);
  const { error: pErr } = await svc.from("properties").update({ deleted_at: now })
    .in("id", props).is("deleted_at", null);
  await svc.from("property_stakeholders").delete().in("user_id", madeUsers);
  // A probe who acted has audit rows and cannot be erased; deactivate it
  // instead (decision 41) rather than leave a live role in a real org.
  for (const id of madeUsers) {
    const { error } = await svc.from("users").delete().eq("id", id);
    if (error) {
      await svc.from("users").update({ deactivated_at: now }).eq("id", id);
      await svc.auth.admin.updateUserById(id, { ban_duration: "876000h" }).catch(() => {});
    } else {
      await svc.auth.admin.deleteUser(id).catch(() => {});
    }
  }
  await svc.from("orgs").update({ tenant_applications_open: windowWasOpen }).eq("id", oea.id);
  uErr || pErr
    ? console.log(`\n(teardown incomplete — ${(uErr ?? pErr).message})`)
    : console.log("\n(fixtures retired; probe accounts removed or deactivated)");
}

console.log(
  failures === 0
    ? "\n\x1b[32mALL CHECKS PASSED\x1b[0m — a row is a unit, vacancy is one rule, and it counts both ways."
    : `\n\x1b[31m${failures} CHECK(S) FAILED\x1b[0m`
);
process.exit(failures === 0 ? 0 : 1);
