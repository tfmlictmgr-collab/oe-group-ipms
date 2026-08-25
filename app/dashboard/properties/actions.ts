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
  siteNodeId: string | null;
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
    site_node_id: input.siteNodeId || null,
  };

  // ⚠️ CREATE goes through `create_property` (0119), not a direct insert.
  // A direct `insert(...).select()` is refused for an FM/PM: they hold no
  // `properties.read_all`, a brand-new property has no stakeholder rows, and
  // Postgres applies SELECT policies to a RETURNING clause — so they could not
  // read back the row they had just created and the whole statement failed.
  // The function attaches the creator as manager, which is both the fix and
  // the correct behaviour: the person who files a property manages it.
  // An admin never saw this, because `read_all` makes their read independent
  // of the assignment.
  //
  // UPDATE is left as a direct write: the row already exists and is already
  // in their scope, so the RETURNING reads fine.
  const { data, error } = input.id
    ? await supabase.from("properties").update(row).eq("id", input.id).select("id").single()
    : await (async () => {
        const r = await supabase.rpc("create_property", {
          p_name: row.name,
          p_address: row.address,
          p_reference: row.reference,
          p_site_node_id: row.site_node_id,
        });
        return { data: r.data ? { id: r.data as string } : null, error: r.error };
      })();

  if (error) {
    if (error.message.includes("properties_org_reference_uidx")) {
      return fail(
        `Another property already uses the reference "${input.reference.trim()}".`,
        "References must be unique so a conversation about one property cannot mean two."
      );
    }
    if (error.message.includes("a property is filed under a site")) {
      return fail("A property can only be filed under a Site, not a region, project or location.");
    }
    return failFromDb(error, input.id ? "save this property" : "create this property");
  }

  // Belt and braces: the RPC path returns null only if the function returned
  // nothing, which would mean no row was created despite no error. Reporting
  // success on that is the silent-no-op pattern this build keeps meeting.
  if (!data?.id) {
    return fail(
      input.id ? "That property could not be saved." : "That property could not be created."
    );
  }

  revalidatePath("/dashboard/properties");
  return ok({ id: data.id as string });
}

export type UnitInput = {
  id?: string;
  propertyId: string;
  label: string;
  apportionmentFactor: string;
  /** 0198 — how many units this row stands for. "" or absent means 1. */
  unitQuantity: string;
  description: string;
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
  if (!label) return fail("Choose what kind of unit this is.");

  // Blank means one, which is the ordinary single flat and every row written
  // before 0198. Refused rather than rounded when fractional: a third of a
  // stall is a typo, and picking a direction for someone is how a bill goes
  // wrong without anyone noticing.
  const rawQty = (input.unitQuantity ?? "").replace(/[,\s]/g, "");
  const quantity = rawQty ? Number(rawQty) : 1;
  if (!Number.isFinite(quantity) || !Number.isInteger(quantity) || quantity < 1) {
    return fail(
      "The number of units must be a whole number, at least 1.",
      "One row can stand for many units — 12 stalls — but not for a fraction of one."
    );
  }

  const description = input.description.trim() || null;

  const factor = Number(input.apportionmentFactor.replace(/[,\s]/g, ""));
  if (!Number.isFinite(factor) || factor <= 0) {
    return fail(
      "The occupied space must be greater than zero.",
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
        .update({ label, apportionment_factor: factor, unit_quantity: quantity, description })
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
          unit_quantity: quantity,
          description,
          occupant_user_id: input.occupantUserId || null,
        })
        .select("id")
        .single();

  if (error) {
    if (
      error.message.includes("units_property_label_desc_uidx") ||
      error.message.includes("units_property_label_uidx")   // pre-0198 name
    ) {
      return fail(
        `This property already has a "${label}"${description ? ` described as "${description}"` : ""}.`,
        "Two identical rows make every invoice for them ambiguous and double that property's share. Give this one a description that tells it apart, or raise the number of units on the existing row."
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

/**
 * Adds a unit description to the calling org's own list (0198).
 *
 * ⚠️ Scoped to the org, never to the platform standards. A standard row carries
 * `org_id is null` and is offered to every organisation; letting one client
 * write into that set would put their vocabulary on another brand's screen,
 * which is B1's "or existence" reached through a dropdown.
 *
 * The insert policy also requires `properties.write`, so this cannot become a
 * way for a role without register access to write rows.
 */
export async function addUnitType(
  label: string,
  category: "residential" | "commercial"
): Promise<ActionResult<{ id: string }>> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return fail("Your session expired. Please sign in again.");

  const { data: me } = await supabase
    .from("users").select("org_id").eq("id", user.id).single();
  if (!me) return fail("Could not resolve your profile.");

  const clean = label.trim();
  if (!clean) return fail("Give the description a name.");
  if (clean.length > 60) return fail("That description is too long — 60 characters at most.");
  if (category !== "residential" && category !== "commercial") {
    return fail("A description has to be residential or commercial.");
  }

  const { data, error } = await supabase
    .from("unit_types")
    .insert({ org_id: me.org_id, label: clean, category, created_by: user.id })
    .select("id")
    .single();

  if (error) {
    if (error.message.includes("unit_types_org_label_uidx")) {
      return fail(`"${clean}" is already on your list.`);
    }
    return failFromDb(error, "add this description");
  }

  return ok({ id: data.id as string });
}

/** Context the importer validates against — existing labels and org members. */
export async function unitImportContext(
  propertyId: string
): Promise<ActionResult<{ existingLabels: string[]; members: { id: string; email: string }[] }>> {
  const supabase = await createClient();
  const [unitsRes, membersRes] = await Promise.all([
    supabase.from("units").select("label, description").eq("property_id", propertyId),
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
    // ⚠️ The composite key `units_property_label_desc_uidx` (0198) enforces,
    // not the label alone. Two terraces in one building are ordinary; two
    // IDENTICAL rows are what doubles a property's share of a budget.
    existingLabels: ((units ?? []) as { label: string; description: string | null }[])
      .map((u) => `${String(u.label).toLowerCase()}|${String(u.description ?? "").toLowerCase()}`),
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
      unit_quantity: r.values!.unit_quantity,
      description: r.values!.description,
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

/**
 * Which contractors work this property — `vendor_properties` (0012).
 *
 * ⚠️ Built while answering "how do we attach a vendor to a property": nothing
 * wrote to this table before now, not even an insert triggered by dispatching
 * a job. Since 0012, `current_user_scoped_vendor_ids()` reads it to decide
 * which vendors' PAYMENTS AND EVALUATIONS an FM/PM may see — sensitive money
 * data, not the vendor directory (0012's own comment: "the vendor DIRECTORY
 * stays org-visible... the sensitive money/performance data is what gets
 * scoped"). An FM/PM dispatching a job to a vendor could always see that
 * vendor's payments through `payments_select`'s other branches; what an empty
 * table meant in practice is that scoping never actually narrowed anything —
 * every FM/PM saw every vendor's money for want of a row here.
 *
 * `vendor_properties_write` already governs this correctly (admin, FM, PM,
 * regional manager) — 0183's mechanical rewrite reached it along with
 * everything else that named the role literally, so this needed no policy
 * change, only a screen.
 */
export async function setVendorProperty(
  propertyId: string,
  vendorId: string,
  attached: boolean
): Promise<ActionResult> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return fail("Your session expired. Please sign in again.");

  const { data: me } = await supabase
    .from("users").select("org_id").eq("id", user.id).single();
  if (!me) return fail("Could not resolve your profile.");

  if (attached) {
    const { error } = await supabase.from("vendor_properties").insert({
      org_id: me.org_id, property_id: propertyId, vendor_id: vendorId,
    });
    if (error && !error.message.includes("duplicate key")) {
      return failFromDb(error, "attach that contractor to this property");
    }
  } else {
    const { error } = await supabase
      .from("vendor_properties")
      .delete()
      .eq("property_id", propertyId)
      .eq("vendor_id", vendorId);
    if (error) return failFromDb(error, "detach that contractor");
  }

  revalidatePath(`/dashboard/properties/${propertyId}`);
  return ok();
}
