import { NextResponse, type NextRequest } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { secretMatches } from "@/lib/webhook-security";

// Carrying a vendor's registration documents across a brand boundary.
//
// `accept_vendor_introduction()` (0165) copies the METADATA of an accepted
// introduction — the vendor, the pack, and a `vendor_documents` row per
// document — but it cannot copy the files. `storage.objects` indexes bytes the
// database does not itself hold, so a copy is a storage API call, and this is
// the job that makes it.
//
// ⚠️ Why this is a job and not one more line inside that function. The
// alternative was to let the receiving org read the sending org's storage
// prefix directly, which would have meant widening the bucket policy that keeps
// one brand's evidence out of the other's reach — permanently, for every
// request, to serve one transfer. B1 is not a thing to trade for convenience.
// So the boundary stays exactly where 0164 put it, and the ONE actor
// legitimately holding paths in two organisations is the service role, here,
// with no user role able to call it (`pending_vendor_document_copies()` is
// granted to service_role alone, asserted by verify-vendor-self-service E18).
//
// ── Order of operations, and why this one ─────────────────────────────────
//
// Copy the file, THEN mark the row. The reverse — mark, then copy — would on a
// crash between the two leave a document the reviewer is told is present and
// which is not there, and they would approve a registration against evidence
// that does not exist. This way a crash leaves `copied_at` null, the pack still
// reads as incomplete, and the next run finishes the job. The failure mode is
// "not yet", which is true, rather than "here it is", which is not.
//
// Idempotent by construction, from both ends: the queue selects on
// `copied_at is null`, and a destination that already exists is treated as done
// rather than as an error — that is precisely the crash-between-the-two case,
// and the file it finds is the one this job put there on the previous run.

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const BUCKET = "vendor-documents";

// Bounded, because a run that cannot finish is a run that times out and copies
// nothing. Whatever is left is still queued and the next run takes it — the
// queue is the state, the schedule is not.
const BATCH = 50;

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

/**
 * A destination that already holds an object is this job finishing what a
 * previous run started, not a conflict. Storage reports it as 409 / "already
 * exists" / "Duplicate" depending on the layer, so all three are matched.
 */
function alreadyThere(message: string, status?: number): boolean {
  if (status === 409) return true;
  return /already exists|duplicate|resource already/i.test(message);
}

async function run(req: NextRequest) {
  if (!authorised(req)) {
    return NextResponse.json({ error: "unauthorised" }, { status: 401 });
  }

  const { data: queue, error: queueErr } = await supabaseAdmin.rpc(
    "pending_vendor_document_copies"
  );

  if (queueErr) {
    console.error("vendor document transfer: queue unreadable:", queueErr.message);
    return NextResponse.json({ ok: false, error: queueErr.message }, { status: 500 });
  }

  const pending = (queue ?? []) as Array<{
    document_id: string;
    source_path: string;
    target_path: string;
  }>;

  if (pending.length === 0) {
    return NextResponse.json({ ok: true, copied: 0, remaining: 0 });
  }

  const batch = pending.slice(0, BATCH);
  let copied = 0;
  const failures: Array<{ document_id: string; error: string }> = [];

  for (const doc of batch) {
    const { error: copyErr } = await supabaseAdmin.storage
      .from(BUCKET)
      .copy(doc.source_path, doc.target_path);

    if (
      copyErr &&
      !alreadyThere(
        copyErr.message,
        (copyErr as { statusCode?: number }).statusCode
      )
    ) {
      // One document failing must not strand the other forty-nine. It stays
      // queued and the next run retries it.
      failures.push({ document_id: doc.document_id, error: copyErr.message });
      continue;
    }

    const { error: markErr } = await supabaseAdmin.rpc("mark_vendor_document_copied", {
      p_document_id: doc.document_id,
    });

    if (markErr) {
      // The file IS across; only the bookkeeping failed. Safe to leave — the
      // next run re-copies onto an existing destination, which is the
      // already-there case above, and marks it then.
      failures.push({ document_id: doc.document_id, error: markErr.message });
      continue;
    }

    copied += 1;
  }

  const remaining = pending.length - copied;

  if (failures.length > 0) {
    // Loud. A registration whose evidence never arrives is a reviewer waiting
    // for something nobody is going to bring them.
    console.error(
      `vendor document transfer: ${failures.length} of ${batch.length} failed —`,
      failures.map((f) => `${f.document_id}: ${f.error}`).join("; ")
    );
  }
  console.log(
    `vendor document transfer: copied ${copied}, ${remaining} still queued`
  );

  return NextResponse.json({
    ok: failures.length === 0,
    copied,
    remaining,
    failures: failures.length > 0 ? failures : undefined,
  });
}
