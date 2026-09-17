import { NextRequest, NextResponse } from "next/server";
import crypto from "node:crypto";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { checkRateLimit, clientIp } from "@/lib/rate-limit";

// Resend tells us what actually became of a message.
//
// This endpoint exists because an API 2xx from Resend means "accepted", and the
// portal was reporting that as "emailed to <address>". A bounce arrives minutes
// later and, until now, arrived nowhere.
//
// Signature verification follows Svix, which Resend uses: the signed payload is
// `${svix-id}.${svix-timestamp}.${rawBody}`, HMAC-SHA256 with the base64-decoded
// secret, compared against the base64 signatures in `svix-signature`. Fails
// CLOSED — an unsigned delivery report could otherwise be used to mark a bounced
// invitation as delivered, which is the exact lie this endpoint is here to stop.

export const runtime = "nodejs";

const TOLERANCE_SECONDS = 5 * 60;

const EVENT_STATUS: Record<string, "delivered" | "bounced" | "complained" | "delayed"> = {
  "email.delivered": "delivered",
  "email.bounced": "bounced",
  "email.complained": "complained",
  "email.delivery_delayed": "delayed",
};

export async function POST(request: NextRequest) {
  const gate = await checkRateLimit("resend-webhook-ip", clientIp(request.headers), 120, "1 m");
  if (!gate.allowed) return new NextResponse("OK", { status: 200 });

  const secret = process.env.RESEND_WEBHOOK_SECRET;
  if (!secret) {
    console.warn("Rejected Resend webhook: RESEND_WEBHOOK_SECRET not configured");
    return new NextResponse("Forbidden", { status: 403 });
  }

  const rawBody = await request.text();
  const id = request.headers.get("svix-id");
  const timestamp = request.headers.get("svix-timestamp");
  const signature = request.headers.get("svix-signature");

  if (!id || !timestamp || !signature) {
    return new NextResponse("Forbidden", { status: 403 });
  }

  // Reject stale deliveries: a valid signature is replayable forever without a
  // freshness check.
  const age = Math.abs(Math.floor(Date.now() / 1000) - Number(timestamp));
  if (!Number.isFinite(age) || age > TOLERANCE_SECONDS) {
    console.warn("Rejected Resend webhook: timestamp outside tolerance");
    return new NextResponse("Forbidden", { status: 403 });
  }

  if (!verifySvix(secret, id, timestamp, rawBody, signature)) {
    console.warn("Rejected Resend webhook: invalid signature");
    return new NextResponse("Forbidden", { status: 403 });
  }

  let payload: { type?: string; data?: { email_id?: string; to?: string[] | string } };
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return new NextResponse("Bad Request", { status: 400 });
  }

  const status = EVENT_STATUS[payload.type ?? ""];
  const messageId = payload.data?.email_id;

  // Opens and clicks arrive here too; we do not track them. Nothing to do is a
  // success, not a failure.
  if (!status || !messageId) return new NextResponse("OK", { status: 200 });

  // A delay is not an outcome — the message may still arrive — so it does not
  // set resolved_at, and it must not overwrite an outcome we already have.
  const isFinal = status !== "delayed";

  const { error } = await supabaseAdmin
    .from("email_deliveries")
    .update({
      status,
      detail: payload.type,
      resolved_at: isFinal ? new Date().toISOString() : null,
    })
    .eq("provider", "resend")
    .eq("provider_message_id", messageId)
    // Never move a resolved row back to `delayed`, and never overwrite a bounce
    // with a late `delivered` for a different recipient of the same message.
    .in("status", isFinal ? ["accepted", "delayed"] : ["accepted"]);

  if (error) console.error("could not record delivery outcome:", error.message);

  // Always 200 once the signature is valid: a non-2xx makes Resend retry, and
  // retrying an event we have already understood changes nothing.
  return new NextResponse("OK", { status: 200 });
}

function verifySvix(
  secret: string,
  id: string,
  timestamp: string,
  body: string,
  header: string
): boolean {
  // `whsec_<base64>` — the prefix is not part of the key material.
  const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
  const expected = crypto
    .createHmac("sha256", key)
    .update(`${id}.${timestamp}.${body}`)
    .digest("base64");

  // The header carries space-separated `v1,<sig>` entries — more than one during
  // a secret rotation, so any match is a pass.
  for (const part of header.split(" ")) {
    const [version, value] = part.split(",");
    if (version !== "v1" || !value) continue;
    const a = Buffer.from(expected);
    const b = Buffer.from(value);
    if (a.length === b.length && crypto.timingSafeEqual(a, b)) return true;
  }
  return false;
}
