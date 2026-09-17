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
 * Sweeps probe PROPERTIES and the applications hanging off them.
 *
 * ⚠️ Same fault, different table. A property named `PROBEREV-A-BPYT0` was found
 * on the **public tenancy application page**, offered to prospective tenants as
 * somewhere they could live. `verify-application-review`'s cleanup block is
 * correct and thorough — and never ran, because an earlier failure threw first.
 *
 * End-of-run cleanup cannot fix end-of-run cleanup. The repair has to happen at
 * the START of the next run, which is the only moment guaranteed to be reached.
 */
export async function sweepProbeProperties(svc, prefixes = ["PROBE", "Probe Court"]) {
  let removed = 0;
  for (const prefix of prefixes) {
    const { data: props } = await svc
      .from("properties").select("id").ilike("name", `${prefix}%`);
    if (!props || props.length === 0) continue;
    const ids = props.map((p) => p.id);

    // Children first, or the foreign keys refuse and the sweep silently fails
    // in exactly the way it exists to prevent.
    const { data: apps } = await svc
      .from("tenant_applications").select("id").in("property_id", ids);
    const appIds = (apps ?? []).map((a) => a.id);
    if (appIds.length) {
      await svc.from("application_document_findings").delete().in("application_id", appIds);
      await svc.from("application_decisions").delete().in("application_id", appIds);
      await svc.from("application_attachments").delete().in("application_id", appIds);
      await svc.from("tenant_applications").delete().in("id", appIds);
    }
    await svc.from("property_stakeholders").delete().in("property_id", ids);
    await svc.from("units").delete().in("property_id", ids);

    for (const id of ids) {
      const { error } = await svc.from("properties").delete().eq("id", id);
      if (!error) removed++;
    }
  }
  return removed;
}

/**
 * Sweeps probe CONTRACTORS.
 *
 * ⚠️ Third table, same fault. A vendor named `Perm probe 1785232896727` was found
 * sitting in the analytics console's contractor filter, offered to an
 * administrator as a real contractor to report on.
 *
 * `verify-permissions` inserts two probe vendors: the first is expected to be
 * REFUSED (the capability is off), so it has no cleanup — and on the run where
 * that expectation failed, the row it was never meant to create was the one row
 * nothing would ever delete. A fixture whose cleanup is conditional on the
 * assertion passing has no cleanup on exactly the runs that need it.
 */
export async function sweepProbeVendors(svc, prefixes = ["Perm probe", "PROBE", "PROBEBI-"]) {
  let removed = 0;
  for (const prefix of prefixes) {
    const { data } = await svc.from("vendors").select("id").ilike("name", `${prefix}%`);
    if (!data?.length) continue;
    const ids = data.map((v) => v.id);

    // Anything pointing at them first, or the delete is refused and the sweep
    // fails silently in the way it exists to prevent.
    await svc.from("tickets").update({ assigned_vendor_id: null }).in("assigned_vendor_id", ids);
    await svc.from("vendor_properties").delete().in("vendor_id", ids);
    await svc.from("vendor_evaluations").delete().in("vendor_id", ids);

    for (const id of ids) {
      const { error } = await svc.from("vendors").delete().eq("id", id);
      if (!error) { removed++; continue; }
      // ⚠️ Never swallow this. Between 0163 and 0180 EVERY vendor delete was
      // refused by the last-owner trigger, and this loop reported `0` — which
      // reads identically to "there was nothing to remove". A probe contractor
      // sat in the analytics filter for weeks behind that silence.
      console.warn(`  probe-cleanup: vendor ${id} NOT removed — ${error.message}`);
    }
  }
  return removed;
}

/** Applications a suite left behind that were never tied to a probe property. */
export async function sweepProbeApplications(svc, namePrefix = "Probe ") {
  const { data } = await svc
    .from("tenant_applications").select("id").ilike("applicant_name", `${namePrefix}%`);
  if (!data || data.length === 0) return 0;
  const ids = data.map((a) => a.id);
  await svc.from("application_document_findings").delete().in("application_id", ids);
  await svc.from("application_decisions").delete().in("application_id", ids);
  await svc.from("application_attachments").delete().in("application_id", ids);
  const { error } = await svc.from("tenant_applications").delete().in("id", ids);
  return error ? 0 : ids.length;
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
