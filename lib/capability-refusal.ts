import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Why a capability was refused, in words that are actually true.
 *
 * ⚠️ Every refusal in this codebase used to say "isn't turned on for your
 * ORGANISATION yet". That is right only when nobody in the organisation holds
 * it. `records.export` and `training.read` are granted **per role, per org**
 * through the operator's permission matrix (decision 7) — so once an
 * administrator and a property manager hold export, telling the payment officer
 * "your organisation" is simply false, and sends them to ask for something they
 * already have. What they need is their own role added.
 *
 * The two cases are told apart by asking the matrix: does ANY role in this org
 * hold it?
 *
 *   • some role does  → "not turned on for your role yet"
 *   • no role does    → "not turned on for your organisation yet"
 *
 * `role_permissions` is readable by any signed-in member of the org
 * (`role_permissions_select` is `org_id = current_user_org_id()`), so this is
 * asked under the CALLER's own session — no elevation, and nothing is disclosed
 * that the Settings → Permissions matrix does not already show them.
 *
 * On a read failure it falls back to the ORG wording, which is the older and
 * vaguer of the two: a refusal that overstates what is missing is safer than one
 * that tells somebody their colleague's access is theirs.
 */
export async function capabilityRefusal(
  supabase: SupabaseClient,
  capability: string,
  /** What was refused, in the subject position: "Record export", "Bulk download". */
  subject: string
): Promise<{ scope: "role" | "org"; message: string; hint: string }> {
  let heldBySomeone = false;
  try {
    const { data } = await supabase
      .from("role_permissions")
      .select("role")
      .eq("capability", capability)
      .eq("granted", true)
      .limit(1);
    heldBySomeone = (data ?? []).length > 0;
  } catch {
    heldBySomeone = false;
  }

  return heldBySomeone
    ? {
        scope: "role",
        message: `${subject} isn't turned on for your role yet.`,
        hint:
          "Other roles in your organisation already have it, so this is a change to " +
          "your own role rather than to the organisation. Ask an administrator to " +
          "request it from your OE Group contact.",
      }
    : {
        scope: "org",
        message: `${subject} isn't turned on for your organisation yet.`,
        hint: "Ask your OE Group contact to enable it.",
      };
}
