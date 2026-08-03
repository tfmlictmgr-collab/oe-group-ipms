"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { Eye, EyeOff, ShieldCheck, Building2, Banknote, AlertCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export type SignInBrand = {
  /** What the portal calls itself — "OEA Portal", "TFML Portal". */
  portalName: string;
  /** The monogram, when there is no logo image. */
  logoText: string;
  logoUrl: string | null;
  /** Hex, already validated by the caller. */
  primary: string;
  headline: string;
  tagline: string;
  /**
   * Whose name goes in the copyright line. The organisation's own legal name on
   * its own door — never a list of the platform's clients (B1).
   */
  owner?: string;
};

/**
 * Auth failures, said in words rather than in the provider's.
 *
 * "Invalid login credentials" is a database's sentence, not a person's, and the
 * rarer ones ("AuthApiError: request rate limit reached") read as a broken site
 * to someone who has simply mistyped a password twice. The wording deliberately
 * does NOT distinguish an unknown email from a wrong password — telling a
 * stranger which addresses have accounts is how you hand over a user list.
 */
/**
 * The one refusal used for every "you are not getting in" case.
 *
 * ⚠️ Shared deliberately, and it must stay shared. A wrong password and a valid
 * password belonging to ANOTHER organisation return this exact string, so the
 * two are indistinguishable to whoever is typing.
 *
 * The first version of the cross-org refusal read "That account isn't set up for
 * this portal" — which quietly confirmed the account exists and belongs
 * somewhere else on the platform. Someone testing a stolen credential against a
 * client's door would have learned their victim is a customer here, and that two
 * portals share a system. Both are things B1 exists to keep private.
 */
const REFUSED = "That email and password don't match. Check both and try again.";

function signInMessage(raw: string): string {
  const m = raw.toLowerCase();
  if (m.includes("invalid login") || m.includes("invalid credentials")) {
    return REFUSED;
  }
  if (m.includes("email not confirmed")) {
    return "This account hasn't been activated yet. Use the link in your invitation email.";
  }
  if (m.includes("rate limit") || m.includes("too many")) {
    return "Too many attempts. Wait a minute and try again.";
  }
  if (m.includes("network") || m.includes("fetch")) {
    return "Couldn't reach the server. Check your connection and try again.";
  }
  return "Something went wrong signing you in. Try again, and tell your administrator if it keeps happening.";
}

const DEFAULT_POINTS = [
  { icon: Building2, text: "Request intake from WhatsApp, Telegram and the portal" },
  { icon: Banknote, text: "Gated vendor payments with a segregated client-funds ledger" },
  { icon: ShieldCheck, text: "Role-scoped access with an immutable audit trail" },
];

/**
 * The sign-in surface, for both the OE Group front door and an organisation's
 * own `/o/<slug>` address.
 *
 * The branding is passed in rather than read here, because on an org's own page
 * it is resolved server-side from the slug by `org_public_branding` — a function
 * that returns one row and cannot be made to list. This component never learns
 * that any other organisation exists.
 *
 * ⚠️ Except that until Day 8.9 it announced one. The footer was hardcoded
 * "© OE Group · TFML & Ora Egbunike & Associates" on EVERY door, so a TFML
 * employee signing in at their own address read the name of the other brand —
 * the precise thing B1 forbids ("must never see the other brand's data **or
 * existence**"), sitting three lines under a comment claiming it could not
 * happen. The isolation was correct everywhere it was enforced and wrong in the
 * one place nobody enforces anything: a piece of static copy.
 *
 * `owner` now says whose door this is, and nothing else appears.
 */
export default function SignInPanel({
  brand,
  redirectTo = "/dashboard",
  backHref,
  expectedOrgId,
  notice,
}: {
  brand: SignInBrand;
  redirectTo?: string;
  backHref?: string;
  /**
   * The organisation whose door this is. When set, an account belonging to any
   * OTHER organisation is signed straight back out rather than admitted.
   *
   * ⚠️ Why this was missing. Auth is global to the platform — Supabase verifies
   * a password without caring which hostname the form was served from — so
   * `oeaportal.com` accepted a TFML password, then landed that person on their
   * OWN dashboard under OEA's domain. No data crossed: RLS scopes every row to
   * the real signed-in identity, not to the door used. But "your data is safe"
   * is not the same as "this behaved correctly", and a client watching a rival
   * brand's login work on their own address has no way to know the difference.
   *
   * The design note on hostnames says a host is "branding and routing, never
   * authority" — written to keep a forged Host header from granting anything.
   * It was never meant to imply the login gate should ignore the host entirely.
   */
  expectedOrgId?: string;
  /** Shown before any attempt — e.g. after being bounced from a wrong-org session. */
  notice?: string;
}) {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(notice ?? null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);

    const supabase = createClient();
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });

    if (error) {
      setError(signInMessage(error.message));
      setLoading(false);
      return;
    }

    // ── The door checks who you are, not just that you are someone ──────────
    //
    // One extra read, on the sign-in submit only — never on a page load. The
    // caller's own `users` row is readable by `users_select` (`id = auth.uid()`),
    // so this needs no elevated access and no new policy.
    //
    // On a mismatch the session is ended immediately. Leaving it alive and only
    // redirecting would mean a valid cross-org session existed, however briefly,
    // and "briefly" is not a security property anyone can verify later.
    if (expectedOrgId && data.user) {
      const { data: profile } = await supabase
        .from("users")
        .select("org_id")
        .eq("id", data.user.id)
        .maybeSingle();

      if (!profile || profile.org_id !== expectedOrgId) {
        await supabase.auth.signOut();
        // The SAME string a wrong password returns. Anything more specific —
        // even something as mild as "not set up for this portal" — confirms the
        // account exists and belongs to another organisation on this platform.
        setError(REFUSED);
        setLoading(false);
        return;
      }
    }

    router.push(redirectTo);
    router.refresh();
  }

  const mark = brand.logoUrl ? (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={brand.logoUrl} alt="" className="h-10 w-10 rounded-lg object-contain" />
  ) : (
    <span
      className="flex h-10 w-10 items-center justify-center rounded-lg text-sm font-bold"
      style={{ background: brand.primary, color: "#fff" }}
    >
      {brand.logoText}
    </span>
  );

  return (
    <main className="flex min-h-screen" style={{ ["--brand" as string]: brand.primary }}>
      {/* Brand panel — desktop only. Sets the client-facing tone before sign-in. */}
      <section className="relative hidden w-1/2 flex-col justify-between overflow-hidden bg-sidebar p-10 lg:flex xl:w-[55%]">
        <div className="bg-grid absolute inset-0 opacity-40" aria-hidden />
        <div
          className="absolute -left-24 -top-24 h-96 w-96 rounded-full blur-3xl"
          style={{ background: brand.primary, opacity: 0.25 }}
          aria-hidden
        />

        <div className="relative flex items-center gap-3">
          {mark}
          <span className="text-sm font-semibold text-white">{brand.portalName}</span>
        </div>

        <div className="animate-rise relative max-w-md space-y-6">
          <h2 className="display-lg text-balance text-white">
            {brand.headline}
          </h2>
          <p className="text-pretty leading-relaxed text-sidebar-foreground">{brand.tagline}</p>
          <ul className="stagger space-y-3">
            {DEFAULT_POINTS.map(({ icon: Icon, text }) => (
              <li key={text} className="flex items-start gap-3 text-sm text-sidebar-foreground">
                <span
                  className="mt-0.5 flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-md"
                  style={{
                    background: `color-mix(in srgb, ${brand.primary} 30%, transparent)`,
                    color: "#fff",
                  }}
                >
                  <Icon className="size-3.5" />
                </span>
                {text}
              </li>
            ))}
          </ul>
        </div>

        {/* Only ever the organisation whose door this is. */}
        <p className="relative text-xs text-sidebar-muted">
          © {new Date().getFullYear()} {brand.owner ?? brand.portalName}
        </p>
      </section>

      {/* Sign-in panel */}
      <section className="bg-brand-wash flex w-full flex-col justify-center px-5 py-10 sm:px-10 lg:w-1/2 xl:w-[45%]">
        <div className="animate-rise mx-auto w-full max-w-sm">
          {/* Compact brand for mobile, where the left panel is hidden. */}
          <div className="mb-8 flex items-center gap-3 lg:hidden">
            {mark}
            <span className="font-semibold tracking-tight">{brand.portalName}</span>
          </div>

          <div className="mb-6 space-y-1.5">
            <h1 className="display-md">Welcome back</h1>
            <p className="text-muted-foreground">
              Sign in to continue to {brand.portalName}.
            </p>
          </div>

          <form onSubmit={handleSubmit} className="space-y-4" noValidate>
            <div className="space-y-1.5">
              <Label htmlFor="email">Email address</Label>
              <Input
                id="email"
                type="email"
                required
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="password">Password</Label>
              <div className="relative">
                <Input
                  id="password"
                  type={showPassword ? "text" : "password"}
                  required
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="••••••••"
                  className="pr-11"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((v) => !v)}
                  aria-label={showPassword ? "Hide password" : "Show password"}
                  aria-pressed={showPassword}
                  className="absolute inset-y-0 right-0 flex w-11 items-center justify-center rounded-r-md text-muted-foreground transition-colors hover:text-foreground"
                >
                  {showPassword ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                </button>
              </div>
            </div>

            {error && (
              <p
                role="alert"
                className="flex items-start gap-2 rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive"
              >
                <AlertCircle className="mt-0.5 size-4 flex-shrink-0" />
                {error}
              </p>
            )}

            <Button type="submit" variant="brand" size="lg" className="w-full" disabled={loading}>
              {loading ? "Signing in…" : "Sign in"}
            </Button>
          </form>

          <p className="mt-6 text-center text-xs text-muted-foreground">
            Access is provisioned by your administrator. Contact them if you need an account.
          </p>

          {backHref && (
            <p className="mt-3 text-center text-xs">
              <a href={backHref} className="text-muted-foreground underline hover:text-foreground">
                Not your organisation?
              </a>
            </p>
          )}
        </div>
      </section>
    </main>
  );
}
