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
  // No error state on purpose — the action always succeeds from the caller's
  // side (see actions.ts): whether an account exists is never observable
  // here, the same anti-enumeration rule the sign-in form itself follows.
  const [sent, setSent] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    await requestPasswordReset(email, window.location.origin);
    setLoading(false);
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
