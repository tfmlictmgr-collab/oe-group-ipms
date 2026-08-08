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
  phone: string | null;
  email: string | null;
  telegram_chat_id: string | null;
  notify_whatsapp: boolean;
  notify_sms: boolean;
  notify_email: boolean;
  notify_telegram: boolean;
};

const RECIPIENT_COLUMNS =
  "phone, email, telegram_chat_id, notify_whatsapp, notify_sms, notify_email, notify_telegram";

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
  entityId: string | null
): Promise<void> {
  for (const r of recipients) {
    await sendCascade({
      orgId,
      entityType,
      entityId,
      message,
      whatsapp: r.notify_whatsapp && r.phone ? r.phone : null,
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
  entityId: string | null
): Promise<void> {
  if (userIds.length === 0) return;
  const { data: recipients } = await supabaseAdmin
    .from("users")
    .select(RECIPIENT_COLUMNS)
    .in("id", userIds)
    .is("deactivated_at", null);
  await cascadeToRecipients(orgId, (recipients ?? []) as Recipient[], message, entityType, entityId);
}
