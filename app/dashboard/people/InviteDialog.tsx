"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { UserPlus, Copy, Check, Mail } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { roleLabel } from "@/lib/roles";
import { inviteMember } from "./actions";

type Option = { id: string; label: string; propertyId?: string };

const ROLE_CHOICES = [
  "facility_manager",
  "fm_ops_staff",
  "finance_approver",
  "property_owner",
  "tenant",
  "vendor",
  "admin",
];

export default function InviteDialog({
  brand,
  isAdmin,
  properties,
  units,
  vendors,
}: {
  brand: string | null;
  isAdmin: boolean;
  properties: Option[];
  units: Option[];
  vendors: Option[];
}) {
  const router = useRouter();
  const [email, setEmail] = React.useState("");
  const [fullName, setFullName] = React.useState("");
  const [role, setRole] = React.useState("facility_manager");
  const [propertyIds, setPropertyIds] = React.useState<string[]>([]);
  const [unitId, setUnitId] = React.useState("");
  const [vendorId, setVendorId] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [issued, setIssued] = React.useState<{ url: string; emailed: boolean } | null>(null);
  const [copied, setCopied] = React.useState(false);

  // Attaché assignment only applies to the roles that are scoped to properties.
  const needsProperties = role === "facility_manager" || role === "property_owner";
  const needsUnit = role === "tenant";
  const needsVendor = role === "vendor";
  const roles = isAdmin ? ROLE_CHOICES : ROLE_CHOICES.filter((r) => r !== "admin");

  function toggleProperty(id: string) {
    setPropertyIds((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const res = await inviteMember({
        email,
        role,
        fullName,
        propertyIds: needsProperties ? propertyIds : [],
        propertyRelation: role === "property_owner" ? "owner" : "manager",
        unitId: needsUnit ? unitId || null : null,
        vendorId: needsVendor ? vendorId || null : null,
      });
      setIssued(res);
      toast.success("Invitation issued", {
        description: res.emailed
          ? `Emailed to ${email}.`
          : "Copy the link below and send it to them.",
      });
      setEmail(""); setFullName(""); setPropertyIds([]); setUnitId(""); setVendorId("");
      router.refresh();
    } catch (err) {
      toast.error("Could not invite", {
        description: err instanceof Error ? err.message : "Unexpected error.",
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
          <UserPlus className="size-4 text-brand" /> Invite someone
        </CardTitle>
        <CardDescription>
          They&apos;ll set their own password. The role you choose here is fixed —
          they can&apos;t change it during sign-up.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <form onSubmit={submit} className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="inv-email">Email address</Label>
              <Input
                id="inv-email" type="email" required value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="name@company.com"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="inv-name">
                Full name <span className="font-normal text-muted-foreground">(optional)</span>
              </Label>
              <Input
                id="inv-name" value={fullName}
                onChange={(e) => setFullName(e.target.value)}
                placeholder="e.g. Abdul Owo"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="inv-role">Role</Label>
              <Select id="inv-role" value={role} onChange={(e) => setRole(e.target.value)}>
                {roles.map((r) => (
                  <option key={r} value={r}>{roleLabel(r, brand)}</option>
                ))}
              </Select>
              {!isAdmin && (
                <p className="text-xs text-muted-foreground">
                  Only an administrator can invite another administrator.
                </p>
              )}
            </div>

            {needsUnit && (
              <div className="space-y-1.5">
                <Label htmlFor="inv-unit">Unit</Label>
                <Select id="inv-unit" value={unitId} onChange={(e) => setUnitId(e.target.value)}>
                  <option value="">— assign later —</option>
                  {units.map((u) => <option key={u.id} value={u.id}>{u.label}</option>)}
                </Select>
              </div>
            )}

            {needsVendor && (
              <div className="space-y-1.5">
                <Label htmlFor="inv-vendor">Vendor record</Label>
                <Select id="inv-vendor" value={vendorId} onChange={(e) => setVendorId(e.target.value)}>
                  <option value="">— link later —</option>
                  {vendors.map((v) => <option key={v.id} value={v.id}>{v.label}</option>)}
                </Select>
              </div>
            )}
          </div>

          {needsProperties && (
            <div className="space-y-2">
              <Label>
                {role === "property_owner" ? "Properties owned" : "Properties attached to"}
              </Label>
              <p className="text-xs text-muted-foreground">
                This is the attaché assignment — it decides exactly which
                properties they can see and act on.
              </p>
              <div className="flex flex-wrap gap-2">
                {properties.length === 0 && (
                  <p className="text-sm text-muted-foreground">No properties available.</p>
                )}
                {properties.map((p) => {
                  const on = propertyIds.includes(p.id);
                  return (
                    <button
                      key={p.id}
                      type="button"
                      onClick={() => toggleProperty(p.id)}
                      aria-pressed={on}
                      className={
                        on
                          ? "rounded-full border border-transparent bg-[var(--brand)] px-3 py-1.5 text-xs font-medium text-[var(--brand-fg)]"
                          : "rounded-full border border-border bg-card px-3 py-1.5 text-xs font-medium text-muted-foreground hover:bg-accent hover:text-foreground"
                      }
                    >
                      {p.label}
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          <Button type="submit" variant="brand" disabled={busy || !email.trim()}>
            {busy ? "Issuing…" : "Issue invitation"}
          </Button>
        </form>

        {issued && (
          <div className="space-y-2 rounded-md border border-border bg-muted/40 p-4">
            <p className="flex items-center gap-2 text-sm font-medium">
              <Mail className="size-4 text-brand" />
              {issued.emailed ? "Invitation emailed" : "Send this link to them"}
            </p>
            {!issued.emailed && (
              <p className="text-xs text-muted-foreground">
                Email delivery isn&apos;t configured yet, so share this link directly
                (WhatsApp is fine). It works once and expires in 14 days.
              </p>
            )}
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
