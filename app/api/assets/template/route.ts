import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { buildTemplateCsv } from "@/lib/asset-schema";

// Downloads the asset register template. Generated per request so an org's own
// admin-defined custom fields appear as columns — the template always matches
// what the importer will accept.
export async function GET() {
  const supabase = await createClient();

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return new NextResponse("Unauthorized", { status: 401 });

  // RLS scopes this to the caller's org.
  const { data: defs } = await supabase
    .from("asset_field_definitions")
    .select("field_key")
    .eq("active", true)
    .order("sort_order");

  const csv = buildTemplateCsv((defs ?? []).map((d) => d.field_key));

  return new NextResponse(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="asset-register-template.csv"`,
      "Cache-Control": "no-store",
    },
  });
}
