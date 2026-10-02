import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { applyTrustedOrgHeaders } from "@/lib/org-headers";
import { mfaGate, isMfaGated, MFA_PATH } from "@/lib/mfa-gate";

// Refreshes the auth session on every request, guards /dashboard, and stamps
// the caller's org/brand/role from the SIGNED JWT onto the forwarded request
// headers (stripping any the client sent) — the B1 brand-middleware layer.
export async function updateSession(request: NextRequest) {
  // Start from the incoming headers with the trust headers stripped, so a
  // client-supplied x-org-id/x-delivery-brand/x-user-role can never survive.
  const requestHeaders = new Headers(request.headers);
  applyTrustedOrgHeaders(requestHeaders, {});

  let supabaseResponse = NextResponse.next({ request: { headers: requestHeaders } });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value)
          );
          supabaseResponse = NextResponse.next({ request: { headers: requestHeaders } });
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options)
          );
        },
      },
    }
  );

  const {
    data: { user },
  } = await supabase.auth.getUser();

  // Stamp the trusted claim from the verified token. Rebuild the forwarded
  // response so downstream sees the headers, preserving refreshed auth cookies.
  if (user) {
    applyTrustedOrgHeaders(requestHeaders, {
      orgId: user.app_metadata?.org_id,
      brand: user.app_metadata?.delivery_brand,
      role: user.app_metadata?.role,
    });
    const withHeaders = NextResponse.next({ request: { headers: requestHeaders } });
    supabaseResponse.cookies.getAll().forEach((c) => withHeaders.cookies.set(c));
    supabaseResponse = withHeaders;
  }

  // `/orgs` joins `/dashboard` behind the sign-in. It is the operator launcher
  // and the root now forwards to it, so an unauthenticated visitor reaches it on
  // an ordinary first visit — without this they would hit the page's own
  // redirect rather than a clean bounce to the login screen.
  const path = request.nextUrl.pathname;
  const isProtected = path.startsWith("/dashboard") || path === "/orgs";
  // `/mfa` is behind the sign-in too: it is where the gate below sends people,
  // and a visitor with no session has no factor to set up or answer.
  if ((isProtected || path === MFA_PATH) && !user) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    return NextResponse.redirect(url);
  }

  // 0308. Two-factor sign-in. Enrolled people must have answered the code in
  // this session; everyone else must enrol once their organisation's date has
  // passed. `getAuthenticatorAssuranceLevel()` reads the session token locally
  // and `user.factors` came with `getUser()` above, so an enrolled person costs
  // no extra round trip — only someone NOT enrolled asks for their org's date.
  if (user && isMfaGated(path)) {
    const hasVerifiedFactor = (user.factors ?? []).some(
      (f) => f.factor_type === "totp" && f.status === "verified"
    );
    const { data: aal } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
    let enforcedFrom: string | null = null;
    if (!hasVerifiedFactor) {
      const { data } = await supabase.rpc("my_mfa_enforced_from");
      enforcedFrom = (data as string | null) ?? null;
    }
    const gate = mfaGate({ hasVerifiedFactor, currentLevel: aal?.currentLevel, enforcedFrom });
    if (gate.kind === "verify" || gate.kind === "enroll") {
      const url = request.nextUrl.clone();
      url.pathname = MFA_PATH;
      url.search = "";
      url.searchParams.set("next", path + request.nextUrl.search);
      const redirect = NextResponse.redirect(url);
      // Keep any refreshed auth cookies, or the redirect logs them out.
      supabaseResponse.cookies.getAll().forEach((c) => redirect.cookies.set(c));
      return redirect;
    }
  }

  return supabaseResponse;
}
