// Creates a demo login: an auth user + matching public.users profile row in
// the demo org. Role is admin so the demo account can see every in-org ticket
// (including WhatsApp/Telegram tickets, which have no sender_id) — that's what
// makes the "watch a request appear live" demo work. RLS still scopes other
// roles per B7.
// Usage: node scripts/seed-demo-user.mjs
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";
import { createClient } from "@supabase/supabase-js";

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
config({ path: path.join(rootDir, ".env.local") });

const EMAIL = process.env.DEMO_USER_EMAIL ?? "demo@oegroup.test";
const PASSWORD = process.env.DEMO_USER_PASSWORD ?? "OEGroupDemo2026!";
const ORG_ID = process.env.DEMO_ORG_ID;

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Find an existing auth user with this email, else create one.
const { data: list } = await supabase.auth.admin.listUsers();
let authUser = list?.users?.find((u) => u.email === EMAIL);

if (!authUser) {
  const { data, error } = await supabase.auth.admin.createUser({
    email: EMAIL,
    password: PASSWORD,
    email_confirm: true,
  });
  if (error) throw error;
  authUser = data.user;
  console.log(`Created auth user: ${EMAIL}`);
} else {
  console.log(`Auth user already exists: ${EMAIL}`);
}

// Upsert the matching profile row (id must equal the auth uid for RLS).
const { error: upsertError } = await supabase.from("users").upsert({
  id: authUser.id,
  org_id: ORG_ID,
  role: "admin",
  full_name: "Demo Admin",
  email: EMAIL,
});
if (upsertError) throw upsertError;

console.log("Profile row ready.");
console.log("\nLogin credentials:");
console.log(`  Email:    ${EMAIL}`);
console.log(`  Password: ${PASSWORD}`);
