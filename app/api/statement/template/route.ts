import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { buildStatementTemplateCsv } from "@/lib/statement-import";

// The canonical statement shape. Bank exports differ, so the importer accepts
// either a signed `amount` or separate debit/credit columns — the template
// shows both so whichever the bank produces can be mapped onto it.
export async function GET() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return new NextResponse("Unauthorized", { status: 401 });

  return new NextResponse(buildStatementTemplateCsv(), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": 'attachment; filename="bank-statement-template.csv"',
      "Cache-Control": "no-store",
    },
  });
}
