"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  CheckCircle2, CircleAlert, Paperclip, Send, Upload, Users,
} from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";
import { runAction, describeError } from "@/lib/run-action";
import {
  saveRegistration, submitRegistration, recordDocument,
  setVendorUserCapabilities, removeVendorUser,
} from "./actions";

const BUCKET = "vendor-documents";

/**
 * ⚠️ THREE NUMBERS THAT HAVE TO AGREE, and did not.
 *
 * The bucket (0164) was created with a 15 MB limit and
 * `image/jpeg,image/png,image/webp,application/pdf`. This file allowed 5 MB and
 * additionally offered `image/heic` — so an iPhone photo passed the check here
 * and was then refused by storage, with the bucket's own message. The board has
 * set the limit at 2 MB (decision 23); 0213 moves the bucket to match, and HEIC
 * is gone from this list because the bucket never accepted it.
 *
 * Anything changed here must change in 0213 too. They are stated in both places
 * because the browser has to say "too big" BEFORE spending a minute of a
 * Nigerian mobile connection uploading it, and the bucket has to refuse it
 * regardless of what the browser said.
 */
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_LABEL = "2 MB";
const ACCEPTED = ["application/pdf", "image/jpeg", "image/png", "image/webp"];
const ACCEPTED_LABEL = "PDF, JPG, PNG or WebP";

function prettyBytes(n: number): string {
  return n >= 1024 * 1024
    ? `${(n / (1024 * 1024)).toFixed(1)} MB`
    : `${Math.max(1, Math.round(n / 1024))} KB`;
}

/**
 * Why this particular file cannot be attached, in words the person can act on.
 * Returns null when it is fine.
 *
 * ⚠️ Some browsers report an empty `type` for files picked from certain sources
 * (and always for HEIC on older Android WebViews), so an unknown type falls
 * back to the extension rather than being refused outright — refusing a valid
 * PDF because the browser declined to name it is the failure this whole
 * function exists to stop.
 */
function rejectReason(file: File): string | null {
  const ext = (file.name.split(".").pop() ?? "").toLowerCase();
  const extOk = ["pdf", "jpg", "jpeg", "png", "webp"].includes(ext);
  const typeKnown = Boolean(file.type);

  if (/^hei[cf]$/.test(ext) || file.type === "image/heic" || file.type === "image/heif") {
    return `iPhone HEIC photos are not accepted. In Settings → Camera → Formats choose "Most Compatible", or open the photo and share it as a JPEG.`;
  }
  if (typeKnown ? !ACCEPTED.includes(file.type) : !extOk) {
    return `That is a ${ext ? `.${ext}` : "an unrecognised"} file. Attach ${ACCEPTED_LABEL}.`;
  }
  if (file.size === 0) {
    return "That file is empty — it may not have finished downloading to your device.";
  }
  if (file.size > MAX_BYTES) {
    return `That file is ${prettyBytes(file.size)}. The limit is ${MAX_LABEL} — photograph the document in your camera's normal quality rather than its highest, or scan it as a PDF.`;
  }
  return null;
}

export type Requirement = {
  tier: string;
  doc_type: string;
  required: boolean;
  label: string;
  help_text: string | null;
  sort_order: number;
};
export type VendorDoc = {
  id: string;
  doc_type: string;
  file_name: string | null;
  uploaded_at: string;
  verified_at: string | null;
  expires_on: string | null;
};
export type VendorMember = {
  id: string;
  userId: string;
  isOwner: boolean;
  capabilities: string[];
  name: string;
  email: string | null;
};
export type RegistrationRow = Record<string, string | null> | null;

/** The four fixed capabilities (decision 17). Set by migration, configurable by nobody. */
const CAPABILITIES: { key: string; label: string; hint: string }[] = [
  { key: "manage_users", label: "Manage people", hint: "Invite colleagues and set what they may do." },
  { key: "manage_profile", label: "Manage company details", hint: "Edit the registration and attach documents." },
  { key: "manage_work", label: "Manage work", hint: "Accept, decline and complete jobs; submit invoices." },
  { key: "manage_contracts", label: "Manage contracts", hint: "Act on contracts and introductions." },
];

/**
 * The compliance declaration, shown verbatim and stored verbatim.
 *
 * ⚠️ `vendor_registration_missing()` has required `compliance_declared_at`
 * since 0164 and NOTHING IN THE PRODUCT EVER WROTE IT — so a vendor who filled
 * every field and attached every document was still told "still outstanding:
 * the compliance declaration", with no control anywhere that could satisfy it.
 * That is the dead end the 28 Aug demo hit. This is the control.
 *
 * Changing this wording does not rewrite what anyone already agreed to: the
 * text is saved onto the vendor's own row (decision 10's rule for consent copy).
 */
const COMPLIANCE_STATEMENT =
  "I confirm that the information given here is true and complete, that the " +
  "documents attached are genuine and current, and that this company complies " +
  "with its tax, statutory and regulatory obligations. I understand that this " +
  "organisation will verify these details, and I will tell them promptly if " +
  "anything here changes.";

const STATUS_COPY: Record<string, { label: string; tone: "muted" | "warning" | "success" }> = {
  draft: { label: "Not yet submitted", tone: "muted" },
  submitted: { label: "With the organisation for review", tone: "warning" },
  changes_requested: { label: "Changes requested", tone: "warning" },
  approved: { label: "Approved", tone: "success" },
};

export default function CompanyClient({
  vendorId, orgId, tier, status, missing, registration, documents, requirements,
  members, canManageProfile, canManageUsers, myVendorUserId,
}: {
  vendorId: string;
  orgId: string;
  tier: string;
  status: string;
  missing: string[];
  registration: RegistrationRow;
  documents: VendorDoc[];
  requirements: Requirement[];
  members: VendorMember[];
  canManageProfile: boolean;
  canManageUsers: boolean;
  myVendorUserId: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = React.useState(false);
  /** Which doc_type is mid-upload, so the row can say so rather than the page. */
  const [uploading, setUploading] = React.useState<string | null>(null);
  /** The last refusal per doc_type, kept ON THE ROW — a toast the person has
   *  already dismissed is not an explanation they can still act on. */
  const [rejected, setRejected] = React.useState<Record<string, string>>({});
  const r = registration ?? {};
  const [form, setForm] = React.useState({
    legalName: r.legal_name ?? "",
    tradingName: r.trading_name ?? "",
    cacNumber: r.cac_number ?? "",
    tin: r.tin ?? "",
    businessType: r.business_type ?? "",
    address: r.address ?? "",
    city: r.city ?? "",
    state: r.state ?? "",
    phone: r.phone ?? "",
    email: r.email ?? "",
    website: r.website ?? "",
    bankName: r.bank_name ?? "",
    accountName: r.account_name ?? "",
    accountNumberLast4: r.account_number_last4 ?? "",
  });
  // Ticked iff a declaration is already on file. Unticking retracts it.
  const [declared, setDeclared] = React.useState(Boolean(r.compliance_declared_at));

  // Locked once the pack is with the organisation: editing underneath a
  // reviewer is how they approve something other than what they read.
  const locked = !canManageProfile || status === "submitted" || status === "approved";
  const st = STATUS_COPY[status] ?? STATUS_COPY.draft;
  /** No registration row yet — the one blocker whose message names no action. */
  const notStarted = missing.length === 1 && /has not been started/.test(missing[0] ?? "");
  const byType = new Map(documents.map((d) => [d.doc_type, d]));

  function set(k: keyof typeof form, v: string) {
    setForm((f) => ({ ...f, [k]: v }));
  }

  async function save() {
    setBusy(true);
    try {
      await runAction(
        saveRegistration(vendorId, {
          ...form,
          complianceStatement: COMPLIANCE_STATEMENT,
          declareCompliance: declared,
        })
      );
      toast.success("Saved");
      router.refresh();
    } catch (e) {
      toast.error("Could not save", { description: describeError(e) });
    } finally {
      setBusy(false);
    }
  }

  async function submit() {
    setBusy(true);
    try {
      await runAction(submitRegistration());
      toast.success("Sent for review", {
        description: "The organisation will verify your pack and come back to you.",
      });
      router.refresh();
    } catch (e) {
      toast.error("Could not submit", { description: describeError(e), duration: Infinity, closeButton: true });
    } finally {
      setBusy(false);
    }
  }

  async function upload(docType: string, file: File) {
    // Said before a byte is sent, and said specifically. "Could not attach that
    // document" is what the demo saw, and it tells the person nothing about
    // what to do differently.
    const why = rejectReason(file);
    if (why) {
      setRejected((m) => ({ ...m, [docType]: why }));
      toast.error("That file cannot be attached", { description: why });
      return;
    }
    setRejected((m) => {
      const next = { ...m };
      delete next[docType];
      return next;
    });

    setBusy(true);
    setUploading(docType);
    try {
      const supabase = createClient();
      const ext = (file.name.split(".").pop() || "bin").toLowerCase();

      // ⚠️ THE BUG THE DEMO HIT. This was `${vendorId}/${docType}-…`, and the
      // storage policy (0164) requires the FIRST path segment to be the
      // organisation:
      //
      //     (storage.foldername(name))[1]::uuid = current_user_org_id()
      //
      // So every single attach failed RLS, the pack never completed, and
      // "Send for review" stayed disabled with no way for the vendor to
      // discover why. `<org>/<vendor>/<doc>` is the convention
      // `accept_vendor_introduction` (0165) already writes for the copies it
      // makes — this brings the one path that a human actually uses into line
      // with the one the transfer job was already using.
      const path = `${orgId}/${vendorId}/${docType}-${crypto.randomUUID()}.${ext}`;

      const { error } = await supabase.storage.from(BUCKET).upload(path, file, {
        contentType: file.type || undefined,
      });
      if (error) throw new Error(error.message);

      // Only after the bytes are actually there. `recordDocument` writing first
      // would tell a reviewer a document is present when it is not — the same
      // ordering rule the cross-brand transfer job states at length.
      await runAction(
        recordDocument({ vendorId, docType, storagePath: path, fileName: file.name, expiresOn: null })
      );
      toast.success(`${file.name} attached`);
      router.refresh();
    } catch (e) {
      const msg = describeError(e);
      setRejected((m) => ({ ...m, [docType]: msg }));
      toast.error("Could not attach that document", { description: msg });
    } finally {
      setUploading(null);
      setBusy(false);
    }
  }

  async function toggleCapability(m: VendorMember, key: string) {
    const next = m.capabilities.includes(key)
      ? m.capabilities.filter((c) => c !== key)
      : [...m.capabilities, key];
    try {
      await runAction(setVendorUserCapabilities(m.id, next));
      router.refresh();
    } catch (e) {
      toast.error("Could not change that", { description: describeError(e) });
    }
  }

  async function remove(m: VendorMember) {
    try {
      await runAction(removeVendorUser(m.id));
      toast.success(`${m.name} removed`);
      router.refresh();
    } catch (e) {
      toast.error("Could not remove that person", { description: describeError(e) });
    }
  }

  return (
    <div className="space-y-6">
      {/* ── Where the registration stands ─────────────────────────────── */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <CardTitle className="text-base">Registration</CardTitle>
              <CardDescription>
                {tier === "enhanced"
                  ? "Enhanced pack — this organisation asks for ownership, directors and accounts as well."
                  : "Standard pack — CAC, TIN, bank evidence and proof of address."}
              </CardDescription>
            </div>
            <Badge variant={st.tone === "success" ? "success" : st.tone === "warning" ? "warning" : "muted"}>
              {st.label}
            </Badge>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {r.review_notes && status === "changes_requested" && (
            <p className="rounded-md bg-warning/10 px-3 py-2 text-sm">
              <span className="font-medium">What they asked for: </span>
              {r.review_notes}
            </p>
          )}

          {missing.length > 0 ? (
            <div className="space-y-1.5">
              <p className="flex items-center gap-2 text-sm font-medium">
                <CircleAlert className="size-4 text-warning" />
                Still needed ({notStarted ? "start here" : missing.length})
              </p>
              {/* ⚠️ `vendor_registration_missing()` returns ONE item and stops
                  when there is no registration row — "the registration has not
                  been started". True, and a dead end: it names no action and
                  hides the ten other things that will be needed. A vendor can
                  attach every document (the visibly effortful part) and still
                  be looking at this. Say what to press instead. */}
              {notStarted ? (
                <p className="ml-6 text-sm text-muted-foreground">
                  Fill in <span className="font-medium text-foreground">Company details</span> below
                  and press <span className="font-medium text-foreground">Save details</span>. That
                  starts your registration — the rest of the checklist appears here once it exists,
                  and your attached documents are already kept against it.
                </p>
              ) : (
                <ul className="ml-6 list-disc space-y-0.5 text-sm text-muted-foreground">
                  {missing.map((m) => <li key={m}>{m}</li>)}
                </ul>
              )}
            </div>
          ) : (
            <p className="flex items-center gap-2 text-sm text-success">
              <CheckCircle2 className="size-4" /> Everything needed is on file.
            </p>
          )}

          {canManageProfile && status !== "approved" && status !== "submitted" && (
            <Button onClick={submit} disabled={busy || missing.length > 0} variant="brand">
              <Send /> Send for review
            </Button>
          )}
          {/* ⚠️ Nothing here gates a payment (decision 17). An incomplete
              registration is a reason to chase a contractor, never a reason to
              withhold money they are owed for work already done. */}
          <p className="text-xs text-muted-foreground">
            Your registration does not hold up payment for work you have already
            done — it is how this organisation knows who they are paying.
          </p>
        </CardContent>
      </Card>

      {/* ── The company itself ────────────────────────────────────────── */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Company details</CardTitle>
          <CardDescription>
            {locked
              ? status === "submitted"
                ? "Locked while the organisation reviews your pack."
                : status === "approved"
                  ? "Approved. Ask the organisation if something needs changing."
                  : "You do not have permission to edit these."
              : "As registered with the CAC."}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field id="legalName" label="Registered business name" value={form.legalName} onChange={set} disabled={locked} />
            <Field id="tradingName" label="Trading name (if different)" value={form.tradingName} onChange={set} disabled={locked} />
            <Field id="cacNumber" label="CAC registration number" value={form.cacNumber} onChange={set} disabled={locked} />
            <Field id="tin" label="Tax Identification Number" value={form.tin} onChange={set} disabled={locked} />
            <Field id="businessType" label="Type of business" value={form.businessType} onChange={set} disabled={locked} />
            <Field id="phone" label="Contact phone" value={form.phone} onChange={set} disabled={locked} />
            <Field id="email" label="Contact email" value={form.email} onChange={set} disabled={locked} />
            <Field id="website" label="Website (optional)" value={form.website} onChange={set} disabled={locked} />
          </div>
          <Field id="address" label="Business address" value={form.address} onChange={set} disabled={locked} />
          <div className="grid gap-4 sm:grid-cols-2">
            <Field id="city" label="City" value={form.city} onChange={set} disabled={locked} />
            <Field id="state" label="State" value={form.state} onChange={set} disabled={locked} />
          </div>

          <Separator />

          <div className="space-y-3">
            <div>
              <p className="text-sm font-medium">Bank account</p>
              {/* Decision 17, said plainly to the person typing. */}
              <p className="text-xs text-muted-foreground">
                Only the last four digits. We never ask for or store the full
                account number here — attach your bank&apos;s own letter or
                statement header below, and finance reads it from there when they
                set you up to be paid.
              </p>
            </div>
            <div className="grid gap-4 sm:grid-cols-3">
              <Field id="bankName" label="Bank" value={form.bankName} onChange={set} disabled={locked} />
              <Field id="accountName" label="Account name" value={form.accountName} onChange={set} disabled={locked} />
              <Field id="accountNumberLast4" label="Last 4 digits" value={form.accountNumberLast4} onChange={set} disabled={locked} maxLength={4} />
            </div>
          </div>

          <Separator />

          {/* ⚠️ The control that did not exist. `vendor_registration_missing()`
              has required a compliance declaration since 0164 and nothing in
              the product ever wrote one, so the pack could never reach
              complete however much a vendor filled in. */}
          <div className="space-y-2">
            <p className="text-sm font-medium">Declaration</p>
            <label
              className={cn(
                "flex gap-2.5 rounded-md border border-border p-3",
                locked ? "opacity-70" : "cursor-pointer hover:bg-accent/40"
              )}
            >
              <input
                type="checkbox"
                className="mt-0.5 size-4 shrink-0 accent-[var(--brand)]"
                checked={declared}
                disabled={locked}
                onChange={(e) => setDeclared(e.target.checked)}
              />
              <span className="text-xs leading-relaxed text-muted-foreground">
                {COMPLIANCE_STATEMENT}
              </span>
            </label>
            {r.compliance_declared_at && (
              <p className="text-xs text-muted-foreground">
                Declared on{" "}
                {new Date(r.compliance_declared_at).toLocaleDateString("en-NG", {
                  day: "numeric", month: "long", year: "numeric",
                })}
                .
              </p>
            )}
          </div>

          {!locked && (
            <Button onClick={save} disabled={busy} variant="brand">
              {busy ? "Saving…" : "Save details"}
            </Button>
          )}
        </CardContent>
      </Card>

      {/* ── Documents ─────────────────────────────────────────────────── */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Documents</CardTitle>
          <CardDescription>
            {requirements.filter((q) => q.required).length} required for your tier.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {/* Stated ONCE, before the list, and again on every row — because the
              demo failed at the file picker and the rules were nowhere near
              it. */}
          <div className="rounded-md border border-border bg-muted/40 px-3 py-2.5 text-xs">
            <p className="font-medium">Before you attach anything</p>
            <ul className="mt-1 space-y-0.5 text-muted-foreground">
              <li>· {ACCEPTED_LABEL} only — one file per document.</li>
              <li>· Up to {MAX_LABEL} each. A phone photo on normal quality is well under it; the highest quality setting is not.</li>
              <li>· iPhone photos save as HEIC by default and are not accepted — Settings → Camera → Formats → &ldquo;Most Compatible&rdquo;.</li>
              <li>· Make sure the whole page is in frame and the text is readable.</li>
            </ul>
          </div>

          {requirements.map((req) => {
            const doc = byType.get(req.doc_type);
            const problem = rejected[req.doc_type];
            const isUploading = uploading === req.doc_type;
            return (
              <div
                key={req.doc_type}
                className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border p-3"
              >
                <div className="min-w-0 flex-1">
                  <p className="flex items-center gap-2 text-sm font-medium">
                    {req.label}
                    {req.required ? (
                      <Badge variant="outline" className="text-[10px]">Required</Badge>
                    ) : (
                      <Badge variant="muted" className="text-[10px]">Optional</Badge>
                    )}
                    {doc?.verified_at && (
                      <Badge variant="success" className="text-[10px]">Verified</Badge>
                    )}
                  </p>
                  {req.help_text && (
                    <p className="mt-0.5 text-xs text-muted-foreground">{req.help_text}</p>
                  )}
                  {doc ? (
                    <p className="mt-1 flex items-center gap-1.5 text-xs text-success">
                      <Paperclip className="size-3" />
                      {doc.file_name ?? "attached"}
                    </p>
                  ) : (
                    <p className="mt-1 text-xs text-muted-foreground">
                      {ACCEPTED_LABEL} · up to {MAX_LABEL}
                    </p>
                  )}
                  {/* Stays until they succeed. The toast is the alert; this is
                      the instruction. */}
                  {problem && (
                    <p className="mt-1.5 flex items-start gap-1.5 text-xs text-destructive">
                      <CircleAlert className="mt-px size-3 shrink-0" />
                      <span>{problem}</span>
                    </p>
                  )}
                </div>
                {canManageProfile && status !== "approved" && (
                  <label
                    className={cn(
                      "inline-flex cursor-pointer items-center gap-1.5 rounded-md border border-input px-3 py-1.5 text-xs font-medium hover:bg-accent",
                      busy && "pointer-events-none opacity-60"
                    )}
                  >
                    <Upload className={cn("size-3.5", isUploading && "animate-pulse")} />
                    {isUploading ? "Uploading…" : doc ? "Replace" : "Attach"}
                    <input
                      type="file"
                      className="sr-only"
                      // The picker offers extensions too: a browser that does
                      // not know a file's MIME type filters on nothing at all
                      // when given only MIME types.
                      accept={`${ACCEPTED.join(",")},.pdf,.jpg,.jpeg,.png,.webp`}
                      onChange={(e) => {
                        const f = e.target.files?.[0];
                        e.target.value = "";
                        if (f) void upload(req.doc_type, f);
                      }}
                    />
                  </label>
                )}
              </div>
            );
          })}
        </CardContent>
      </Card>

      {/* ── Who in the company may do what ────────────────────────────── */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <Users className="size-4" /> People at {members.length === 1 ? "this company" : "this company"}
          </CardTitle>
          <CardDescription>
            Reading is company-wide; acting needs the capability. A company must
            always keep at least one owner.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {members.map((m) => (
            <div key={m.id} className="space-y-2 rounded-md border border-border p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">
                    {m.name}
                    {m.id === myVendorUserId && (
                      <span className="ml-2 text-xs font-normal text-muted-foreground">(you)</span>
                    )}
                  </p>
                  <p className="truncate text-xs text-muted-foreground">{m.email}</p>
                </div>
                <div className="flex items-center gap-2">
                  {m.isOwner && <Badge variant="outline">Owner</Badge>}
                  {canManageUsers && m.id !== myVendorUserId && (
                    <Button variant="ghost" size="sm" onClick={() => remove(m)}>
                      Remove
                    </Button>
                  )}
                </div>
              </div>
              {/* ⚠️ A DISABLED BUTTON IS STILL A BUTTON.
                  These rendered as four brand-coloured pills against an owner's
                  own row — on OEA, four red ones — and did nothing when
                  pressed, because `editable` is false for an owner by design.
                  A vendor reported them as broken, which is exactly what they
                  looked like: primary-coloured, button-shaped, inert, unexplained.

                  An owner genuinely cannot have these toggled (they hold all
                  four implicitly, and `vendor_users_keep_an_owner` means the
                  database would refuse). So when they are not editable they are
                  no longer BUTTONS — they are state, rendered as state, with a
                  line underneath saying why. */}
              <div className="flex flex-wrap gap-1.5">
                {CAPABILITIES.map((c) => {
                  const on = m.isOwner || m.capabilities.includes(c.key);
                  const editable = canManageUsers && !m.isOwner;

                  if (!editable) {
                    return (
                      <span
                        key={c.key}
                        title={c.hint}
                        className={cn(
                          "inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs font-medium",
                          on
                            ? "border-success/30 bg-success/10 text-success"
                            : "border-border bg-muted/40 text-muted-foreground"
                        )}
                      >
                        {on && <CheckCircle2 className="size-3" />}
                        {c.label}
                      </span>
                    );
                  }

                  return (
                    <button
                      key={c.key}
                      type="button"
                      title={c.hint}
                      aria-pressed={on}
                      onClick={() => toggleCapability(m, c.key)}
                      className={cn(
                        "rounded-full border px-2.5 py-1 text-xs font-medium transition-colors hover:opacity-90",
                        on
                          ? "border-transparent bg-[var(--brand)] text-[var(--brand-fg)]"
                          : "border-border bg-card text-muted-foreground"
                      )}
                    >
                      {c.label}
                    </button>
                  );
                })}
              </div>
              {/* Said once per row, rather than left for the reader to infer
                  from four controls that decline to respond. */}
              <p className="text-xs text-muted-foreground">
                {m.isOwner
                  ? `An owner holds all four permanently — these cannot be changed${
                      m.id === myVendorUserId ? ", including your own" : ""
                    }.`
                  : canManageUsers
                    ? "Tap to grant or remove."
                    : "Only someone who can manage people may change these."}
              </p>
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}

function Field({
  id, label, value, onChange, disabled, maxLength,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (k: never, v: string) => void;
  disabled?: boolean;
  maxLength?: number;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        value={value}
        disabled={disabled}
        maxLength={maxLength}
        onChange={(e) => onChange(id as never, e.target.value)}
      />
    </div>
  );
}
