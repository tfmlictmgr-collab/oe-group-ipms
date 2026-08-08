"use client";

import { useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Eye, EyeOff, AlertCircle, CheckCircle2, ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { confirmPasswordReset } from "../actions";

export default function ConfirmResetForm() {
  const params = useSearchParams();
  const token = params.get("token") ?? "";

  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);

    const result = await confirmPasswordReset(token, password);
    setLoading(false);
    if (!result.ok) {
      setError(result.hint ? `${result.message} ${result.hint}` : result.message);
      return;
    }
    setDone(true);
  }

  if (!token) {
    return (
      <div className="space-y-4 text-center">
        <span className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-destructive/10 text-destructive">
          <AlertCircle className="size-6" />
        </span>
        <div className="space-y-1.5">
          <h1 className="display-md">Missing reset link</h1>
          <p className="text-muted-foreground">
            This page needs the link from your email. If you opened it directly, request a fresh one.
          </p>
        </div>
        <Button asChild variant="outline" className="w-full">
          <Link href="/reset-password">
            <ArrowLeft /> Request a new link
          </Link>
        </Button>
      </div>
    );
  }

  if (done) {
    return (
      <div className="space-y-4 text-center">
        <span className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-success/10 text-success">
          <CheckCircle2 className="size-6" />
        </span>
        <div className="space-y-1.5">
          <h1 className="display-md">Password changed</h1>
          <p className="text-muted-foreground">
            Sign in with your new password. This link cannot be used again.
          </p>
        </div>
        <Button asChild variant="brand" size="lg" className="w-full">
          <Link href="/login">Sign in</Link>
        </Button>
      </div>
    );
  }

  return (
    <>
      <div className="mb-6 space-y-1.5">
        <h1 className="display-md">Set a new password</h1>
        <p className="text-muted-foreground">At least 10 characters.</p>
      </div>

      <form onSubmit={handleSubmit} className="space-y-4" noValidate>
        <div className="space-y-1.5">
          <Label htmlFor="password">New password</Label>
          <div className="relative">
            <Input
              id="password"
              type={showPassword ? "text" : "password"}
              required
              minLength={10}
              autoFocus
              autoComplete="new-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••••"
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
          <p role="alert" className="flex items-start gap-2 rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
            <AlertCircle className="mt-0.5 size-4 flex-shrink-0" />
            {error}
          </p>
        )}

        <Button type="submit" variant="brand" size="lg" className="w-full" disabled={loading}>
          {loading ? "Changing password…" : "Change password"}
        </Button>
      </form>
    </>
  );
}
