"use client";

import * as React from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { updateOrgContent } from "./actions";
import { runAction, describeError } from "@/lib/run-action";
import { replyInboxFor, CATEGORY_CARRIES, type MailCategory } from "@/lib/mail-routes";

export default function ContentForm({
  orgId,
  initial,
  placeholders,
}: {
  orgId: string;
  initial: {
    portalName: string;
    tagline: string;
    supportEmail: string;
    supportPhone: string;
    whatsappNumber: string;
    telegramBotUsername: string;
    financeEmail: string;
    itEmail: string;
    emailFromName: string;
    emailFromAddress: string;
  };
  placeholders: { portalName: string };
}) {
  const [form, setForm] = React.useState(initial);
  const [saving, setSaving] = React.useState(false);

  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      await runAction(updateOrgContent(orgId, form));
      toast.success("Portal text updated");
    } catch (err) {
      toast.error("Could not save", {
        description: describeError(err),
      });
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="space-y-5">
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="portal-name">Portal name</Label>
          <Input
            id="portal-name"
            value={form.portalName}
            onChange={set("portalName")}
            maxLength={40}
            placeholder={placeholders.portalName}
          />
          <p className="text-xs text-muted-foreground">
            Shown under your logo in the sidebar.
          </p>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="tagline">Tagline</Label>
          <Input
            id="tagline"
            value={form.tagline}
            onChange={set("tagline")}
            maxLength={120}
            placeholder="e.g. Managed by TFML"
          />
          <p className="text-xs text-muted-foreground">Optional short descriptor.</p>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="support-email">Support email</Label>
          <Input
            id="support-email"
            type="email"
            value={form.supportEmail}
            onChange={set("supportEmail")}
            placeholder="support@yourorg.com"
          />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="support-phone">Support phone</Label>
          <Input
            id="support-phone"
            value={form.supportPhone}
            onChange={set("supportPhone")}
            maxLength={40}
            placeholder="+234 800 000 0000"
          />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="whatsapp-number">WhatsApp number</Label>
          <Input
            id="whatsapp-number"
            value={form.whatsappNumber}
            onChange={set("whatsappNumber")}
            maxLength={24}
            placeholder="+234 703 689 1329"
          />
          <p className="text-xs text-muted-foreground">
            The number registered for this organisation on WhatsApp Business. It
            is never shown to people — it only powers the &ldquo;Chat on
            WhatsApp&rdquo; buttons, so nobody has to type it.
          </p>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="telegram-bot">Telegram bot</Label>
          <Input
            id="telegram-bot"
            value={form.telegramBotUsername}
            onChange={set("telegramBotUsername")}
            maxLength={33}
            placeholder="@yourorg_support_bot"
          />
          <p className="text-xs text-muted-foreground">
            The bot&rsquo;s own username, not your personal handle. Leave blank
            until the bot exists in @BotFather.
          </p>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="finance-email">Finance / accounts email</Label>
          <Input
            id="finance-email"
            type="email"
            value={form.financeEmail}
            onChange={set("financeEmail")}
            placeholder="accounts@yourorg.com"
          />
          <p className="text-xs text-muted-foreground">
            Replies to invoices, statements and remittance advice go here.
          </p>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="it-email">IT / technical email</Label>
          <Input
            id="it-email"
            type="email"
            value={form.itEmail}
            onChange={set("itEmail")}
            placeholder="admin@yourorg.com"
          />
          <p className="text-xs text-muted-foreground">
            For system and technical notices.
          </p>
        </div>
      </div>

      <ReplyRouting
        supportEmail={form.supportEmail}
        financeEmail={form.financeEmail}
        itEmail={form.itEmail}
      />

      <div className="grid gap-4 border-t border-border pt-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="from-name">Sender name</Label>
          <Input
            id="from-name"
            value={form.emailFromName}
            onChange={set("emailFromName")}
            maxLength={60}
            placeholder="e.g. TFML"
          />
          <p className="text-xs text-muted-foreground">
            What recipients see in their inbox. Use your client-facing brand.
          </p>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="from-address">Sending address</Label>
          <Input
            id="from-address"
            type="email"
            value={form.emailFromAddress}
            onChange={set("emailFromAddress")}
            placeholder="no-reply@notify.yourbrand.com"
          />
          <p className="text-xs text-muted-foreground">
            Must be on a domain verified with the email provider.
          </p>
        </div>
      </div>

      <p className="text-xs text-muted-foreground">
        Mail is sent from the address above, so replies are routed to the inboxes
        set here. Leave a reply field blank and it falls back to the support
        address.
      </p>

      <Button type="submit" variant="brand" disabled={saving}>
        {saving ? "Saving…" : "Save portal text"}
      </Button>
    </form>
  );
}

/**
 * Where a reply to each kind of email actually lands, given what is in the
 * boxes above — recomputed as somebody types, from the SAME rule the sender
 * uses (`replyInboxFor`).
 *
 * ⚠️ Why this exists. Every client-facing email is sent From
 * `no-reply@notify.<brand>` — a dedicated sending subdomain that is deliberately
 * not a mailbox — and made replyable by a `Reply-To` header pointing at one of
 * these three inboxes. An administrator had no way to see that: leaving
 * "Finance / accounts email" blank silently routes every invoice, statement,
 * receipt and payment-request reply into the general support inbox. Measured on
 * staging when this was written — OEA had no finance address, so a tenant
 * replying "I have already paid this" landed in `info@` beside everything else.
 *
 * Nothing here is a refusal: the fallback is correct, and an unreplyable email
 * would be far worse. It is only that a fallback nobody can see is a fallback
 * nobody chose.
 */
function ReplyRouting({
  supportEmail,
  financeEmail,
  itEmail,
}: {
  supportEmail: string;
  financeEmail: string;
  itEmail: string;
}) {
  const routes = {
    support_email: supportEmail,
    finance_email: financeEmail,
    it_email: itEmail,
  };
  const shown: MailCategory[] = ["account", "finance", "it"];

  return (
    <div className="space-y-2 rounded-lg border border-border bg-muted/30 p-4">
      <p className="text-sm font-medium">Where replies to your emails go</p>
      <p className="text-xs text-muted-foreground">
        Everything is sent from a no-reply address on your notification
        subdomain, so the reputation of app mail stays separate from your real
        business mail. What makes it replyable is the reply-to address below.
      </p>
      <dl className="space-y-1.5 pt-1">
        {shown.map((c) => {
          const route = replyInboxFor(c, routes);
          return (
            <div key={c} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5 text-sm">
              <dt className="text-muted-foreground">{CATEGORY_CARRIES[c]}</dt>
              <dd className="text-right">
                {route.address ? (
                  <>
                    <span className="font-medium">{route.address}</span>
                    {route.fellBack && (
                      <span className="ml-2 text-xs text-warning">
                        — no {c === "finance" ? "finance" : "IT"} address set, so
                        support is catching these
                      </span>
                    )}
                  </>
                ) : (
                  <span className="text-destructive">
                    nowhere — set a support email, or these cannot be replied to
                  </span>
                )}
              </dd>
            </div>
          );
        })}
      </dl>
    </div>
  );
}
