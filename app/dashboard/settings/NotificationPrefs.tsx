"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { ChannelPicker, type ChannelPrefs } from "@/components/patterns/channel-picker";
// Imported from `consent-statements`, NOT `channel-consent` — the latter pulls
// in the service-role client, which must never reach a browser bundle.
import { CONSENT_STATEMENTS, type ConsentChannel } from "@/lib/consent-statements";

// Personal preferences — these apply to the signed-in user only, which is why
// they save through an RPC that can only ever touch the caller's own row.
//
// ── Preference and consent are two different things ──────────────────────
// Switching WhatsApp on says "route to me here." It does not, on its own, say
// "I agree to be contacted here" — and WhatsApp's platform rules and NDPA s.25
// both require the second, recorded, with the wording the person saw (0148).
//
// So enabling a messaging channel asks for consent explicitly, in the same
// action, and does not save until it is given. The alternative — inferring
// consent from the toggle — is exactly the tick-box-as-consent pattern that
// 0062 already refused for tenancy applications, and it produces a record that
// cannot answer "what did they agree to, and when."

/** Channels that require recorded consent before we may speak first. */
const CONSENTABLE: ConsentChannel[] = ["whatsapp", "telegram", "sms"];

type Props = {
  initial: ChannelPrefs;
  /** Channels this person currently has an active consent record for. */
  consented: ConsentChannel[];
};

export default function NotificationPrefs({ initial, consented }: Props) {
  const router = useRouter();
  const [prefs, setPrefs] = React.useState<ChannelPrefs>(initial);
  const [agreed, setAgreed] = React.useState<Record<string, boolean>>({});
  const [saving, setSaving] = React.useState(false);

  const hasConsent = React.useCallback(
    (c: ConsentChannel) => consented.includes(c),
    [consented]
  );

  // Channels switched on in the form that carry no consent record yet. These
  // are what the person is asked about — not every channel, which would make
  // re-consenting to something already agreed the price of any other edit.
  const needsConsent = CONSENTABLE.filter((c) => prefs[c] && !hasConsent(c));

  // Channels switched OFF here that still hold an active consent record. Their
  // consent is withdrawn on save, so the record and the behaviour cannot drift.
  const toWithdraw = CONSENTABLE.filter((c) => !prefs[c] && hasConsent(c));

  const blocked = needsConsent.some((c) => !agreed[c]);

  async function save() {
    setSaving(true);
    try {
      const supabase = createClient();

      // Consent FIRST, preferences second. If the preference write succeeded
      // and the consent write then failed, the person would be routed to a
      // channel with no record backing it — the precise state this exists to
      // prevent. In the other order a failure leaves consent recorded but
      // unused, which is inert.
      for (const c of needsConsent) {
        const { error } = await supabase.rpc("record_my_channel_consent", {
          p_channel: c,
          // The wording actually rendered below — copied, not referenced, so a
          // later edit to the copy cannot rewrite what this person agreed to.
          p_statement: CONSENT_STATEMENTS[c],
          p_identifier: c === "telegram" ? prefs.telegramChatId : prefs.phone,
        });
        if (error) throw new Error(error.message);
      }

      for (const c of toWithdraw) {
        const { error } = await supabase.rpc("withdraw_my_channel_consent", {
          p_channel: c,
        });
        if (error) throw new Error(error.message);
      }

      const { error } = await supabase.rpc("update_my_notification_prefs", {
        p_phone: prefs.phone,
        p_telegram_chat_id: prefs.telegramChatId,
        p_email: prefs.email,
        p_whatsapp: prefs.whatsapp,
        p_sms: prefs.sms,
        p_telegram: prefs.telegram,
      });
      if (error) throw new Error(error.message);

      toast.success("Notification preferences saved");
      setAgreed({});
      router.refresh();
    } catch (e) {
      toast.error("Could not save preferences", {
        description: e instanceof Error ? e.message : "Unexpected error.",
      });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-5">
      <ChannelPicker value={prefs} onChange={setPrefs} />

      {needsConsent.map((c) => (
        <div key={c} className="rounded-lg border border-border bg-muted/30 p-3 sm:p-4">
          <label className="flex cursor-pointer gap-3">
            <input
              type="checkbox"
              className="mt-0.5 size-4 flex-shrink-0"
              checked={Boolean(agreed[c])}
              onChange={(e) =>
                setAgreed((a) => ({ ...a, [c]: e.target.checked }))
              }
            />
            <span className="text-xs leading-relaxed text-muted-foreground">
              {CONSENT_STATEMENTS[c]}
            </span>
          </label>
        </div>
      ))}

      {toWithdraw.length > 0 && (
        <p className="text-xs text-muted-foreground">
          Saving will also withdraw your consent for{" "}
          {toWithdraw.join(", ")}. You will still receive anything you are owed
          by email.
        </p>
      )}

      <Button variant="brand" onClick={save} disabled={saving || blocked}>
        {saving ? "Saving…" : "Save preferences"}
      </Button>
      {blocked && (
        <p className="text-xs text-muted-foreground">
          Tick the box above to switch that channel on.
        </p>
      )}
    </div>
  );
}
