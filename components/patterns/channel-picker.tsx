"use client";

import * as React from "react";
import { Mail, MessageCircle, Smartphone, Send } from "lucide-react";
import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

// Shared by the enrolment screen and the settings panel, so a person is asked
// the same question the same way whether they're signing up or changing their
// mind later.

export type ChannelPrefs = {
  phone: string;
  telegramChatId: string;
  email: boolean;
  whatsapp: boolean;
  sms: boolean;
  telegram: boolean;
};

export const EMPTY_PREFS: ChannelPrefs = {
  phone: "",
  telegramChatId: "",
  email: true,
  whatsapp: false,
  sms: false,
  telegram: false,
};

const CHANNELS = [
  {
    key: "email" as const,
    label: "Email",
    icon: Mail,
    hint: "Always available.",
    needs: null,
  },
  {
    key: "whatsapp" as const,
    label: "WhatsApp",
    icon: MessageCircle,
    hint: "Most people read this first.",
    needs: "phone" as const,
  },
  {
    key: "sms" as const,
    label: "SMS",
    icon: Smartphone,
    hint: "Works without data.",
    needs: "phone" as const,
  },
  {
    key: "telegram" as const,
    label: "Telegram",
    icon: Send,
    hint: "Needs your chat ID.",
    needs: "telegramChatId" as const,
  },
];

export function ChannelPicker({
  value,
  onChange,
  compact = false,
}: {
  value: ChannelPrefs;
  onChange: (next: ChannelPrefs) => void;
  compact?: boolean;
}) {
  const set = <K extends keyof ChannelPrefs>(k: K, v: ChannelPrefs[K]) =>
    onChange({ ...value, [k]: v });

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="ch-phone">
            Mobile number{" "}
            <span className="font-normal text-muted-foreground">(optional)</span>
          </Label>
          <Input
            id="ch-phone"
            type="tel"
            value={value.phone}
            onChange={(e) => set("phone", e.target.value)}
            placeholder="+234 800 000 0000"
          />
          <p className="text-xs text-muted-foreground">Used for WhatsApp and SMS.</p>
        </div>
        {!compact && (
          <div className="space-y-1.5">
            <Label htmlFor="ch-tg">
              Telegram chat ID{" "}
              <span className="font-normal text-muted-foreground">(optional)</span>
            </Label>
            <Input
              id="ch-tg"
              value={value.telegramChatId}
              onChange={(e) => set("telegramChatId", e.target.value)}
              placeholder="e.g. 123456789"
            />
            <p className="text-xs text-muted-foreground">
              Message our bot and it will tell you your ID.
            </p>
          </div>
        )}
      </div>

      <fieldset className="space-y-2">
        <legend className="mb-2 text-sm font-medium">How should we reach you?</legend>
        <div className="grid gap-2 sm:grid-cols-2">
          {CHANNELS.map((c) => {
            const Icon = c.icon;
            // A channel can't be chosen until we have a way to deliver on it —
            // better to disable it than to accept a preference that will fail.
            const missing =
              c.needs === "phone"
                ? !value.phone.trim()
                : c.needs === "telegramChatId"
                  ? !value.telegramChatId.trim()
                  : false;
            const on = value[c.key] && !missing;

            return (
              <label
                key={c.key}
                className={cn(
                  "flex cursor-pointer items-start gap-3 rounded-md border p-3 transition-colors",
                  on ? "border-[var(--brand)] bg-[var(--brand)]/[0.05]" : "border-border",
                  missing && "cursor-not-allowed opacity-55"
                )}
              >
                <input
                  type="checkbox"
                  className="mt-0.5 size-4 rounded border-input"
                  checked={on}
                  disabled={missing}
                  onChange={(e) => set(c.key, e.target.checked)}
                />
                <span className="min-w-0">
                  <span className="flex items-center gap-1.5 text-sm font-medium">
                    <Icon className="size-3.5" /> {c.label}
                  </span>
                  <span className="block text-xs text-muted-foreground">
                    {missing
                      ? c.needs === "phone"
                        ? "Add a mobile number to enable"
                        : "Add a Telegram chat ID to enable"
                      : c.hint}
                  </span>
                </span>
              </label>
            );
          })}
        </div>
      </fieldset>

      <p className="text-xs text-muted-foreground">
        Urgent items always try your chosen channels in order and fall back to
        email, so nothing important is missed.
      </p>
    </div>
  );
}
