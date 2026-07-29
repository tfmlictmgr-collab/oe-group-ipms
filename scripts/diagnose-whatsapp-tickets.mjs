// Why WhatsApp requests do not appear on the dashboards.
//
// The reply reaching the sender proves the ticket was written — the
// acknowledgement is built from `ticket.id`. So the question is not whether the
// row exists, it is who can see it.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";
import { createClient } from "@supabase/supabase-js";

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
config({ path: path.join(rootDir, ".env.local") });

const URL_ = process.env.NEXT_PUBLIC_SUPABASE_URL;
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const SVCK = process.env.SUPABASE_SERVICE_ROLE_KEY;
const PW = "OEGroupDemo2026!";

const svc = createClient(URL_, SVCK, { auth: { persistSession: false } });

const orgRes = await svc.from("orgs").select("id, name, delivery_brand");
if (orgRes.error || !orgRes.data) {
  console.error("Could not reach the database:", orgRes.error?.message ?? "no data");
  process.exit(1);
}
const orgs = orgRes.data;
const byId = Object.fromEntries(orgs.map((o) => [o.id, o.name]));

console.log("1. Every WhatsApp/Telegram ticket the database holds\n");
const { data: chat } = await svc
  .from("tickets")
  .select("id, org_id, channel, status, sender_id, property_id, assigned_to_user_id, message_text, created_at")
  .in("channel", ["whatsapp", "telegram"])
  .order("created_at", { ascending: false })
  .limit(15);

if (!chat?.length) {
  console.log("   NONE. The webhook is not writing tickets at all.");
} else {
  for (const t of chat) {
    console.log(
      `   ${t.created_at.slice(0, 16)}  ${t.channel.padEnd(8)}  ${(byId[t.org_id] ?? "?").slice(0, 22).padEnd(22)}` +
        `  status=${String(t.status).padEnd(10)} sender_id=${t.sender_id ? "set" : "NULL"}` +
        `  property=${t.property_id ? "set" : "NULL"}  "${(t.message_text ?? "").slice(0, 34)}"`
    );
  }
}

console.log("\n2. What each administrator actually sees\n");
for (const email of ["tfml@oegroup.test", "oea@oegroup.test"]) {
  const c = createClient(URL_, ANON);
  const { error: le } = await c.auth.signInWithPassword({ email, password: PW });
  if (le) { console.log(`   ${email}: cannot sign in — ${le.message}`); continue; }

  const { data: me } = await c.from("users").select("org_id, role").single();
  const { data: perm } = await c.rpc("has_permission", { p_capability: "tickets.read_all" });
  const { data: seen } = await c
    .from("tickets")
    .select("id, channel, created_at")
    .order("created_at", { ascending: false })
    .limit(200);

  const chatSeen = (seen ?? []).filter((t) => t.channel === "whatsapp" || t.channel === "telegram");
  const mine = (chat ?? []).filter((t) => t.org_id === me?.org_id);

  console.log(
    `   ${email.padEnd(22)} role=${String(me?.role).padEnd(16)} tickets.read_all=${perm}` +
      `\n      sees ${seen?.length ?? 0} tickets total, ${chatSeen.length} from chat channels` +
      `  (its org actually has ${mine.length} chat tickets)`
  );
  if (mine.length > 0 && chatSeen.length === 0) {
    console.log("      ^^ THE FAULT: rows exist for this org and the administrator cannot read them.");
  }
}

console.log("\n3. Is `tickets.read_all` granted per org?\n");
const { data: rp } = await svc
  .from("role_permissions")
  .select("org_id, role, granted")
  .eq("capability", "tickets.read_all")
  .in("role", ["admin", "facility_manager", "finance_approver"]);
for (const r of rp ?? []) {
  console.log(`   ${(byId[r.org_id] ?? "?").slice(0, 24).padEnd(26)} ${r.role.padEnd(18)} granted=${r.granted}`);
}

console.log("\n4. Channel routes\n");
const { data: routes } = await svc
  .from("channel_routes")
  .select("channel, external_id, org_id, label, active");
for (const r of routes ?? []) {
  console.log(
    `   ${r.channel.padEnd(9)} ${String(r.external_id).padEnd(18)} -> ${(byId[r.org_id] ?? "?").slice(0, 24).padEnd(26)} active=${r.active}`
  );
}
