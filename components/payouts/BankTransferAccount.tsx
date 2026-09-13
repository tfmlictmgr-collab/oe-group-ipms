"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  Landmark, FileText, CheckCircle2, Send, Link2, Copy, Clock, ShieldCheck, TriangleAlert,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { PayoutAccountView, PayoutRequestView } from "@/lib/payout-views";
import {
  requestPayoutDetails,
  withdrawPayoutRequest,
  adoptRegistrationBankDetails,
  confirmPayoutAccountEvidence,
  openPayoutEvidence,
  type PayoutParty,
} from "@/lib/payout-actions";

function shortDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-GB", {
    timeZone: "Africa/Lagos", day: "numeric", month: "short", year: "numeric",
  });
}

/**
 * Where somebody is paid by bank transfer — shown, set up and confirmed in one
 * place, for a contractor, a landlord or a one-off payee on a requisition.
 *
 * The full account number is never on this screen or anywhere in the system.
 * The payment officer reads it off the payee's own document, opened from here,
 * at the moment they make the transfer (0289: evidence, not a stored field).
 */
export default function BankTransferAccount({
  party,
  vendorId,
  userId,
  lineId,
  payeeName,
  purpose,
  defaultEmail,
  defaultPhone,
  account,
  request,
  canManage,
  canAdoptRegistration,
  askForName,
  path,
}: {
  party: PayoutParty;
  vendorId?: string;
  userId?: string;
  lineId?: string;
  payeeName: string;
  purpose: string;
  defaultEmail?: string | null;
  defaultPhone?: string | null;
  account: PayoutAccountView | null;
  request: PayoutRequestView | null;
  /** The payment officer or an administrator. Everyone else sees only the state. */
  canManage: boolean;
  /** An approved registration with a bank letter is on file. */
  canAdoptRegistration?: boolean;
  /** A one-off payee named for the first time: the name is typed here. */
  askForName?: boolean;
  path: string;
}) {
  const router = useRouter();
  const [asking, setAsking] = React.useState(false);
  const [name, setName] = React.useState(askForName ? payeeName : "");
  const [email, setEmail] = React.useState(defaultEmail ?? "");
  const [phone, setPhone] = React.useState(defaultPhone ?? "");
  const [busy, setBusy] = React.useState<string | null>(null);
  const [sentLink, setSentLink] = React.useState<{ link: string; sentTo: string[] } | null>(null);

  async function act(key: string, fn: () => Promise<{ ok: boolean; message?: string; hint?: string }>, success: string) {
    setBusy(key);
    try {
      const r = await fn();
      if (!r.ok) {
        toast.error(r.message ?? "That could not be done.", { description: r.hint, duration: Infinity, closeButton: true });
        return;
      }
      toast.success(success);
      router.refresh();
    } finally {
      setBusy(null);
    }
  }

  async function sendLink() {
    setBusy("ask");
    try {
      const r = await requestPayoutDetails({
        party,
        vendorId: vendorId ?? null,
        userId: userId ?? null,
        lineId: lineId ?? null,
        payeeName: askForName ? name : null,
        contactEmail: email || null,
        contactPhone: phone || null,
        purpose,
        path,
      });
      if (!r.ok) {
        toast.error(r.message, { description: r.hint, duration: Infinity, closeButton: true });
        return;
      }
      setSentLink({ link: r.data.link, sentTo: r.data.sentTo });
      setAsking(false);
      toast.success(
        r.data.sentTo.length ? `Link sent — ${r.data.sentTo.join(" and ")}.` : "Link ready — nothing could be sent automatically.",
        { description: "It works for 14 days and only once." }
      );
      router.refresh();
    } finally {
      setBusy(null);
    }
  }

  async function openDocument() {
    if (!account) return;
    setBusy("doc");
    try {
      const r = await openPayoutEvidence(account.id);
      if (!r.ok) {
        toast.error(r.message, { description: r.hint });
        return;
      }
      window.open(r.data.url, "_blank", "noopener");
    } finally {
      setBusy(null);
    }
  }

  const status = account ? (
    account.verified ? (
      <Badge variant="success">
        {account.confirmedByBank ? "Name confirmed by the bank" : `Confirmed${account.verifiedByName ? ` by ${account.verifiedByName}` : ""}`}
      </Badge>
    ) : (
      <Badge variant="warning">Waiting for someone to check the document</Badge>
    )
  ) : request && !request.lapsed ? (
    <Badge variant="info">Waiting for their details</Badge>
  ) : (
    <Badge variant="muted">No bank-transfer account</Badge>
  );

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Landmark className="size-4 text-brand" />
        <p className="text-sm font-medium">Paid by bank transfer</p>
        {status}
      </div>

      {account && canManage && (
        <div className="rounded-md border border-border bg-muted/40 p-3 text-sm">
          <p className="font-medium">{account.accountName}</p>
          <p className="text-xs text-muted-foreground">
            {account.bankName} · account ending {account.last4} ·{" "}
            {account.source === "vendor_registration" ? "from their approved registration" : "sent by the payee"} ·{" "}
            {shortDate(account.addedAt)}
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button size="sm" variant="outline" disabled={busy !== null} onClick={openDocument}>
              <FileText className="size-3.5" /> {busy === "doc" ? "Opening…" : "Open their document"}
            </Button>
            {!account.verified && (
              <Button
                size="sm"
                variant="brand"
                disabled={busy !== null}
                onClick={() =>
                  act("confirm", () => confirmPayoutAccountEvidence(account.id, path),
                    "Confirmed. They can now be paid by bank transfer — by someone other than you.")
                }
              >
                <CheckCircle2 className="size-3.5" /> I have checked the document
              </Button>
            )}
          </div>
          {!account.verified && (
            <p className="mt-2 flex items-start gap-1.5 text-xs text-muted-foreground">
              <ShieldCheck className="mt-0.5 size-3 flex-shrink-0" />
              The bank could not confirm the name automatically. Open the document and check the account
              name and number on it belong to {payeeName}. Whoever confirms it cannot also send the payment.
            </p>
          )}
        </div>
      )}

      {account && !canManage && (
        <p className="text-xs text-muted-foreground">
          Bank details are on file{account.verified ? " and confirmed" : ", waiting to be checked"}. The
          payment officer sees the account itself.
        </p>
      )}

      {request && (
        <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
          <Clock className="mt-0.5 size-3 flex-shrink-0" />
          {request.lapsed
            ? `A link sent on ${shortDate(request.sentAt)} expired unanswered on ${shortDate(request.expiresAt)}.`
            : `A link went to ${request.to || "the payee"} on ${shortDate(request.sentAt)}. It works until ${shortDate(request.expiresAt)}.`}
          {!request.lapsed && (canManage || !account) && (
            <button
              type="button"
              className="ml-1 font-medium text-brand underline-offset-2 hover:underline"
              disabled={busy !== null}
              onClick={() => act("withdraw", () => withdrawPayoutRequest(request.id, path), "The link has been cancelled.")}
            >
              Cancel it
            </button>
          )}
        </p>
      )}

      {sentLink && (
        <div className="space-y-1.5 rounded-md border border-dashed border-border p-3 text-xs">
          <p className="text-muted-foreground">
            {sentLink.sentTo.length
              ? `Sent by ${sentLink.sentTo.join(" and ")}.`
              : "It could not be sent automatically from here."}{" "}
            You can also send it yourself — it is for {payeeName} alone, works once, and expires in 14 days.
          </p>
          <div className="flex items-center gap-2">
            <code className="min-w-0 flex-1 truncate rounded bg-muted px-2 py-1">{sentLink.link}</code>
            <Button
              size="sm"
              variant="ghost"
              onClick={async () => {
                await navigator.clipboard.writeText(sentLink.link);
                toast.success("Link copied.");
              }}
            >
              <Copy className="size-3.5" /> Copy
            </Button>
          </div>
        </div>
      )}

      {(canManage || party === "other") && (
        <div className="flex flex-wrap gap-2">
          {!asking && (
            <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => setAsking(true)}>
              <Send className="size-3.5" />
              {account ? "Ask for new bank details" : request && !request.lapsed ? "Send a new link" : "Ask them for their bank details"}
            </Button>
          )}
          {canManage && canAdoptRegistration && !asking && (
            <Button
              size="sm"
              variant="outline"
              disabled={busy !== null}
              onClick={() =>
                act("adopt", () => adoptRegistrationBankDetails(vendorId!),
                  "Their registration's bank details are now how they are paid by bank transfer.")
              }
            >
              <Link2 className="size-3.5" /> Use the account on their registration
            </Button>
          )}
        </div>
      )}

      {asking && (
        <div className="space-y-3 rounded-md border border-border p-3">
          {account && (
            <p className="flex items-start gap-2 rounded-md bg-warning/10 px-3 py-2 text-xs">
              <TriangleAlert className="mt-0.5 size-3.5 flex-shrink-0 text-warning" />
              When they answer, their new details replace these. Payments already made keep pointing at the
              account they were sent to.
            </p>
          )}
          {askForName && (
            <div className="space-y-1.5">
              <Label htmlFor={`pn-${lineId ?? vendorId ?? userId}`}>Who is being paid</Label>
              <Input
                id={`pn-${lineId ?? vendorId ?? userId}`}
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Their name as it appears on their bank account"
              />
              <p className="text-xs text-muted-foreground">
                The approvers see this name, and it cannot be changed once approval starts.
              </p>
            </div>
          )}
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor={`pe-${lineId ?? vendorId ?? userId}`}>Their email</Label>
              <Input
                id={`pe-${lineId ?? vendorId ?? userId}`}
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="name@example.com"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={`pp-${lineId ?? vendorId ?? userId}`}>Their phone (WhatsApp or SMS)</Label>
              <Input
                id={`pp-${lineId ?? vendorId ?? userId}`}
                inputMode="tel"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                placeholder="080…"
              />
            </div>
          </div>
          <p className="text-xs text-muted-foreground">
            Either will do. They get a secure link that asks for their bank, their account number and a
            document showing both — we keep the bank, the name and the last four digits only.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="brand"
              disabled={busy !== null || (!email.trim() && !phone.trim()) || (askForName && name.trim().length < 2)}
              onClick={sendLink}
            >
              <Send className="size-3.5" /> {busy === "ask" ? "Sending…" : "Send the link"}
            </Button>
            <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => setAsking(false)}>
              Not now
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
