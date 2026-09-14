"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { classifyMessageWithProvider } from "@/lib/triage";
import { shortRef } from "@/lib/acknowledgement";
import { ok, fail, type ActionResult } from "@/lib/action-result";
import { FM_PM } from "@/lib/roles";
import { notifyRoleWithCascade } from "@/lib/role-notify";

// Raising a request from the portal.
//
// This used to be a `supabase.from("tickets").insert()` in the browser, with
// the category and the urgency taken from two dropdowns the reporter filled in
// themselves. Three things followed from that, and each of them mattered:
//
//   * No classification. WhatsApp and Telegram messages go through
//     `classifyMessageWithProvider` — model, failover, recorded provider. The
//     portal, which A2 calls the system of record, was the one channel that
//     did not, so a gas leak reported on the web carried whatever severity the
//     reporter happened to pick from a select box.
//   * No acknowledgement. The chat channels answer with a reference and what
//     was understood (`buildAcknowledgement`). The web form redirected to
//     /dashboard — a page a tenant is not even given in the nav — and said
//     nothing. The tenant had no reference to quote and no confirmation that
//     anything had been received.
//   * Nobody told. Chat intake is watched; a portal ticket landed in the table
//     and waited to be noticed.
//
// Moved to the server so the model call happens somewhere the API key exists,
// and so the three of them happen together or not at all.

export type RaisedRequest = {
  ticketId: string;
  reference: string;
  category: string;
  urgency: string;
  summary: string | null;
  /** Which provider classified it — 'none' when both were unreachable. */
  classifiedBy: string;
  /** True when the reporter overrode the model, so the UI can say so. */
  categoryOverridden: boolean;
};

export async function raiseRequest(input: {
  messageText: string;
  /** Optional: the reporter insisted on a category. Blank means "you decide". */
  category?: string | null;
  propertyOrUnit?: string | null;
  /**
   * A tenant with more than one live tenancy naming WHICH ONE this is about.
   * Ignored for anyone who is not a tenant. Re-verified below against
   * `leases.tenant_user_id = auth.uid()` — never trusted as a bare id, since
   * that would let a tenant name a unit that is not theirs.
   */
  leaseId?: string | null;
  /**
   * A landlord or staff member naming a property/unit they hold. Ignored for
   * a tenant (their place always comes from their own verified lease, never
   * from client input — 0273). Re-verified below under the caller's own RLS
   * session before being trusted.
   */
  propertyId?: string | null;
  unitId?: string | null;
}): Promise<ActionResult<RaisedRequest>> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return fail("Your session expired. Please sign in again.");

  const messageText = (input.messageText ?? "").trim();
  // The same refusal `handleInboundMessage` makes for an empty chat message,
  // and for the same reason: classifying nothing produces a ticket that says
  // nothing about what is wrong or where, which is how the blank tickets got
  // into the register in the first place.
  if (!messageText) {
    return fail("Please describe what needs attention before submitting.");
  }

  const { data: me } = await supabase
    .from("users").select("org_id, role").eq("id", user.id).single();
  if (!me?.org_id) return fail("Your account is not attached to an organisation.");

  // ── Where this is about, resolved reliably (0273) ─────────────────────────
  //
  // Was: `units.occupant_user_id = user.id`, LIMIT 1 — the same occupancy join
  // decision 22/0226 already found unreliable for exactly this population (16
  // of 18 real tenancies then had no matching occupant), and one that resolves
  // to NOTHING at all for a landlord, who never occupies a unit even though
  // decision 19 explicitly gives them their own raise path through this same
  // form.
  let propertyId: string | null = null;
  let unitId: string | null = null;

  if (me.role === "tenant") {
    // Only a live lease belonging to THIS caller — never the client-supplied
    // propertyId/unitId, which for a tenant is trusted from nowhere but their
    // own verified tenancy. A picked leaseId is re-checked here rather than
    // assumed correct: the browser chose it from a list this same query
    // produces, but the browser is not the one deciding.
    const { data: leases } = await supabase
      .from("leases")
      .select("id, property_id, unit_id")
      .eq("tenant_user_id", user.id)
      .is("deleted_at", null)
      .in("status", ["active", "renewed"]);

    const live = leases ?? [];
    const chosen = input.leaseId
      ? live.find((l) => l.id === input.leaseId)
      : live.length === 1
        ? live[0]
        : undefined;
    // More than one live tenancy and no (or an unrecognised) choice: left
    // unresolved rather than guessed — the same "exactly one, or nobody" rule
    // `resolve_chat_sender` applies to an ambiguous match.
    propertyId = chosen?.property_id ?? null;
    unitId = chosen?.unit_id ?? null;
  } else if (input.propertyId) {
    // A landlord or staff member. Re-fetched under THEIR OWN session — RLS
    // (`properties_select`/`units_select`) already decides what this query can
    // ever return, so a client-supplied id that is not genuinely theirs comes
    // back empty and is silently dropped rather than trusted.
    const { data: prop } = await supabase
      .from("properties").select("id").eq("id", input.propertyId).maybeSingle();
    if (prop) {
      propertyId = prop.id;
      if (input.unitId) {
        const { data: unitRow } = await supabase
          .from("units").select("id, property_id")
          .eq("id", input.unitId).maybeSingle();
        if (unitRow && unitRow.property_id === propertyId) unitId = unitRow.id;
      }
    }
  }

  const { classification, provider } = await classifyMessageWithProvider(messageText);

  // The reporter's own words win on CATEGORY when they gave one — they know
  // whether this is a billing question or a broken lift better than a model
  // reading one sentence.
  //
  // ⚠️ Not on URGENCY, which is deliberately never taken from the form. "How
  // bad is this" is the judgement the classifier exists to make consistently
  // across reporters, and a self-assessed severity is the field people lean on
  // to jump the queue. They can still correct it AFTER seeing what we decided
  // (`set_my_ticket_urgency`) — which is a correction against a stated
  // baseline, recorded as such, rather than an unanchored claim.
  const chosen = (input.category ?? "").trim();
  const category = chosen || classification.category;

  const { data: ticket, error } = await supabase
    .from("tickets")
    .insert({
      org_id: me.org_id,
      sender_id: user.id,
      // Snapshot, not a live join (0273) — matches this schema's own pattern
      // for a fact that must not silently reinterpret itself later if the
      // person's role changes (decision 14's fee %, decision 30's superseded
      // approvals).
      sender_role: me.role,
      channel: "portal",
      message_text: messageText,
      classified_by: provider,
      category,
      urgency: classification.urgency,
      summary: classification.summary ?? messageText.slice(0, 140),
      property_or_unit: (input.propertyOrUnit ?? "").trim() || classification.property_or_unit,
      property_id: propertyId,
      unit_id: unitId,
      requires_human_review: classification.requires_human_review,
    })
    .select("id, category, urgency, summary")
    .single();

  if (error) return fail(error.message);

  // Someone is now told — on the bell AND on the channels they actually watch.
  //
  // ⚠️ This was a bare `notify_role`, which writes the in-app bell entry and
  // nothing else. The CHAT path has used `notifyRoleWithCascade` since it was
  // written, so a request arriving on WhatsApp reached an FM's phone while the
  // identical request raised on the portal — "the system of record" — reached
  // only a badge they had to be looking at the page to see. The comment thirty
  // lines above this one says "Nobody told" was one of the three defects the
  // server action existed to fix; it was fixed for the bell and not for the
  // person. Decision 23 asks for the FM to be reached "via all their preferred
  // notification/communication channels", and this is the path that was not.
  //
  // Best-effort, exactly as the chat path is: a notification failure must never
  // undo a ticket that has already been accepted and given a reference.
  try {
    await notifyRoleWithCascade({
      orgId: me.org_id,
      roles: ["admin", ...FM_PM],
      kind: "request",
      title: `New ${ticket.urgency} request — ${shortRef(ticket.id)}`,
      body: ticket.summary ?? messageText.slice(0, 140),
      link: `/dashboard/tickets/${ticket.id}`,
      entityType: "ticket",
      entityId: ticket.id,
    });
  } catch (e) {
    console.error("Could not notify admin/FM of new portal request:", e);
  }

  revalidatePath("/dashboard/my-requests");
  revalidatePath("/dashboard");

  return ok({
    ticketId: ticket.id,
    reference: shortRef(ticket.id),
    category: ticket.category,
    urgency: ticket.urgency,
    summary: ticket.summary,
    classifiedBy: provider,
    categoryOverridden: Boolean(chosen) && chosen !== classification.category,
  });
}

/**
 * The reporter pushing back on the priority we assigned — the portal's half of
 * the exchange 0075 gave the chat channels.
 *
 * Standing is decided in `set_my_ticket_urgency` (0124), not here: it returns
 * false rather than raising when the ticket is not theirs, is already closed,
 * or an operator has since set the priority deliberately. Those are three
 * different reasons for one honest answer — we did not change it — and the
 * caller should not be told which, since two of them describe a ticket they
 * have no business knowing about.
 */
export async function correctMyUrgency(
  ticketId: string,
  urgency: string
): Promise<ActionResult<{ applied: boolean }>> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("set_my_ticket_urgency", {
    p_ticket_id: ticketId,
    p_urgency: urgency,
  });
  if (error) return fail(error.message);

  revalidatePath("/dashboard/my-requests");
  revalidatePath(`/dashboard/tickets/${ticketId}`);
  return ok({ applied: Boolean(data) });
}
