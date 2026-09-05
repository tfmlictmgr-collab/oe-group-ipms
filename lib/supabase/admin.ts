import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// service_role client — bypasses RLS. Server-side only (webhook handlers,
// scripts); never import this into client components.
//
// ⚠️ `cache: "no-store"` on every request, and it is not optional.
//
// Next.js patches the global `fetch`, and supabase-js uses `fetch`. Without this,
// server-side reads are served from Next's DATA cache — which is invisible at the
// CDN layer, so the response says `x-vercel-cache: MISS` and
// `Cache-Control: no-store` while the *data* inside it is minutes or hours old.
//
// This cost real time to find. The public tenancy page reported "Applications are
// closed" while the same query run directly returned the property — same database,
// correct code, freshly deployed — because the page was reading cached copies of
// both the org row and the RPC result from an earlier moment when it genuinely was
// closed. Every hypothesis about a stale deployment, the wrong database or a
// pinned alias was chasing a cache.
//
// `export const dynamic = "force-dynamic"` does NOT cover this. That makes the
// ROUTE dynamic — about when the page re-renders — not about whether the fetches
// inside it come from the data cache.
//
// A database client must never hand back stale data.
//
// This is deliberately absolute: `{ ...init, cache: "no-store" }` puts `cache`
// AFTER the spread, so it also overrides any `next: { revalidate }` a caller
// might set. There is no per-call escape hatch, and that is the intended
// behaviour rather than an oversight — a caller who genuinely wants a cached
// read should build their own client for it, so the decision is visible where it
// is made instead of hiding in a shared singleton.
//
// ⚠️ BUILT ON FIRST USE, not when this module is imported.
//
// `createClient` throws "supabaseUrl is required" the moment it is called
// without the environment, and calling it at module scope meant merely
// IMPORTING this file did that. Next.js evaluates every route module during
// "Collecting page data", so any environment without the secrets — a Vercel
// Preview build, a CI checkout, a contributor's first clone — failed the build
// outright:
//
//     Error: supabaseUrl is required.
//     > Failed to collect page data for /api/jobs/raise-rent-demands
//
// It surfaced on that route because it was the newest importer, but every
// importer carried the same latent dependency; the route only happened to be
// the one the build reached first. Preview deployments had been failing on it
// for a day while Production kept succeeding, because Production is where the
// variables are set — so the difference looked like Vercel being flaky rather
// than a build that needs runtime credentials.
//
// **A build must not require runtime secrets.** Deferring construction to the
// first property access moves the requirement to request time, where the
// credentials genuinely exist and where a missing one is a real fault worth
// throwing on. The proxy keeps every call site (`supabaseAdmin.from(...)`,
// `.rpc(...)`, `.auth.admin...`) exactly as it was.
let cached: SupabaseClient | null = null;

function adminClient(): SupabaseClient {
  if (cached) return cached;

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceRoleKey) {
    // Named explicitly: "supabaseUrl is required" from inside the vendor library
    // says nothing about which of ours is missing, or where to set it.
    throw new Error(
      "The service-role Supabase client needs NEXT_PUBLIC_SUPABASE_URL and " +
        "SUPABASE_SERVICE_ROLE_KEY. Set both in this environment."
    );
  }

  cached = createClient(url, serviceRoleKey, {
    global: {
      fetch: (input: RequestInfo | URL, init?: RequestInit) =>
        fetch(input, { ...init, cache: "no-store" }),
    },
  });
  return cached;
}

export const supabaseAdmin = new Proxy({} as SupabaseClient, {
  get(_target, property) {
    const client = adminClient();
    const value = Reflect.get(client, property, client);
    // Methods are bound to the real client: `const { from } = supabaseAdmin`
    // and `supabaseAdmin.from(...)` must both work, and an unbound method would
    // lose `this` and fail confusingly at the first call rather than here.
    return typeof value === "function" ? value.bind(client) : value;
  },
});
