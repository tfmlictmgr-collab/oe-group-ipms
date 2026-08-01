// Day 8.75 — the read/write surface the hierarchy screen needs.
//
// The claims that matter:
//   • retire_org_node refuses while a live child node exists
//   • retire_org_node refuses while a live property is filed on it
//   • retire_org_node succeeds once both are clear, and is idempotent
//   • retire_org_node is gated on hierarchy.write, same as every other write here
//   • org_nodes_overview's three counts are each correct, not just non-null
//   • property_summary carries the property's place in the tree
//
// Usage: node scripts/verify-hierarchy-ui.mjs
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { sweepProbeNodes, cleanupNodes } from "./lib/probe-cleanup.mjs";

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
config({ path: path.join(rootDir, ".env.local") });

const URL_ = process.env.NEXT_PUBLIC_SUPABASE_URL;
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const SVCK = process.env.SUPABASE_SERVICE_ROLE_KEY;
const PW = "OEGroupDemo2026!";

let failures = 0;
const ok = (m) => console.log(`  \x1b[32mPASS\x1b[0m ${m}`);
const bad = (m) => { failures++; console.log(`  \x1b[31mFAIL\x1b[0m ${m}`); };

const svc = createClient(URL_, SVCK, { auth: { persistSession: false } });

const orgRes = await svc.from("orgs").select("id, slug, delivery_brand").is("deleted_at", null);
if (orgRes.error) { console.error("db unreachable:", orgRes.error.message); process.exit(1); }
// ⚠️ The POC org by SLUG. `delivery_brand === 'direct'` is not an identifier —
// it means "no single brand delivers this", which is equally true of the platform
// operator and of every independent client (the service-charge client, 0094). The
// old `.find()` returned whichever such row came back first.
const poc = orgRes.data.find((o) => o.slug === "oe-group-foundation-poc");

// Repair anything a crashed earlier run left behind, before adding more.
const swept = await sweepProbeNodes(svc, "PROBE-UI-");
if (swept > 0) console.log(`(swept ${swept} node(s) left by an earlier run)\n`);

const S = Date.now().toString(36).toUpperCase().slice(-5);
const nodes = [];
const props = [];

const mkNode = async (parent, level, name) => {
  const { data, error } = await svc.from("org_nodes")
    .insert({ org_id: poc.id, parent_id: parent, level, name, path: "" })
    .select("id, path, level").single();
  if (error) return { error };
  nodes.push(data.id);
  return { data };
};
const mkProperty = async (siteId, name) => {
  const { data, error } = await svc.from("properties")
    .insert({ org_id: poc.id, name, site_node_id: siteId })
    .select("id").single();
  if (error) return { error };
  props.push(data.id);
  return { data };
};

console.log("Day 8.75 — the hierarchy screen's surface\n");

console.log("A. Retiring is refused while something depends on the node");
let region, location, project, prop;
{
  region = (await mkNode(null, "region", `PROBE-UI-Region-${S}`)).data;
  location = (await mkNode(region.id, "location", `PROBE-UI-Location-${S}`)).data;

  const { error: e1 } = await svc.rpc("retire_org_node", { p_node_id: region.id });
  e1 ? ok("a region with a live location cannot be retired") : bad("A REGION WITH A LIVE CHILD WAS RETIRED");

  project = (await mkNode(location.id, "project", `PROBE-UI-Project-${S}`)).data;
  const site = (await mkNode(project.id, "site", `PROBE-UI-Site-${S}`)).data;
  prop = (await mkProperty(site.id, `PROBE-UI-Property-${S}`)).data;

  const { error: e2 } = await svc.rpc("retire_org_node", { p_node_id: site.id });
  e2 ? ok("a site with a live property cannot be retired") : bad("A SITE WITH A LIVE PROPERTY WAS RETIRED");

  // Clear the property, then the site should retire cleanly.
  await svc.from("properties").update({ deleted_at: new Date().toISOString() }).eq("id", prop.id);
  const { error: e3 } = await svc.rpc("retire_org_node", { p_node_id: site.id });
  e3 ? bad(`site still refused once its property was retired — ${e3.message.slice(0, 70)}`)
     : ok("once the property is retired, the site retires cleanly");

  const { data: after } = await svc.from("org_nodes").select("deleted_at").eq("id", site.id).single();
  after?.deleted_at ? ok("the retired site actually carries a deleted_at") : bad("deleted_at was not set");

  const { error: e4 } = await svc.rpc("retire_org_node", { p_node_id: site.id });
  e4 ? bad(`retiring an already-retired node raised — ${e4.message.slice(0, 70)}`)
     : ok("retiring an already-retired node is a no-op, not an error");

  const { error: e5 } = await svc.rpc("retire_org_node", { p_node_id: project.id });
  e5 ? bad("a project whose only child is retired still could not be retired")
     : ok("a project whose child is now retired can itself be retired");
}

console.log("\nB. Retiring is gated on hierarchy.write, same as every other write here");
{
  const c = createClient(URL_, ANON);
  await c.auth.signInWithPassword({ email: "oe-group-foundation-poc.facilitymanager@oegroup.test", password: PW });
  const { error } = await c.rpc("retire_org_node", { p_node_id: location.id });
  error ? ok("an FM/PM without hierarchy.write is refused") : bad("AN FM/PM RETIRED A NODE WITHOUT THE CAPABILITY");
  await c.auth.signOut();
}

console.log("\nC. org_nodes_overview's counts are correct, not just present");
{
  const region2 = (await mkNode(null, "region", `PROBE-UI-Region2-${S}`)).data;
  const locA = (await mkNode(region2.id, "location", `PROBE-UI-LocA-${S}`)).data;
  await mkNode(region2.id, "location", `PROBE-UI-LocB-${S}`);
  const projA = (await mkNode(locA.id, "project", `PROBE-UI-ProjA-${S}`)).data;
  const siteA = (await mkNode(projA.id, "site", `PROBE-UI-SiteA-${S}`)).data;
  await mkProperty(siteA.id, `PROBE-UI-PropA1-${S}`);
  await mkProperty(siteA.id, `PROBE-UI-PropA2-${S}`);

  const { data: rows, error } = await svc.from("org_nodes_overview")
    .select("id, child_count, direct_property_count, subtree_property_count")
    .in("id", [region2.id, locA.id, siteA.id]);
  if (error) { bad(`could not read org_nodes_overview — ${error.message.slice(0, 70)}`); }
  else {
    const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
    byId[region2.id]?.child_count === 2
      ? ok("the region's child_count is exactly its two locations")
      : bad(`region child_count was ${byId[region2.id]?.child_count}`);
    byId[locA.id]?.child_count === 1
      ? ok("the location's child_count is its one project")
      : bad(`location child_count was ${byId[locA.id]?.child_count}`);
    byId[siteA.id]?.direct_property_count === 2
      ? ok("the site's direct_property_count is its two properties")
      : bad(`site direct_property_count was ${byId[siteA.id]?.direct_property_count}`);
    byId[region2.id]?.subtree_property_count === 2
      ? ok("the region's subtree_property_count reaches both properties, four levels down")
      : bad(`region subtree_property_count was ${byId[region2.id]?.subtree_property_count}`);
  }
}

console.log("\nD. property_summary carries the property's place in the tree");
{
  const names = {
    region: `PROBE-UI-Region3-${S}`, project: `PROBE-UI-Proj3-${S}`,
    location: `PROBE-UI-Loc3-${S}`, site: `PROBE-UI-Site3-${S}`,
  };
  const region3 = (await mkNode(null, "region", names.region)).data;
  const loc3 = (await mkNode(region3.id, "location", names.location)).data;
  const proj3 = (await mkNode(loc3.id, "project", names.project)).data;
  const site3 = (await mkNode(proj3.id, "site", names.site)).data;
  const filed = (await mkProperty(site3.id, `PROBE-UI-Filed-${S}`)).data;
  const unfiled = (await mkProperty(null, `PROBE-UI-Unfiled-${S}`)).data ??
    (await svc.from("properties").insert({ org_id: poc.id, name: `PROBE-UI-Unfiled-${S}` }).select("id").single()).data;
  if (unfiled) props.push(unfiled.id);

  const { data: rows } = await svc.from("property_summary")
    .select("id, site_node_id, node_path").in("id", [filed.id, unfiled?.id].filter(Boolean));
  const byId = Object.fromEntries((rows ?? []).map((r) => [r.id, r]));

  byId[filed.id]?.site_node_id === site3.id
    ? ok("a filed property's site_node_id round-trips through the view")
    : bad(`site_node_id was ${byId[filed.id]?.site_node_id}`);
  byId[filed.id]?.node_path === [names.region, names.location, names.project, names.site].join(" / ")
    ? ok(`node_path reads as the full ancestry ("${byId[filed.id]?.node_path}")`)
    : bad(`node_path was "${byId[filed.id]?.node_path}"`);
  if (unfiled) {
    (byId[unfiled.id]?.site_node_id ?? null) === null && byId[unfiled.id]?.node_path == null
      ? ok("an unfiled property carries no node_path — it stays fully operable, just unfiled")
      : bad("an unfiled property unexpectedly carries hierarchy data");
  }
}

// ── Cleanup ────────────────────────────────────────────────────────────────
const undeleted = await cleanupNodes(svc, nodes, props);
if (undeleted > 0) bad(`CLEANUP LEAKED ${undeleted} node(s) — they will appear in a live dropdown`);
else console.log("\n(cleaned up)");

console.log(
  failures === 0
    ? "\n\x1b[32mALL CHECKS PASSED\x1b[0m — retirement refuses to orphan, and both read surfaces the hierarchy screen needs report real counts."
    : `\n\x1b[31m${failures} CHECK(S) FAILED\x1b[0m`
);
process.exit(failures === 0 ? 0 : 1);
