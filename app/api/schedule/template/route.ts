import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { tenancyTemplateCsv } from "@/lib/tenancy-import";

/**
 * The tenancy-schedule import template (0265).
 *
 * Generated per request, and it NAMES the properties this caller can import to
 * in its comment rows. A template that lists nothing is how somebody fills in
 * two hundred rows against a building they do not manage and finds out at the
 * preview; the names are already on the page they downloaded it from, so this
 * discloses nothing new.
 */
export async function GET() {
  const supabase = await createClient();

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return new NextResponse("Unauthorized", { status: 401 });

  const { data: canWrite } = await supabase.rpc("has_permission", {
    p_capability: "leases.write",
  });
  if (!canWrite) return new NextResponse("Forbidden", { status: 403 });

  // RLS scopes this to the caller's org; the importer scopes it again to the
  // properties they may actually write to.
  const { data: props } = await supabase
    .from("properties").select("name").is("deleted_at", null).order("name");

  const csv = tenancyTemplateCsv((props ?? []).map((p) => p.name as string));

  return new NextResponse(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="tenancy-schedule-template.csv"`,
      "Cache-Control": "no-store",
    },
  });
}
