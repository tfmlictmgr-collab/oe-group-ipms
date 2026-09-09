import { supabaseAdmin } from "./supabase/admin";
import { whatsappSenderForNumber } from "./notify";
import { PROOF_BUCKET, PROOF_MAX_BYTES, PROOF_MIME_TYPES } from "./offline-payments";

// Fetching an attachment somebody sent us.
//
// ⚠️ This did not exist, and `handle-inbound.ts` said so in as many words:
// "nothing here can attach the media itself, since there is no inbound-media
// storage pipeline". A photo or a PDF arrived, `hasMedia` was set to true so the
// reply could mention it, and the file itself was dropped on the floor.
//
// That was tolerable while every inbound attachment was a picture of a leak —
// annoying, not load-bearing. It stopped being tolerable the moment a tenant
// could report a PAYMENT from WhatsApp, because proof is compulsory at the table
// (0281) and a claim with no evidence cannot be created at all. Without this
// file the honest answer on WhatsApp would have been "please use the portal".
//
// ── What is deliberately narrow here ────────────────────────────────────────
//
// This fetches ONE attachment, straight into the `payment-proofs` bucket, and
// enforces the same limits the bucket and the form enforce. It is not a general
// media pipeline and does not pretend to be: work-order photos are a bigger
// question (retention, who may see them, whether they belong on the ticket) and
// inventing a general answer while building a payment feature is how a
// half-considered one gets shipped.

/** What a webhook hands us: enough to fetch the file, and nothing about it. */
export type InboundMedia = {
  channel: "whatsapp" | "telegram";
  /** WhatsApp media id, or Telegram file_id. */
  mediaId: string;
  mimeType?: string | null;
  filename?: string | null;
  /** The number the message arrived ON — WhatsApp only; chooses the credential. */
  toNumber?: string | null;
};

export type StoredProof = {
  path: string;
  filename: string;
  mimeType: string;
  bytes: number;
};

const WHATSAPP_BASE = "https://waba-v2.360dialog.io";

/**
 * Resolves a WhatsApp media id to bytes.
 *
 * Two calls, both authenticated with the credential belonging to the number the
 * message arrived on — never a shared default. `lib/notify.ts` records why at
 * length: TFML and OEA are separate businesses on the BSP with their own API
 * keys, and one shared token cannot answer for both.
 */
async function fetchWhatsAppMedia(
  media: InboundMedia
): Promise<{ bytes: Buffer; mimeType: string } | null> {
  if (!media.toNumber) return null;
  const sender = await whatsappSenderForNumber(media.toNumber);
  if (!sender) return null;

  const lookup = await fetch(`${WHATSAPP_BASE}/${encodeURIComponent(media.mediaId)}`, {
    headers: { "D360-API-KEY": sender.accessToken },
  });
  if (!lookup.ok) {
    console.error(`whatsapp media lookup failed: ${lookup.status}`);
    return null;
  }
  const meta = (await lookup.json()) as { url?: string; mime_type?: string; file_size?: number };
  if (!meta.url) return null;

  // ⚠️ Refused on the DECLARED size before a byte is downloaded. The bucket
  // would refuse it anyway, but only after we had pulled it across the network
  // and into memory on a serverless function.
  if (meta.file_size && meta.file_size > PROOF_MAX_BYTES) {
    throw new OversizeMedia(meta.file_size);
  }

  const file = await fetch(meta.url, { headers: { "D360-API-KEY": sender.accessToken } });
  if (!file.ok) {
    console.error(`whatsapp media download failed: ${file.status}`);
    return null;
  }
  return {
    bytes: Buffer.from(await file.arrayBuffer()),
    mimeType: meta.mime_type ?? media.mimeType ?? "application/octet-stream",
  };
}

/** Telegram: getFile for a path, then download from the file endpoint. */
async function fetchTelegramMedia(
  orgId: string,
  media: InboundMedia
): Promise<{ bytes: Buffer; mimeType: string } | null> {
  const { data } = await supabaseAdmin
    .from("channel_routes")
    .select("outbound_token")
    .eq("org_id", orgId)
    .eq("channel", "telegram")
    .limit(1)
    .maybeSingle();
  const token = data?.outbound_token ?? process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return null;

  const lookup = await fetch(
    `https://api.telegram.org/bot${token}/getFile?file_id=${encodeURIComponent(media.mediaId)}`
  );
  if (!lookup.ok) return null;
  const meta = (await lookup.json()) as {
    ok?: boolean;
    result?: { file_path?: string; file_size?: number };
  };
  if (!meta.ok || !meta.result?.file_path) return null;
  if (meta.result.file_size && meta.result.file_size > PROOF_MAX_BYTES) {
    throw new OversizeMedia(meta.result.file_size);
  }

  const file = await fetch(
    `https://api.telegram.org/file/bot${token}/${meta.result.file_path}`
  );
  if (!file.ok) return null;
  return {
    bytes: Buffer.from(await file.arrayBuffer()),
    mimeType: media.mimeType ?? guessMime(meta.result.file_path),
  };
}

/** Thrown rather than returned, so the caller can say WHY rather than "sorry". */
export class OversizeMedia extends Error {
  constructor(public readonly bytes: number) {
    super(`attachment is ${(bytes / 1024 / 1024).toFixed(1)} MB`);
    this.name = "OversizeMedia";
  }
}

function guessMime(pathOrName: string): string {
  const ext = pathOrName.toLowerCase().split(".").pop() ?? "";
  if (ext === "pdf") return "application/pdf";
  if (ext === "png") return "image/png";
  if (ext === "webp") return "image/webp";
  if (ext === "heic" || ext === "heif") return "image/heic";
  return "image/jpeg";
}

/**
 * Downloads an inbound attachment and stores it as a payment proof.
 *
 * Returns null when the file cannot be fetched at all — a lost credential, an
 * expired media id, a provider hiccup. The caller must treat that as "we could
 * not take your receipt" and say so, never as "there was no receipt": a person
 * who has sent their evidence and is told nothing will assume it worked.
 *
 * ⚠️ The org id is the first path segment, exactly as the storage policy (0281)
 * requires and as `submit_offline_claim_for_sender` re-checks. This writes
 * through the SERVICE ROLE — there is no session behind a webhook — which is
 * precisely why both of those checks exist rather than being trusted to this.
 */
export async function storeInboundProof(
  orgId: string,
  media: InboundMedia
): Promise<StoredProof | null> {
  let fetched: { bytes: Buffer; mimeType: string } | null = null;
  try {
    fetched =
      media.channel === "whatsapp"
        ? await fetchWhatsAppMedia(media)
        : await fetchTelegramMedia(orgId, media);
  } catch (e) {
    if (e instanceof OversizeMedia) throw e;
    console.error("inbound media fetch failed:", e instanceof Error ? e.message : e);
    return null;
  }
  if (!fetched) return null;

  if (fetched.bytes.byteLength > PROOF_MAX_BYTES) {
    throw new OversizeMedia(fetched.bytes.byteLength);
  }

  // The bucket's own allow-list is the boundary; this makes the refusal legible
  // rather than a 400 from storage. A voice note is the common case — somebody
  // saying "I've paid" out loud is not a receipt, and telling them that plainly
  // is more use than accepting it and having the audit desk reject it.
  const mime = (PROOF_MIME_TYPES as readonly string[]).includes(fetched.mimeType)
    ? fetched.mimeType
    : null;
  if (!mime) throw new UnusableMedia(fetched.mimeType);

  const ext =
    mime === "application/pdf" ? "pdf"
    : mime === "image/png" ? "png"
    : mime === "image/webp" ? "webp"
    : mime.includes("hei") ? "heic"
    : "jpg";
  const filename = media.filename?.replace(/[^a-zA-Z0-9._-]/g, "_").slice(-80)
    || `payment-proof.${ext}`;
  const path = `${orgId}/chat-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}/${filename}`;

  const { error } = await supabaseAdmin.storage
    .from(PROOF_BUCKET)
    .upload(path, fetched.bytes, { contentType: mime, upsert: false });
  if (error) {
    console.error("inbound proof upload failed:", error.message);
    return null;
  }

  return { path, filename, mimeType: mime, bytes: fetched.bytes.byteLength };
}

/** A file we can fetch but must not accept as evidence. */
export class UnusableMedia extends Error {
  constructor(public readonly mimeType: string) {
    super(`attachment is ${mimeType}`);
    this.name = "UnusableMedia";
  }
}

/** Removes a stored proof whose claim never got created. */
export async function discardInboundProof(path: string): Promise<void> {
  try {
    await supabaseAdmin.storage.from(PROOF_BUCKET).remove([path]);
  } catch {
    /* an orphaned object is untidy, not harmful — and nothing points at it */
  }
}
