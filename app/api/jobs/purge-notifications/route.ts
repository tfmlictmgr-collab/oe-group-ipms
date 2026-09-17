import { NextResponse, type NextRequest } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { secretMatches } from "@/lib/webhook-security";

// Clears READ notifications older than 30 days.
//
// The retention rule is enforced in two places on purpose, and they are not
// duplicates of each other: `my_notifications()` (0145) HIDES old read rows so
// the inbox shows what still matters, and this job DELETES them so the table
// does not grow without bound. Hiding alone would leave the rows forever;
// deleting alone would mean the inbox depended on a job having run.
//
// ⚠️ Unread rows are never touched, at any age. An untreated notification does
// not stop mattering because it got old — that is precisely when it matters
// most, and a housekeeping job that quietly swept away someone's outstanding
// work would be worse than the growth it was written to prevent.

export const dynamic = "force-dynamic";
export const maxDuration = 60;

function authorised(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const header = req.headers.get("authorization") ?? "";
  const bearer = header.startsWith("Bearer ") ? header.slice(7) : null;
  return secretMatches(bearer, secret);
}

export async function GET(req: NextRequest) { return run(req); }
export async function POST(req: NextRequest) { return run(req); }

async function run(req: NextRequest) {
  if (!authorised(req)) {
    return NextResponse.json({ error: "unauthorised" }, { status: 401 });
  }
  const { data, error } = await supabaseAdmin.rpc("purge_old_read_notifications", { p_days: 30 });
  if (error) {
    console.error("notification purge failed:", error.message);
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }
  console.log(`notification purge: ${data ?? 0} read notification(s) older than 30 days removed`);
  return NextResponse.json({ ok: true, purged: data ?? 0 });
}
