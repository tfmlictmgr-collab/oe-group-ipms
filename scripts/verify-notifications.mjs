// Proves the notification centre and preference controls are safe.
//   • a notification is readable ONLY by its recipient (cross-user + cross-org)
//   • a user cannot fabricate notifications, for themselves or anyone else
//   • marking read cannot reassign a row to someone else
//   • notify_role reaches only ACTIVE members of that org
//   • a user can set their OWN channels but cannot escalate their role
//   • only an admin may deactivate, and never themselves
// Usage: npx tsx scripts/verify-notifications.mjs
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";
import { createClient } from "@supabase/supabase-js";

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
config({ path: path.join(rootDir, ".env.local") });

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const SVCK = process.env.SUPABASE_SERVICE_ROLE_KEY;
const PW = "OEGroupDemo2026!";

let failures = 0;
const ok = (m) => console.log(`  \x1b[32mPASS\x1b[0m ${m}`);
const bad = (m) => { failures++; console.log(`  \x1b[31mFAIL\x1b[0m ${m}`); };

const svc = createClient(URL, SVCK, { auth: { persistSession: false } });
async function login(email) {
  const c = createClient(URL, ANON);
  const { error } = await c.auth.signInWithPassword({ email, password: PW });
  if (error) throw new Error(`${email}: ${error.message}`);
  const { data: { user } } = await c.auth.getUser();
  return { c, id: user.id };
}

const admin = await login("oe-group-foundation-poc.admin@oegroup.test");
const fm = await login("oe-group-foundation-poc.facilitymanager@oegroup.test");
const tenant = await login("oe-group-foundation-poc.tenant@oegroup.test");
const oea = await login("oea.admin@oegroup.test");

const { data: me } = await svc.from("users").select("org_id").eq("id", admin.id).single();
const orgId = me.org_id;
const stamp = Date.now().toString(36);
const made = [];

console.log("Notification centre & preferences\n");

console.log("A. A notification is readable only by its recipient");
{
  const { data: id } = await svc.rpc("notify_user", {
    p_user_id: fm.id, p_kind: "system",
    p_title: `FM-only ${stamp}`, p_body: "private", p_link: "/dashboard",
  });
  made.push(id);

  const { data: mine } = await fm.c
    .from("user_notifications").select("id").eq("id", id).maybeSingle();
  mine ? ok("recipient can read it") : bad("recipient cannot read their own notification");

  for (const [label, who] of [["admin", admin], ["tenant", tenant], ["other-org admin", oea]]) {
    const { data } = await who.c.from("user_notifications").select("id").eq("id", id).maybeSingle();
    data ? bad(`${label} READ another user's notification`) : ok(`${label} cannot read it`);
  }
}

console.log("\nB. A user cannot fabricate notifications");
{
  const { error: self } = await tenant.c.from("user_notifications").insert({
    org_id: orgId, user_id: tenant.id, kind: "system", title: "self-made",
  });
  self ? ok(`cannot insert for self (${self.message.slice(0, 40)})`) : bad("ALLOWED — user inserted their own notification");

  const { error: other } = await tenant.c.from("user_notifications").insert({
    org_id: orgId, user_id: admin.id, kind: "system", title: "planted",
  });
  other ? ok("cannot insert for someone else") : bad("ALLOWED — user planted a notification on another account");
}

console.log("\nC. Marking read cannot steal a notification");
{
  const { data: id } = await svc.rpc("notify_user", {
    p_user_id: fm.id, p_kind: "system", p_title: `steal-test ${stamp}`,
  });
  made.push(id);
  const { data, error } = await tenant.c
    .from("user_notifications").update({ user_id: tenant.id }).eq("id", id).select("id");
  (error || (data ?? []).length === 0)
    ? ok("another user cannot reassign it to themselves")
    : bad("ALLOWED — a notification was reassigned");

  const { data: still } = await svc.from("user_notifications").select("user_id").eq("id", id).single();
  still.user_id === fm.id ? ok("recipient unchanged") : bad("recipient was changed");
}

console.log("\nD. notify_role reaches only ACTIVE members of that org");
{
  const { data: n } = await svc.rpc("notify_role", {
    p_org_id: orgId, p_roles: ["admin"], p_kind: "system",
    p_title: `role-blast ${stamp}`, p_link: "/dashboard",
  });
  const { count: activeAdmins } = await svc
    .from("users").select("*", { count: "exact", head: true })
    .eq("org_id", orgId).eq("role", "admin").is("deactivated_at", null);
  n === activeAdmins ? ok(`reached ${n} active admin(s), matching the roster`) : bad(`reached ${n}, expected ${activeAdmins}`);

  const { data: leaked } = await oea.c
    .from("user_notifications").select("id").eq("title", `role-blast ${stamp}`);
  (leaked ?? []).length === 0 ? ok("no cross-org leakage") : bad("another org received the blast");

  const { data: rows } = await svc
    .from("user_notifications").select("id").eq("title", `role-blast ${stamp}`);
  made.push(...(rows ?? []).map((r) => r.id));
}

console.log("\nE. A relative link is required (no off-site redirects)");
{
  const { error } = await svc.rpc("notify_user", {
    p_user_id: fm.id, p_kind: "system", p_title: "evil", p_link: "https://evil.example/steal",
  });
  error ? ok(`absolute URL rejected (${error.message.slice(0, 45)})`) : bad("ALLOWED — external link accepted");
}

console.log("\nF. Preferences: own only, and no privilege escalation");
{
  const { error } = await tenant.c.rpc("update_my_notification_prefs", {
    p_phone: "+234 800 111 2222", p_telegram_chat_id: null,
    p_email: true, p_whatsapp: true, p_sms: false, p_telegram: true,
  });
  error ? bad(`tenant could not set own prefs — ${error.message}`) : ok("tenant set their own channels");

  const { data: t } = await svc
    .from("users").select("role, phone, notify_whatsapp, notify_telegram").eq("id", tenant.id).single();
  t.notify_whatsapp === true ? ok("WhatsApp enabled (phone supplied)") : bad("WhatsApp not enabled");
  t.notify_telegram === false
    ? ok("Telegram refused without a chat ID — no undeliverable preference stored")
    : bad("Telegram enabled without an identifier");
  t.role === "tenant" ? ok("role unchanged by the preferences call") : bad(`ROLE CHANGED to ${t.role}`);

  // The direct route must also be closed.
  const { data: esc } = await tenant.c
    .from("users").update({ role: "admin" }).eq("id", tenant.id).select("id");
  (esc ?? []).length === 0 ? ok("direct self-promotion blocked by RLS") : bad("ALLOWED — tenant made themselves admin");
}

console.log("\nG. Deactivation is admin-only, and never self-inflicted");
{
  const { error: byFm } = await fm.c.rpc("set_member_active", { p_user_id: tenant.id, p_active: false });
  byFm ? ok(`FM blocked (${byFm.message.slice(0, 45)})`) : bad("ALLOWED — an FM deactivated a member");

  const { error: self } = await admin.c.rpc("set_member_active", { p_user_id: admin.id, p_active: false });
  self ? ok(`admin cannot deactivate themselves (${self.message.slice(0, 40)})`) : bad("ALLOWED — admin locked themselves out");

  const { error: cross } = await oea.c.rpc("set_member_active", { p_user_id: tenant.id, p_active: false });
  cross ? ok("other-org admin blocked") : bad("ALLOWED — cross-org deactivation");
}

console.log("\nH. A deactivated member receives nothing");
{
  await svc.from("users").update({ deactivated_at: new Date().toISOString() }).eq("id", tenant.id);
  const { data: id } = await svc.rpc("notify_user", {
    p_user_id: tenant.id, p_kind: "system", p_title: `to-deactivated ${stamp}`,
  });
  id === null ? ok("notify_user declines to notify a deactivated member") : bad("a deactivated member was notified");
  await svc.from("users").update({ deactivated_at: null }).eq("id", tenant.id);
}

// Cleanup
await svc.from("user_notifications").delete().in("id", made.filter(Boolean));
await svc.from("user_notifications").delete().like("title", `%${stamp}`);
await svc.from("users").update({
  phone: null, notify_whatsapp: false, notify_sms: false, notify_telegram: false,
}).eq("id", tenant.id);
console.log("\n(cleaned up)");

console.log(
  failures === 0
    ? "\n\x1b[32mALL CHECKS PASSED\x1b[0m — notifications are strictly per-recipient and unforgeable."
    : `\n\x1b[31m${failures} CHECK(S) FAILED\x1b[0m`
);
process.exit(failures === 0 ? 0 : 1);
