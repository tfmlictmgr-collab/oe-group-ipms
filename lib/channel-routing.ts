import { supabaseAdmin } from "./supabase/admin";

// Resolves which org an inbound message belongs to, from the channel identity.
// Returns null when no route matches — callers MUST treat that as "drop", never
// as "fall back to a default org". Silently defaulting is exactly the DEMO_ORG_ID
// collapse this replaces (and, for money-bearing messages, a cross-brand leak).

export type ChannelRoute = { orgId: string; label: string | null };

export async function resolveOrgForChannel(
  channel: "whatsapp" | "telegram",
  externalId: string | null | undefined
): Promise<ChannelRoute | null> {
  if (!externalId) return null;
  const { data, error } = await supabaseAdmin
    .from("channel_routes")
    .select("org_id, label")
    .eq("channel", channel)
    .eq("external_id", externalId)
    .maybeSingle();

  if (error) {
    // Fail closed: an errored lookup must not route to a guessed org.
    console.error("channel route lookup failed:", error.message);
    return null;
  }
  if (!data) return null;
  return { orgId: data.org_id, label: data.label };
}
