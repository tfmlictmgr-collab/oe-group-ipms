"use client";

import * as React from "react";
import { toast } from "sonner";
import {
  ChevronLeft, ChevronRight, Save, Upload, Check, ShieldCheck, FileText, Lock,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { runAction, describeError } from "@/lib/run-action";
import {
  sectionsFor, REQUIRED_DOCUMENTS, OPTIONAL_DOCUMENTS, CONSENT_STATEMENT,
  type Field,
} from "@/lib/application-form";
import { saveDraft, submitApplication, createUploadTarget } from "./actions";

type Kind = "individual" | "corporate";

export default function ApplicationForm({
  applicationId, resumeToken, type, orgName, initialValues, supabaseUrl, anonKey,
}: {
  applicationId: string;
  resumeToken: string;
  type: Kind;
  orgName: string;
  initialValues: Record<string, unknown>;
  supabaseUrl: string;
  anonKey: string;
}) {
  const sections = sectionsFor(type);
  // Documents are the last step: asking for a passport photo before someone has
  // typed their name is how an application gets abandoned.
  const steps = [...sections.map((s) => s.title), "Documents", "Consent"];

  const [step, setStep] = React.useState(0);
  const [values, setValues] = React.useState<Record<string, unknown>>(initialValues);
  const [uploaded, setUploaded] = React.useState<Record<string, string>>({});
  const [consented, setConsented] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [done, setDone] = React.useState<string | null>(null);

  const set = (k: string, v: unknown) => setValues((s) => ({ ...s, [k]: v }));

  // Autosave on step change rather than per keystroke — a phone on Nigerian
  // mobile data should not be making a request per character, and a dropped
  // connection mid-form must not lose the page just completed.
  async function persist(silent = true) {
    try {
      await runAction(saveDraft(applicationId, resumeToken, type, values));
      if (!silent) toast.success("Saved", { description: "You can close this and come back." });
      return true;
    } catch (e) {
      toast.error("Could not save", { description: describeError(e) });
      return false;
    }
  }

  async function go(next: number) {
    setBusy(true);
    const okSave = await persist();
    setBusy(false);
    if (okSave) { setStep(next); window.scrollTo({ top: 0, behavior: "smooth" }); }
  }

  async function upload(kind: string, file: File) {
    setBusy(true);
    try {
      const target = await runAction(
        createUploadTarget(applicationId, resumeToken, kind, file.name, file.type, file.size)
      );
      // Signed upload straight to storage — the file never passes through our
      // server, so a 10 MB scan does not occupy a serverless function.
      const res = await fetch(
        `${supabaseUrl}/storage/v1/object/upload/sign/application-documents/${target.path}?token=${target.token}`,
        { method: "PUT", headers: { "Content-Type": file.type, apikey: anonKey }, body: file }
      );
      if (!res.ok) throw new Error(`Upload failed (${res.status})`);
      setUploaded((u) => ({ ...u, [kind]: file.name }));
      toast.success("Uploaded", { description: file.name });
    } catch (e) {
      toast.error("Could not upload that file", { description: describeError(e) });
    } finally { setBusy(false); }
  }

  async function submit() {
    setBusy(true);
    try {
      const r = await runAction(
        submitApplication(applicationId, resumeToken, type, values, consented)
      );
      setDone(r.reference);
      window.scrollTo({ top: 0 });
    } catch (e) {
      toast.error("Not submitted", {
        description: describeError(e), duration: Infinity, closeButton: true,
      });
    } finally { setBusy(false); }
  }

  if (done) {
    return (
      <div className="space-y-4 rounded-xl border border-success/40 bg-success/5 p-6 text-center">
        <Check className="mx-auto size-10 text-success" />
        <h2 className="text-lg font-semibold">Application received</h2>
        <p className="text-sm text-muted-foreground">
          Your reference is <span className="font-mono font-medium">{done}</span>. The{" "}
          {orgName} letting team will review it and contact you at the email you gave.
        </p>
        <p className="text-xs text-muted-foreground">
          Every application is read by a person. Nothing here is decided automatically.
        </p>
      </div>
    );
  }

  const isDocs = step === sections.length;
  const isConsent = step === sections.length + 1;
  const section = sections[step];

  return (
    <div className="space-y-6">
      {/* Progress — a long form on a phone needs to say how much is left. */}
      <div className="space-y-2">
        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span>Step {step + 1} of {steps.length}</span>
          <span>{steps[step]}</span>
        </div>
        <div className="flex gap-1">
          {steps.map((s, i) => (
            <span key={s} className={cn(
              "h-1 flex-1 rounded-full",
              i <= step ? "bg-[var(--brand)]" : "bg-muted"
            )} />
          ))}
        </div>
      </div>

      {section && (
        <div className="space-y-4">
          <div>
            <h2 className="text-lg font-semibold">{section.title}</h2>
            {section.description && (
              <p className="mt-1 text-sm text-muted-foreground">{section.description}</p>
            )}
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            {section.fields.map((f) => (
              <FieldInput key={f.key} field={f} value={values[f.key]} onChange={set} />
            ))}
          </div>
        </div>
      )}

      {isDocs && (
        <div className="space-y-4">
          <div>
            <h2 className="text-lg font-semibold">Documents</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Photographs of documents are fine — they do not need to be scanned.
              PDF, JPG, PNG or WEBP, up to 10 MB each.
            </p>
          </div>
          {REQUIRED_DOCUMENTS[type].map((d) => (
            <DocRow key={d.kind} kind={d.kind} label={d.label} required
                    uploadedName={uploaded[d.kind]} busy={busy} onPick={upload} />
          ))}
          <p className="pt-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Optional
          </p>
          {OPTIONAL_DOCUMENTS.map((d) => (
            <DocRow key={d.kind} kind={d.kind} label={d.label}
                    uploadedName={uploaded[d.kind]} busy={busy} onPick={upload} />
          ))}
        </div>
      )}

      {isConsent && (
        <div className="space-y-4">
          <h2 className="text-lg font-semibold">Before you send it</h2>

          <div className="rounded-lg border border-border bg-muted/40 p-4 text-sm">
            {CONSENT_STATEMENT}
          </div>

          <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-border p-4">
            <input
              type="checkbox" className="mt-0.5 size-4"
              checked={consented} onChange={(e) => setConsented(e.target.checked)}
            />
            <span className="text-sm">
              I have read and agree to the above.
            </span>
          </label>

          <div className="flex items-start gap-2 rounded-lg bg-info/8 p-3 text-xs text-muted-foreground">
            <ShieldCheck className="mt-0.5 size-4 flex-shrink-0 text-info" />
            <p>
              A person reviews every application. Nothing about it is decided by a
              computer, and your information is not used to rank or score you.
            </p>
          </div>
        </div>
      )}

      <div className="flex items-center justify-between gap-3 border-t border-border pt-4">
        <Button
          variant="ghost" disabled={step === 0 || busy}
          onClick={() => setStep((s) => Math.max(0, s - 1))}
        >
          <ChevronLeft className="size-4" /> Back
        </Button>

        <div className="flex gap-2">
          {!isConsent && (
            <Button variant="outline" disabled={busy} onClick={() => persist(false)}>
              <Save className="size-4" /> Save
            </Button>
          )}
          {isConsent ? (
            <Button variant="brand" disabled={busy || !consented} onClick={submit}>
              {busy ? "Sending…" : "Submit application"}
            </Button>
          ) : (
            <Button variant="brand" disabled={busy} onClick={() => go(step + 1)}>
              Next <ChevronRight className="size-4" />
            </Button>
          )}
        </div>
      </div>

      <p className="text-center text-xs text-muted-foreground">
        Your answers are saved as you go. You can close this page and return using
        the link we emailed you — for 30 days.
      </p>
    </div>
  );
}

function FieldInput({
  field, value, onChange,
}: {
  field: Field;
  value: unknown;
  onChange: (k: string, v: unknown) => void;
}) {
  const id = `f-${field.key}`;
  const wrap = field.half ? "space-y-1.5" : "space-y-1.5 sm:col-span-2";

  return (
    <div className={wrap}>
      <Label htmlFor={id} className="flex items-center gap-2">
        {field.label}
        {field.required && <span className="text-destructive">*</span>}
        {field.sensitive && (
          <Badge variant="muted" className="gap-1 text-[0.65rem]">
            <Lock className="size-2.5" /> optional
          </Badge>
        )}
      </Label>

      {field.type === "select" ? (
        <Select id={id} value={String(value ?? "")} onChange={(e) => onChange(field.key, e.target.value)}>
          <option value="">— select —</option>
          {field.options?.map((o) => <option key={o} value={o}>{o}</option>)}
        </Select>
      ) : field.type === "textarea" ? (
        <textarea
          id={id} rows={3} value={String(value ?? "")}
          onChange={(e) => onChange(field.key, e.target.value)}
          className="flex w-full rounded-md border border-border bg-card px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)]"
        />
      ) : field.type === "checkbox" ? (
        <label className="flex items-center gap-2 pt-1 text-sm">
          <input
            id={id} type="checkbox" className="size-4"
            checked={Boolean(value)} onChange={(e) => onChange(field.key, e.target.checked)}
          />
          Yes
        </label>
      ) : (
        <Input
          id={id} type={field.type} value={String(value ?? "")}
          onChange={(e) => onChange(field.key, e.target.value)}
          // A phone keyboard that matches the field is the difference between a
          // form filled on mobile and one abandoned on mobile.
          inputMode={field.type === "tel" ? "tel" : field.type === "number" ? "decimal" : undefined}
        />
      )}

      {field.hint && <p className="text-xs text-muted-foreground">{field.hint}</p>}
    </div>
  );
}

function DocRow({
  kind, label, required, uploadedName, busy, onPick,
}: {
  kind: string;
  label: string;
  required?: boolean;
  uploadedName?: string;
  busy: boolean;
  onPick: (kind: string, file: File) => void;
}) {
  const ref = React.useRef<HTMLInputElement>(null);
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border p-3">
      <div className="min-w-0">
        <p className="text-sm font-medium">
          {label} {required && <span className="text-destructive">*</span>}
        </p>
        {uploadedName ? (
          <p className="flex items-center gap-1.5 text-xs text-success">
            <Check className="size-3" /> {uploadedName}
          </p>
        ) : (
          <p className="text-xs text-muted-foreground">Not uploaded</p>
        )}
      </div>
      <input
        ref={ref} type="file" className="sr-only"
        accept="image/jpeg,image/png,image/webp,application/pdf"
        onChange={(e) => { const f = e.target.files?.[0]; if (f) onPick(kind, f); }}
      />
      <Button size="sm" variant="outline" disabled={busy} onClick={() => ref.current?.click()}>
        {uploadedName ? <FileText className="size-4" /> : <Upload className="size-4" />}
        {uploadedName ? "Replace" : "Upload"}
      </Button>
    </div>
  );
}
