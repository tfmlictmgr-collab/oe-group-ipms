// Does Supabase Realtime actually deliver changes from this world's database?
//
// Listens — and only listens — for INSERT/UPDATE on `tickets` and
// `user_notifications` as the SERVICE ROLE, which bypasses row-level security.
// That isolates the one question a browser cannot answer on its own:
//
//   • events arrive here, but not in a signed-in browser → the stream works and
//     Realtime's per-user access check is withholding the rows;
//   • nothing arrives here either, while a row demonstrably changed → the
//     stream itself is not delivering, and the fault is on the Supabase side.
//
// Written 25 Sept 2026: production's dashboard showed "Live" and Realtime
// answered "Subscribed to PostgreSQL" on both channels, yet a request created
// in front of the operator reached neither the board nor the bell.
//
// Prints table, event type, org id and time — never row content, never a key.
// Writes nothing. The service-role key is read from the world's own env file
// and never leaves this machine.
//
//   node scripts/diagnose-realtime.mjs --world prod            (listens 180 s)
//   node scripts/diagnose-realtime.mjs --world prod --seconds 300
//
// Needs Node 22+ (a built-in WebSocket).
import path from "node:path";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse } from "dotenv";
import { createClient } from "@supabase/supabase-js";

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const argv = process.argv.slice(2);
const flag = (n) => { const i = argv.indexOf(`--${n}`); return i === -1 ? null : argv[i + 1]; };
const world = flag("world");
const seconds = Number(flag("seconds") ?? 180);

if (!world) {
  console.error("Name the world:  node scripts/diagnose-realtime.mjs --world prod");
  process.exit(2);
}
const envFile = path.join(rootDir, `.env.${world}.local`);
if (!existsSync(envFile)) {
  console.error(`Missing .env.${world}.local`);
  process.exit(2);
}
if (typeof globalThis.WebSocket === "undefined") {
  console.error(`This Node (${process.version}) has no built-in WebSocket. Use Node 22 or later.`);
  process.exit(2);
}

// Read into a private object, never process.env — the same reason migrate.mjs
// does: a running `next dev` must not be redirected by a diagnostic.
const env = parse(readFileSync(envFile));
const url = env.NEXT_PUBLIC_SUPABASE_URL;
const key = env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error(`.env.${world}.local lacks NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY`);
  process.exit(2);
}
const ref = url.match(/https:\/\/([a-z0-9]+)\./)?.[1] ?? "?";

const svc = createClient(url, key, { auth: { persistSession: false } });
const count = async (t) => {
  const { count: n, error } = await svc.from(t).select("id", { count: "exact", head: true });
  return error ? `error: ${error.message}` : n;
};

const t0 = new Date();
const before = { tickets: await count("tickets"), user_notifications: await count("user_notifications") };
console.log(`\nRealtime diagnostic — world "${world}", project ${ref}`);
console.log(`Rows now: tickets ${before.tickets}, user_notifications ${before.user_notifications}`);

const received = { tickets: 0, user_notifications: 0 };
const stamp = () => new Date().toISOString().slice(11, 19);
const onChange = (p) => {
  received[p.table] = (received[p.table] ?? 0) + 1;
  const org = p.new?.org_id ?? p.old?.org_id ?? "?";
  console.log(`  ${stamp()}  EVENT  ${p.eventType.padEnd(6)} ${p.table}  org ${org}`);
};

const channel = svc
  .channel(`diagnose-realtime-${Date.now()}`)
  .on("postgres_changes", { event: "INSERT", schema: "public", table: "tickets" }, onChange)
  .on("postgres_changes", { event: "UPDATE", schema: "public", table: "tickets" }, onChange)
  .on("postgres_changes", { event: "INSERT", schema: "public", table: "user_notifications" }, onChange)
  .on("system", {}, (m) => console.log(`  ${stamp()}  system ${m?.status ?? ""} ${m?.message ?? ""}`.trimEnd()))
  .subscribe((status, err) => {
    console.log(`  ${stamp()}  channel ${status}${err ? ` — ${err.message}` : ""}`);
    if (status === "SUBSCRIBED") {
      console.log(`\nListening for ${seconds} s. NOW send a real issue to a WhatsApp number or bot,`);
      console.log("and answer the bot until it confirms a request.\n");
    }
  });

await new Promise((r) => setTimeout(r, seconds * 1000));
await svc.removeChannel(channel);

const after = { tickets: await count("tickets"), user_notifications: await count("user_notifications") };
const grew = {
  tickets: Number(after.tickets) - Number(before.tickets),
  user_notifications: Number(after.user_notifications) - Number(before.user_notifications),
};

console.log(`\nSince ${t0.toISOString().slice(11, 19)}:`);
for (const t of ["tickets", "user_notifications"]) {
  console.log(`  ${t.padEnd(19)} rows +${grew[t]}   events heard ${received[t]}`);
}

const changed = grew.tickets > 0 || grew.user_notifications > 0;
const heard = received.tickets + received.user_notifications > 0;
console.log("");
if (!changed && !heard) {
  console.log("INCONCLUSIVE — nothing changed while listening. Run again and send a real issue.");
} else if (heard) {
  console.log("THE STREAM WORKS. Events reach the service role, so a signed-in browser missing them");
  console.log("means Realtime's per-user access check is withholding the rows.");
} else {
  console.log("THE STREAM IS NOT DELIVERING. Rows changed and not one event arrived, even with");
  console.log("full rights. The fault is on the Supabase side, not in the app or its access rules.");
}
process.exit(0);
