"use client";

import dynamic from "next/dynamic";

// The toast layer, kept out of the initial bundle.
//
// ⚠️ `sonner` was imported directly by the root layout, so every page carried it
// — including the sign-in screen, which shows its errors inline and never
// toasts at all. Measured on a live domain, the sign-in page cost 236 kB of
// JavaScript while containing 314 B of its own.
//
// Moving `<Toaster>` into the layouts that need it would mean editing five
// public pages and being right about all of them; missing one breaks its toasts
// silently, and nothing would fail a build or a suite to say so. Deferring it
// is one change with the same effect and no way to get it wrong.
//
// ⚠️ `ssr: false` is correct here rather than a shortcut: a toast is a response
// to something the user did, so it cannot exist before hydration. There is
// nothing to render on the server and nothing to hydrate — only a container
// waiting to be told something happened.
const Toaster = dynamic(
  () => import("sonner").then((m) => m.Toaster),
  { ssr: false }
);

export default function LazyToaster() {
  return <Toaster richColors position="top-right" closeButton />;
}
