import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";
import "./globals.css";
import { ThemeProvider } from "@/components/theme-provider";
import LazyToaster from "@/components/lazy-toaster";

// ⚠️ 131 kB of font was downloading on every page, including the sign-in screen
// — measured on a live domain, where fonts and JS were 381 kB of a 394 kB cold
// load. On a 400 kbps connection that is the difference between slow and
// abandoned, and Nigerian mobile bandwidth is the target here, not an edge case.
//
// `display: "swap"` renders the text immediately in a fallback face and swaps
// when the webfont arrives. Without it the browser holds text invisible while it
// waits — the worst possible behaviour on a slow link, because the page looks
// broken rather than plain.
const geistSans = localFont({
  src: "./fonts/GeistVF.woff",
  variable: "--font-geist-sans",
  weight: "100 900",
  display: "swap",
});

// ⚠️ NOT preloaded. Monospace is used for asset tags, payment references and a
// few form fields — real usage, so it cannot simply be dropped — but nothing on
// the sign-in page renders it, and it was still costing ~66 kB there.
//
// `preload: false` keeps the face available everywhere while leaving the fetch
// to the browser, which only requests it when a rule actually applies it. The
// pages that use it pay for it; the pages that do not, do not.
const geistMono = localFont({
  src: "./fonts/GeistMonoVF.woff",
  variable: "--font-geist-mono",
  weight: "100 900",
  display: "swap",
  preload: false,
});

// ⚠️ Names no client, and must not.
//
// This read "...for TFML and OEA — ..." and, being the ROOT metadata, was
// inherited by every page that does not set its own — including each org's
// branded door. So `oeaportal.com` served a description naming TFML.
//
// 📌 Worse than the sign-in footer leak, and for a reason that is easy to miss:
// a meta description is not just on-page text. It is what Google shows in
// results and what WhatsApp, Slack and iMessage render in a link preview. A
// client pasting their own portal link into a group chat would have published
// the other brand's name to that room. B1 forbids revealing another brand's
// **existence**, and a link preview is exactly that, at scale.
//
// Per-org pages override this in their own `generateMetadata`.
export const metadata: Metadata = {
  title: "OE Group — Integrated FM & Property Management",
  description:
    "Facilities and property management in one auditable workspace — requests, service charges, vendor payments and reporting.",
};

// Explicit rather than relying on Next's own default. `viewportFit: "cover"`
// draws under the notch/home-indicator on a real phone (every screenshot from
// testing showed one) instead of leaving bars of unstyled browser chrome at
// the top and bottom. Zoom is deliberately left alone — WCAG 1.4.4 requires
// pinch-to-zoom to keep working, so this never sets `userScalable: false` or
// a `maximumScale`, however tempting that is for an "app-like" feel.
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning className="overflow-x-hidden">
      {/*
        `overflow-x-hidden` on body is the last line of defence, not the fix
        itself — every wide element (Table, MatrixEditor) already scrolls
        inside its own container. This just guarantees that if a future page
        adds one that doesn't, the PAGE still can't scroll sideways on a
        phone; the offending element clips instead of dragging the whole
        viewport with it.

        ⚠️ Needed on BOTH html and body, not body alone. Found 2026-08-20: a
        `position: fixed` element (record-drawer.tsx, always mounted and slid
        off-screen via `translate-x-full` while closed) is positioned against
        the viewport/initial containing block, which `<body>`'s own overflow
        never clips — only `<html>` does. With only body covered, every page
        using that drawer carried a permanent phantom horizontal scrollbar
        and a blank strip the width of the closed drawer, because `<html>`
        was left at its default `overflow-x: visible`.
      */}
      <body className={`${geistSans.variable} ${geistMono.variable} overflow-x-hidden font-sans antialiased`}>
        <ThemeProvider
          attribute="class"
          defaultTheme="light"
          enableSystem
          disableTransitionOnChange
        >
          {children}
          <LazyToaster />
        </ThemeProvider>
      </body>
    </html>
  );
}
