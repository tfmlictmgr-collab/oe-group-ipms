import { supabaseAdmin } from "./supabase/admin";
import { sendCascade, type CascadeTarget } from "./cascade";

// Every update that matters to a role should reach them the way THEY chose to
// be reached — in-app is not enough on its own, and neither is picking one
// external channel for everyone. `notify_role`/`notify_user` (0025, hardened
// 0122) already write the in-app bell entry, org-boundary-checked; this layers
// the B8 external cascade on top, for the exact same audience, reading each
// recipient's OWN registered channels (`update_my_notification_prefs`, 0026)
// rather than guessing one for all of them.

type EntityType = CascadeTarget["entityType"];

type Recipient = {
  // Needed to check consent, which is recorded against a PERSON (0148), not a
  // phone number — the same row could be reached on a number they have since
  // replaced.
  id: string;
  full_name: string | null;
  phone: string | null;
  email: string | null;
  telegram_chat_id: string | null;
  notify_whatsapp: boolean;
  notify_sms: boolean;
  notify_email: boolean;
  notify_telegram: boolean;
};

const RECIPIENT_COLUMNS =
  "id, full_name, phone, email, telegram_chat_id, notify_whatsapp, notify_sms, notify_email, notify_telegram";

/** Builds a WhatsApp template for ONE recipient — needed because {{1}} is
 * conventionally a first name, which differs per person, unlike `message`
 * (one string shared by everyone in the loop). Returning `null`/`undefined`
 * falls back to `message` as free text for that recipient, same as omitting
 * a template entirely. */
type TemplateBuilder = (r: Recipient) => CascadeTarget["whatsappTemplate"];

// One send per recipient, each restricted to the channels THEY opted into —
// never a channel they never registered or turned off. `sendCascade`'s own
// WhatsApp → SMS → Email fallback still applies, just within that subset: a
// recipient with only email enabled gets only email attempted, not silently
// tried on channels they declined.
async function cascadeToRecipients(
  orgId: string,
  recipients: Recipient[],
  message: string,
  entityType: EntityType,
  entityId: string | null,
  buildWhatsAppTemplate?: TemplateBuilder
): Promise<void> {
  for (const r of recipients) {
    await sendCascade({
      orgId,
      entityType,
      entityId,
      message,
      // Every send from here is business-initiated — a role holder or a named
      // person being told something happened, not an answer to a message they
      // sent. So the consent gate in `sendCascade` applies, and it needs to
      // know WHO, not just which number.
      recipientUserId: r.id,
      whatsapp: r.notify_whatsapp && r.phone ? r.phone : null,
      whatsappTemplate: buildWhatsAppTemplate ? buildWhatsAppTemplate(r) : null,
      phone: r.notify_sms && r.phone ? r.phone : null,
      email: r.notify_email && r.email ? r.email : null,
      telegram: r.notify_telegram && r.telegram_chat_id ? r.telegram_chat_id : null,
    });
  }
}

/**
 * Notifies every active holder of a role in an org: the in-app bell (via
 * `notify_role`, which enforces the org boundary itself) plus each of their
 * own registered external channels. Used where the recipient is "whoever
 * holds this role," not a named person — e.g. a new request landing on
 * admin/FM.
 */
export async function notifyRoleWithCascade(opts: {
  orgId: string;
  roles: string[];
  kind: string;
  title: string;
  body?: string | null;
  link?: string | null;
  entityType: EntityType;
  entityId: string | null;
}): Promise<void> {
  await supabaseAdmin.rpc("notify_role", {
    p_org_id: opts.orgId,
    p_roles: opts.roles,
    p_kind: opts.kind,
    p_title: opts.title,
    p_body: opts.body ?? null,
    p_link: opts.link ?? null,
    p_entity_type: opts.entityType,
    p_entity_id: opts.entityId,
  });

  const { data: recipients } = await supabaseAdmin
    .from("users")
    .select(RECIPIENT_COLUMNS)
    .eq("org_id", opts.orgId)
    .in("role", opts.roles)
    .is("deactivated_at", null);

  const message = opts.body ? `${opts.title} — ${opts.body}` : opts.title;
  await cascadeToRecipients(opts.orgId, (recipients ?? []) as Recipient[], message, opts.entityType, opts.entityId);
}

/**
 * Same external delivery, for one or more NAMED people rather than a role —
 * e.g. the specific vendor/ops person a job was just dispatched to. The
 * caller already knows who and has already written the in-app notification
 * (`notify_user`); this only adds their registered external channels
 * alongside it.
 */
export async function cascadeToUserIds(
  orgId: string,
  userIds: string[],
  message: string,
  entityType: EntityType,
  entityId: string | null,
  buildWhatsAppTemplate?: TemplateBuilder
): Promise<void> {
  if (userIds.length === 0) return;
  // Runs on the service role, so nothing else here stops a foreign-org id
  // from resolving — this is the same org boundary `notifyRoleWithCascade`
  // above already applies (and that `notify_user`/`notify_role`, 0122,
  // enforce for the in-app half of this same feature). Without it, a caller
  // who can supply or already knows another org's user id reaches a real
  // external send — WhatsApp/SMS/Telegram/email, on this org's own paid
  // credentials — to someone outside it. (Build audit 0806-M2.)
  const { data: recipients } = await supabaseAdmin
    .from("users")
    .select(RECIPIENT_COLUMNS)
    .eq("org_id", orgId)
    .in("id", userIds)
    .is("deactivated_at", null);
  await cascadeToRecipients(
    orgId,
    (recipients ?? []) as Recipient[],
    message,
    entityType,
    entityId,
    buildWhatsAppTemplate
  );
}

/**
 * Announces a NEW request to the people who can open it and act on it — and
 * nobody else (0304, operator's rule of 27 Sept 2026).
 *
 * ⚠️ This replaced `notifyRoleWithCascade({ roles: ["admin", ...FM_PM] })`,
 * which told every administrator, FM and PM in the organisation about every
 * request — on WhatsApp and email too — while `tickets_select` let each FM/PM
 * open only the ones on their own buildings. The person told could not act,
 * and the people who could were buried in everyone else's work.
 *
 * Who is told is decided in SQL (`notify_ticket_audience`), next to the policy
 * it mirrors: the manager of the request's property, or — with no property —
 * whoever triages those. Administrators act only on work left 24 hours, and
 * hear about it from the hourly escalation; the one exception is a request
 * nobody operational can open, which the database sends to them at once with
 * a note saying why.
 */
export async function notifyTicketAudience(opts: {
  orgId: string;
  ticketId: string;
  kind: string;
  title: string;
  body?: string | null;
  link?: string | null;
}): Promise<void> {
  const { data, error } = await supabaseAdmin.rpc("notify_ticket_audience", {
    p_ticket_id: opts.ticketId,
    p_kind: opts.kind,
    p_title: opts.title,
    p_body: opts.body ?? null,
    p_link: opts.link ?? null,
  });
  if (error) throw new Error(`notify_ticket_audience: ${error.message}`);

  const told = (data ?? []) as { user_id: string; fallback: boolean }[];
  if (told.length === 0) return;

  const fallback = told.some((r) => r.fallback);
  const title = fallback ? `${opts.title} — no manager covers it` : opts.title;
  const message = opts.body ? `${title} — ${opts.body}` : title;
  await cascadeToUserIds(opts.orgId, told.map((r) => r.user_id), message, "ticket", opts.ticketId);
}
