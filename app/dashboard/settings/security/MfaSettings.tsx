"use client";

import * as React from "react";
import { ShieldCheck, ShieldOff, KeyRound, AlertCircle, Copy, Check } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { generateMyBackupCodes, clearMyBackupCodes, myBackupCodeStatus } from "@/lib/mfa";

type Status = "loading" | "off" | "enrolling" | "backup-codes" | "on";

export default function MfaSettings() {
  const supabase = createClient();
  const [status, setStatus] = React.useState<Status>("loading");
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  // Enrollment in progress
  const [factorId, setFactorId] = React.useState<string | null>(null);
  const [qrCode, setQrCode] = React.useState<string | null>(null);
  const [secret, setSecret] = React.useState<string | null>(null);
  const [code, setCode] = React.useState("");

  // Backup codes, shown exactly once
  const [freshCodes, setFreshCodes] = React.useState<string[]>([]);
  const [copied, setCopied] = React.useState(false);
  const [remaining, setRemaining] = React.useState<{ total: number; remaining: number } | null>(null);

  const refresh = React.useCallback(async () => {
    const { data } = await supabase.auth.mfa.listFactors();
    const verified = (data?.totp ?? []).find((f) => f.status === "verified");
    if (verified) {
      setStatus("on");
      setRemaining(await myBackupCodeStatus());
    } else {
      setStatus("off");
    }
  }, [supabase]);

  React.useEffect(() => {
    refresh();
  }, [refresh]);

  async function startEnroll() {
    setError(null);
    setBusy(true);
    const { data, error: enrollErr } = await supabase.auth.mfa.enroll({ factorType: "totp" });
    setBusy(false);
    if (enrollErr || !data) {
      setError(enrollErr?.message ?? "Could not start enrollment.");
      return;
    }
    setFactorId(data.id);
    setQrCode(data.totp.qr_code);
    setSecret(data.totp.secret);
    setStatus("enrolling");
  }

  async function cancelEnroll() {
    if (factorId) await supabase.auth.mfa.unenroll({ factorId });
    setFactorId(null);
    setQrCode(null);
    setSecret(null);
    setCode("");
    setStatus("off");
  }

  async function verifyEnroll(e: React.FormEvent) {
    e.preventDefault();
    if (!factorId) return;
    setError(null);
    setBusy(true);

    const { data: challenge, error: challengeErr } = await supabase.auth.mfa.challenge({ factorId });
    if (challengeErr || !challenge) {
      setBusy(false);
      setError(challengeErr?.message ?? "Could not verify that code.");
      return;
    }
    const { error: verifyErr } = await supabase.auth.mfa.verify({
      factorId,
      challengeId: challenge.id,
      code: code.trim(),
    });
    if (verifyErr) {
      setBusy(false);
      setError("That code didn't match. Check your authenticator app and try again.");
      return;
    }

    // Enrolled. Now the one-time backup codes.
    const result = await generateMyBackupCodes();
    setBusy(false);
    if (!result.ok) {
      setError(result.message);
      setStatus("on"); // MFA is on regardless; codes can be generated again below
      return;
    }
    setFreshCodes(result.data);
    setStatus("backup-codes");
  }

  function finishBackupCodes() {
    setFreshCodes([]);
    setCopied(false);
    refresh();
  }

  async function regenerateCodes() {
    setError(null);
    setBusy(true);
    const result = await generateMyBackupCodes();
    setBusy(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    setFreshCodes(result.data);
    setStatus("backup-codes");
  }

  async function disable() {
    if (!confirm("Turn off two-factor authentication for your account? You can re-enable it any time.")) return;
    setBusy(true);
    const { data } = await supabase.auth.mfa.listFactors();
    for (const f of data?.totp ?? []) {
      await supabase.auth.mfa.unenroll({ factorId: f.id });
    }
    await clearMyBackupCodes();
    setBusy(false);
    refresh();
  }

  function copyAll() {
    navigator.clipboard.writeText(freshCodes.join("\n")).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  if (status === "loading") {
    return <p className="text-sm text-muted-foreground">Checking your two-factor status…</p>;
  }

  if (status === "backup-codes") {
    return (
      <div className="space-y-4">
        <p className="flex items-start gap-2 rounded-md bg-warning/10 px-3 py-2 text-sm">
          <AlertCircle className="mt-0.5 size-4 flex-shrink-0 text-warning" />
          Save these somewhere safe — this is the only time they&apos;re shown. Each works once, to
          get back in if you lose your authenticator.
        </p>
        <div className="grid grid-cols-2 gap-2 rounded-md border border-border bg-muted/40 p-4 font-mono text-sm">
          {freshCodes.map((c) => (
            <span key={c}>{c}</span>
          ))}
        </div>
        <div className="flex gap-2">
          <Button type="button" variant="outline" onClick={copyAll}>
            {copied ? <Check /> : <Copy />} {copied ? "Copied" : "Copy all"}
          </Button>
          <Button type="button" variant="brand" onClick={finishBackupCodes}>
            I&apos;ve saved these
          </Button>
        </div>
      </div>
    );
  }

  if (status === "enrolling") {
    return (
      <form onSubmit={verifyEnroll} className="space-y-4">
        <p className="text-sm text-muted-foreground">
          Scan this with your authenticator app (Google Authenticator, Authy, 1Password, …), then
          enter the 6-digit code it shows.
        </p>
        {qrCode && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={qrCode} alt="Scan with your authenticator app" className="h-40 w-40 rounded-md border border-border bg-white p-2" />
        )}
        {secret && (
          <p className="text-xs text-muted-foreground">
            Can&apos;t scan? Enter this key manually: <code className="rounded bg-muted px-1.5 py-0.5">{secret}</code>
          </p>
        )}
        <div className="space-y-1.5">
          <Label htmlFor="mfa-code">6-digit code</Label>
          <Input
            id="mfa-code"
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
            placeholder="123456"
            autoFocus
          />
        </div>
        {error && (
          <p role="alert" className="flex items-start gap-2 rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
            <AlertCircle className="mt-0.5 size-4 flex-shrink-0" /> {error}
          </p>
        )}
        <div className="flex gap-2">
          <Button type="button" variant="ghost" onClick={cancelEnroll} disabled={busy}>
            Cancel
          </Button>
          <Button type="submit" variant="brand" disabled={busy || code.length !== 6}>
            {busy ? "Verifying…" : "Verify and enable"}
          </Button>
        </div>
      </form>
    );
  }

  if (status === "on") {
    return (
      <div className="space-y-4">
        <div className="flex items-center gap-2">
          <Badge variant="success" className="gap-1">
            <ShieldCheck className="size-3.5" /> Two-factor authentication is on
          </Badge>
        </div>
        {remaining && (
          <p className="text-sm text-muted-foreground">
            <KeyRound className="mr-1 inline size-3.5" />
            {remaining.remaining} of {remaining.total} backup codes remaining.
            {remaining.remaining <= 2 && " Consider regenerating a fresh set."}
          </p>
        )}
        {error && (
          <p role="alert" className="flex items-start gap-2 rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
            <AlertCircle className="mt-0.5 size-4 flex-shrink-0" /> {error}
          </p>
        )}
        <Separator />
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="outline" onClick={regenerateCodes} disabled={busy}>
            <KeyRound /> Regenerate backup codes
          </Button>
          <Button type="button" variant="destructive" onClick={disable} disabled={busy}>
            <ShieldOff /> Turn off
          </Button>
        </div>
      </div>
    );
  }

  // status === "off"
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <Badge variant="outline" className="gap-1">
          <ShieldOff className="size-3.5" /> Two-factor authentication is off
        </Badge>
      </div>
      <p className="text-sm text-muted-foreground">
        Add a second step at sign-in — a 6-digit code from an authenticator app — on top of your
        password.
      </p>
      {error && (
        <p role="alert" className="flex items-start gap-2 rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
          <AlertCircle className="mt-0.5 size-4 flex-shrink-0" /> {error}
        </p>
      )}
      <Button type="button" variant="brand" onClick={startEnroll} disabled={busy}>
        <ShieldCheck /> Enable two-factor authentication
      </Button>
    </div>
  );
}
