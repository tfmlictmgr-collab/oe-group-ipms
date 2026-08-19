"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Building2, Copy, Check, Mail } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { createOrg } from "./actions";
import { runAction, describeError } from "@/lib/run-action";

/**
 * Provisions a new organisation — TFML, OEA, a service-charge client, a
 * landlord org, whatever the next one turns out to be — from the operator
 * launcher itself, rather than needing a migration or a service-role script.
 *
 * Deliberately not a modal: this page is already behind the operator gate
 * (`operator_org_directory()` returns nothing to anyone else), so the same
 * "form, then a copyable link" shape `InviteDialog` uses for people works
 * here for orgs too, with one more field — which brand the new org answers
 * to, because that decides its lettings flag and its slug.
 */
export default function CreateOrgForm() {
  const router = useRouter();
  const [name, setName] = React.useState("");
  const [deliveryBrand, setDeliveryBrand] = React.useState<"TFML" | "OEA" | "direct">("direct");
  const [adminEmail, setAdminEmail] = React.useState("");
  const [adminName, setAdminName] = React.useState("");
  const [reason, setReason] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [issued, setIssued] = React.useState<{ url: string; emailed: boolean } | null>(null);
  const [copied, setCopied] = React.useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const res = await runAction(
        createOrg({ name, deliveryBrand, adminEmail, adminName, reason })
      );
      setIssued(res);
      toast.success("Organisation provisioned", {
        description: res.emailed
          ? `Invitation sent to ${adminEmail}. Copy the link below in case it doesn't arrive.`
          : "Email wasn't sent — copy the link below and share it directly.",
      });
      setName(""); setAdminEmail(""); setAdminName(""); setReason("");
      router.refresh();
    } catch (err) {
      toast.error("Could not provision that organisation", {
        description: describeError(err),
      });
    } finally {
      setBusy(false);
    }
  }

  async function copy() {
    if (!issued) return;
    await navigator.clipboard.writeText(issued.url);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
    toast.success("Link copied");
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Building2 className="size-4 text-brand" /> New organisation
        </CardTitle>
        <CardDescription>
          Creates the org, seeds its permission baseline and hierarchy, and
          invites its first administrator — they set their own password.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <form onSubmit={submit} className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="org-name">Organisation name</Label>
              <Input
                id="org-name" required value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Lekki Gardens Estate"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="org-brand">Delivery brand</Label>
              <Select
                id="org-brand" value={deliveryBrand}
                onChange={(e) => setDeliveryBrand(e.target.value as "TFML" | "OEA" | "direct")}
              >
                <option value="direct">Direct — its own brand</option>
                <option value="TFML">TFML — facilities-delivered</option>
                <option value="OEA">OEA — property-delivered</option>
              </Select>
              <p className="text-xs text-muted-foreground">
                Decides whether lettings switches on — it is not the org's
                identity, so its address always comes from the name above.
              </p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="org-admin-email">First administrator's email</Label>
              <Input
                id="org-admin-email" type="email" required value={adminEmail}
                onChange={(e) => setAdminEmail(e.target.value)}
                placeholder="name@company.com"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="org-admin-name">
                Their name <span className="font-normal text-muted-foreground">(optional)</span>
              </Label>
              <Input
                id="org-admin-name" value={adminName}
                onChange={(e) => setAdminName(e.target.value)}
                placeholder="e.g. Abdul Owo"
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="org-reason">Reason</Label>
            <Input
              id="org-reason" required value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="e.g. Onboarding the new service-charge client for October"
            />
            <p className="text-xs text-muted-foreground">
              Recorded to operator_actions — visible to this org once it exists,
              not only to OE Group.
            </p>
          </div>

          <Button type="submit" variant="brand" disabled={busy || !name.trim() || !adminEmail.trim()}>
            {busy ? "Provisioning…" : "Provision organisation"}
          </Button>
        </form>

        {issued && (
          <div className="space-y-2 rounded-md border border-border bg-muted/40 p-4">
            <p className="flex items-center gap-2 text-sm font-medium">
              <Mail className="size-4 text-brand" />
              {issued.emailed ? "Invitation sent" : "Send this link to them"}
            </p>
            <p className="text-xs text-muted-foreground">
              {issued.emailed
                ? "Handed to the mail provider. If it hasn't arrived in a few minutes, send this link directly (WhatsApp is fine)."
                : "Email wasn't sent, so share this link directly (WhatsApp is fine)."}{" "}
              It works once and expires in 14 days.
            </p>
            <div className="flex gap-2">
              <Input readOnly value={issued.url} className="font-mono text-xs" />
              <Button type="button" variant="outline" onClick={copy} className="flex-shrink-0">
                {copied ? <Check /> : <Copy />}
                {copied ? "Copied" : "Copy"}
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
