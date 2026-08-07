"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { classifyMessageWithProvider } from "@/lib/triage";
import { shortRef } from "@/lib/acknowledgement";
import { ok, fail, type ActionResult } from "@/lib/action-result";

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
    .from("users").select("org_id").eq("id", user.id).single();
  if (!me?.org_id) return fail("Your account is not attached to an organisation.");

  // Link the request to the property of the unit they occupy, so the FM/PM who
  // manages it sees the request under property-scoped RLS. Best-effort: an
  // unfiled request is visible to whoever holds `tickets.triage_unassigned`,
  // which is a worse route but not a lost one.
  const { data: unit } = await supabase
    .from("units").select("property_id").eq("occupant_user_id", user.id)
    .limit(1).maybeSingle();

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
      channel: "portal",
      message_text: messageText,
      classified_by: provider,
      category,
      urgency: classification.urgency,
      summary: classification.summary ?? messageText.slice(0, 140),
      property_or_unit: (input.propertyOrUnit ?? "").trim() || classification.property_or_unit,
      property_id: unit?.property_id ?? null,
      requires_human_review: classification.requires_human_review,
    })
    .select("id, category, urgency, summary")
    .single();

  if (error) return fail(error.message);

  // Someone is now told. `notify_role` is org-bounded as of 0122 — before that
  // it took the org as an argument and never checked it, so a tenant calling it
  // could have written into another brand's inbox.
  await supabase.rpc("notify_role", {
    p_org_id: me.org_id,
    p_roles: ["admin", "facility_manager"],
    p_kind: "request",
    p_title: `New ${ticket.urgency} request — ${shortRef(ticket.id)}`,
    p_body: ticket.summary ?? messageText.slice(0, 140),
    p_link: `/dashboard/tickets/${ticket.id}`,
    p_entity_type: "ticket",
    p_entity_id: ticket.id,
  });

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
