"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { ShieldCheck, AlertCircle, Copy, Check, LogOut } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { generateMyBackupCodes, verifyBackupCodeAndDisableMfa } from "@/lib/mfa";
import { recordSessionEvent } from "@/lib/session-events";

type Step = "starting" | "scan" | "codes" | "verify";

/**
 * The gate's own screen (0308). Two jobs, one page:
 *
 *   • `verify` — this person has a factor and this session has not answered
 *     it. Same challenge as the sign-in form, plus the backup-code way out.
 *   • `enroll` — no factor yet. Enrolment starts on its own (no "Enable"
 *     button to find), then the one-time backup codes, then on to `next`.
 *
 * ⚠️ There is no Cancel on enrolment, deliberately: where it is required, the
 * only alternative to finishing is signing out. A Cancel that returned them to
 * a dashboard that immediately sends them back here is a loop, not a choice.
 */
export default function MfaGateFlow({
  mode,
  next,
  orgName,
  required,
}: {
  mode: "verify" | "enroll";
  next: string;
  orgName: string | null;
  required: boolean;
}) {
  const router = useRouter();
  const supabase = React.useMemo(() => createClient(), []);
  const [step, setStep] = React.useState<Step>(mode === "verify" ? "verify" : "starting");
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  const [factorId, setFactorId] = React.useState<string | null>(null);
  const [qrCode, setQrCode] = React.useState<string | null>(null);
  const [secret, setSecret] = React.useState<string | null>(null);
  const [code, setCode] = React.useState("");
  const [useBackup, setUseBackup] = React.useState(false);
  const [freshCodes, setFreshCodes] = React.useState<string[]>([]);
  const [copied, setCopied] = React.useState(false);
  const started = React.useRef(false);

  const proceed = React.useCallback(() => {
    // `replace`, so Back does not return to a step that is finished.
    router.replace(next);
    router.refresh();
  }, [router, next]);

  const startEnroll = React.useCallback(async () => {
    setError(null);
    setBusy(true);
    // An abandoned attempt (closed tab, reload) leaves an unverified factor
    // behind; clear it so this one starts clean rather than colliding.
    const { data: existing } = await supabase.auth.mfa.listFactors();
    for (const f of existing?.all ?? []) {
      if (f.status !== "verified") await supabase.auth.mfa.unenroll({ factorId: f.id });
    }
    const { data, error: enrollErr } = await supabase.auth.mfa.enroll({ factorType: "totp" });
    setBusy(false);
    if (enrollErr || !data) {
      setError(enrollErr?.message ?? "Could not start setting up two-factor sign-in.");
      return;
    }
    setFactorId(data.id);
    setQrCode(data.totp.qr_code);
    setSecret(data.totp.secret);
    setStep("scan");
  }, [supabase]);

  React.useEffect(() => {
    if (mode === "enroll" && !started.current) {
      started.current = true;
      void startEnroll();
    }
  }, [mode, startEnroll]);

  async function confirmEnroll(e: React.FormEvent) {
    e.preventDefault();
    if (!factorId) return;
    setError(null);
    setBusy(true);
    const { error: verifyErr } = await supabase.auth.mfa.challengeAndVerify({
      factorId,
      code: code.trim(),
    });
    if (verifyErr) {
      setBusy(false);
      setError("That code didn't match. Check your authenticator app and try again.");
      return;
    }
    // The session is AAL2 from here. Now the one-time recovery codes.
    const result = await generateMyBackupCodes();
    setBusy(false);
    if (!result.ok) {
      // Two-factor is on regardless; codes can be made under Settings → Security.
      proceed();
      return;
    }
    setFreshCodes(result.data);
    setStep("codes");
  }

  async function answerChallenge(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    if (useBackup) {
      const result = await verifyBackupCodeAndDisableMfa(code);
      setBusy(false);
      if (!result.ok) {
        setError(result.message);
        return;
      }
      // The code removed their factor. Where it is required they set a new
      // one up now; the page decides that on reload.
      router.refresh();
      return;
    }
    const { data: factors } = await supabase.auth.mfa.listFactors();
    const totp = (factors?.totp ?? []).find((f) => f.status === "verified");
    if (!totp) {
      setBusy(false);
      router.refresh();
      return;
    }
    const { error: verifyErr } = await supabase.auth.mfa.challengeAndVerify({
      factorId: totp.id,
      code: code.trim(),
    });
    setBusy(false);
    if (verifyErr) {
      setError("That code didn't match. Check your authenticator app and try again.");
      return;
    }
    proceed();
  }

  async function signOut() {
    await recordSessionEvent("signed_out");
    await supabase.auth.signOut();
    router.replace("/login");
    router.refresh();
  }

  function copyAll() {
    navigator.clipboard.writeText(freshCodes.join("\n")).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  const errorBox = error && (
    <p role="alert" className="flex items-start gap-2 rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
      <AlertCircle className="mt-0.5 size-4 flex-shrink-0" /> {error}
    </p>
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ShieldCheck className="size-5 text-brand" />
          {step === "verify" ? "Enter your sign-in code" : "Set up two-factor sign-in"}
        </CardTitle>
        <CardDescription>
          {step === "verify"
            ? "Open your authenticator app and enter the 6-digit code for this account."
            : required
              ? `${orgName ?? "Your organisation"} requires a second step at sign-in for every account. It takes about a minute.`
              : "Add a second step at sign-in — a 6-digit code from an authenticator app — on top of your password."}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {step === "starting" && (
          <>
            <p className="text-sm text-muted-foreground">{busy ? "Preparing…" : ""}</p>
            {errorBox}
            {error && (
              <Button type="button" variant="brand" onClick={startEnroll} disabled={busy}>
                Try again
              </Button>
            )}
          </>
        )}

        {step === "scan" && (
          <form onSubmit={confirmEnroll} className="space-y-4">
            <ol className="list-decimal space-y-1 pl-5 text-sm text-muted-foreground">
              <li>Install an authenticator app on your phone (Google Authenticator, Microsoft Authenticator, Authy, …).</li>
              <li>In the app, add an account and scan this code.</li>
              <li>Type the 6-digit code the app shows.</li>
            </ol>
            {qrCode && (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={qrCode} alt="Scan with your authenticator app" className="h-44 w-44 rounded-md border border-border bg-white p-2" />
            )}
            {secret && (
              <p className="break-all text-xs text-muted-foreground">
                Can&apos;t scan? Enter this key manually:{" "}
                <code className="rounded bg-muted px-1.5 py-0.5">{secret}</code>
              </p>
            )}
            <div className="space-y-1.5">
              <Label htmlFor="mfa-setup-code">6-digit code</Label>
              <Input
                id="mfa-setup-code"
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
                placeholder="123456"
                autoFocus
              />
            </div>
            {errorBox}
            <Button type="submit" variant="brand" className="w-full" disabled={busy || code.length !== 6}>
              {busy ? "Verifying…" : "Verify and continue"}
            </Button>
          </form>
        )}

        {step === "codes" && (
          <div className="space-y-4">
            <p className="flex items-start gap-2 rounded-md bg-warning/10 px-3 py-2 text-sm">
              <AlertCircle className="mt-0.5 size-4 flex-shrink-0 text-warning" />
              Save these backup codes somewhere safe — this is the only time they&apos;re shown.
              Each works once, to get back in if you lose your phone.
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
              <Button type="button" variant="brand" onClick={proceed}>
                I&apos;ve saved these — continue
              </Button>
            </div>
          </div>
        )}

        {step === "verify" && (
          <form onSubmit={answerChallenge} className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="mfa-gate-code">{useBackup ? "Backup code" : "6-digit code"}</Label>
              <Input
                id="mfa-gate-code"
                inputMode={useBackup ? "text" : "numeric"}
                autoComplete="one-time-code"
                maxLength={useBackup ? 9 : 6}
                value={code}
                onChange={(e) =>
                  setCode(useBackup ? e.target.value.toUpperCase() : e.target.value.replace(/\D/g, ""))
                }
                placeholder={useBackup ? "XXXX-XXXX" : "123456"}
                autoFocus
              />
            </div>
            {useBackup && (
              <p className="text-xs text-muted-foreground">
                A backup code turns off your current authenticator. You will set up a new one next.
              </p>
            )}
            {errorBox}
            <Button
              type="submit"
              variant="brand"
              className="w-full"
              disabled={busy || (useBackup ? code.trim().length < 8 : code.length !== 6)}
            >
              {busy ? "Checking…" : "Continue"}
            </Button>
            <button
              type="button"
              className="text-sm text-muted-foreground underline-offset-4 hover:underline"
              onClick={() => {
                setUseBackup((v) => !v);
                setCode("");
                setError(null);
              }}
            >
              {useBackup ? "Use my authenticator app instead" : "Lost your phone? Use a backup code"}
            </button>
          </form>
        )}

        <div className="border-t border-border pt-3">
          <Button type="button" variant="ghost" size="sm" onClick={signOut}>
            <LogOut /> Sign out
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
