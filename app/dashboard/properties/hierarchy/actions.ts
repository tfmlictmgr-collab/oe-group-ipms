"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { ok, fail, failFromDb, type ActionResult } from "@/lib/action-result";

// The regional structure: REGION → PROJECT → LOCATION → SITE, above the
// property register (0066). Every write here runs under the caller's own
// session — `hierarchy.write` (admin-only by default, B7 silence-means-off) is
// what the database actually checks; this layer only turns its refusals into
// something readable.

export async function createNode(
  parentId: string | null,
  level: "region" | "location" | "project" | "site",
  name: string,
  code: string
): Promise<ActionResult<{ id: string }>> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return fail("Your session expired. Please sign in again.");
  const { data: me } = await supabase.from("users").select("org_id").eq("id", user.id).single();
  if (!me) return fail("Could not resolve your profile.");

  const trimmed = name.trim();
  if (trimmed.length < 2) return fail("Give it a name.");

  const { data, error } = await supabase
    .from("org_nodes")
    .insert({
      org_id: me.org_id,
      parent_id: parentId,
      level,
      name: trimmed,
      code: code.trim() || null,
    })
    .select("id")
    .single();

  if (error) {
    if (error.message.includes("org_nodes_sibling_name_uidx")) {
      return fail(
        `Another ${level} already uses the name "${trimmed}" at this level.`,
        "Names must be unique among siblings — an import that resolves nodes by name would otherwise have no way to choose between them."
      );
    }
    if (error.message.includes("org_nodes_org_code_uidx")) {
      return fail(`Another node already uses the code "${code.trim()}".`);
    }
    return failFromDb(error, `create that ${level}`);
  }

  revalidatePath("/dashboard/properties/hierarchy");
  return ok({ id: data.id as string });
}

export async function renameNode(
  nodeId: string,
  name: string,
  code: string
): Promise<ActionResult> {
  const supabase = await createClient();
  const trimmed = name.trim();
  if (trimmed.length < 2) return fail("Give it a name.");

  const { error } = await supabase
    .from("org_nodes")
    .update({ name: trimmed, code: code.trim() || null })
    .eq("id", nodeId);

  if (error) {
    if (error.message.includes("org_nodes_sibling_name_uidx")) {
      return fail(`Another node at this level already uses the name "${trimmed}".`);
    }
    if (error.message.includes("org_nodes_org_code_uidx")) {
      return fail(`Another node already uses the code "${code.trim()}".`);
    }
    return failFromDb(error, "rename that");
  }

  revalidatePath("/dashboard/properties/hierarchy");
  return ok();
}

/**
 * Retiring runs through `retire_org_node` rather than a direct UPDATE — it
 * refuses while a live child node or a live property still depends on this
 * one, the same shape `retire_property` already uses for units.
 */
export async function retireNode(nodeId: string): Promise<ActionResult> {
  const supabase = await createClient();
  const { error } = await supabase.rpc("retire_org_node", { p_node_id: nodeId });
  if (error) return fail(error.message.replace(/^.*?:\s*/, ""));
  revalidatePath("/dashboard/properties/hierarchy");
  return ok();
}

/**
 * The regional-manager equivalent of `setPropertyStakeholder` — the same
 * attach/detach shape, scoped to a node instead of a single property. This is
 * the assignment that makes `current_user_property_ids()` expand: attach
 * someone here and every property beneath the node resolves for them,
 * including ones filed later.
 */
export async function setNodeStakeholder(
  nodeId: string,
  userId: string,
  attached: boolean
): Promise<ActionResult> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return fail("Your session expired. Please sign in again.");
  const { data: me } = await supabase.from("users").select("org_id").eq("id", user.id).single();
  if (!me) return fail("Could not resolve your profile.");

  if (attached) {
    const { error } = await supabase.from("property_stakeholders").insert({
      org_id: me.org_id, node_id: nodeId, user_id: userId, relation: "manager",
    });
    if (error && !error.message.includes("duplicate key")) {
      return failFromDb(error, "assign that manager to this node");
    }
  } else {
    const { error } = await supabase
      .from("property_stakeholders")
      .delete()
      .eq("node_id", nodeId)
      .eq("user_id", userId)
      .eq("relation", "manager");
    if (error) return failFromDb(error, "remove that assignment");
  }

  revalidatePath("/dashboard/properties/hierarchy");
  return ok();
}
