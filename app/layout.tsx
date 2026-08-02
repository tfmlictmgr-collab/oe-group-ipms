import type { Metadata } from "next";
import localFont from "next/font/local";
import "./globals.css";
import { ThemeProvider } from "@/components/theme-provider";
import { Toaster } from "sonner";

const geistSans = localFont({
  src: "./fonts/GeistVF.woff",
  variable: "--font-geist-sans",
  weight: "100 900",
});
const geistMono = localFont({
  src: "./fonts/GeistMonoVF.woff",
  variable: "--font-geist-mono",
  weight: "100 900",
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
          <Toaster richColors position="top-right" closeButton />
        </ThemeProvider>
      </body>
    </html>
  );
}
