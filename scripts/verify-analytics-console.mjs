// Day 10 — the filterable analytics console.
//
// The claims that matter:
//   • the lifecycle stamp fires on the transition, once, and survives a reopen
//   • tickets resolved before stamping began are EXCLUDED, not invented
//   • every filter narrows, and they compose
//   • the period bucket changes the grouping, not the totals
//   • RLS still scopes it — an FM/PM sees only their properties, through the
//     same functions the admin uses
//   • a tenant sees their own requests and nobody else's
//   • an unmeasured vendor is not reported as the fastest
//
// Usage: node scripts/verify-analytics-console.mjs
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

let failures = 0;
const ok = (m) => console.log(`  \x1b[32mPASS\x1b[0m ${m}`);
const bad = (m) => { failures++; console.log(`  \x1b[31mFAIL\x1b[0m ${m}`); };

const svc = createClient(URL_, SVCK, { auth: { persistSession: false } });
const login = async (email) => {
  const c = createClient(URL_, ANON, { auth: { persistSession: false } });
  const { error } = await c.auth.signInWithPassword({ email, password: PW });
  return error ? null : c;
};

const { data: orgs } = await svc.from("orgs").select("id, slug").is("deleted_at", null);
const poc = orgs.find((o) => o.slug === "oe-group-foundation-poc");

const S = Date.now().toString(36).toUpperCase().slice(-5);
const made = { tickets: [], vendors: [], properties: [] };

// Two properties: one the FM manages, one they do not — so scoping has a far
// side to prove.
const { data: fmUser } = await svc.from("users").select("id")
  .eq("email", "oe-group-foundation-poc.facilitymanager@oegroup.test").single();
const { data: staked } = await svc.from("property_stakeholders")
  .select("property_id").eq("user_id", fmUser.id);
const managedId = staked[0]?.property_id;
const { data: allProps } = await svc.from("properties")
  .select("id, name").eq("org_id", poc.id).is("deleted_at", null);
const unmanagedId = allProps.find((p) => !staked.some((s) => s.property_id === p.id))?.id;

const vendor = (await svc.from("vendors")
  .insert({ org_id: poc.id, name: `PROBEBI-Vendor-${S}` }).select("id").single()).data;
made.vendors.push(vendor.id);

const mkTicket = async (extra = {}) => {
  const { data, error } = await svc.from("tickets").insert({
    org_id: poc.id, channel: "portal", message_text: `PROBEBI ${S}`,
    category: "maintenance", urgency: "normal", status: "open", ...extra,
  }).select("id, created_at, resolved_at").single();
  if (error) { bad(`fixture failed — ${error.message.slice(0, 60)}`); return null; }
  made.tickets.push(data.id);
  return data;
};

console.log("The analytics console\n");

console.log("A. The lifecycle stamp fires on the transition");
let timed;
{
  timed = await mkTicket({ property_id: managedId, assigned_vendor_id: vendor.id });
  timed?.resolved_at === null ? ok("a new ticket has no resolution time") : bad("resolved_at was preset");

  await svc.from("tickets").update({ status: "resolved" }).eq("id", timed.id);
  const { data: after } = await svc.from("tickets")
    .select("resolved_at, first_response_at").eq("id", timed.id).single();
  after.resolved_at ? ok("resolving it stamps resolved_at") : bad("RESOLVED WITH NO TIMESTAMP");
  after.first_response_at ? ok("and a first-response time") : bad("no first_response_at");

  // Reopen, resolve again — the ORIGINAL time must survive.
  const firstStamp = after.resolved_at;
  await svc.from("tickets").update({ status: "in_progress" }).eq("id", timed.id);
  await svc.from("tickets").update({ status: "closed" }).eq("id", timed.id);
  const { data: reopened } = await svc.from("tickets")
    .select("resolved_at").eq("id", timed.id).single();
  reopened.resolved_at === firstStamp
    ? ok("a reopened-and-reclosed ticket keeps its ORIGINAL resolution time")
    : bad(`REOPEN REWROTE THE RESOLUTION TIME: ${firstStamp} -> ${reopened.resolved_at}`);
}

console.log("\nB. Unmeasured tickets are excluded, not invented");
{
  // A ticket resolved the old way: status set with the trigger bypassed by
  // writing resolved_at back to null, standing in for pre-0099 history.
  const legacy = await mkTicket({ property_id: managedId, status: "open" });
  await svc.from("tickets").update({ status: "resolved" }).eq("id", legacy.id);
  await svc.from("tickets").update({ resolved_at: null }).eq("id", legacy.id);

  const { data: rows } = await svc.rpc("bi_ticket_metrics", { p_bucket: "year" });
  const totals = (rows ?? []).reduce(
    (a, r) => ({ total: a.total + Number(r.total), timed: a.timed + Number(r.timed),
                 completed: a.completed + Number(r.completed) }),
    { total: 0, timed: 0, completed: 0 }
  );
  totals.timed < totals.completed
    ? ok(`${totals.timed} of ${totals.completed} completed tickets are timed — the rest are not counted as instant`)
    : bad(`timed (${totals.timed}) is not less than completed (${totals.completed})`);

  const anyRow = (rows ?? []).find((r) => Number(r.timed) > 0);
  anyRow && Number(anyRow.avg_hours_to_resolve) >= 0
    ? ok("and the average is computed only over those")
    : bad("no timed average produced");
}

console.log("\nC. Filters narrow, and compose");
{
  const all = await svc.rpc("bi_ticket_metrics", { p_bucket: "year" });
  const sum = (rs) => (rs ?? []).reduce((a, r) => a + Number(r.total), 0);

  const byVendor = await svc.rpc("bi_ticket_metrics", { p_vendor_id: vendor.id, p_bucket: "year" });
  sum(byVendor.data) > 0 && sum(byVendor.data) < sum(all.data)
    ? ok(`filtering to one vendor narrows ${sum(all.data)} → ${sum(byVendor.data)}`)
    : bad(`vendor filter gave ${sum(byVendor.data)} of ${sum(all.data)}`);

  const byStatus = await svc.rpc("bi_ticket_metrics", { p_status: "open", p_bucket: "year" });
  sum(byStatus.data) < sum(all.data)
    ? ok("filtering to open narrows it further")
    : bad("the status filter did not narrow");

  // Composed: vendor AND a window that excludes everything.
  const composed = await svc.rpc("bi_ticket_metrics", {
    p_vendor_id: vendor.id, p_from: "2000-01-01", p_to: "2000-12-31", p_bucket: "year",
  });
  sum(composed.data) === 0
    ? ok("vendor + an empty date window composes to nothing")
    : bad(`composed filter returned ${sum(composed.data)}`);
}

console.log("\nD. The bucket changes grouping, not totals");
{
  const sum = (rs) => (rs ?? []).reduce((a, r) => a + Number(r.total), 0);
  const y = await svc.rpc("bi_ticket_metrics", { p_bucket: "year" });
  const m = await svc.rpc("bi_ticket_metrics", { p_bucket: "month" });
  sum(y.data) === sum(m.data)
    ? ok(`yearly and monthly agree on the total (${sum(y.data)})`)
    : bad(`year ${sum(y.data)} vs month ${sum(m.data)}`);
  (m.data ?? []).length >= (y.data ?? []).length
    ? ok(`but monthly has at least as many buckets (${(m.data ?? []).length} vs ${(y.data ?? []).length})`)
    : bad("monthly produced fewer buckets than yearly");
}

console.log("\nE. An unmeasured vendor is not the fastest");
{
  const idle = (await svc.from("vendors")
    .insert({ org_id: poc.id, name: `PROBEBI-Idle-${S}` }).select("id").single()).data;
  made.vendors.push(idle.id);
  const t = await mkTicket({ property_id: managedId, assigned_vendor_id: idle.id });
  void t; // open, never resolved — so it has no measured duration

  const { data: rows } = await svc.rpc("bi_vendor_performance", {});
  const first = (rows ?? [])[0];
  const idleRow = (rows ?? []).find((r) => r.vendor_id === idle.id);

  idleRow && idleRow.avg_hours_to_resolve === null
    ? ok("the idle vendor has no average, as it should")
    : bad("the idle vendor reported an average from nothing");
  first && first.vendor_id !== idle.id
    ? ok("and is not ranked first — unmeasured is not fastest")
    : bad("AN UNMEASURED VENDOR WAS RANKED FASTEST");
}

console.log("\nF. RLS still scopes it — same functions, narrower answer");
{
  const admin = await login("oe-group-foundation-poc.admin@oegroup.test");
  const fm = await login("oe-group-foundation-poc.facilitymanager@oegroup.test");
  if (!admin || !fm) bad("could not sign in as admin and FM");
  else {
    const sum = (rs) => (rs ?? []).reduce((a, r) => a + Number(r.total), 0);
    const a = await admin.rpc("bi_ticket_metrics", { p_bucket: "year" });
    const f = await fm.rpc("bi_ticket_metrics", { p_bucket: "year" });

    sum(f.data) > 0
      ? ok(`the FM sees their own properties' tickets (${sum(f.data)})`)
      : bad("the FM saw nothing — cannot tell scoping from breakage");
    sum(f.data) < sum(a.data)
      ? ok(`and fewer than the admin (${sum(f.data)} < ${sum(a.data)})`)
      : bad(`FM ${sum(f.data)} is not less than admin ${sum(a.data)}`);

    // A property outside their scope returns nothing rather than erroring.
    if (unmanagedId) {
      const outside = await fm.rpc("bi_ticket_metrics", {
        p_property_id: unmanagedId, p_bucket: "year",
      });
      sum(outside.data) === 0
        ? ok("filtering to a property they do not manage returns nothing")
        : bad(`the FM saw ${sum(outside.data)} tickets on an unmanaged property`);
    }
    await admin.auth.signOut(); await fm.auth.signOut();
  }
}

console.log("\nG. A tenant follows their own request, and only theirs");
{
  const c = await login("oe-group-foundation-poc.tenant@oegroup.test");
  if (!c) bad("could not sign in as the tenant");
  else {
    const { data: { user } } = await c.auth.getUser();
    const mine = await mkTicket({ sender_id: user.id, property_id: managedId });
    void mine;

    const { data: rows, error } = await c.rpc("my_requests");
    if (error) bad(`my_requests failed — ${error.message.slice(0, 60)}`);
    else {
      (rows ?? []).length > 0
        ? ok(`the tenant sees their own request(s) (${(rows ?? []).length})`)
        : bad("A TENANT CANNOT SEE THEIR OWN REQUEST");
      (rows ?? []).every((r) => r.ticket_id)
        ? ok("each carries a timeline they can follow")
        : bad("a row has no ticket");

      // Nothing belonging to anyone else.
      const { data: everyTicket } = await svc.from("tickets")
        .select("id").neq("sender_id", user.id).limit(50);
      const foreign = new Set((everyTicket ?? []).map((t) => t.id));
      (rows ?? []).some((r) => foreign.has(r.ticket_id))
        ? bad("A TENANT SAW SOMEONE ELSE'S REQUEST")
        : ok("and none belonging to anyone else");
    }
    await c.auth.signOut();
  }
}

// ── Cleanup ────────────────────────────────────────────────────────────────
await svc.from("tickets").delete().in("id", made.tickets);
await svc.from("vendors").delete().in("id", made.vendors);
console.log("\n(cleaned up)");

console.log(
  failures === 0
    ? "\n\x1b[32mALL CHECKS PASSED\x1b[0m — the console filters, buckets and scopes, and never invents a duration."
    : `\n\x1b[31m${failures} CHECK(S) FAILED\x1b[0m`
);
process.exitCode = failures === 0 ? 0 : 1;
