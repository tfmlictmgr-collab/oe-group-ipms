import type { Metadata } from "next";
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

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className={`${geistSans.variable} ${geistMono.variable} font-sans antialiased`}>
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
