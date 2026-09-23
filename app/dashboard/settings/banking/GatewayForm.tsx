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

type Gateway = "paystack" | "flutterwave";

// What differs between the two gateways, stated once. Everything else about
// connecting an account — write-only secret, mode and last four shown back —
// is the same act.
const COPY: Record<Gateway, {
  name: string;
  publicPlaceholder: string;
  secretPlaceholder: string;
  webhookLabel: string;
  webhookPlaceholder: string;
  webhookHint: string;
  webhookRequired: boolean;
  connected: string;
  none: string;
}> = {
  flutterwave: {
    name: "Flutterwave",
    publicPlaceholder: "FLWPUBK_TEST-… or FLWPUBK-…",
    secretPlaceholder: "FLWSECK_TEST-… or FLWSECK-…",
    webhookLabel: "Secret hash",
    webhookPlaceholder: "The secret hash set under Settings → Webhooks in Flutterwave",
    webhookHint:
      "Required. Flutterwave proves a payment notification with this value alone, so it must be entered again whenever the key is replaced.",
    webhookRequired: true,
    connected: "Naira and foreign-currency collections for this organisation now use it.",
    none:
      "This organisation has no Flutterwave account of its own. Connect one to take Naira and foreign-currency payments online into its own merchant account.",
  },
  paystack: {
    name: "Paystack",
    publicPlaceholder: "pk_test_… or pk_live_…",
    secretPlaceholder: "sk_test_… or sk_live_…",
    webhookLabel: "Webhook secret",
    webhookPlaceholder: "Optional",
    webhookHint: "Optional — Paystack signs its notifications with the secret key itself.",
    webhookRequired: false,
    connected: "Automated payouts for this organisation now use it, and Naira collections too if Flutterwave is not connected.",
    none:
      "This organisation has no Paystack account of its own, so payouts are made by recorded bank transfer. Flutterwave is the collections gateway; Paystack is only needed for automated payouts.",
  },
};

/**
 * Connect this organisation's own merchant account on one gateway.
 *
 * The secret field is write-only by construction — there is no value to
 * populate it with, because nothing can read a stored key back. What is shown
 * instead is the mode and the last four characters, which is what every payment
 * dashboard shows and is enough to answer "is this the key I pasted?".
 */
export default function GatewayForm({ gateway, status }: { gateway: Gateway; status: Status | null }) {
  const c = COPY[gateway];
  const [secret, setSecret] = React.useState("");
  const [publicKey, setPublicKey] = React.useState(status?.public_key ?? "");
  const [webhook, setWebhook] = React.useState("");
  const [busy, setBusy] = React.useState(false);

  const live = status?.key_mode === "live";
  const id = (s: string) => `${gateway}-${s}`;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    const res = await saveOrgGatewayCredential({
      gateway,
      secretKey: secret,
      publicKey,
      webhookSecret: webhook,
    });
    setBusy(false);
    if (!res.ok) {
      toast.error(res.message, { description: res.hint ?? undefined });
      return;
    }
    toast.success(`${c.name} account connected.`, { description: c.connected });
    setSecret("");
    setWebhook("");
  }

  const ready = secret.trim().length >= 20 && (!c.webhookRequired || webhook.trim().length > 0);

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
        <p className="text-sm text-muted-foreground">{c.none}</p>
      )}

      <form onSubmit={submit} className="space-y-4">
        <div className="space-y-1.5">
          <Label htmlFor={id("pk")}>Public key</Label>
          <Input
            id={id("pk")} value={publicKey} onChange={(e) => setPublicKey(e.target.value)}
            placeholder={c.publicPlaceholder} autoComplete="off"
          />
          <p className="text-xs text-muted-foreground">
            Not a secret — {c.name} publishes it, and the browser uses it to open checkout.
          </p>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor={id("sk")}>Secret key</Label>
          <Input
            id={id("sk")} type="password" value={secret} onChange={(e) => setSecret(e.target.value)}
            placeholder={status ? "Paste a new key to replace the current one" : c.secretPlaceholder}
            autoComplete="off"
          />
          <p className="text-xs text-muted-foreground">
            Stored encrypted and never shown again. Replacing a key keeps a record
            of when it changed and who changed it.
          </p>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor={id("wh")}>{c.webhookLabel}</Label>
          <Input
            id={id("wh")} type="password" value={webhook} onChange={(e) => setWebhook(e.target.value)}
            placeholder={c.webhookPlaceholder} autoComplete="off"
          />
          <p className="text-xs text-muted-foreground">{c.webhookHint}</p>
        </div>

        <Button type="submit" disabled={busy || !ready}>
          {busy ? "Connecting…" : status ? "Replace the key" : `Connect ${c.name}`}
        </Button>
      </form>
    </div>
  );
}
