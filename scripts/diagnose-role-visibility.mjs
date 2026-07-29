// Who can actually see a WhatsApp request?
//
// Every chat ticket carries property_id = NULL (the webhook has no property to
// attach) and sender_id = NULL (an unknown phone number is not a user). The
// policy grants a non-`read_all` role only
//   property_id in (select current_user_property_ids())
// and NULL never matches an IN list. So the prediction is: admin and finance
// see them, everyone property-scoped sees none.
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

const orgRes = await svc.from("orgs").select("id, name");
if (orgRes.error) { console.error("db unreachable:", orgRes.error.message); process.exit(1); }
const byId = Object.fromEntries(orgRes.data.map((o) => [o.id, o.name]));

const { data: staff } = await svc
  .from("users")
  .select("id, email, role, org_id")
  .order("role");

console.log("Every staff account, and how many chat requests it can see\n");
console.log("  role              email                          org                    chat tickets in org / seen");
console.log("  " + "-".repeat(96));

for (const u of staff ?? []) {
  if (!u.email?.endsWith("@oegroup.test") && !u.email?.includes("oegroup")) continue;

  const { count: inOrg } = await svc
    .from("tickets")
    .select("*", { count: "exact", head: true })
    .eq("org_id", u.org_id)
    .in("channel", ["whatsapp", "telegram"]);

  const c = createClient(URL_, ANON);
  const { error: le } = await c.auth.signInWithPassword({ email: u.email, password: PW });
  if (le) {
    console.log(`  ${String(u.role).padEnd(17)} ${u.email.padEnd(30)} ${(byId[u.org_id] ?? "?").slice(0, 22).padEnd(23)} (cannot sign in)`);
    continue;
  }

  const { data: seen } = await c
    .from("tickets")
    .select("id, channel")
    .in("channel", ["whatsapp", "telegram"])
    .limit(500);

  const n = seen?.length ?? 0;
  const flag = (inOrg ?? 0) > 0 && n === 0 ? "   <-- BLIND" : "";
  console.log(
    `  ${String(u.role).padEnd(17)} ${u.email.padEnd(30)} ${(byId[u.org_id] ?? "?").slice(0, 22).padEnd(23)} ${String(inOrg).padStart(3)} / ${String(n).padStart(3)}${flag}`
  );
  await c.auth.signOut();
}

console.log("\nHow many chat tickets have no property attached?\n");
const { count: total } = await svc
  .from("tickets").select("*", { count: "exact", head: true })
  .in("channel", ["whatsapp", "telegram"]);
const { count: orphan } = await svc
  .from("tickets").select("*", { count: "exact", head: true })
  .in("channel", ["whatsapp", "telegram"]).is("property_id", null);
console.log(`  ${orphan} of ${total} — ${orphan === total ? "ALL of them." : ""}`);

const { count: portalTotal } = await svc
  .from("tickets").select("*", { count: "exact", head: true }).eq("channel", "portal");
const { count: portalOrphan } = await svc
  .from("tickets").select("*", { count: "exact", head: true })
  .eq("channel", "portal").is("property_id", null);
console.log(`  portal requests: ${portalOrphan} of ${portalTotal} also have no property`);
