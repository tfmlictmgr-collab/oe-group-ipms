import { NextResponse, type NextRequest } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { secretMatches } from "@/lib/webhook-security";

// The daily rent-demand run.
//
// Rent is billed annually in advance (locked decision 15), so a demand missed is
// a year's rent nobody asked for. Until now `orgs.rent_demand_lead_days` was
// stored, configurable, and read by nothing — demands were raised by clicking
// "Bill rent" on the rent roll, which works right up until the day nobody clicks.
//
// ⚠️ This route decides nothing about money. `leases_needing_rent_demand()` says
// which lease is due and for what period; `raise_rent_charge()` writes the
// charge and snapshots the fee, exactly as it does when a manager clicks the
// button. One writer, one fee path — a second would eventually disagree with the
// first about what a landlord is owed.
//
// ⚠️ Idempotency is a database constraint, not a flag this route sets.
// `rent_charges_one_per_period` is unique on (lease_id, period_start), so a
// retried run, an overlapping run, or a manual raise for the same period is
// refused by Postgres rather than trusted not to happen. Double-billing a tenant
// for a year's rent is not an error anyone should be able to make twice.

export const dynamic = "force-dynamic";
export const maxDuration = 60;

function authorised(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  // No secret configured means closed, not open. A job that bills tenants must
  // never be reachable by anyone who happens to find the URL.
  if (!secret) return false;

  const header = req.headers.get("authorization") ?? "";
  const bearer = header.startsWith("Bearer ") ? header.slice(7) : null;
  // Constant-time, matching the discipline `lib/webhook-security.ts` documents
  // for every other shared secret in this codebase (audit 0804 E1).
  return secretMatches(bearer, secret);
}

// Vercel Cron invokes with GET and an `Authorization: Bearer $CRON_SECRET`
// header. POST is kept so an operator can trigger a run by hand with the same
// credential — the work is identical and idempotent either way.
export async function GET(req: NextRequest) {
  return run(req);
}

export async function POST(req: NextRequest) {
  return run(req);
}

async function run(req: NextRequest) {
  if (!authorised(req)) {
    return NextResponse.json({ error: "unauthorised" }, { status: 401 });
  }

  const { data: orgs, error: orgErr } = await supabaseAdmin
    .from("orgs")
    .select("id, name")
    .is("deleted_at", null);
  if (orgErr) {
    return NextResponse.json({ error: orgErr.message }, { status: 500 });
  }

  let considered = 0;
  let raised = 0;
  let alreadyBilled = 0;
  const problems: string[] = [];

  for (const org of orgs ?? []) {
    const { data: due, error } = await supabaseAdmin.rpc("leases_needing_rent_demand", {
      p_org_id: org.id,
    });
    if (error) {
      problems.push(`${org.name}: ${error.message.slice(0, 70)}`);
      continue;
    }

    for (const lease of (due ?? []) as {
      lease_id: string;
      property_name: string;
      unit_label: string;
      period_start: string;
      period_end: string;
      rent_amount: number;
    }[]) {
      considered++;

      const { error: raiseErr } = await supabaseAdmin.rpc("raise_rent_charge", {
        p_lease_id: lease.lease_id,
        p_period_start: lease.period_start,
        p_period_end: lease.period_end,
        // Due on the day the period begins. The lead time decides when the
        // demand is RAISED, not when it falls due — asking early is a courtesy,
        // moving the due date is a change to the tenancy.
        p_due_date: lease.period_start,
      });

      if (!raiseErr) {
        raised++;
        continue;
      }

      // The unique constraint doing its job: something already billed this
      // period. Expected traffic on a retry, not a failure.
      if (raiseErr.message.includes("rent_charges_one_per_period")) {
        alreadyBilled++;
        continue;
      }

      problems.push(
        `${lease.unit_label} @ ${lease.property_name}: ${raiseErr.message.slice(0, 70)}`
      );
    }
  }

  return NextResponse.json({
    considered,
    raised,
    alreadyBilled,
    problems: problems.slice(0, 10),
  });
}
