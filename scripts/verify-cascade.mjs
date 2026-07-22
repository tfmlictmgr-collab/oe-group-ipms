// Day 13 verification: force a WhatsApp failure and confirm the fallback chain
// (SMS → Email) is attempted and every attempt is logged to `notifications`
// (and mirrored to audit_log). Uses a deliberately invalid WhatsApp recipient so
// the WhatsApp Cloud API rejects it.
// Usage: npx tsx scripts/verify-cascade.mjs
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
config({ path: path.join(rootDir, ".env.local") });

const { sendCascade } = await import("../lib/cascade.ts");
const { createClient } = await import("@supabase/supabase-js");
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

console.log("Sending a cascade with an INVALID WhatsApp number to force failure…\n");

const { cascadeId, delivered } = await sendCascade({
  orgId: process.env.DEMO_ORG_ID,
  entityType: "ticket",
  entityId: null,
  message: "Cascade fallback test — please ignore.",
  whatsapp: "000000000000000", // invalid → WhatsApp API rejects
  phone: "+2348030000000",
  email: "fallback-test@oegroup.example",
});

const { data: attempts } = await supabase
  .from("notifications")
  .select("channel, status, detail, attempt_order")
  .eq("cascade_id", cascadeId)
  .order("attempt_order");

console.log(`cascade_id ${cascadeId} · delivered=${delivered}\n`);
console.log("Logged attempts (in order):");
for (const a of attempts ?? []) {
  console.log(`  ${a.attempt_order}. ${a.channel.padEnd(9)} ${a.status.padEnd(8)} ${a.detail}`);
}

// Confirm the attempts also reached the audit trail.
const { count } = await supabase
  .from("audit_log")
  .select("*", { count: "exact", head: true })
  .eq("action", "notification.attempt")
  .gte("created_at", new Date(Date.now() - 60000).toISOString());
console.log(`\nnotification.attempt audit entries in the last minute: ${count}`);

const whatsappFailed = (attempts ?? []).some(
  (a) => a.channel === "whatsapp" && a.status === "failed"
);
const fellBack = (attempts ?? []).some((a) => a.channel === "sms" || a.channel === "email");
console.log(
  `\nRESULT: WhatsApp failed=${whatsappFailed}, fell back to SMS/Email=${fellBack} → ${
    whatsappFailed && fellBack ? "PASS" : "CHECK"
  }`
);

// Clean up the test rows (notifications is not append-only; audit is).
await supabase.from("notifications").delete().eq("cascade_id", cascadeId);
console.log("(test notification rows cleaned; audit entries remain, as designed)");
