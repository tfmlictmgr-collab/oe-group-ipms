// No notification offers a link that goes nowhere — for anyone, in any org.
//
// ⚠️ This exists because the same 404 was reported TWICE.
//
// `0138` fixed it by deleting a notification when its subject is deleted,
// keyed on `entity_type` + `entity_id`. That works — checked against the live
// database, zero orphans by that key. What it could not see is that
// `notify_user`/`notify_role` take those two columns as trailing OPTIONAL
// arguments, and several callers (0118's work-order notifications among them)
// build a link as `'/dashboard/tickets/' || p_ticket_id` and stop there. 84
// rows carried a UUID in the link and a NULL `entity_id`; 66 of those links
// were dead, across four roles and two organisations.
//
// 📌 The lesson this suite encodes: **a fix that keys on a field the writer is
// not required to populate is a fix for the cases that happened to populate
// it.** So section A checks the SHAPE (every id-bearing link declares its
// subject) rather than only the symptom, because the shape is what stops the
// next caller reintroducing it.
//
// Usage: node scripts/verify-notification-links.mjs
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";
import { createClient } from "@supabase/supabase-js";
import pg from "pg";

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
config({ path: path.join(rootDir, ".env.local") });

const svc = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);

let failures = 0;
const ok = (m) => console.log(`  \x1b[32mPASS\x1b[0m ${m}`);
const bad = (m) => { failures++; console.log(`  \x1b[31mFAIL\x1b[0m ${m}`); };
const note = (m) => console.log(`  \x1b[33mNOTE\x1b[0m ${m}`);

const db = new pg.Client({
  host: process.env.SUPABASE_DB_HOST, port: Number(process.env.SUPABASE_DB_PORT || 5432),
  database: process.env.SUPABASE_DB_NAME, user: process.env.SUPABASE_DB_USER,
  password: process.env.SUPABASE_DB_PASSWORD, ssl: { rejectUnauthorized: false },
  // Section D holds this one connection open across every user in every org —
  // dozens of serial round-trips over the remote pooler. A NAT/firewall idle
  // timeout can drop it mid-loop, and pg's default behaviour for a socket
  // error with no listener is to THROW, crashing the whole suite and losing
  // every result gathered so far. keepAlive makes the drop itself less likely;
  // the listener below is what stops it taking the process down when it still
  // happens — each in-flight query then rejects into its own try/catch
  // instead of the process exiting uncaught.
  keepAlive: true,
  keepAliveInitialDelayMillis: 10000,
});
db.on("error", (err) => {
  console.log(
    `  \x1b[33mNOTE\x1b[0m database connection dropped mid-suite (${err.message.slice(0, 90)}) — ` +
    `remaining checks will fail individually rather than crash the run.`
  );
});
await db.connect();

console.log("Notification links — nothing points at nothing\n");

// ── A. The shape: an id-bearing link must declare its subject ─────────────
console.log("A. Every id-bearing link declares what it points at");
{
  const { rows } = await db.query(`
    select count(*)::int n from user_notifications
     where link ~ '^/dashboard/(tickets|payments|assets|properties|leases|people/tenancy)/'
       and link ~ '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}'
       and entity_id is null`);
  rows[0].n === 0
    ? ok("no notification links to a row without saying which row")
    : bad(`${rows[0].n} notification(s) link to an id with a NULL entity_id — 0138's cleanup cannot see them`);
}

// ── B. And nothing dangles ────────────────────────────────────────────────
console.log("\nB. No notification outlives its subject");
{
  for (const [type, table] of [
    ["ticket", "tickets"], ["payment", "payments"], ["asset", "assets"],
    ["property", "properties"], ["lease", "leases"],
    // Added by 0242, after a live 404 traced to exactly this entity type
    // being absent from this list.
    ["tenant_application", "tenant_applications"],
  ]) {
    const { rows } = await db.query(
      `select count(*)::int n from user_notifications nt
        where nt.entity_type = $1
          and nt.entity_id is not null
          and not exists (select 1 from ${table} x where x.id = nt.entity_id)`, [type]
    );
    rows[0].n === 0
      ? ok(`no orphaned ${type} notification`)
      : bad(`${rows[0].n} ${type} notification(s) point at a deleted row`);
  }
}

// ── C. The derivation happens even when the caller forgets ────────────────
console.log("\nC. A caller who omits the subject still gets one");
{
  // ⚠️ The heart of the fix. Written as the thing a careless caller does.
  const { data: org } = await svc.from("orgs")
    .select("id").eq("slug", "tfml").single();
  const { data: u } = await svc.from("users")
    .select("id").eq("org_id", org.id).eq("role", "admin")
    .is("deactivated_at", null).limit(1).single();
  const { data: t } = await svc.from("tickets")
    .select("id").eq("org_id", org.id).limit(1).maybeSingle();

  if (!t) { note("no ticket on tfml — the derivation check needs one"); }
  else {
    await db.query("begin");
    try {
      // No p_entity_type, no p_entity_id — exactly how 0118 calls it.
      await db.query(
        `select notify_user($1::uuid, 'system', 'Probe: derived subject', null, $2)`,
        [u.id, `/dashboard/tickets/${t.id}`]
      );
      const { rows } = await db.query(
        `select entity_type, entity_id from user_notifications
          where title = 'Probe: derived subject' order by created_at desc limit 1`
      );
      const r = rows[0];
      r && r.entity_type === "ticket" && r.entity_id === t.id
        ? ok("notify_user derives entity_type/entity_id from the link when they are omitted")
        : bad(`the subject was not derived: ${JSON.stringify(r)}`);
    } catch (e) {
      bad(`derivation check failed: ${e.message.slice(0, 110)}`);
    }
    await db.query("rollback");
  }
}

// ── D. What every real user would actually see ────────────────────────────
//
// ⚠️ This section separates TWO causes that look identical to a clicking user
// and are completely different problems:
//
//   * **deleted** — the subject is gone. A bug, and it must be zero: 0138's
//     triggers plus 0145's backfill exist for exactly this.
//   * **out of scope** — the subject EXISTS but this reader cannot see it.
//     Not a dangling reference at all. `notify_role` broadcasts to every
//     holder of a role in the organisation, while RLS scopes each of them to a
//     subset — an FM/PM is property-scoped on tickets and vendor-scoped on
//     payments. So an FM assigned to two properties is told about a ticket on
//     a third, and clicking it used to 404.
//
// That second case is the REAL root of the reported 404, and no cascade could
// ever have fixed it. The UI now refuses to offer such a link, which is what
// stops the 404. Narrowing the broadcast itself is a genuine follow-up, so it
// is reported here with a count rather than silently tolerated or turned into
// a red build over a design consequence.
console.log("\nD. Every role, every org: no dead link is offered");
{
  const { data: orgs } = await svc.from("orgs")
    .select("id, slug, is_platform_operator").is("deleted_at", null).order("slug");

  let checked = 0, deleted = 0, outOfScope = 0;
  const scopeDetail = [];

  for (const org of (orgs ?? []).filter((o) => !o.is_platform_operator)) {
    const { data: users } = await svc.from("users")
      .select("id, email, role").eq("org_id", org.id).is("deactivated_at", null);

    for (const u of users ?? []) {
      await db.query("begin");
      try {
        await db.query("set local role authenticated");
        await db.query(
          `set local request.jwt.claims = '${JSON.stringify({ sub: u.id, role: "authenticated" })}'`
        );
        const { rows } = await db.query(
          `select link, entity_type, entity_id, target_live from my_notifications(30)`
        );
        checked += rows.length;

        for (const r of rows.filter((x) => x.link && x.target_live === false)) {
          // Ask as SERVICE ROLE whether the row exists at all. That is what
          // tells the two causes apart.
          const table = { ticket: "tickets", payment: "payments", asset: "assets",
                          property: "properties", lease: "leases",
                          tenant_application: "tenant_applications" }[r.entity_type];
          let exists = false;
          if (table && r.entity_id) {
            let q = svc.from(table).select("id").eq("id", r.entity_id);
            // Purged, not just deleted — my_notifications()'s own target_live
            // check for this entity treats a purged row as gone too.
            if (table === "tenant_applications") q = q.is("purged_at", null);
            const { data } = await q.maybeSingle();
            exists = Boolean(data);
          }
          if (exists) { outOfScope++; scopeDetail.push(`${org.slug} ${u.role}`); }
          else { deleted++; bad(`${org.slug} ${u.role} ${u.email}: link to a DELETED ${r.entity_type}`); }
        }
      } catch (e) {
        bad(`${org.slug} ${u.email}: my_notifications failed — ${e.message.slice(0, 80)}`);
      }
      await db.query("rollback");
    }
  }

  deleted === 0
    ? ok(`${checked} notification(s) read as their actual owners — none points at a deleted row`)
    : bad(`${deleted} notification(s) still point at deleted rows`);

  if (outOfScope > 0) {
    const byRole = [...new Set(scopeDetail)].join(", ");
    note(
      `${outOfScope} notification(s) name a row that EXISTS but is outside the ` +
      `recipient's scope (${byRole}). Not a dangling link: notify_role broadcasts ` +
      `org-wide by role while RLS scopes each reader to a subset. The UI no longer ` +
      `offers these as links, so they cannot 404 — narrowing the broadcast at the ` +
      `notify site is the outstanding follow-up.`
    );
  } else {
    ok("and none names a row outside its recipient's scope");
  }
}

// ── E. Retention: unread survives, old read does not ──────────────────────
console.log("\nE. The 30-day rule keeps what still needs a person");
{
  const { data: org } = await svc.from("orgs").select("id").eq("slug", "tfml").single();
  const { data: u } = await svc.from("users")
    .select("id").eq("org_id", org.id).eq("role", "admin").is("deactivated_at", null).limit(1).single();

  await db.query("begin");
  try {
    // Three fixtures: old+read (must vanish), old+unread (must survive),
    // recent+read (must survive).
    await db.query(
      `insert into user_notifications (org_id, user_id, kind, title, created_at, read_at) values
         ($1,$2,'system','Probe old read',   now() - interval '90 days', now() - interval '89 days'),
         ($1,$2,'system','Probe old unread', now() - interval '90 days', null),
         ($1,$2,'system','Probe new read',   now() - interval '2 days',  now())`,
      [org.id, u.id]
    );
    await db.query("set local role authenticated");
    await db.query(`set local request.jwt.claims = '${JSON.stringify({ sub: u.id, role: "authenticated" })}'`);
    const { rows } = await db.query(
      `select title from my_notifications(30) where title like 'Probe %'`
    );
    const titles = rows.map((r) => r.title);
    !titles.includes("Probe old read")
      ? ok("a READ notification older than 30 days is cleared")
      : bad("an old read notification is still shown");
    titles.includes("Probe old unread")
      ? ok("an UNREAD one survives whatever its age — untreated does not stop mattering")
      : bad("an old UNREAD notification was hidden — that is the one that still needs someone");
    titles.includes("Probe new read")
      ? ok("and a recent read one is still listed")
      : bad("a recent read notification went missing");
  } catch (e) {
    bad(`retention check failed: ${e.message.slice(0, 120)}`);
  }
  await db.query("rollback");
}

await db.end();

console.log(
  failures === 0
    ? "\n\x1b[32mALL CHECKS PASSED\x1b[0m — no notification points at nothing, for anyone, in any org."
    : `\n\x1b[31m${failures} CHECK(S) FAILED\x1b[0m`
);
process.exit(failures === 0 ? 0 : 1);
