import { createBrowserClient } from "@supabase/ssr";

// Browser client — carries the logged-in user's session, so all queries run
// under RLS as that user (per the B7 matrix). Safe for client components.
export function createClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  );
}
