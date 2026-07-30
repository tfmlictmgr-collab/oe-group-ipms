"use client";

import * as React from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { runAction, describeError } from "@/lib/run-action";
import { startApplication } from "./actions";
import ApplicationForm from "./ApplicationForm";

// Three fields before the long form starts.
//
// The application is created on the FIRST screen, not the last, so the resume
// token exists before anyone has typed anything worth losing. Someone who fills
// four sections on a phone and loses signal should come back to four sections,
// not to a blank page.
export default function StartApplication({
  orgId, propertyId, propertyName, type, brandName,
}: {
  orgId: string;
  /** Which property they are applying to — set by the link they arrived through. */
  propertyId: string;
  propertyName: string;
  type: "individual" | "corporate";
  brandName: string;
}) {
  const [form, setForm] = React.useState({ name: "", email: "", phone: "" });
  const [busy, setBusy] = React.useState(false);
  const [started, setStarted] = React.useState<{ id: string; token: string } | null>(null);

  // Survives a refresh on the same device without an account. The token is also
  // emailed, which is what covers a different device.
  React.useEffect(() => {
    // Keyed by PROPERTY as well as type: someone applying to two properties has
    // two applications, and restoring the wrong one would put their answers on
    // the wrong tenancy.
    const saved = window.localStorage.getItem(`oe-apply-${orgId}-${propertyId}-${type}`);
    if (saved) {
      try { setStarted(JSON.parse(saved)); } catch { /* corrupt entry, start fresh */ }
    }
  }, [orgId, propertyId, type]);

  async function begin(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const r = await runAction(
        startApplication({ orgId, propertyId, type, name: form.name, email: form.email, phone: form.phone })
      );
      const next = { id: r.id, token: r.resumeToken };
      window.localStorage.setItem(`oe-apply-${orgId}-${propertyId}-${type}`, JSON.stringify(next));
      setStarted(next);
    } catch (err) {
      toast.error("Could not start the application", {
        description: describeError(err), duration: Infinity, closeButton: true,
      });
    } finally { setBusy(false); }
  }

  if (started) {
    return (
      <ApplicationForm
        applicationId={started.id}
        resumeToken={started.token}
        type={type}
        orgName={brandName}
        initialValues={{}}
        supabaseUrl={process.env.NEXT_PUBLIC_SUPABASE_URL!}
        anonKey={process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!}
      />
    );
  }

  return (
    <form onSubmit={begin} className="space-y-4">
      <p className="rounded-lg border border-border bg-accent/40 px-3 py-2 text-xs text-muted-foreground">
        Applying to <span className="font-medium text-foreground">{propertyName}</span>
      </p>
      <div>
        <h1 className="text-xl font-semibold">
          {type === "corporate" ? "Business tenancy application" : "Tenancy application"}
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Just enough to save your progress. The rest comes next, and you can stop
          and return at any point.
        </p>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="s-name">
          {type === "corporate" ? "Your name" : "Full name"} <span className="text-destructive">*</span>
        </Label>
        <Input
          id="s-name" required value={form.name}
          onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
        />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="s-email">Email address <span className="text-destructive">*</span></Label>
        <Input
          id="s-email" type="email" required value={form.email}
          onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))}
        />
        <p className="text-xs text-muted-foreground">
          We send your return link here, and this is how the letting team replies.
        </p>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="s-phone">Phone number</Label>
        <Input
          id="s-phone" type="tel" inputMode="tel" value={form.phone}
          onChange={(e) => setForm((f) => ({ ...f, phone: e.target.value }))}
          placeholder="+234…"
        />
      </div>

      <Button
        type="submit" variant="brand" className="w-full"
        disabled={busy || form.name.trim().length < 2 || !form.email.includes("@")}
      >
        {busy ? "Starting…" : "Start application"}
      </Button>
    </form>
  );
}
