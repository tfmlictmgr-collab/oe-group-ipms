"use client";

import * as React from "react";
import { toast } from "sonner";
import { ShieldCheck, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { saveOrgGatewayCredential } from "./gateway-actions";

type Status = {
  gateway: string;
  key_mode: string;
  public_key: string | null;
  secret_last4: string | null;
  updated_at: string;
};

/**
 * Connect this organisation's own Paystack account.
 *
 * The secret field is write-only by construction — there is no value to
 * populate it with, because nothing can read a stored key back. What is shown
 * instead is the mode and the last four characters, which is what every payment
 * dashboard shows and is enough to answer "is this the key I pasted?".
 */
export default function GatewayForm({ status }: { status: Status | null }) {
  const [secret, setSecret] = React.useState("");
  const [publicKey, setPublicKey] = React.useState(status?.public_key ?? "");
  const [webhook, setWebhook] = React.useState("");
  const [busy, setBusy] = React.useState(false);

  const live = status?.key_mode === "live";

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    const res = await saveOrgGatewayCredential({
      gateway: "paystack",
      secretKey: secret,
      publicKey,
      webhookSecret: webhook,
    });
    setBusy(false);
    if (!res.ok) {
      toast.error(res.message, { description: res.hint ?? undefined });
      return;
    }
    toast.success("Paystack account connected.", {
      description: "Collections and payouts for this organisation now use it.",
    });
    setSecret("");
    setWebhook("");
  }

  return (
    <div className="space-y-4">
      {status ? (
        <div
          className={
            live
              ? "flex items-start gap-2 rounded-lg border border-warning/40 bg-warning/8 px-4 py-3 text-sm"
              : "flex items-start gap-2 rounded-lg border border-info/40 bg-info/8 px-4 py-3 text-sm"
          }
        >
          {live ? (
            <TriangleAlert className="mt-0.5 size-4 flex-shrink-0 text-warning" />
          ) : (
            <ShieldCheck className="mt-0.5 size-4 flex-shrink-0 text-info" />
          )}
          <p className="text-muted-foreground">
            <span className="font-medium text-foreground">
              {live ? "LIVE key connected" : "Test key connected"}
            </span>{" "}
            — secret ending <span className="font-mono">{status.secret_last4}</span>, set{" "}
            {new Date(status.updated_at).toLocaleDateString("en-NG", {
              day: "numeric", month: "short", year: "numeric",
            })}
            .{" "}
            {live
              ? "Real cards will be charged and real money will move."
              : "Nothing charged here is real money."}
          </p>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">
          This organisation has no Paystack account of its own, so collections
          fall back to the platform account. Connect one to keep this
          organisation&rsquo;s money in its own merchant account.
        </p>
      )}

      <form onSubmit={submit} className="space-y-4">
        <div className="space-y-1.5">
          <Label htmlFor="pk">Public key</Label>
          <Input
            id="pk" value={publicKey} onChange={(e) => setPublicKey(e.target.value)}
            placeholder="pk_test_… or pk_live_…" autoComplete="off"
          />
          <p className="text-xs text-muted-foreground">
            Not a secret — Paystack publishes it, and the browser uses it to open checkout.
          </p>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="sk">Secret key</Label>
          <Input
            id="sk" type="password" value={secret} onChange={(e) => setSecret(e.target.value)}
            placeholder={status ? "Paste a new key to replace the current one" : "sk_test_… or sk_live_…"}
            autoComplete="off"
          />
          <p className="text-xs text-muted-foreground">
            Stored encrypted and never shown again. Replacing a key keeps a record
            of when it changed and who changed it.
          </p>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="wh">Webhook secret</Label>
          <Input
            id="wh" type="password" value={webhook} onChange={(e) => setWebhook(e.target.value)}
            placeholder="Optional — leave blank to keep the current one" autoComplete="off"
          />
          <p className="text-xs text-muted-foreground">
            Proves a notification really came from Paystack for this organisation.
          </p>
        </div>

        <Button type="submit" disabled={busy || secret.trim().length < 20}>
          {busy ? "Connecting…" : status ? "Replace the key" : "Connect Paystack"}
        </Button>
      </form>
    </div>
  );
}
