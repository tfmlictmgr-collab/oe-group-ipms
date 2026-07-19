import { createClient } from "@supabase/supabase-js";

// service_role client — bypasses RLS. Server-side only (webhook handlers,
// scripts); never import this into client components.
export const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);
