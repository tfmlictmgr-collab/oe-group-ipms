// Week 1 deliverable: instantiate the dual-brand architecture so it is
// demonstrable (and front-loads the Week 4 cross-brand isolation test).
// Creates a TFML org and an OEA org (each with its delivery_brand), one admin
// user per brand, and one ticket per brand so data separation is visible.
// Isolation itself is enforced by the existing org_id RLS backstop.
// Usage: node scripts/seed-brands.mjs
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";
import { createClient } from "@supabase/supabase-js";

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
config({ path: path.join(rootDir, ".env.local") });

const PASSWORD = "OEGroupDemo2026!";
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const BRANDS = [
  {
    orgName: "TFML — Total Facilities Management",
    brand: "TFML",
    email: "tfml@oegroup.test",
    userName: "Ifeanyi Uche (TFML)",
    ticket: "AC servicing overdue in the east wing plant room — TFML site",
  },
  {
    orgName: "OEA — Ora Egbunike & Associates",
    brand: "OEA",
    email: "oea@oegroup.test",
    userName: "Zainab Bello (OEA)",
    ticket: "Tenancy renewal query for a managed property — OEA client",
  },
];

const { data: authList } = await supabase.auth.admin.listUsers();

for (const b of BRANDS) {
  // Org (idempotent by name)
  let { data: org } = await supabase
    .from("orgs")
    .select("id")
    .eq("name", b.orgName)
    .maybeSingle();
  if (!org) {
    const { data, error } = await supabase
      .from("orgs")
      .insert({ name: b.orgName, delivery_brand: b.brand })
      .select()
      .single();
    if (error) throw error;
    org = data;
  } else {
    await supabase
      .from("orgs")
      .update({ delivery_brand: b.brand })
      .eq("id", org.id);
  }

  // Auth user + profile
  let authUser = authList?.users?.find((u) => u.email === b.email);
  if (!authUser) {
    const { data, error } = await supabase.auth.admin.createUser({
      email: b.email,
      password: PASSWORD,
      email_confirm: true,
    });
    if (error) throw error;
    authUser = data.user;
  }
  await supabase.from("users").upsert({
    id: authUser.id,
    org_id: org.id,
    role: "admin",
    full_name: b.userName,
    email: b.email,
  });

  // One ticket so data separation is visible (idempotent by message)
  const { data: existingTicket } = await supabase
    .from("tickets")
    .select("id")
    .eq("org_id", org.id)
    .eq("message_text", b.ticket)
    .maybeSingle();
  if (!existingTicket) {
    await supabase.from("tickets").insert({
      org_id: org.id,
      channel: "portal",
      message_text: b.ticket,
      category: "maintenance",
      urgency: "normal",
      summary: b.ticket,
    });
  }

  console.log(`${b.brand.padEnd(5)} org ready · login ${b.email} · 1 ticket`);
}

console.log(`\nBoth brand logins use password: ${PASSWORD}`);
console.log("Data isolation is enforced by org_id RLS (verify-bi-scoping.mjs).");
