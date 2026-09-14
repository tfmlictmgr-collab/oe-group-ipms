"use client";

import * as React from "react";
import { toast } from "sonner";
import { CheckCircle2, AlertCircle, Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input, Textarea } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { submitVendorApplication } from "./actions";

const FIELDS = [
  { key: "businessName", label: "Registered business name", required: true, placeholder: "e.g. PowerGen Services Ltd" },
  { key: "serviceCategory", label: "Service category", placeholder: "e.g. Generator maintenance" },
  { key: "cacNumber", label: "CAC registration number", placeholder: "e.g. RC 1234567" },
  { key: "tin", label: "Tax Identification Number (TIN)", placeholder: "e.g. 01234567-0001" },
  { key: "contactName", label: "Contact person", required: true, placeholder: "e.g. Chidi Okafor" },
  { key: "contactEmail", label: "Contact email", required: true, type: "email", placeholder: "name@company.com" },
  { key: "contactPhone", label: "Contact phone", placeholder: "+234 800 000 0000" },
  { key: "website", label: "Website", placeholder: "https://…" },
] as const;

export default function ApplyForm({
  orgId,
  turnstileSiteKey,
}: {
  orgId: string;
  turnstileSiteKey: string | null;
}) {
  const [form, setForm] = React.useState<Record<string, string>>({});
  const [honeypot, setHoneypot] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [done, setDone] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  // Used to reject submissions that arrive impossibly fast for a human.
  const renderedAt = React.useRef<number>(Date.now());

  const set = (k: string) => (
    e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>
  ) => setForm((f) => ({ ...f, [k]: e.target.value }));

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const token =
        turnstileSiteKey && typeof window !== "undefined"
          ? ((window as unknown as { turnstile?: { getResponse: () => string } })
              .turnstile?.getResponse() ?? null)
          : null;

      const res = await submitVendorApplication({
        orgId,
        businessName: form.businessName ?? "",
        serviceCategory: form.serviceCategory ?? "",
        cacNumber: form.cacNumber ?? "",
        tin: form.tin ?? "",
        address: form.address ?? "",
        website: form.website ?? "",
        contactName: form.contactName ?? "",
        contactEmail: form.contactEmail ?? "",
        contactPhone: form.contactPhone ?? "",
        notes: form.notes ?? "",
        turnstileToken: token,
        honeypot,
        renderedAt: renderedAt.current,
      });

      if (res.ok) {
        setDone(true);
        toast.success("Application submitted");
      } else {
        setError(res.message);
        toast.error("Not submitted", { description: res.message });
      }
    } catch {
      setError("Something went wrong. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <div className="space-y-3 rounded-lg border border-border bg-card p-6 text-center shadow-sm">
        <CheckCircle2 className="mx-auto size-10 text-success" />
        <h2 className="text-lg font-semibold">Application received</h2>
        <p className="text-sm text-muted-foreground">
          Thank you. Our team will review your details and get in touch. If we
          sent you a confirmation email, please click the link in it to verify
          your address — it helps us process your application faster.
        </p>
      </div>
    );
  }

  return (
    <form onSubmit={onSubmit} className="space-y-5">
      {/* Honeypot: positioned off-screen rather than display:none, because some
          bots skip hidden inputs. Real users never see or tab to it. */}
      <div aria-hidden="true" className="absolute left-[-9999px] top-auto h-px w-px overflow-hidden">
        <label htmlFor="company_website_alt">Leave this field empty</label>
        <input
          id="company_website_alt"
          name="company_website_alt"
          type="text"
          tabIndex={-1}
          autoComplete="off"
          value={honeypot}
          onChange={(e) => setHoneypot(e.target.value)}
        />
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        {FIELDS.map((f) => (
          <div key={f.key} className="space-y-1.5">
            <Label htmlFor={f.key}>
              {f.label}
              {!("required" in f && f.required) && (
                <span className="ml-1 font-normal text-muted-foreground">(optional)</span>
              )}
            </Label>
            <Input
              id={f.key}
              type={"type" in f ? f.type : "text"}
              required={"required" in f ? f.required : false}
              value={form[f.key] ?? ""}
              onChange={set(f.key)}
              placeholder={f.placeholder}
            />
          </div>
        ))}
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="address">
          Business address <span className="font-normal text-muted-foreground">(optional)</span>
        </Label>
        <Textarea id="address" rows={2} value={form.address ?? ""} onChange={set("address")} />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="notes">
          Anything else we should know{" "}
          <span className="font-normal text-muted-foreground">(optional)</span>
        </Label>
        <Textarea
          id="notes"
          rows={3}
          value={form.notes ?? ""}
          onChange={set("notes")}
          placeholder="Services you provide, notable clients, certifications…"
        />
      </div>

      {turnstileSiteKey && (
        <div
          className="cf-turnstile"
          data-sitekey={turnstileSiteKey}
          data-theme="auto"
        />
      )}

      {error && (
        <p
          role="alert"
          className="flex items-start gap-2 rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          <AlertCircle className="mt-0.5 size-4 flex-shrink-0" />
          {error}
        </p>
      )}

      <div className="space-y-3">
        <Button type="submit" variant="brand" size="lg" className="w-full" disabled={busy}>
          <Send /> {busy ? "Submitting…" : "Submit application"}
        </Button>
        <p className="text-xs text-muted-foreground">
          Submitting does not create an account or make you an approved vendor.
          Every application is reviewed by a person, and no work can be assigned
          or paid until it is approved.
        </p>
      </div>
    </form>
  );
}
