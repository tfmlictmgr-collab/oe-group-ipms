import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";
import { createClient } from "@supabase/supabase-js";

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
config({ path: path.join(rootDir, ".env.local") });

const URL_ = process.env.NEXT_PUBLIC_SUPABASE_URL;
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const svc = createClient(URL_, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

const o = await svc.from("orgs").select("id, name, delivery_brand");
if (o.error) { console.error("db unreachable:", o.error.message); process.exit(1); }
const poc = o.data.find((x) => x.delivery_brand === "direct");

const { count: totalPoc } = await svc.from("tickets")
  .select("*", { count: "exact", head: true }).eq("org_id", poc.id);
const { count: unassignedPoc } = await svc.from("tickets")
  .select("*", { count: "exact", head: true }).eq("org_id", poc.id).is("property_id", null);
console.log(`POC org: ${totalPoc} tickets, ${unassignedPoc} with no property`);

const c = createClient(URL_, ANON);
await c.auth.signInWithPassword({ email: "fm@oegroup.test", password: "OEGroupDemo2026!" });

const { data: perm } = await c.rpc("has_permission", { p_capability: "tickets.triage_unassigned" });
console.log(`fm@oegroup.test  tickets.triage_unassigned = ${perm}`);

const { count: seen } = await c.from("tickets").select("*", { count: "exact", head: true });
const { count: seenUnassigned } = await c.from("tickets")
  .select("*", { count: "exact", head: true }).is("property_id", null);
console.log(`  sees ${seen} tickets, ${seenUnassigned} of them unassigned`);

const { data: rp } = await svc.from("role_permissions")
  .select("granted").eq("org_id", poc.id).eq("role", "facility_manager")
  .eq("capability", "tickets.triage_unassigned").maybeSingle();
console.log(`  role_permissions row for POC/facility_manager: granted=${rp?.granted}`);
