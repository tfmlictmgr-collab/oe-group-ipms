"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { getSessionProfile } from "@/lib/auth";
import { ok, fail, failFromDb, type ActionResult } from "@/lib/action-result";

const CATEGORIES = [
  "cleaning", "security", "plumbing", "electrical", "hvac",
  "landscaping", "waste", "pest", "maintenance", "other",
] as const;

/**
 * Creates a vendor company.
 *
 * ⚠️ The path that was missing entirely. `vendors` rows could only ever arrive
 * through the public self-service application flow (`approve_vendor_application`,
 * 0021) or a seed script — so an organisation with no self-service applicants
 * had no vendors, the invite dialog's vendor picker was empty, and a vendor
 * invitation could only be issued with no company attached. That produced a
 * user with a vendor role and no company: invisible in the vendor list,
 * unassignable when dispatching, and shown an empty My Work page.
 *
 * ⚠️ Created as `approval_status = 'pending'`, NOT approved. An administrator
 * adding a company directly is stating that it exists, not that it has passed
 * the B4 checks — and `runPerformanceCheck` gates payment on evaluations
 * regardless. The public application path sets 'approved' because a human has
 * just reviewed the application in front of them; this one has no such review,
 * so claiming approval here would launder an unreviewed vendor into a payable
 * one. Approve it deliberately from the vendor page.
 */
export async function createVendor(input: {
  name: string;
  serviceCategory: string;
  contactEmail: string | null;
  contactPhone: string | null;
  /** Optionally attach an existing vendor-role user who has no company. */
  linkUserId: string | null;
}): Promise<ActionResult<{ id: string }>> {
  const session = await getSessionProfile();
  if (!session?.profile) return fail("Your session expired. Please sign in again.");

  const name = input.name.trim();
  if (name.length < 2) return fail("Give the vendor a name.");
  if (!(CATEGORIES as readonly string[]).includes(input.serviceCategory)) {
    return fail("Choose a service category.");
  }

  const supabase = await createClient();

  // RLS (`vendors_insert`, 0055) is the real gate — org scoping and the
  // `vendors.write` capability. This insert simply runs as the caller and is
  // refused if they do not hold it.
  const { data: vendor, error } = await supabase
    .from("vendors")
    .insert({
      org_id: session.profile.org_id,
      name,
      service_category: input.serviceCategory,
      contact_email: input.contactEmail?.trim() || null,
      contact_phone: input.contactPhone?.trim() || null,
      status: "active",
      approval_status: "pending",
    })
    .select("id")
    .single();

  if (error) return failFromDb(error, "create this vendor");

  // Attaching an existing login is what rescues a vendor user who was invited
  // before any company existed — the exact state this whole screen exists to
  // fix. Scoped to the caller's own org on both sides.
  if (input.linkUserId) {
    const { error: linkErr } = await supabase
      .from("vendors")
      .update({ user_id: input.linkUserId })
      .eq("id", vendor.id);
    if (linkErr) {
      // The company exists and is usable; only the link failed. Say so
      // precisely rather than implying nothing was created.
      return fail(
        "The vendor was created, but the login could not be attached.",
        "Attach it from the vendor's own page."
      );
    }
  }

  revalidatePath("/dashboard/vendors");
  revalidatePath("/dashboard/people");
  return ok({ id: vendor.id });
}
