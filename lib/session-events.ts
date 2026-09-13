"use server";

import { headers } from "next/headers";
import { createClient } from "@/lib/supabase/server";

/**
 * Writes "signed in" or "signed out" to the audit trail (0290), with the device
 * and the address the request came from.
 *
 * Called once at the end of a successful sign-in and once just BEFORE signing
 * out — after would be too late, because the session this attributes the row
 * to is the thing being ended.
 *
 * Swallows every failure. Signing in or out must never fail because the trail
 * could not be written; the database de-duplicates, so a retry is harmless.
 */
export async function recordSessionEvent(event: "signed_in" | "signed_out"): Promise<void> {
  try {
    const h = await headers();
    const device = h.get("user-agent");
    const ip = (h.get("x-forwarded-for") ?? "").split(",")[0]?.trim() || h.get("x-real-ip") || null;
    const supabase = await createClient();
    await supabase.rpc("record_session_event", {
      p_event: event,
      p_user_agent: device,
      p_ip: ip,
    });
  } catch {
    /* the trail is best-effort here; the sign-in itself is not */
  }
}
