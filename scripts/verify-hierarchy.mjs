// REGION → PROJECT → LOCATION → SITE, and the scoping it grants.
//
// The claims that matter:
//   • the tree is a tree: only a region is a root, levels cannot be skipped,
//     and the path is derived rather than supplied
//   • re-parenting carries the whole subtree, so no descendant's path is a lie
//   • a node cannot be parented across an organisation boundary
//   • a property is filed under a SITE and nothing else
//   • an assignment is to a property OR a node, never both and never neither
//   • a manager assigned to a region reaches every property beneath it, at any
//     depth, INCLUDING properties added after the assignment
//   • that scoping never crosses a brand boundary
//   • directly-assigned properties still resolve exactly as before
//
// Usage: node scripts/verify-hierarchy.mjs
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

const orgRes = await svc.from("orgs").select("id, name, delivery_brand").is("deleted_at", null);
if (orgRes.error) { console.error("db unreachable:", orgRes.error.message); process.exit(1); }
const poc = orgRes.data.find((o) => o.delivery_brand === "direct");
const tfml = orgRes.data.find((o) => o.delivery_brand === "TFML");

// Repair anything a crashed earlier run left behind, before adding more.
const swept = await sweepProbeNodes(svc, "PROBE-");
if (swept > 0) console.log(`(swept ${swept} node(s) left by an earlier run)\n`);

const S = Date.now().toString(36).toUpperCase().slice(-5);
const nodes = [];
const props = [];
const stakes = [];

const mkNode = async (org, parent, level, name) => {
  const { data, error } = await svc.from("org_nodes")
    .insert({ org_id: org, parent_id: parent, level, name, path: "" })
    .select("id, path, level").single();
  if (error) return { error };
  nodes.push(data.id);
  return { data };
};
const mkProperty = async (org, siteId, name) => {
  const { data, error } = await svc.from("properties")
    .insert({ org_id: org, name, site_node_id: siteId })
    .select("id").single();
  if (error) return { error };
  props.push(data.id);
  return { data };
};

console.log("The portfolio hierarchy\n");

console.log("A. The tree is a tree");
let region, project, location, site;
{
  const r = await mkNode(poc.id, null, "region", `PROBE-Region-${S}`);
  r.data ? ok("a region can be a root") : bad(`could not create a region — ${r.error?.message.slice(0, 70)}`);
  region = r.data;

  if (region) {
    region.path === `/${region.id}/`
      ? ok("its path is derived, delimited at both ends")
      : bad(`path was ${region.path}`);
  }

  // A non-region with no parent must be refused.
  const orphan = await mkNode(poc.id, null, "location", `PROBE-Orphan-${S}`);
  orphan.error ? ok("a location cannot be a root") : bad("A LOCATION WAS CREATED AS A ROOT");

  // Skipping a level must be refused. Since 0087 the order is
  // REGION → LOCATION → PROJECT → SITE, so a project directly under a region is
  // the skip — the reverse of what this asserted before the reorder.
  const skipped = await mkNode(poc.id, region.id, "project", `PROBE-Skip-${S}`);
  skipped.error
    ? ok("a project cannot sit directly under a region — levels cannot be skipped")
    : bad("A LEVEL WAS SKIPPED");

  const l = await mkNode(poc.id, region.id, "location", `PROBE-Location-${S}`);
  l.data ? ok("a location sits under a region") : bad(`location rejected — ${l.error?.message.slice(0, 70)}`);
  location = l.data;

  const p = await mkNode(poc.id, location.id, "project", `PROBE-Project-${S}`);
  project = p.data;
  project ? ok("a project sits under a location — a project happens in a place") : bad("project rejected");

  const st = await mkNode(poc.id, project.id, "site", `PROBE-Site-${S}`);
  site = st.data;
  site ? ok("and a site completes the chain") : bad("could not complete the chain");

  if (site) {
    site.path === `/${region.id}/${location.id}/${project.id}/${site.id}/`
      ? ok("the site's path spells out its full ancestry")
      : bad(`site path was ${site.path}`);
  }

  // A duplicate name among siblings must be refused.
  const dup = await mkNode(poc.id, region.id, "location", `PROBE-Location-${S}`);
  dup.error
    ? ok("two siblings cannot share a name")
    : bad("A DUPLICATE SIBLING NAME WAS ACCEPTED");
}

console.log("\nB. A node cannot be parented across a brand boundary");
{
  const tfmlRegion = await mkNode(tfml.id, null, "region", `PROBE-TFML-Region-${S}`);
  const cross = await svc.from("org_nodes").insert({
    org_id: poc.id, parent_id: tfmlRegion.data.id, level: "location",
    name: `PROBE-Cross-${S}`, path: "",
  });
  cross.error
    ? ok("a POC location cannot hang off a TFML region")
    : bad("CROSS-ORG PARENTING SUCCEEDED");
}

console.log("\nC. A property is filed under a site, and only a site");
{
  const wrong = await svc.from("properties").insert({
    org_id: poc.id, name: `PROBE-Wrong-${S}`, site_node_id: region.id,
  });
  wrong.error
    ? ok("filing a property directly under a region is refused")
    : bad("A PROPERTY WAS FILED UNDER A REGION");

  const p1 = await mkProperty(poc.id, site.id, `PROBE-Property-A-${S}`);
  p1.data ? ok("filing it under a site works") : bad(`site filing failed — ${p1.error?.message.slice(0, 70)}`);
}

console.log("\nD. Everything beneath a node, at any depth");
{
  const { data: fromRegion } = await svc.rpc("properties_under_node", { p_node_id: region.id });
  const { data: fromSite } = await svc.rpc("properties_under_node", { p_node_id: site.id });
  const ids = (x) => (x ?? []).map((r) => (typeof r === "string" ? r : r.properties_under_node ?? r.id));

  ids(fromRegion).includes(props[0])
    ? ok("the region reaches a property four levels below it")
    : bad(`the region did not reach its property (got ${ids(fromRegion).length})`);
  ids(fromSite).includes(props[0])
    ? ok("and so does the site directly above it")
    : bad("the site did not reach its own property");

  const { data: label } = await svc.rpc("node_full_name", { p_node_id: site.id });
  typeof label === "string" && label.split(" / ").length === 4
    ? ok(`the readable label spells the whole path (${label.slice(0, 52)}…)`)
    : bad(`label was ${label}`);
}

console.log("\nE. Re-parenting carries the subtree");
{
  const r2 = await mkNode(poc.id, null, "region", `PROBE-Region2-${S}`);

  // The LOCATION moves, because since 0087 a location is what hangs directly
  // off a region. The failure to check this update's error is what let the old
  // version of this section keep passing after the reorder made the move
  // illegal — the paths simply never changed and the assertions read stale
  // values as if they were fresh ones.
  const { error: moveError } = await svc.from("org_nodes")
    .update({ parent_id: r2.data.id }).eq("id", location.id);
  if (moveError) bad(`could not re-parent the location — ${moveError.message.slice(0, 70)}`);

  const { data: after } = await svc.from("org_nodes")
    .select("id, path").in("id", [location.id, project.id, site.id]);
  const byId = Object.fromEntries((after ?? []).map((n) => [n.id, n.path]));

  byId[location.id]?.startsWith(`/${r2.data.id}/`)
    ? ok("the moved location sits under its new region")
    : bad(`location path is ${byId[location.id]}`);
  byId[site.id]?.startsWith(`/${r2.data.id}/`)
    ? ok("and the site three levels down moved with it")
    : bad(`DESCENDANT PATH IS STALE: ${byId[site.id]}`);

  const { data: viaOld } = await svc.rpc("properties_under_node", { p_node_id: region.id });
  (viaOld ?? []).length === 0
    ? ok("the old region no longer reaches it")
    : bad("THE OLD PARENT STILL REACHES THE MOVED SUBTREE");
}

console.log("\nF. An assignment is to a property OR a node");
{
  const both = await svc.from("property_stakeholders").insert({
    org_id: poc.id, user_id: (await svc.from("users").select("id").eq("email", "fm@oegroup.test").single()).data.id,
    property_id: props[0], node_id: site.id, relation: "manager",
  });
  both.error ? ok("both at once is refused") : bad("AN ASSIGNMENT CARRIED BOTH SCOPES");

  const neither = await svc.from("property_stakeholders").insert({
    org_id: poc.id, user_id: (await svc.from("users").select("id").eq("email", "fm@oegroup.test").single()).data.id,
    relation: "manager",
  });
  neither.error ? ok("neither is refused") : bad("AN ASSIGNMENT CARRIED NO SCOPE AT ALL");
}

console.log("\nG. A regional assignment reaches the whole subtree");
{
  const { data: fm } = await svc.from("users").select("id").eq("email", "fm@oegroup.test").single();

  // Park the FM's existing assignments so this measures only the new one.
  //
  // The whole ROW, not just the id: keeping ids alone would leave nothing to
  // restore from after the delete, which is how a verification run ends up
  // permanently altering the database it was only meant to measure.
  const { data: existing } = await svc.from("property_stakeholders")
    .select("org_id, user_id, property_id, node_id, relation").eq("user_id", fm.id);
  const parked = existing ?? [];
  if (parked.length) await svc.from("property_stakeholders").delete().eq("user_id", fm.id);

  const { data: stake, error: se } = await svc.from("property_stakeholders")
    .insert({ org_id: poc.id, user_id: fm.id, node_id: project.id, relation: "manager" })
    .select("id").single();
  if (se) bad(`could not assign to a node — ${se.message.slice(0, 70)}`);
  else stakes.push(stake.id);

  const c = createClient(URL_, ANON);
  await c.auth.signInWithPassword({ email: "fm@oegroup.test", password: PW });

  const { data: reach } = await c.rpc("current_user_property_ids");
  const reachIds = (reach ?? []).map((r) => (typeof r === "string" ? r : r.current_user_property_ids));
  reachIds.includes(props[0])
    ? ok("assigned to the project, the manager reaches a property two levels below")
    : bad(`the manager reached ${reachIds.length} properties, not including theirs`);

  // A property added AFTER the assignment must appear without re-assigning.
  const later = await mkProperty(poc.id, site.id, `PROBE-Property-Later-${S}`);
  const { data: reach2 } = await c.rpc("current_user_property_ids");
  const reach2Ids = (reach2 ?? []).map((r) => (typeof r === "string" ? r : r.current_user_property_ids));
  reach2Ids.includes(later.data.id)
    ? ok("a property added afterwards appears with no re-assignment — the point of node scoping")
    : bad("A LATER PROPERTY DID NOT APPEAR");

  // And nothing outside the subtree.
  const { data: outside } = await svc.from("properties")
    .select("id").eq("org_id", poc.id).is("site_node_id", null).limit(1).maybeSingle();
  if (outside) {
    reach2Ids.includes(outside.id)
      ? bad("AN UNFILED PROPERTY LEAKED INTO A REGIONAL SCOPE")
      : ok("an unfiled property stays outside the regional scope");
  }

  // Cross-brand: TFML properties must never appear.
  const { data: tfmlProps } = await svc.from("properties").select("id").eq("org_id", tfml.id);
  const leaked = (tfmlProps ?? []).filter((p) => reach2Ids.includes(p.id));
  leaked.length === 0
    ? ok("no TFML property is reachable from a POC regional assignment")
    : bad(`CROSS-BRAND LEAK: ${leaked.length} TFML propert(ies) reachable`);

  await c.auth.signOut();

  // Restore. A direct property assignment must still resolve exactly as before.
  await svc.from("property_stakeholders").delete().in("id", stakes);
  const { data: direct } = await svc.from("property_stakeholders")
    .insert({ org_id: poc.id, user_id: fm.id, property_id: props[0], relation: "manager" })
    .select("id").single();

  const c2 = createClient(URL_, ANON);
  await c2.auth.signInWithPassword({ email: "fm@oegroup.test", password: PW });
  const { data: reach3 } = await c2.rpc("current_user_property_ids");
  const reach3Ids = (reach3 ?? []).map((r) => (typeof r === "string" ? r : r.current_user_property_ids));
  reach3Ids.length === 1 && reach3Ids[0] === props[0]
    ? ok("a direct property assignment still resolves to exactly that property")
    : bad(`direct assignment resolved to ${reach3Ids.length} propert(ies)`);
  await c2.auth.signOut();

  await svc.from("property_stakeholders").delete().eq("id", direct.id);

  // Put the FM back exactly as they were found.
  if (parked.length) {
    const { error: re } = await svc.from("property_stakeholders").insert(parked);
    re ? bad(`could not restore the FM's assignments — ${re.message.slice(0, 60)}`)
       : ok(`restored the manager's ${parked.length} original assignment(s)`);
  }
}

// ── Cleanup ────────────────────────────────────────────────────────────────
// Deepest path first, and asserted. The start-of-run sweep above is what covers
// the case this block cannot: a run that throws before reaching here.
const undeleted = await cleanupNodes(svc, nodes, props);
if (undeleted > 0) {
  bad(`CLEANUP LEAKED ${undeleted} node(s) — they will appear in a live dropdown`);
} else {
  console.log("\n(cleaned up)");
}

console.log(
  failures === 0
    ? "\n\x1b[32mALL CHECKS PASSED\x1b[0m — the tree holds its shape, and a regional assignment reaches exactly its own subtree."
    : `\n\x1b[31m${failures} CHECK(S) FAILED\x1b[0m`
);
process.exit(failures === 0 ? 0 : 1);
