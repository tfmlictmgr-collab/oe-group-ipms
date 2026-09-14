// "Chat with us" — the affordance that replaces publishing a phone number.
//
// A person taps this and their messaging app opens already addressed to the
// right brand, with the context prefilled. They never read, type, dial or save
// a number, which is the entire point: the number stops being something a user
// handles and becomes an implementation detail, the way an email address behind
// a "Contact us" link is.
//
// Server Component by default — it renders anchors, holds no state, and the
// values it reads (brand theme) are already loaded server-side. Nothing here
// touches a credential: WhatsApp's link needs only the public E.164 number
// (0146) and Telegram's only the public bot username (0147). The routing token
// and bot token both stay in `channel_routes`, service-role only (0039).

import { MessageCircle, Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { BrandTheme } from "@/lib/brands";
import { whatsAppChatLink, generalChatMessage, ticketChatMessage } from "@/lib/whatsapp-link";
import { telegramChatLink, ticketStartPayload } from "@/lib/telegram-link";

type Props = {
  theme: BrandTheme;
  /**
   * The request this conversation is about, if any. Supplying it prefills the
   * WhatsApp message and sets Telegram's start payload, so the org receives a
   * message that is already placed instead of "hi, who is this."
   */
  ticketReference?: string | null;
  /** `sm` suits an inline placement on a ticket row; `default` a support panel. */
  size?: "sm" | "default";
  className?: string;
};

/**
 * Renders nothing when the org has neither channel registered.
 *
 * That is the expected state today for Telegram on both live orgs — the TFML
 * and OEA bots are still uncreated in @BotFather — so this component must
 * degrade to a single WhatsApp button without looking broken, and to nothing at
 * all for an org with no messaging channels rather than showing a dead link.
 */
export function ChatWithUs({ theme, ticketReference, size = "default", className }: Props) {
  const portalName = theme.portalName;
  const message = ticketReference
    ? ticketChatMessage(ticketReference, portalName)
    : generalChatMessage(portalName);

  const whatsapp = whatsAppChatLink(theme.whatsappNumber, { message });
  const telegram = telegramChatLink(theme.telegramBotUsername, {
    startPayload: ticketReference ? ticketStartPayload(ticketReference) : null,
  });

  if (!whatsapp && !telegram) return null;

  return (
    <div className={className}>
      <div className="flex flex-wrap gap-2">
        {whatsapp && (
          <Button asChild variant="outline" size={size}>
            {/*
              noopener/noreferrer on every outbound link, and target=_blank so a
              half-written form on the page behind is not lost when the
              messaging app takes over the tab.
            */}
            <a href={whatsapp} target="_blank" rel="noopener noreferrer">
              <MessageCircle aria-hidden="true" />
              Chat on WhatsApp
            </a>
          </Button>
        )}
        {telegram && (
          <Button asChild variant="outline" size={size}>
            <a href={telegram} target="_blank" rel="noopener noreferrer">
              <Send aria-hidden="true" />
              Chat on Telegram
            </a>
          </Button>
        )}
      </div>
      {/*
        No number is printed here, deliberately. Showing it invites someone to
        copy it into their contacts, which re-creates exactly the "here is our
        number" problem the link exists to remove — and a saved number goes
        stale silently when a channel is re-provisioned, while a link in the
        portal does not.
      */}
      <p className="mt-2 text-xs text-muted-foreground">
        Opens a chat with {portalName}. Your reply arrives in this portal too.
      </p>
    </div>
  );
}
