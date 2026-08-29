import { NextResponse } from "next/server";
import { ZipArchive } from "archiver";
import { createClient } from "@/lib/supabase/server";
import { getSessionProfile } from "@/lib/auth";

// Every document on ONE applicant or vendor, zipped — for the reviewer who
// needs the whole pack in hand (an external check, an audit request) rather
// than one document at a time. The per-document "view"/"download" buttons
// next to each attachment (AttachmentList, vendor ReviewPanel) are unchanged
// and stay the everyday path; this is the bulk one.
//
// Same gate as `/api/records/export` (0223): the platform operator always
// has this, a client org's own admin only once the operator turns
// `records.export` on for that org.
//
// Files are read through the CALLER's own session, not the service role —
// the storage policies that already scope `application-documents` and
// `vendor-documents` to the caller's own org are the boundary; this route
// adds nothing to what those policies already allow one document at a time,
// it only bundles them.
export const runtime = "nodejs";

type Kind = "tenant" | "vendor";

export async function GET(req: Request) {
  const session = await getSessionProfile();
  if (!session?.profile || !session.org) {
    return new NextResponse("Sign in required", { status: 401 });
  }
  const { profile, org } = session;
  if (profile.role !== "admin") {
    return new NextResponse("Administrator access required", { status: 403 });
  }

  const supabase = await createClient();
  const isOperator = Boolean(org.is_platform_operator);
  if (!isOperator) {
    const { data: canExport } = await supabase.rpc("has_permission", {
      p_capability: "records.export",
    });
    if (!canExport) {
      return new NextResponse(
        "Document download isn't turned on for your organisation yet. Ask your OE Group contact to enable it.",
        { status: 403 }
      );
    }
  }

  const { searchParams } = new URL(req.url);
  const kind = searchParams.get("type") as Kind | null;
  const id = searchParams.get("id");
  if (!id || (kind !== "tenant" && kind !== "vendor")) {
    return new NextResponse("Unknown request.", { status: 400 });
  }

  let bucket: string;
  let files: { path: string; name: string }[];
  let subjectName: string;

  if (kind === "tenant") {
    bucket = "application-documents";
    const { data: app } = await supabase
      .from("application_overview")
      .select("applicant_name")
      .eq("id", id)
      .maybeSingle();
    if (!app) return new NextResponse("That application could not be found.", { status: 404 });
    subjectName = app.applicant_name ?? "applicant";
    const { data: attachments } = await supabase
      .from("application_attachments")
      .select("storage_path, file_name")
      .eq("application_id", id);
    files = (attachments ?? []).map((a) => ({ path: a.storage_path, name: a.file_name }));
  } else {
    bucket = "vendor-documents";
    const { data: vendor } = await supabase
      .from("vendors").select("name").eq("id", id).maybeSingle();
    if (!vendor) return new NextResponse("That vendor could not be found.", { status: 404 });
    subjectName = vendor.name;
    const { data: docs } = await supabase
      .from("vendor_documents")
      .select("storage_path, file_name, doc_type")
      .eq("vendor_id", id)
      .is("superseded_at", null);
    files = (docs ?? []).map((d) => ({
      path: d.storage_path, name: d.file_name ?? `${d.doc_type}.pdf`,
    }));
  }

  if (files.length === 0) {
    return new NextResponse("There are no documents to download for this record.", { status: 404 });
  }

  const archive = new ZipArchive({ zlib: { level: 9 } });
  const chunks: Buffer[] = [];
  archive.on("data", (c: Buffer) => chunks.push(c));
  const done = new Promise<void>((resolve, reject) => {
    archive.on("end", resolve);
    archive.on("error", reject);
  });

  // Same-name collisions (two documents both called "id-card.pdf") are real —
  // an index prefix keeps every file in the zip, rather than one silently
  // overwriting another when it lands on disk.
  const seen = new Set<string>();
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    const { data, error } = await supabase.storage.from(bucket).download(f.path);
    if (error || !data) continue; // one unreadable file does not fail the whole pack
    let name = f.name || `document-${i + 1}`;
    if (seen.has(name)) name = `${i + 1}-${name}`;
    seen.add(name);
    archive.append(Buffer.from(await data.arrayBuffer()), { name });
  }
  await archive.finalize();
  await done;

  const niceName = `${subjectName} - documents.zip`.replace(/[/\\?%*:|"<>]/g, "-");
  const asciiName = niceName.replace(/[^\x20-\x7E]/g, "").trim() || "documents.zip";

  return new NextResponse(Buffer.concat(chunks) as unknown as BodyInit, {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition":
        `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(niceName)}`,
      "Cache-Control": "private, no-store",
    },
  });
}
