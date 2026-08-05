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
 * A short-lived link to a private attachment. The storage policy already
 * gates this to the caller's own org, and the row they got the path from was
 * itself gated by the ticket — a signed URL is a convenience for the browser,
 * not the security boundary. Five minutes is enough to open or play it.
 */
export async function getMediaUrl(storagePath: string): Promise<ActionResult<{ url: string }>> {
  const supabase = await createClient();
  const { data, error } = await supabase.storage.from(BUCKET).createSignedUrl(storagePath, 300);
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

  await supabase.storage.from(BUCKET).remove([row.storage_path]);
  revalidatePath(`/dashboard/tickets/${ticketId}`);
  return ok();
}
