"use client";

import * as React from "react";

/**
 * Cloudflare Turnstile for the doors people sign in through — sign-in,
 * accepting an invitation, and asking for a password reset.
 *
 * ⚠️ WHERE THE GATE ACTUALLY IS. Sign-in goes straight from the browser to
 * Supabase Auth, so a widget on the page alone is decoration: a script can call
 * Supabase with the published key and never see it. The gate is Supabase's own
 * CAPTCHA setting (Auth → Attack Protection, provider Turnstile), which makes
 * Supabase refuse a sign-in that carries no valid token. This component only
 * MINTS the token; the callers pass it as `options.captchaToken`. Password
 * reset is our own server action, so there the token is verified server-side
 * by `lib/turnstile.ts`, exactly as the vendor application is.
 *
 * ⚠️ ORDER OF SWITCHING ON. Deploy this first; enable Supabase's CAPTCHA
 * second. The reverse locks every account out, the operator's included. With
 * Supabase's CAPTCHA off, a token passed to it is simply ignored — so this is
 * safe to ship before the switch, and dev/staging (where 77 verify suites sign
 * in with a password) keep it off.
 *
 * Explicit rendering, not the `cf-turnstile` class the vendor form uses: that
 * mode scans the page once when the script loads, and the sign-in screen is
 * routinely reached by client-side navigation after it already has — the box
 * would simply never appear.
 *
 * With no site key in this build, renders nothing and `enabled` is false.
 */

export const TURNSTILE_SITE_KEY: string | null =
  process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY || null;

type TurnstileApi = {
  render: (el: HTMLElement, opts: Record<string, unknown>) => string;
  reset: (id?: string) => void;
  remove: (id: string) => void;
};
declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

const SCRIPT_SRC = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
let scriptPromise: Promise<void> | null = null;

function loadTurnstile(): Promise<void> {
  if (typeof window === "undefined") return Promise.resolve();
  if (window.turnstile) return Promise.resolve();
  if (scriptPromise) return scriptPromise;
  scriptPromise = new Promise<void>((resolve, reject) => {
    const s = document.createElement("script");
    s.src = SCRIPT_SRC;
    s.async = true;
    s.defer = true;
    s.onload = () => resolve();
    s.onerror = () => {
      scriptPromise = null;
      reject(new Error("Turnstile script failed to load"));
    };
    document.head.appendChild(s);
  });
  return scriptPromise;
}

export type TurnstileGateHandle = {
  /** Tokens are single-use: call after every attempt, successful or not. */
  reset: () => void;
};

export const TurnstileGate = React.forwardRef<
  TurnstileGateHandle,
  { onToken: (token: string | null) => void; action?: string }
>(function TurnstileGate({ onToken, action }, ref) {
  const el = React.useRef<HTMLDivElement>(null);
  const widgetId = React.useRef<string | null>(null);
  const onTokenRef = React.useRef(onToken);
  onTokenRef.current = onToken;
  const [failed, setFailed] = React.useState(false);

  React.useImperativeHandle(ref, () => ({
    reset: () => {
      onTokenRef.current(null);
      if (widgetId.current) window.turnstile?.reset(widgetId.current);
    },
  }));

  React.useEffect(() => {
    if (!TURNSTILE_SITE_KEY) return;
    let cancelled = false;
    loadTurnstile()
      .then(() => {
        if (cancelled || !el.current || !window.turnstile) return;
        widgetId.current = window.turnstile.render(el.current, {
          sitekey: TURNSTILE_SITE_KEY,
          action,
          theme: "auto",
          callback: (t: string) => onTokenRef.current(t),
          "expired-callback": () => onTokenRef.current(null),
          "error-callback": () => onTokenRef.current(null),
        });
      })
      .catch(() => setFailed(true));
    return () => {
      cancelled = true;
      if (widgetId.current) window.turnstile?.remove(widgetId.current);
      widgetId.current = null;
    };
  }, [action]);

  if (!TURNSTILE_SITE_KEY) return null;
  return (
    <div className="space-y-1">
      <div ref={el} className="min-h-[65px]" />
      {failed && (
        <p className="text-xs text-destructive">
          The security check couldn&apos;t load. Check your connection, or disable any blocker for
          challenges.cloudflare.com, then reload the page.
        </p>
      )}
    </div>
  );
});
