"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { ok, fail, failFromDb, type ActionResult } from "@/lib/action-result";
import { validateUnitCsv } from "@/lib/unit-import";

// Properties and units.
//
// Every write runs under the caller's own session, so the `properties.write`
// and `units.assign_occupant` capabilities (Day 6.5) and the org isolation rule
// decide what is permitted. Nothing here uses the service role: the UI cannot
// grant itself access the database would refuse.

export type PropertyInput = {
  id?: string;
  name: string;
  reference: string;
  address: string;
  propertyType: string;
};

export async function saveProperty(
  input: PropertyInput
): Promise<ActionResult<{ id: string }>> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return fail("Your session expired. Please sign in again.");

  const { data: me } = await supabase
    .from("users").select("org_id").eq("id", user.id).single();
  if (!me) return fail("Could not resolve your profile.");

  const name = input.name.trim();
  if (name.length < 2) return fail("Give the property a name.");

  const row = {
    org_id: me.org_id,
    name,
    reference: input.reference.trim() || null,
    address: input.address.trim() || null,
    property_type: input.propertyType.trim() || null,
  };

  const { data, error } = input.id
    ? await supabase.from("properties").update(row).eq("id", input.id).select("id").single()
    : await supabase.from("properties").insert(row).select("id").single();

  if (error) {
    if (error.message.includes("properties_org_reference_uidx")) {
      return fail(
        `Another property already uses the reference "${input.reference.trim()}".`,
        "References must be unique so a conversation about one property cannot mean two."
      );
    }
    return failFromDb(error, input.id ? "save this property" : "create this property");
  }

  revalidatePath("/dashboard/properties");
  return ok({ id: data.id as string });
}

export type UnitInput = {
  id?: string;
  propertyId: string;
  label: string;
  apportionmentFactor: string;
  occupantUserId: string | null;
};

export async function saveUnit(input: UnitInput): Promise<ActionResult<{ id: string }>> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return fail("Your session expired. Please sign in again.");

  const { data: me } = await supabase
    .from("users").select("org_id").eq("id", user.id).single();
  if (!me) return fail("Could not resolve your profile.");

  const label = input.label.trim();
  if (!label) return fail("Give the unit a label.");

  const factor = Number(input.apportionmentFactor.replace(/[,\s]/g, ""));
  if (!Number.isFinite(factor) || factor <= 0) {
    return fail(
      "The apportionment factor must be greater than zero.",
      "A zero-weighted unit pays nothing, and its share of the budget falls on its neighbours."
    );
  }

  // On an UPDATE, property_id is deliberately excluded. Writing a
  // client-supplied parent while matching only on `id` would let a unit be
  // moved between properties, silently shrinking the original property's
  // apportionment base and inflating every remaining unit's share.
  const { data, error } = input.id
    ? await supabase
        .from("units")
        .update({ label, apportionment_factor: factor })
        .eq("id", input.id)
        .eq("property_id", input.propertyId)   // and it must still be where we think
        .select("id")
        .single()
    : await supabase
        .from("units")
        .insert({
          org_id: me.org_id,
          property_id: input.propertyId,
          label,
          apportionment_factor: factor,
          occupant_user_id: input.occupantUserId || null,
        })
        .select("id")
        .single();

  if (error) {
    if (error.message.includes("units_property_label_uidx")) {
      return fail(
        `This property already has a unit called "${label}".`,
        "Two units with one label make every invoice for it ambiguous."
      );
    }
    return failFromDb(error, "save this unit");
  }

  revalidatePath(`/dashboard/properties/${input.propertyId}`);
  return ok({ id: data.id as string });
}

/**
 * Assigns or clears a unit's occupant, and nothing else.
 *
 * Separate from `saveUnit` because `units_write` admits EITHER
 * `properties.write` or `units.assign_occupant` — so a role holding only the
 * latter could, through the general save, rewrite the label and apportionment
 * factor and change what every unit in the property pays. Occupancy and
 * pricing are different powers and are now different calls.
 */
export async function assignUnitOccupant(
  unitId: string,
  occupantUserId: string | null
): Promise<ActionResult> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return fail("Your session expired. Please sign in again.");

  if (occupantUserId) {
    // Occupants are tenants. Anything else produces a record that reads as an
    // occupancy and is not one.
    const { data: person } = await supabase
      .from("users").select("id, role").eq("id", occupantUserId).maybeSingle();
    if (!person) return fail("That person could not be found in your organisation.");
    if (person.role !== "tenant") {
      return fail(
        "Only a tenant can be recorded as the occupant of a unit.",
        "Staff and vendors are attached to properties, not to units."
      );
    }
  }

  // `.select().single()` deliberately: an UPDATE matching zero rows — a missing
  // capability, a retired unit — returns no error, so without this the caller
  // is told it worked and the UI silently snaps back on refresh.
  const { data: updated, error } = await supabase
    .from("units")
    .update({ occupant_user_id: occupantUserId })
    .eq("id", unitId)
    .select("id, property_id")
    .maybeSingle();

  if (error) {
    if (/row-level security/i.test(error.message)) {
      return fail("You can only change occupancy on properties you manage.");
    }
    return failFromDb(error, "change that unit's occupant");
  }
  if (!updated) {
    return fail(
      "That unit could not be updated.",
      "It may have been retired, or you may not have permission to change occupancy on this property."
    );
  }

  revalidatePath(`/dashboard/properties/${updated.property_id}`);
  revalidatePath("/dashboard/people");
  return ok();
}

export async function retireProperty(propertyId: string): Promise<ActionResult> {
  const supabase = await createClient();
  const { error } = await supabase.rpc("retire_property", { p_property_id: propertyId });
  // The function's refusals name what is in the way ("still has 4 active units"),
  // which is more useful than a constraint violation.
  if (error) return fail(error.message.replace(/^.*?:\s*/, ""));
  revalidatePath("/dashboard/properties");
  return ok();
}

export async function retireUnit(
  unitId: string,
  propertyId: string
): Promise<ActionResult> {
  const supabase = await createClient();
  const { error } = await supabase.rpc("retire_unit", { p_unit_id: unitId });
  if (error) return fail(error.message.replace(/^.*?:\s*/, ""));
  revalidatePath(`/dashboard/properties/${propertyId}`);
  return ok();
}

/** Context the importer validates against — existing labels and org members. */
export async function unitImportContext(
  propertyId: string
): Promise<ActionResult<{ existingLabels: string[]; members: { id: string; email: string }[] }>> {
  const supabase = await createClient();
  const [unitsRes, membersRes] = await Promise.all([
    supabase.from("units").select("label").eq("property_id", propertyId),
    // Occupants must be tenants, so the manual picker and the importer agree
    // on who is eligible rather than diverging.
    supabase.from("users").select("id, email").eq("role", "tenant").is("deactivated_at", null),
  ]);

  // Returning ok() on a failed read made every occupant email look unknown, and
  // made the caller's `if (!ctxResult.ok)` unreachable. A validation context
  // built from a partial read validates nothing.
  if (unitsRes.error) return failFromDb(unitsRes.error, "read this property's units");
  if (membersRes.error) return failFromDb(membersRes.error, "read your organisation's members");

  const { data: units } = unitsRes;
  const { data: members } = membersRes;
  return ok({
    existingLabels: (units ?? []).map((u) => String(u.label).toLowerCase()),
    members: ((members ?? []) as { id: string; email: string | null }[])
      .filter((m) => m.email)
      .map((m) => ({ id: m.id, email: m.email!.toLowerCase() })),
  });
}

/**
 * Commits a bulk unit import.
 *
 * Re-validates server-side against freshly read context rather than trusting
 * the browser's preview — the client could have been tampered with, and a label
 * may have been taken since the preview was generated.
 *
 * All-or-nothing on purpose. A partial import is worse than a refused one: the
 * budget apportions across whatever exists, so a silently missing unit inflates
 * every other unit's share without anyone being told.
 */
export async function commitUnitImport(
  propertyId: string,
  csvText: string
): Promise<ActionResult<{ inserted: number }>> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return fail("Your session expired. Please sign in again.");

  const { data: me } = await supabase
    .from("users").select("org_id").eq("id", user.id).single();
  if (!me) return fail("Could not resolve your profile.");

  const ctxResult = await unitImportContext(propertyId);
  if (!ctxResult.ok) return ctxResult;

  const memberByEmail = new Map(ctxResult.data.members.map((m) => [m.email, m.id]));
  const { rows, headerIssues } = validateUnitCsv(csvText, {
    existingLabels: new Set(ctxResult.data.existingLabels),
    memberEmails: new Set(memberByEmail.keys()),
  });

  if (headerIssues.length > 0) return fail(headerIssues.join(" "));

  const invalid = rows.filter((r) => !r.valid);
  if (invalid.length > 0) {
    return fail(
      `${invalid.length} of ${rows.length} rows are not valid, so nothing was imported.`,
      "Fix them and upload again — a partly imported block would silently change what every other unit pays."
    );
  }
  if (rows.length === 0) return fail("That file contains no unit rows.");

  const { data, error } = await supabase.from("units").insert(
    rows.map((r) => ({
      org_id: me.org_id,
      property_id: propertyId,
      label: r.values!.label,
      apportionment_factor: r.values!.apportionment_factor,
      occupant_user_id: r.values!.occupant_email
        ? memberByEmail.get(r.values!.occupant_email) ?? null
        : null,
    }))
  ).select("id");

  if (error) return failFromDb(error, "import these units");

  revalidatePath(`/dashboard/properties/${propertyId}`);
  return ok({ inserted: data?.length ?? 0 });
}

/** The attaché assignment — which FM/PM or owner is staked to this property. */
export async function setPropertyStakeholder(
  propertyId: string,
  userId: string,
  relation: "manager" | "owner",
  attached: boolean
): Promise<ActionResult> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return fail("Your session expired. Please sign in again.");

  const { data: me } = await supabase
    .from("users").select("org_id").eq("id", user.id).single();
  if (!me) return fail("Could not resolve your profile.");

  if (attached) {
    const { error } = await supabase.from("property_stakeholders").insert({
      org_id: me.org_id, property_id: propertyId, user_id: userId, relation,
    });
    // Already attached is the desired end state, not a failure.
    if (error && !error.message.includes("duplicate key")) {
      return failFromDb(error, "attach that person to this property");
    }
  } else {
    const { error } = await supabase
      .from("property_stakeholders")
      .delete()
      .eq("property_id", propertyId)
      .eq("user_id", userId)
      .eq("relation", relation);
    if (error) return failFromDb(error, "detach that person");
  }

  revalidatePath(`/dashboard/properties/${propertyId}`);
  return ok();
}
