"use client";

import { useState } from "react";
import Link from "next/link";
import { Mail, ArrowLeft, CheckCircle2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { requestPasswordReset } from "./actions";

export default function RequestResetForm() {
  const [email, setEmail] = useState("");
  const [loading, setLoading] = useState(false);
  const [sent, setSent] = useState(false);
  // ⚠️ There is exactly ONE way this action reports a failure, and it is not
  // "no such account". Whether an account exists is never observable here —
  // actions.ts returns ok() for sent, for unknown, for stranded-shell and for
  // rate-limited alike, the same anti-enumeration rule the sign-in form
  // follows, and that silence must stay.
  //
  // But it also returns fail("Enter a valid email address.") for a malformed
  // address, and this form carries `noValidate`, so the browser does NOT catch
  // that first — the string reaches the action, comes back as a failure, and
  // (until now) was discarded, showing "Check your email" for an address no
  // email could ever be sent to. Nothing leaks by saying so: the input is
  // wrong on its face, independent of who has an account.
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    const result = await requestPasswordReset(email, window.location.origin);
    setLoading(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    setSent(true);
  }

  if (sent) {
    return (
      <div className="space-y-4 text-center">
        <span className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-success/10 text-success">
          <CheckCircle2 className="size-6" />
        </span>
        <div className="space-y-1.5">
          <h1 className="display-md">Check your email</h1>
          <p className="text-muted-foreground">
            If an account exists for <strong>{email}</strong>, a reset link is on its way.
            It expires in an hour and works once.
          </p>
        </div>
        <Button asChild variant="outline" className="w-full">
          <Link href="/login">
            <ArrowLeft /> Back to sign in
          </Link>
        </Button>
      </div>
    );
  }

  return (
    <>
      <div className="mb-6 space-y-1.5">
        <h1 className="display-md">Reset your password</h1>
        <p className="text-muted-foreground">
          Enter the email on your account and we&apos;ll send a link to set a new password.
        </p>
      </div>

      <form onSubmit={handleSubmit} className="space-y-4" noValidate>
        <div className="space-y-1.5">
          <Label htmlFor="email">Email address</Label>
          <div className="relative">
            <Mail className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              id="email"
              type="email"
              required
              autoFocus
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              className="pl-9"
            />
          </div>
        </div>

        {error && (
          <p role="alert" className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {error}
          </p>
        )}

        <Button type="submit" variant="brand" size="lg" className="w-full" disabled={loading}>
          {loading ? "Sending…" : "Send reset link"}
        </Button>
      </form>

      <p className="mt-6 text-center text-xs">
        <Link href="/login" className="text-muted-foreground underline hover:text-foreground">
          Back to sign in
        </Link>
      </p>
    </>
  );
}
