import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";
import { createClient } from "@supabase/supabase-js";

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
config({ path: path.join(rootDir, ".env.local") });

const svc = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

const orgRes = await svc.from("orgs").select("id, name, delivery_brand");
if (orgRes.error) { console.error("db unreachable:", orgRes.error.message); process.exit(1); }
const byId = Object.fromEntries(orgRes.data.map((o) => [o.id, `${o.name.slice(0, 26)} [${o.delivery_brand}]`]));

console.log("Which Supabase project this is:", process.env.NEXT_PUBLIC_SUPABASE_URL);

const { data: users } = await svc
  .from("users").select("email, role, org_id, created_at").order("created_at");

console.log("\nAccounts that are NOT seeded demo/probe accounts\n");
const real = (users ?? []).filter(
  (u) => !/@oegroup\.test$|@oegroup-invite\.test$/.test(u.email ?? "")
);
if (!real.length) console.log("  none — every account is a seeded one");
for (const u of real) {
  console.log(`  ${String(u.email).padEnd(38)} ${String(u.role).padEnd(18)} ${byId[u.org_id] ?? "?"}`);
}

console.log("\nChat requests per org, and who in that org could see them\n");
for (const o of orgRes.data) {
  const { count } = await svc
    .from("tickets").select("*", { count: "exact", head: true })
    .eq("org_id", o.id).in("channel", ["whatsapp", "telegram"]);
  const { count: noProp } = await svc
    .from("tickets").select("*", { count: "exact", head: true })
    .eq("org_id", o.id).in("channel", ["whatsapp", "telegram"]).is("property_id", null);
  const roles = (users ?? []).filter((u) => u.org_id === o.id).map((u) => u.role);
  const tally = roles.reduce((a, r) => ((a[r] = (a[r] ?? 0) + 1), a), {});
  console.log(
    `  ${byId[o.id].padEnd(40)} ${String(count).padStart(3)} chat (${noProp} with no property)` +
      `\n      staff: ${Object.entries(tally).map(([r, n]) => `${r}x${n}`).join(", ") || "none"}`
  );
}
