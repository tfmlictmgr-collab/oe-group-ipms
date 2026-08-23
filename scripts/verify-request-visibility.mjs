// Board direction, 21 Aug 2026: a service request reaches the desk it belongs
// to and no other. Verified at the RLS layer, which is the enforced boundary —
// the dashboard's own filtering sits on top of this and is not a control.
//
// What this asserts, per org, per role, by impersonating a real account exactly
// as PostgREST does:
//
//   1. LANDLORD — a property owner sees NO request they did not raise. This is
//      the leak 0184 closed: `current_user_property_ids()` answers for an owner
//      exactly as it does for a manager, so the unguarded place branch handed
//      them every tenant complaint on every building they own.
//   2. FINANCE — a finance approver sees no request except through a payment
//      that has cleared to them, and NEVER the operational queue.
//   3. PAYMENT APPROVER — likewise, bounded to stage 3.
//   4. ORG-WIDE SIGHT — exactly admin, executive and payment_audit_approver.
//   5. FM/PM — still see their managed properties, because triage and dispatch
//      depend on it. Narrowing this was never the ask and would break 0178.
//   6. OPS STAFF — assigned work only.
//   7. ISOLATION — no role, on any path, reads a row from another org.
//
// Usage: node scripts/verify-request-visibility.mjs
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";
import pg from "pg";

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
config({ path: path.join(rootDir, ".env.local") });

const client = new pg.Client({
  host: process.env.SUPABASE_DB_HOST,
  port: Number(process.env.SUPABASE_DB_PORT || 5432),
  database: process.env.SUPABASE_DB_NAME,
  user: process.env.SUPABASE_DB_USER,
  password: process.env.SUPABASE_DB_PASSWORD,
  ssl: { rejectUnauthorized: false },
});

let failures = 0;
const pass = (m) => console.log(`  \x1b[32mPASS\x1b[0m ${m}`);
const fail = (m) => {
  failures++;
  console.log(`  \x1b[31mFAIL\x1b[0m ${m}`);
};

async function asUser(uid, fn) {
  await client.query("begin");
  try {
    await client.query("set local role authenticated");
    await client.query(
      `set local request.jwt.claims = '${JSON.stringify({ sub: uid, role: "authenticated" })}'`
    );
    return await fn();
  } finally {
    await client.query("rollback");
  }
}

/**
 * Roles B7 grants organisation-wide sight of the request queue.
 *
 * Loaded from `request_read_all_roles()` (0185) rather than hardcoded, so this
 * check cannot pass by agreeing with a stale copy of the rule. A verification
 * script holding its own list of what the database should say is how a suite
 * goes green against the wrong answer.
 */
let SEES_ALL = new Set();
/** Roles whose only route to a request is a payment that climbed to them. */
const PAYMENT_DESK = new Set(["finance_approver", "payment_approver"]);
/** Roles scoped to the properties they manage. */
const PLACE_SCOPED = new Set([
  "facility_manager",
  "property_manager",
  "regional_manager",
]);

await client.connect();
try {
  SEES_ALL = new Set(
    (await client.query(`select unnest(request_read_all_roles())::text as r`)).rows.map(
      (x) => x.r
    )
  );
  console.log(`Org-wide request sight, per the database: ${[...SEES_ALL].join(", ")}`);

  const { rows: users } = await client.query(`
    select distinct on (u.org_id, u.role)
           u.id, u.role, u.email, u.org_id, o.name as org_name, o.delivery_brand
      from users u join orgs o on o.id = u.org_id
     where u.deactivated_at is null
       and o.deleted_at is null
       and not o.is_platform_operator
     order by u.org_id, u.role,
              case when u.email like o.slug || '.%' then 0 else 1 end, u.email`);

  console.log(
    `Checking ${users.length} accounts across ${new Set(users.map((u) => u.org_id)).size} organisations\n`
  );

  // Ground truth, read with the policy bypassed, so each assertion compares
  // what the role SEES against what actually exists.
  const { rows: totals } = await client.query(
    `select org_id, count(*)::int as n from tickets group by org_id`
  );
  const totalByOrg = Object.fromEntries(totals.map((t) => [t.org_id, t.n]));

  for (const u of users) {
    const label = `${u.org_name} / ${u.role}`;
    const orgTotal = totalByOrg[u.org_id] ?? 0;
    if (orgTotal === 0) continue; // nothing to prove in an empty org

    const r = await asUser(u.id, async () => {
      const { rows } = await client.query(
        `select
           (select count(*)::int from tickets)                            as visible,
           (select count(*)::int from tickets where org_id <> $1)         as foreign,
           (select count(*)::int from tickets where sender_id = $2)       as own,
           (select count(*)::int from tickets
             where assigned_to_user_id = $2)                              as assigned,
           -- Their company's dispatched work. A vendor reaches this through
           -- current_user_vendor_ids(), which is identity rather than
           -- privilege — omitting it from the accounting made every
           -- contractor look like an unexplained reader of other people's
           -- requests.
           (select count(*)::int from tickets
             where assigned_vendor_id in (select current_user_vendor_ids())) as vendor_work,
           -- Inbound chat that has not been filed against a property yet.
           -- Unscopable by construction: no property means no place, so no
           -- place-scoping can narrow it. Whoever triages sees all of it, and
           -- that is 0064's deliberate design, not a leak.
           (select count(*)::int from tickets where property_id is null)   as unfiled,
           (select has_permission('tickets.triage_unassigned'))            as may_triage`,
        [u.org_id, u.id]
      );
      return rows[0];
    });

    // ── 7. Isolation, on every role and every path ────────────────────────
    if (r.foreign > 0) {
      fail(`${label}: reads ${r.foreign} request(s) from another organisation`);
    }

    // ── 4. Org-wide sight ─────────────────────────────────────────────────
    if (SEES_ALL.has(u.role)) {
      if (r.visible === orgTotal) pass(`${label}: sees all ${orgTotal} (B7)`);
      else fail(`${label}: sees ${r.visible} of ${orgTotal} — should see all`);
      continue;
    }

    // Everything a non-org-wide role may legitimately reach, from the branches
    // of tickets_select that are identity rather than privilege.
    const triage = r.may_triage ? r.unfiled : 0;
    const explained = r.own + r.assigned + r.vendor_work + triage;

    if (r.visible === orgTotal && orgTotal > 1 && triage === 0) {
      fail(`${label}: sees all ${orgTotal} requests — org-wide sight is not theirs`);
      continue;
    }

    // ── 1. The landlord ───────────────────────────────────────────────────
    if (u.role === "property_owner") {
      if (r.visible === r.own) {
        pass(`${label}: ${r.visible} request(s), all self-raised`);
      } else {
        fail(
          `${label}: sees ${r.visible} but raised only ${r.own} — reading tenants' requests`
        );
      }
      continue;
    }

    // ── 2 & 3. The payment desks ──────────────────────────────────────────
    if (PAYMENT_DESK.has(u.role)) {
      const viaPayable = await asUser(u.id, async () => {
        const { rows } = await client.query(
          `select count(*)::int as n from current_user_payable_ticket_ids()`
        );
        return rows[0].n;
      });
      if (r.visible <= explained + viaPayable) {
        pass(
          `${label}: ${r.visible} request(s) — ${viaPayable} at their desk, ${r.own} self-raised (not the ${orgTotal}-row queue)`
        );
      } else {
        fail(
          `${label}: sees ${r.visible}, but only ${explained + viaPayable} are accounted for by a payment or their own hand`
        );
      }
      continue;
    }

    // ── 5. FM / PM / regional ─────────────────────────────────────────────
    if (PLACE_SCOPED.has(u.role)) {
      const inScope = await asUser(u.id, async () => {
        const { rows } = await client.query(
          `select count(*)::int as n from tickets
            where property_id in (select current_user_property_ids())`
        );
        return rows[0].n;
      });
      if (r.visible < inScope) {
        fail(
          `${label}: sees ${r.visible} but ${inScope} are on properties they manage — triage would break`
        );
      } else if (r.visible > explained + inScope) {
        fail(
          `${label}: sees ${r.visible}, only ${explained + inScope} explained by place, assignment or triage`
        );
      } else {
        pass(
          `${label}: ${r.visible} request(s) — ${inScope} on managed property, ${triage} unfiled awaiting triage`
        );
      }
      continue;
    }

    // ── 6. Everyone else: only what is specifically theirs ────────────────
    if (r.visible <= explained) {
      pass(
        `${label}: ${r.visible} request(s), all their own, assigned or their company's`
      );
    } else {
      fail(
        `${label}: sees ${r.visible}, only ${explained} explained by sender, assignment or company`
      );
    }
  }

  // ── The capability itself ───────────────────────────────────────────────
  console.log("\nB7 baseline — who holds tickets.read_all");
  const { rows: caps } = await client.query(`
    select rp.role::text as role,
           count(*) filter (where rp.granted)::int as orgs_granted,
           count(*)::int as orgs
      from role_permissions rp
      join orgs o on o.id = rp.org_id
     where rp.capability = 'tickets.read_all' and o.deleted_at is null
     group by rp.role order by rp.role`);

  for (const c of caps) {
    const should = SEES_ALL.has(c.role);
    if (should && c.orgs_granted === c.orgs) {
      pass(`${c.role}: granted in all ${c.orgs} orgs`);
    } else if (!should && c.orgs_granted === 0) {
      pass(`${c.role}: granted nowhere`);
    } else {
      fail(
        `${c.role}: granted in ${c.orgs_granted} of ${c.orgs} orgs — expected ${should ? "all" : "none"}`
      );
    }
  }
} finally {
  await client.end();
}

console.log(
  failures === 0
    ? "\n\x1b[32mAll request-visibility checks passed.\x1b[0m"
    : `\n\x1b[31m${failures} check(s) failed.\x1b[0m`
);
process.exit(failures === 0 ? 0 : 1);
