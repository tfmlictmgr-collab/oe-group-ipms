"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { getSessionProfile } from "@/lib/auth";
import { ok, fail, failFromDb, type ActionResult } from "@/lib/action-result";

const BUCKET = "work-order-media";

/**
 * Records an uploaded file against its ticket.
 *
 * The browser uploads the bytes straight to storage (as the logo upload
 * already does — routing a 25 MB video through a server action would buy
 * nothing and cost the request body limit), then calls this to index it.
 *
 * ⚠️ The index row is where the real gate lives. Storage RLS only proves the
 * caller is writing inside their own org's prefix; `ticket_attachments`'
 * insert policy is what proves they can see the ticket and that it is still
 * open. So if this insert is refused, the already-uploaded object is REMOVED
 * — otherwise a refused attachment would leave its file sitting in the bucket
 * with nothing pointing at it and nothing ever cleaning it up.
 */
export async function recordAttachment(input: {
  ticketId: string;
  storagePath: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
}): Promise<ActionResult<{ id: string }>> {
  const session = await getSessionProfile();
  if (!session?.profile) return fail("You are not signed in.");

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("ticket_attachments")
    .insert({
      org_id: session.profile.org_id,
      ticket_id: input.ticketId,
      storage_path: input.storagePath,
      file_name: input.fileName,
      content_type: input.contentType,
      size_bytes: input.sizeBytes,
      uploaded_by: session.user.id,
    })
    .select("id")
    .single();

  if (error) {
    await supabase.storage.from(BUCKET).remove([input.storagePath]);
    // The policy refuses silently rather than explaining itself, and by far the
    // likeliest reason is the one worth naming.
    return fail(
      "That file could not be attached.",
      "The request may already be resolved — evidence is attached while the work is still open."
    );
  }

  revalidatePath(`/dashboard/tickets/${input.ticketId}`);
  return ok({ id: data.id });
}

/**
 * A short-lived link to a private attachment.
 *
 * ⚠️ Takes the ATTACHMENT'S ID, never a caller-supplied storage path (audit
 * 0805-H1/C2). A path string is not something the server can trust just
 * because it looks right — nothing stopped a caller from constructing any
 * `{orgId}/{ticketId}/{file}` path for an org they belong to and asking to
 * sign it, which is a real, low-effort cross-ticket leak: this action used to
 * be the ONLY thing between "authenticated in the org" and "can read any
 * other ticket's photos," because the storage policy of the time didn't check
 * the ticket either. The storage policy is now ticket-scoped too (0107), but
 * this lookup stands on its own regardless — the row is fetched by id under
 * `ticket_attachments_select`, which already answers "can this caller see
 * it," and only ITS OWN storage_path is ever signed. A caller who cannot see
 * the row gets a clean refusal, never a chance to guess a path.
 */
export async function getMediaUrl(attachmentId: string): Promise<ActionResult<{ url: string }>> {
  const supabase = await createClient();

  const { data: row } = await supabase
    .from("ticket_attachments")
    .select("storage_path")
    .eq("id", attachmentId)
    .maybeSingle();
  if (!row) return fail("That file could not be found.");

  const { data, error } = await supabase.storage.from(BUCKET).createSignedUrl(row.storage_path, 300);
  if (error) return failFromDb(error, "open that file");
  if (!data) return fail("Could not open that file.");
  return ok({ url: data.signedUrl });
}

/**
 * Removes an attachment the caller uploaded, while the job is still open.
 *
 * The row goes first, deliberately. Its policy is the narrower of the two, so
 * a refusal there stops the whole operation with the file intact — whereas
 * removing the object first would, on a refused row delete, destroy the
 * evidence while leaving a row that still claims it exists.
 */
export async function removeAttachment(
  attachmentId: string,
  ticketId: string
): Promise<ActionResult> {
  const supabase = await createClient();

  const { data: row } = await supabase
    .from("ticket_attachments")
    .select("storage_path")
    .eq("id", attachmentId)
    .maybeSingle();
  if (!row) return fail("That attachment could not be found.");

  const { data: deleted, error } = await supabase
    .from("ticket_attachments")
    .delete()
    .eq("id", attachmentId)
    .select("id");

  if (error) return failFromDb(error, "remove that attachment");
  if (!deleted?.length) {
    return fail(
      "That attachment cannot be removed.",
      "You can only remove your own upload, and only while the request is still open."
    );
  }

  // The index row is gone either way by this point — that's the state that
  // matters for RLS and for the evidence record. But silently swallowing a
  // failure here (audit 0805-C3) reports success while the file may still be
  // sitting in the bucket, the exact "stranded object" outcome
  // `recordAttachment()`'s own cleanup exists to prevent on the write side.
  const { error: rmErr } = await supabase.storage.from(BUCKET).remove([row.storage_path]);
  if (rmErr) {
    console.error("Attachment row deleted but storage object remains:", row.storage_path, rmErr.message);
  }
  revalidatePath(`/dashboard/tickets/${ticketId}`);
  return ok();
}
