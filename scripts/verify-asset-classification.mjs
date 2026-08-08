// Asset assemblies, mobility and maintenance strategy (0121).
//
// From `docs/ASSET_CLASSIFICATION_AND_SCOPE.md` Part 2. Part 1 of that
// document is confirmation of the existing taxonomy and RLS scoping, which
// this deliberately does not re-test — `verify-asset-access` already covers
// the scoping, and re-asserting a design nobody changed is noise.
//
// ⚠️ The cycle guard is the piece worth proving. A self-referencing FK with a
// "walk up and refuse" trigger is easy to write and easy to get subtly wrong:
// the direct self-parent case is obvious, the A→B→A case is not, and the case
// that actually bites is re-parenting an ANCESTOR under its own descendant,
// which looks like an ordinary edit right up until the register cannot be
// walked. Sections B and C test all three.
//
// Usage: node scripts/verify-asset-classification.mjs
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
const note = (m) => console.log(`  \x1b[33mNOTE\x1b[0m ${m}`);

const MARK = "PROBEASSET";
const S = Date.now().toString(36).toUpperCase().slice(-5);
const made = [];

// Start-of-run sweep.
{
  const { data: strays } = await svc.from("assets").select("id").like("name", `${MARK}%`);
  if (strays?.length) {
    // Children first: the FK has no cascade, so a parent cannot go while a
    // component still points at it.
    await svc.from("assets").update({ parent_asset_id: null }).in("id", strays.map((s) => s.id));
    await svc.from("assets").delete().in("id", strays.map((s) => s.id));
    console.log(`(swept ${strays.length} stray asset(s))`);
  }
}

const { data: orgs } = await svc.from("orgs")
  .select("id, slug, is_platform_operator").is("deleted_at", null);
const tenantOrgs = (orgs ?? []).filter((o) => !o.is_platform_operator);

// An org with at least two properties, so cross-property parenting is testable.
let ctx = null;
for (const o of tenantOrgs) {
  const { data: props } = await svc.from("properties").select("id, name").eq("org_id", o.id).limit(2);
  if ((props ?? []).length >= 2) { ctx = { org: o, props }; break; }
}
if (!ctx) {
  const o = tenantOrgs[0];
  const { data: props } = await svc.from("properties").select("id, name").eq("org_id", o.id).limit(1);
  ctx = { org: o, props: props ?? [] };
}
if (!ctx.props.length) { console.log("no property to attach assets to — cannot run"); process.exit(1); }

let tagSeq = 0;
const mk = async (name, extra = {}) => {
  // `asset_tag` is NOT NULL and unique per org — each fixture needs its own.
  const { data, error } = await svc.from("assets").insert({
    org_id: ctx.org.id, property_id: ctx.props[0].id,
    name: `${MARK}-${S}-${name}`, asset_tag: `${MARK}-${S}-${++tagSeq}`,
    category: "hvac", ...extra,
  }).select("id").single();
  if (error) throw new Error(`fixture ${name}: ${error.message}`);
  made.push(data.id);
  return data.id;
};

console.log(`Asset classification — assemblies, mobility, maintenance (${ctx.org.slug})\n`);

console.log("A. An assembly holds its components");
{
  const plant = await mk("Plant");
  const ahu = await mk("AHU", { parent_asset_id: null });

  const { error } = await svc.from("assets").update({ parent_asset_id: plant }).eq("id", ahu);
  error ? bad(`could not attach a component: ${error.message}`) : ok("a component attaches to its assembly");

  const { data: kids } = await svc.from("assets").select("id").eq("parent_asset_id", plant);
  (kids ?? []).length === 1
    ? ok("and the assembly lists it — a system-level rollup is now possible")
    : bad(`expected 1 component, got ${(kids ?? []).length}`);
}

console.log("\nB. An asset cannot become a component of itself");
{
  const a = await mk("Self");
  const { error } = await svc.from("assets").update({ parent_asset_id: a }).eq("id", a);
  error ? ok("direct self-parenting is refused") : bad("!!! AN ASSET BECAME ITS OWN PARENT");
}

console.log("\nC. Nor through its own descendants — the case that actually bites");
{
  const top = await mk("Top");
  const mid = await mk("Mid");
  const leaf = await mk("Leaf");
  await svc.from("assets").update({ parent_asset_id: top }).eq("id", mid);
  await svc.from("assets").update({ parent_asset_id: mid }).eq("id", leaf);

  // A→B is fine; B→A closes a two-step loop.
  const two = await svc.from("assets").update({ parent_asset_id: mid }).eq("id", top);
  two.error ? ok("a two-step loop (top under its own child) is refused") : bad("!!! A TWO-STEP CYCLE WAS CREATED");

  // The deeper one: re-parent the root under its own grandchild. This looks
  // like an ordinary edit and is what silently makes a register unwalkable.
  const three = await svc.from("assets").update({ parent_asset_id: leaf }).eq("id", top);
  three.error
    ? ok("and a three-step loop (root under its own grandchild) is refused")
    : bad("!!! A THREE-STEP CYCLE WAS CREATED — the register can no longer be walked");

  // The chain is intact and still walkable after the refusals.
  const { data: chain } = await svc.from("assets")
    .select("id, parent_asset_id").in("id", [top, mid, leaf]);
  const byId = new Map((chain ?? []).map((c) => [c.id, c.parent_asset_id]));
  byId.get(top) === null && byId.get(mid) === top && byId.get(leaf) === mid
    ? ok("and the refusals left the existing chain exactly as it was")
    : bad(`chain damaged: ${JSON.stringify([...byId])}`);
}

console.log("\nD. A component belongs to the same property");
{
  if (ctx.props.length < 2) { note("only one property on this org — cross-property parenting not testable"); }
  else {
    const here = await mk("Here");
    const { data: there, error: mkErr } = await svc.from("assets").insert({
      org_id: ctx.org.id, property_id: ctx.props[1].id,
      name: `${MARK}-${S}-There`, asset_tag: `${MARK}-${S}-there`, category: "hvac",
    }).select("id").single();
    if (mkErr) bad(`could not create the second-property fixture: ${mkErr.message}`);
    else {
      made.push(there.id);
      const { error } = await svc.from("assets").update({ parent_asset_id: here }).eq("id", there.id);
      error
        ? ok("an asset on another property cannot be a component of this one")
        : bad("!!! A COMPONENT WAS ATTACHED ACROSS PROPERTIES — a register would misreport what is on site");
    }
  }
}

console.log("\nE. Fixed vs movable");
{
  const a = await mk("Mobility");
  const { data: def } = await svc.from("assets").select("mobility").eq("id", a).single();
  def.mobility === "fixed"
    ? ok("defaults to FIXED — the safe assumption for a register of buildings")
    : bad(`default is ${def.mobility}`);

  const { error: okErr } = await svc.from("assets").update({ mobility: "movable" }).eq("id", a);
  okErr ? bad(`could not mark an asset movable: ${okErr.message}`) : ok("can be marked movable");

  const { error: badErr } = await svc.from("assets").update({ mobility: "portable" }).eq("id", a);
  badErr ? ok("and an invented value is refused") : bad("an arbitrary mobility value was accepted");

  // Advisory by design: relocating a FIXED asset must still be POSSIBLE, so a
  // miscategorised lift can be corrected. Asserting the opposite would encode
  // the wrong rule.
  if (ctx.props.length >= 2) {
    const fixed = await mk("StillFixed");
    const { error: moveErr } = await svc.from("assets")
      .update({ property_id: ctx.props[1].id }).eq("id", fixed);
    !moveErr
      ? ok("a fixed asset can still be relocated — advisory, so a mistake stays correctable")
      : bad(`the database blocked correcting a fixed asset: ${moveErr.message}`);
  }
}

console.log("\nF. Maintenance strategy");
{
  const a = await mk("Strategy");
  const { data: def } = await svc.from("assets")
    .select("maintenance_strategy, service_interval_days").eq("id", a).single();
  def.maintenance_strategy === "reactive" && def.service_interval_days === null
    ? ok("defaults to REACTIVE with no interval")
    : bad(`unexpected default: ${JSON.stringify(def)}`);

  const { error: noInterval } = await svc.from("assets")
    .update({ maintenance_strategy: "calendar" }).eq("id", a);
  noInterval
    ? ok("calendar with no interval is refused — a strategy with no period is just a label")
    : bad("!!! a calendar asset was saved with no service interval");

  const { error: good } = await svc.from("assets")
    .update({ maintenance_strategy: "calendar", service_interval_days: 90 }).eq("id", a);
  good ? bad(`a valid calendar strategy was refused: ${good.message}`) : ok("calendar with an interval saves");

  const { error: zero } = await svc.from("assets")
    .update({ service_interval_days: 0 }).eq("id", a);
  zero ? ok("a zero-day interval is refused") : bad("a zero-day service interval was accepted");

  // `usage` stays reachable at the database so the column never needs
  // widening when the meter tables land — but nothing should set it yet.
  const { error: usageErr } = await svc.from("assets")
    .update({ maintenance_strategy: "usage", service_interval_days: null }).eq("id", a);
  !usageErr
    ? ok("'usage' is accepted by the constraint — the Phase-2 seam is open, and the UI simply does not offer it")
    : bad(`the Phase-2 value was rejected, so the column WILL need widening later: ${usageErr.message}`);
}

console.log("\nG. An asset states what it serves (decision 8)");
{
  // ⚠️ The clause decision 8 spelled out and nothing had built: "'Shared' is a
  // stated fact, never an absent `unit_id` — a nullable FK used as a meaning
  // produced three live defects in one week, because NULL never matches an
  // `IN` list."
  const a = await mk("Scope");
  const { data: def } = await svc.from("assets").select("scope").eq("id", a).single();
  def.scope === "property"
    ? ok("defaults to PROPERTY — shared unless someone says otherwise")
    : bad(`default scope is ${def.scope}`);

  const { error: badVal } = await svc.from("assets").update({ scope: "block" }).eq("id", a);
  badVal ? ok("and an invented scope is refused") : bad("an arbitrary scope was accepted");

  // The consistency rule, both ways round. Without it the column is decoration:
  // a row could claim unit scope with no unit, or shared scope while pinned to
  // one, and the "stated fact" would be a lie.
  const { error: unitNoUnit } = await svc.from("assets")
    .update({ scope: "unit" }).eq("id", a);
  unitNoUnit
    ? ok("a unit-scoped asset with no unit is refused — the stated fact must be true")
    : bad("!!! an asset claims unit scope while naming no unit");

  const { data: someUnit } = await svc.from("units")
    .select("id").eq("property_id", ctx.props[0].id).limit(1).maybeSingle();
  if (!someUnit) {
    note("no unit on this property — the pinned-shared-asset check needs one");
  } else {
    const { error: sharedPinned } = await svc.from("assets")
      .update({ scope: "property", unit_id: someUnit.id }).eq("id", a);
    sharedPinned
      ? ok("and a property-scoped asset cannot be pinned to a single unit")
      : bad("!!! a shared asset was pinned to one unit");

    // The query the column exists for: a unit's own assets PLUS the shared
    // plant above it. `unit_id IN (...)` structurally cannot answer this, which
    // is how shared plant disappeared from per-unit reports.
    const shared = await mk("SharedPlant");
    const pinned = await mk("InUnit", { unit_id: someUnit.id, scope: "unit" });
    const { data: serving, error: servErr } = await svc
      .rpc("assets_serving_unit", { p_unit_id: someUnit.id });
    if (servErr) {
      bad(`assets_serving_unit failed: ${servErr.message}`);
    } else {
      const ids = (serving ?? []).map((r) => r.id);
      ids.includes(pinned) && ids.includes(shared)
        ? ok("assets_serving_unit returns the unit's OWN asset and the shared plant above it")
        : bad(`a per-unit view missed one: own=${ids.includes(pinned)} shared=${ids.includes(shared)}`);
    }
  }
}

console.log("\nH. Phase 2 really is still Phase 2");
{
  // The doc's claim, re-checked here rather than trusted: if these tables ever
  // appear, 'usage' stops being a seam and this suite should say so.
  const present = [];
  for (const t of ["meters", "sensor_readings", "ml_features"]) {
    const { error } = await svc.from(t).select("*").limit(1);
    if (!error) present.push(t);
  }
  present.length === 0
    ? ok("meters/sensor_readings/ml_features still absent — 'usage' is correctly unreachable")
    : note(`${present.join(", ")} now exist — usage-based maintenance can be built`);
}

console.log("\nI. A parent cannot leave its components behind on relocation (0806-M1, 0143)");
{
  // Section D proved a component cannot be ATTACHED across properties. This is
  // the direction that gap actually was: an existing, validly-attached
  // assembly whose PARENT moves afterward, with parent_asset_id never touched
  // at all. Section E's "StillFixed" case (a childless asset) already proves
  // relocation must stay possible — this proves it must stay possible WITHOUT
  // silently stranding components on the property just left.
  if (ctx.props.length < 2) { note("only one property on this org — relocation-with-components not testable"); }
  else {
    const plant = await mk("RelocatingPlant");
    const c1 = await mk("Comp1", { parent_asset_id: plant });
    const c2 = await mk("Comp2", { parent_asset_id: plant });

    const { error: moveErr } = await svc.from("assets")
      .update({ property_id: ctx.props[1].id }).eq("id", plant);
    moveErr
      ? ok("relocating a parent away from its components is refused")
      : bad("!!! A PARENT WAS RELOCATED WHILE ITS COMPONENTS STAYED BEHIND — the old property's register now lies");

    const { data: after } = await svc.from("assets")
      .select("id, property_id").in("id", [plant, c1, c2]);
    const byId = new Map((after ?? []).map((r) => [r.id, r.property_id]));
    const stillTogether = byId.get(plant) === ctx.props[0].id
      && byId.get(c1) === ctx.props[0].id
      && byId.get(c2) === ctx.props[0].id;
    stillTogether
      ? ok("and the refusal left the whole assembly exactly where it was")
      : bad(`assembly split across properties after a refused move: ${JSON.stringify([...byId])}`);

    // The other direction: a component with no assembly relationship must
    // still be relocatable on its own — this must not become a blanket freeze
    // on property_id.
    const lone = await mk("LoneComponent");
    const { error: loneErr } = await svc.from("assets")
      .update({ property_id: ctx.props[1].id }).eq("id", lone);
    !loneErr
      ? ok("an asset with no parent and no children still relocates freely")
      : bad(`an unrelated asset was blocked from relocating: ${loneErr.message}`);
  }
}

// ── Cleanup ───────────────────────────────────────────────────────────────
// Parent links first: the FK has no cascade.
await svc.from("assets").update({ parent_asset_id: null }).in("id", made);
await svc.from("assets").delete().in("id", made);
console.log("\n(cleaned up)");

console.log(
  failures === 0
    ? "\n\x1b[32mALL CHECKS PASSED\x1b[0m — assemblies hold together, cannot loop, and a maintenance strategy means something."
    : `\n\x1b[31m${failures} CHECK(S) FAILED\x1b[0m`
);
process.exit(failures === 0 ? 0 : 1);
