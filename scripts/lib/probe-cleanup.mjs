// Sweeping fixtures that a previous run left behind.
//
// ⚠️ Why this exists. `verify-hierarchy` leaked 17 hierarchy nodes into the POC
// org across several runs, and they surfaced in a live property form's Region
// dropdown in front of the user — a list of `PROBE-Region2-*` where Nigeria's
// regions should have been.
//
// Two distinct faults produced that, and only fixing both closes it:
//
//   1. Cleanup deleted in REVERSE CREATION ORDER, which stops respecting the
//      tree the moment anything is re-parented. Fixed by deleting deepest-path
//      first.
//   2. **Cleanup did not run at all when the suite threw.** A failing assertion
//      that leaves a variable undefined kills the script before its final
//      cleanup block, and every fixture that run created stays forever. This is
//      the fault that actually did the damage, and no amount of care in the
//      cleanup block addresses it — the block never executes.
//
// So cleanup also happens at the START of a run, sweeping anything matching the
// suite's own prefix. A crashed run is then repaired by the next one rather than
// accumulating silently until someone sees it in production.

/**
 * Deletes every org_node whose name starts with `prefix`, deepest first.
 * Returns how many were removed. Safe to call when there are none.
 */
export async function sweepProbeNodes(svc, prefix) {
  const { data, error } = await svc
    .from("org_nodes")
    .select("id, path")
    .ilike("name", `${prefix}%`);
  if (error || !data || data.length === 0) return 0;

  // Properties filed under any of these must go first — a node with a property
  // on it cannot be deleted, and leaving the property would leave a dangling
  // fixture of its own.
  const ids = data.map((n) => n.id);
  await svc.from("properties").delete().in("site_node_id", ids);

  let removed = 0;
  for (const n of [...data].sort((a, b) => b.path.length - a.path.length)) {
    const { error: e } = await svc.from("org_nodes").delete().eq("id", n.id);
    if (!e) removed++;
  }
  return removed;
}

/**
 * The end-of-run half: delete the ids this run created, deepest first, and say
 * so if any survive rather than reporting a clean exit.
 */
export async function cleanupNodes(svc, nodeIds, propertyIds = []) {
  if (propertyIds.length) await svc.from("properties").delete().in("id", propertyIds);
  if (!nodeIds.length) return 0;

  const { data } = await svc.from("org_nodes").select("id, path").in("id", nodeIds);
  let undeleted = 0;
  for (const n of [...(data ?? [])].sort((a, b) => b.path.length - a.path.length)) {
    const { error } = await svc.from("org_nodes").delete().eq("id", n.id);
    if (error) undeleted++;
  }
  return undeleted;
}
