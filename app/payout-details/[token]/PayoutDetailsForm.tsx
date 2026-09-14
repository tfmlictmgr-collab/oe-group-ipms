"use client";

import * as React from "react";
import { CheckCircle2, Loader2, Paperclip, ShieldCheck, AlertCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { createClient } from "@/lib/supabase/client";
import { listBanks } from "@/lib/bank-actions";
import {
  PAYOUT_BUCKET,
  PAYOUT_EVIDENCE_RULES,
  PAYOUT_NAME_NEEDED,
  payoutEvidenceProblem,
  payoutEvidenceType,
} from "@/lib/payout-evidence-rules";
import { checkAccountName, prepareEvidenceUpload, submitPayoutDetails } from "./actions";

type Lookup =
  | { state: "idle" }
  | { state: "checking" }
  | { state: "confirmed"; name: string }
  | { state: "type-it"; note: string }
  | { state: "not-found"; message: string };

/**
 * Where a payee tells us their bank account.
 *
 * Built for one person on a phone, possibly on a poor connection, who may never
 * have used this portal: one question at a time, the bank's answer shown back
 * to them, and every rule said before they act on it rather than after.
 */
export default function PayoutDetailsForm({
  token,
  brandName,
  payeeName,
}: {
  token: string;
  brandName: string;
  payeeName: string;
}) {
  const [banks, setBanks] = React.useState<{ code: string; name: string }[]>([]);
  const [bankCode, setBankCode] = React.useState("");
  const [accountNumber, setAccountNumber] = React.useState("");
  const [lookup, setLookup] = React.useState<Lookup>({ state: "idle" });
  const [typedName, setTypedName] = React.useState("");
  const [file, setFile] = React.useState<File | null>(null);
  const [fileProblem, setFileProblem] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [done, setDone] = React.useState<{ bankName: string; last4: string; confirmed: boolean } | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    void listBanks().then((r) => {
      if (!cancelled && r.ok) setBanks(r.data);
    });
    return () => { cancelled = true; };
  }, []);

  // Ask the bank as soon as there is something to ask about — the answer is
  // what tells a person they typed the right number.
  React.useEffect(() => {
    if (!bankCode || accountNumber.length !== 10) {
      setLookup({ state: "idle" });
      return;
    }
    let cancelled = false;
    setLookup({ state: "checking" });
    const t = setTimeout(async () => {
      const r = await checkAccountName(token, accountNumber, bankCode);
      if (cancelled) return;
      if (!r.ok) setLookup({ state: "not-found", message: r.message });
      else if (r.data.confirmed && r.data.accountName) setLookup({ state: "confirmed", name: r.data.accountName });
      else setLookup({ state: "type-it", note: r.data.note ?? "Type the account name exactly as your bank shows it." });
    }, 500);
    return () => { cancelled = true; clearTimeout(t); };
  }, [token, bankCode, accountNumber]);

  function choose(f: File | null) {
    setFile(f);
    setFileProblem(f ? payoutEvidenceProblem({ size: f.size, type: f.type, name: f.name }) : null);
  }

  const nameReady =
    lookup.state === "confirmed" || (lookup.state === "type-it" && typedName.trim().length >= 3);
  const ready = Boolean(bankCode) && accountNumber.length === 10 && nameReady && file && !fileProblem;

  async function submit() {
    if (!file || !ready) return;
    setBusy(true);
    setError(null);
    try {
      const prep = await prepareEvidenceUpload(token, { name: file.name, size: file.size, type: payoutEvidenceType(file) });
      if (!prep.ok) throw new Error(prep.message);

      const supabase = createClient();
      const { error: upErr } = await supabase.storage
        .from(PAYOUT_BUCKET)
        .uploadToSignedUrl(prep.data.path, prep.data.uploadToken, file, {
          contentType: payoutEvidenceType(file),
          upsert: false,
        });
      if (upErr) throw new Error("Your document did not upload. Check your connection and try again.");

      const r = await submitPayoutDetails({
        token,
        bankCode,
        accountNumber,
        typedAccountName: typedName,
        evidencePath: prep.data.path,
        evidenceFilename: file.name,
      });
      if (!r.ok) {
        // 0296: the server could not have the bank's name and needs it typed.
        // Open the box — with the name the bank gave earlier, if it did —
        // rather than showing an instruction with nowhere to follow it.
        if (r.message === PAYOUT_NAME_NEEDED) {
          if (lookup.state === "confirmed") setTypedName(lookup.name);
          setLookup({
            state: "type-it",
            note: "The bank could not be asked just now. Type the account name exactly as your bank shows it, then send again.",
          });
          return;
        }
        throw new Error(r.message);
      }
      setDone(r.data);
      setAccountNumber("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "That could not be sent. Try again.");
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <div className="flex items-start gap-3 rounded-xl border border-success/40 bg-success/5 p-4 text-sm">
        <CheckCircle2 className="mt-0.5 size-5 flex-shrink-0 text-success" />
        <div className="space-y-1">
          <p className="font-medium">Thank you — your details have reached {brandName}.</p>
          <p className="text-pretty text-muted-foreground">
            We will pay you into your {done.bankName} account ending {done.last4}.{" "}
            {done.confirmed
              ? "Your bank confirmed the account name, so there is nothing more for you to do."
              : "Someone will check your document against the name before any payment is made."}{" "}
            You will get a message when the money is sent. You can close this page.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="pd-bank">Your bank</Label>
          <Select id="pd-bank" value={bankCode} onChange={(e) => setBankCode(e.target.value)}>
            <option value="">— choose your bank —</option>
            {banks.map((b) => (
              <option key={b.code} value={b.code}>{b.name}</option>
            ))}
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="pd-number">Account number</Label>
          <Input
            id="pd-number"
            inputMode="numeric"
            autoComplete="off"
            maxLength={10}
            value={accountNumber}
            onChange={(e) => setAccountNumber(e.target.value.replace(/\D/g, ""))}
            placeholder="10 digits"
          />
        </div>
      </div>

      {/* The bank's answer, said back to the person who typed the number. */}
      {lookup.state === "checking" && (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> Checking with your bank…
        </p>
      )}
      {lookup.state === "confirmed" && (
        <div className="rounded-xl border border-success/40 bg-success/5 p-3 text-sm">
          <p className="text-xs text-muted-foreground">Your bank holds this account in the name</p>
          <p className="text-base font-semibold">{lookup.name}</p>
          <p className="mt-1 text-xs text-muted-foreground">
            If that is not you{payeeName ? ` or ${payeeName}` : ""}, check the number before going on.
          </p>
        </div>
      )}
      {lookup.state === "not-found" && (
        <p className="flex items-start gap-2 text-sm text-destructive">
          <AlertCircle className="mt-0.5 size-4 flex-shrink-0" /> {lookup.message}
        </p>
      )}
      {lookup.state === "type-it" && (
        <div className="space-y-1.5">
          <Label htmlFor="pd-name">Account name</Label>
          <Input
            id="pd-name"
            value={typedName}
            onChange={(e) => setTypedName(e.target.value)}
            placeholder="Exactly as your bank shows it"
          />
          <p className="text-xs text-muted-foreground">{lookup.note}</p>
        </div>
      )}

      <div className="space-y-1.5">
        <Label htmlFor="pd-file">A document showing your account name and number</Label>
        <p className="text-xs text-muted-foreground">
          A bank letter, a statement, or a screenshot from your banking app. {PAYOUT_EVIDENCE_RULES}{" "}
          It is kept privately and read only by the people who make the payment.
        </p>
        <label
          htmlFor="pd-file"
          className="flex cursor-pointer items-center gap-2 rounded-lg border border-dashed border-border px-3 py-3 text-sm hover:bg-muted/40"
        >
          <Paperclip className="size-4 text-muted-foreground" />
          <span className="truncate">{file ? file.name : "Choose a file or take a photo"}</span>
        </label>
        <input
          id="pd-file"
          type="file"
          accept="application/pdf,image/*"
          className="sr-only"
          onChange={(e) => choose(e.target.files?.[0] ?? null)}
        />
        {fileProblem && <p className="text-xs text-destructive">{fileProblem}</p>}
      </div>

      {error && (
        <p className="flex items-start gap-2 rounded-lg bg-destructive/8 px-3 py-2 text-sm text-destructive">
          <AlertCircle className="mt-0.5 size-4 flex-shrink-0" /> {error}
        </p>
      )}

      <Button variant="brand" className="w-full sm:w-auto" disabled={!ready || busy} onClick={submit}>
        {busy ? <Loader2 className="size-4 animate-spin" /> : <ShieldCheck className="size-4" />}
        {busy ? "Sending securely…" : "Send my bank details"}
      </Button>

      <p className="text-xs text-muted-foreground">
        We keep your bank, your account name and the last four digits of your account number —
        never the whole number. {brandName} will never ask for your PIN, your password or a
        one-time code.
      </p>
    </div>
  );
}
