"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { Eye, EyeOff, ShieldCheck, Building2, Banknote, AlertCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);

    const supabase = createClient();
    const { error } = await supabase.auth.signInWithPassword({ email, password });

    if (error) {
      setError(error.message);
      setLoading(false);
      return;
    }

    router.push("/dashboard");
    router.refresh();
  }

  return (
    <main className="flex min-h-screen">
      {/* Brand panel — desktop only. Sets the client-facing tone before sign-in. */}
      <section className="relative hidden w-1/2 flex-col justify-between overflow-hidden bg-sidebar p-10 lg:flex xl:w-[55%]">
        <div className="bg-grid absolute inset-0 opacity-40" aria-hidden />
        <div
          className="absolute -left-24 -top-24 h-96 w-96 rounded-full blur-3xl"
          style={{ background: "var(--brand)", opacity: 0.25 }}
          aria-hidden
        />

        <div className="relative flex items-center gap-3">
          <span
            className="flex h-10 w-10 items-center justify-center rounded-lg text-sm font-bold"
            style={{ background: "var(--brand)", color: "var(--brand-fg)" }}
          >
            OE
          </span>
          <span className="text-sm font-semibold text-white">OE Group</span>
        </div>

        <div className="relative max-w-md space-y-6">
          <h2 className="text-balance text-3xl font-semibold leading-tight text-white">
            Facilities and property management, unified.
          </h2>
          <p className="text-sm leading-relaxed text-sidebar-foreground">
            One auditable workspace for requests, service charges, vendor
            performance and payments — across TFML and OEA.
          </p>
          <ul className="space-y-3">
            {[
              { icon: Building2, text: "Request intake from WhatsApp, Telegram and the portal" },
              { icon: Banknote, text: "Gated vendor payments with a segregated client-funds ledger" },
              { icon: ShieldCheck, text: "Role-scoped access with an immutable audit trail" },
            ].map(({ icon: Icon, text }) => (
              <li key={text} className="flex items-start gap-3 text-sm text-sidebar-foreground">
                <span
                  className="mt-0.5 flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-md"
                  style={{
                    background: "color-mix(in srgb, var(--brand) 30%, transparent)",
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

        <p className="relative text-xs text-sidebar-muted">
          © {new Date().getFullYear()} OE Group · TFML &amp; Ora Egbunike &amp; Associates
        </p>
      </section>

      {/* Sign-in panel */}
      <section className="flex w-full flex-col justify-center px-5 py-10 sm:px-10 lg:w-1/2 xl:w-[45%]">
        <div className="mx-auto w-full max-w-sm">
          {/* Compact brand for mobile, where the left panel is hidden. */}
          <div className="mb-8 flex items-center gap-3 lg:hidden">
            <span
              className="flex h-10 w-10 items-center justify-center rounded-lg text-sm font-bold"
              style={{ background: "var(--brand)", color: "var(--brand-fg)" }}
            >
              OE
            </span>
            <span className="font-semibold">OE Group Portal</span>
          </div>

          <div className="mb-6 space-y-1.5">
            <h1 className="text-2xl font-semibold tracking-tight">Welcome back</h1>
            <p className="text-sm text-muted-foreground">
              Sign in to continue to your portal.
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
        </div>
      </section>
    </main>
  );
}
