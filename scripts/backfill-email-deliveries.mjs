// Fills in delivery outcomes the Resend webhook never recorded.
//
// ⚠️ Why this exists. Production's RESEND_WEBHOOK_SECRET was unset from the
// first send (22 Sept 2026) until 2 Oct 2026, and the webhook fails CLOSED
// without it — every delivery report was refused with a 403, so all 27 rows
// sent in that window stayed `accepted` and the invitations screen read
// "delivery not yet confirmed" over mail that had arrived. Resend stops
// retrying a refused event after a while, so those outcomes will never arrive
// on their own.
//
// This asks Resend for each message's `last_event` (GET /emails/{id}) and
// applies it under the SAME rules as the webhook: only rows still `accepted`
// or `delayed` move, a delay never overwrites an outcome, and `resolved_at` is
// set only for a final outcome. A message Resend still reports as `sent` or
// `queued` is left alone, which is the honest answer.
//
// Dry run by default. `--apply` writes. `--env <file>` picks the world and is
// REQUIRED, so this never runs against whatever `.env.local` happens to be.
//
// Usage: node scripts/backfill-email-deliveries.mjs --env .env.prod.local [--apply]
import path from "node:path";
import { config } from "dotenv";
import { createClient } from "@supabase/supabase-js";

const apply = process.argv.includes("--apply");
const envArg = process.argv.indexOf("--env");
if (envArg === -1 || !process.argv[envArg + 1]) {
  console.error("Pass --env <file>, e.g. --env .env.prod.local");
  process.exit(1);
}
const envFile = process.argv[envArg + 1];
config({ path: path.join(process.cwd(), envFile), override: true });

const key = process.env.RESEND_API_KEY;
if (!key) {
  console.error(`RESEND_API_KEY is not set in ${envFile}`);
  process.exit(1);
}

const svc = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);

// Mirrors EVENT_STATUS in app/api/webhooks/email/resend/route.ts, keyed by
// Resend's `last_event` names rather than its webhook event types.
const LAST_EVENT_STATUS = {
  delivered: "delivered",
  bounced: "bounced",
  complained: "complained",
  delivery_delayed: "delayed",
};

const c = { g: (s) => `\x1b[32m${s}\x1b[0m`, r: (s) => `\x1b[31m${s}\x1b[0m`, d: (s) => `\x1b[2m${s}\x1b[0m` };
console.log(`\nEmail delivery backfill — ${apply ? c.r("APPLY") : c.g("DRY RUN")}  ·  ${envFile}`);
console.log(c.d(`  ${process.env.NEXT_PUBLIC_SUPABASE_URL}\n`));

const { data: rows, error } = await svc
  .from("email_deliveries")
  .select("id, provider_message_id, to_email, category, status, sent_at")
  .eq("provider", "resend")
  .in("status", ["accepted", "delayed"])
  .not("provider_message_id", "is", null)
  .order("sent_at");
if (error) {
  console.error("Could not read email_deliveries:", error.message);
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tally = {};
let changed = 0;

for (const row of rows) {
  // Resend's API allows 2 requests a second.
  await sleep(600);
  let lastEvent;
  try {
    const res = await fetch(`https://api.resend.com/emails/${row.provider_message_id}`, {
      headers: { Authorization: `Bearer ${key}` },
    });
    if (!res.ok) {
      console.log(`  ${c.r("ERR")} ${row.provider_message_id}: Resend answered ${res.status}`);
      tally.error = (tally.error ?? 0) + 1;
      continue;
    }
    lastEvent = (await res.json()).last_event;
  } catch (e) {
    console.log(`  ${c.r("ERR")} ${row.provider_message_id}: ${e.message}`);
    tally.error = (tally.error ?? 0) + 1;
    continue;
  }

  const status = LAST_EVENT_STATUS[lastEvent];
  tally[lastEvent ?? "none"] = (tally[lastEvent ?? "none"] ?? 0) + 1;
  const line = `${row.sent_at.slice(0, 16)}  ${row.category.padEnd(8)}  ${row.to_email}`;

  // Still in flight, or nothing we record: leave it as it is.
  if (!status || status === row.status) {
    console.log(`  ${c.d("keep")}  ${line}  ${c.d(`(${lastEvent})`)}`);
    continue;
  }
  // A delay never overwrites anything but `accepted` — same rule as the webhook.
  if (status === "delayed" && row.status !== "accepted") continue;

  console.log(`  ${c.g("set ")}  ${line}  → ${status}`);
  changed++;
  if (!apply) continue;

  const isFinal = status !== "delayed";
  const { error: upErr } = await svc
    .from("email_deliveries")
    .update({
      status,
      detail: `email.${lastEvent} (backfilled from Resend API)`,
      resolved_at: isFinal ? new Date().toISOString() : null,
    })
    .eq("id", row.id)
    .in("status", isFinal ? ["accepted", "delayed"] : ["accepted"]);
  if (upErr) console.log(`  ${c.r("ERR")} could not update ${row.id}: ${upErr.message}`);
}

console.log(`\n${rows.length} unresolved row(s) checked · Resend says:`, tally);
console.log(apply ? `${changed} row(s) updated.` : `${changed} row(s) would change. Re-run with --apply to write.`);
