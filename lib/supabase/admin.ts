import { createClient } from "@supabase/supabase-js";

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
export const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  {
    global: {
      fetch: (input: RequestInfo | URL, init?: RequestInit) =>
        fetch(input, { ...init, cache: "no-store" }),
    },
  }
);
