import { NextResponse, type NextRequest } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { secretMatches } from "@/lib/webhook-security";

// Telling the administrators about requests nobody has picked up.
//
// Board direction, 28 Aug 2026 (decision 23): the administrator assigns job
// requests still unassigned 24 hours after they were raised — whoever raised
// them, tenant, vendor, landlord, FM/PM or regional manager.
//
// ⚠️ **This job grants nothing.** The administrator's authority to rescue a
// stale request is computed from `tickets.created_at` by the dispatch trigger
// itself (0212), not from anything written here. That is deliberate and it is
// decision 15's rule — *the record decides, never the schedule*: if this route
// never runs, an administrator can still dispatch a request that has been
// sitting, and all that is lost is the nudge. A control that depended on a cron
// having fired would be a control with a scheduler in its trust boundary.
//
// What the job does is notify, once per request. `escalate_stale_unassigned_
// requests()` stamps `tickets.escalated_at` before it sends, so a retry — or two
// overlapping runs — cannot tell the same administrator the same thing twice.
// The row is the record of having been told; the schedule never was.

export const dynamic = "force-dynamic";
export const maxDuration = 60;

function authorised(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  // No secret configured means CLOSED, not open — the same posture as every
  // other job route here.
  if (!secret) return false;
  const header = req.headers.get("authorization") ?? "";
  const bearer = header.startsWith("Bearer ") ? header.slice(7) : null;
  return secretMatches(bearer, secret);
}

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

  const { data, error } = await supabaseAdmin.rpc(
    "escalate_stale_unassigned_requests"
  );

  if (error) {
    console.error("unassigned escalation failed:", error.message);
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }

  const escalated = Number(data ?? 0);
  if (escalated > 0) {
    console.log(`unassigned escalation: flagged ${escalated} request(s) to administrators`);
  }

  return NextResponse.json({ ok: true, escalated });
}
