import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";
import { createClient } from "@supabase/supabase-js";

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
config({ path: path.join(rootDir, ".env.local") });

const svc = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

const u = await svc.from("users").select("email, role, phone, org_id").not("phone", "is", null);
if (u.error) { console.error("db unreachable:", u.error.message); process.exit(1); }

console.log("Stored phone numbers on users\n");
if (!u.data.length) console.log("  NONE — no user has a phone number recorded.");
for (const r of u.data) console.log(`  ${String(r.email).padEnd(38)} ${String(r.role).padEnd(17)} ${r.phone}`);

const t = await svc
  .from("tickets")
  .select("channel, channel_sender_ref, org_id, created_at")
  .in("channel", ["whatsapp", "telegram"])
  .order("created_at", { ascending: false })
  .limit(8);
console.log("\nSender refs as the webhook records them\n");
for (const r of t.data ?? []) console.log(`  ${r.channel.padEnd(9)} ${r.channel_sender_ref}`);

const un = await svc.from("units").select("id, occupant_user_id, property_id").not("occupant_user_id", "is", null);
console.log(`\nUnits with an occupant: ${un.data?.length ?? 0}`);
for (const r of (un.data ?? []).slice(0, 8)) {
  console.log(`  unit ${r.id.slice(0, 8)}  occupant ${String(r.occupant_user_id).slice(0, 8)}  property ${String(r.property_id).slice(0, 8)}`);
}
