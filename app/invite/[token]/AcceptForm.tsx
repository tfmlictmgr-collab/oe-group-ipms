"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Eye, EyeOff, AlertCircle, CheckCircle2 } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ChannelPicker, EMPTY_PREFS, type ChannelPrefs } from "@/components/patterns/channel-picker";
import { redeemInvitation } from "./actions";
import { runAction, describeError } from "@/lib/run-action";

// Two steps in one submit: create the auth account for the invited address, then
// redeem the invitation, which creates the profile in the right org with the
// right role. The role is never sent from here.
export default function AcceptForm({
  token,
  email,
  suggestedName,
}: {
  token: string;
  email: string;
  suggestedName: string | null;
}) {
  const router = useRouter();
  const [fullName, setFullName] = React.useState(suggestedName ?? "");
  const [password, setPassword] = React.useState("");
  const [confirm, setConfirm] = React.useState("");
  const [show, setShow] = React.useState(false);
  const [prefs, setPrefs] = React.useState<ChannelPrefs>(EMPTY_PREFS);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const tooShort = password.length > 0 && password.length < 10;
  const mismatch = confirm.length > 0 && confirm !== password;
  const canSubmit =
    fullName.trim().length >= 2 && password.length >= 10 && !mismatch && !busy;

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const supabase = createClient();

    try {
      // The email is fixed by the invitation — the field is read-only above.
      const { error: signUpError } = await supabase.auth.signUp({ email, password });

      if (signUpError) {
        // An existing account is fine: sign in and redeem with it.
        const { error: signInError } = await supabase.auth.signInWithPassword({
          email,
          password,
        });
        if (signInError) throw new Error(signUpError.message);
      }

      // Some projects require email confirmation before a session exists.
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) {
        throw new Error(
          "Your account was created but needs email confirmation before you can continue. Check your inbox, then open this link again."
        );
      }

      await runAction(redeemInvitation(token, fullName, prefs));
      toast.success("Welcome aboard", { description: "Your account is ready." });
      router.push("/dashboard");
      router.refresh();
    } catch (err) {
      const msg = describeError(err);
      setError(msg);
      toast.error("Could not complete sign-up", { description: msg });
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4" noValidate>
      <div className="space-y-1.5">
        <Label htmlFor="email">Email address</Label>
        <Input id="email" value={email} readOnly disabled className="bg-muted/60" />
        <p className="text-xs text-muted-foreground">
          Fixed by your invitation — it can&apos;t be changed here.
        </p>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="fullName">Your full name</Label>
        <Input
          id="fullName"
          value={fullName}
          onChange={(e) => setFullName(e.target.value)}
          placeholder="e.g. Abdul Owo"
          required
        />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="password">Create a password</Label>
        <div className="relative">
          <Input
            id="password"
            type={show ? "text" : "password"}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="new-password"
            className="pr-11"
            required
          />
          <button
            type="button"
            onClick={() => setShow((v) => !v)}
            aria-label={show ? "Hide password" : "Show password"}
            aria-pressed={show}
            className="absolute inset-y-0 right-0 flex w-11 items-center justify-center rounded-r-md text-muted-foreground transition-colors hover:text-foreground"
          >
            {show ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
          </button>
        </div>
        <p className={tooShort ? "text-xs text-destructive" : "text-xs text-muted-foreground"}>
          At least 10 characters.
        </p>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="confirm">Confirm password</Label>
        <Input
          id="confirm"
          type={show ? "text" : "password"}
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          autoComplete="new-password"
          aria-invalid={mismatch}
          required
        />
        {mismatch && <p className="text-xs text-destructive">Passwords don&apos;t match.</p>}
        {!mismatch && confirm.length > 0 && (
          <p className="flex items-center gap-1 text-xs text-success">
            <CheckCircle2 className="size-3.5" /> Passwords match
          </p>
        )}
      </div>

      <div className="space-y-3 border-t border-border pt-4">
        <ChannelPicker value={prefs} onChange={setPrefs} />
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

      <Button type="submit" variant="brand" size="lg" className="w-full" disabled={!canSubmit}>
        {busy ? "Setting up your account…" : "Accept invitation"}
      </Button>
    </form>
  );
}
