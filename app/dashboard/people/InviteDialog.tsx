"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { UserPlus, Copy, Check, Mail } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { roleLabel, invitableBy, ROLE_HINTS, FM_PM } from "@/lib/roles";
import HierarchyPicker, { type OrgNode } from "@/components/patterns/hierarchy-picker";
import { inviteMember } from "./actions";
import { runAction, describeError } from "@/lib/run-action";

type Option = { id: string; label: string; propertyId?: string };

export default function InviteDialog({
  brand,
  myRole,
  properties,
  units,
  vendors,
  nodes,
}: {
  brand: string | null;
  /** The signed-in person's own role — what they may issue is derived from it. */
  myRole: string | null;
  properties: Option[];
  units: Option[];
  vendors: Option[];
  nodes: OrgNode[];
}) {
  const router = useRouter();
  const [email, setEmail] = React.useState("");
  const [fullName, setFullName] = React.useState("");
  const [role, setRole] = React.useState("facility_manager");
  const [propertyIds, setPropertyIds] = React.useState<string[]>([]);
  const [nodeId, setNodeId] = React.useState("");
  const [unitId, setUnitId] = React.useState("");
  const [vendorId, setVendorId] = React.useState("");
  const [approvalTier, setApprovalTier] = React.useState<1 | 2 | 3>(1);
  const [busy, setBusy] = React.useState(false);
  const [issued, setIssued] = React.useState<{ url: string; accepted: boolean } | null>(null);
  const [copied, setCopied] = React.useState(false);

  // Attaché assignment only applies to the roles that are scoped to properties.
  const needsProperties =
    (FM_PM as readonly string[]).includes(role) || role === "property_owner";
  // A regional manager is scoped to a NODE, not a list of properties — the
  // whole point (0067) is that they reach everything beneath it, including
  // properties filed later, without ever being re-assigned.
  const needsNode = role === "regional_manager";
  const needsUnit = role === "tenant";
  const needsVendor = role === "vendor";
  // A payment approver's scope is an AMOUNT, not a place — the one role whose
  // authority cannot be expressed by attaching them to something. Without a
  // tier the invitation violates its own constraint (0153) and fails only when
  // the person clicks the link, which is the worst moment to find out.
  const needsTier = role === "payment_approver";
  // ⚠️ This read `isAdmin ? INVITABLE_ROLES : INVITABLE_ROLES.filter(r => r !== "admin")`
  // — the one special case `0078c` was written to abolish, reintroduced in the
  // UI. It offered a facilities manager, a property manager and a regional
  // manager EVERY role except `admin`: the Managing Partner, the payment
  // officer, the payment auditor and the payment approver among them. Not an
  // escalation — `invitations_insert` refuses every one of them — but the
  // person picks "Managing Partner", fills the form, and is told no at the
  // end. That is decision 26's fault exactly: the offer and the rule
  // disagreed, and the offer was the wrong one.
  //
  // `invitableBy()` is the mirror of the database's `invitable_roles()` and
  // exists for precisely this. It was written, exported, and never called
  // here.
  const roles = React.useMemo(() => invitableBy(myRole), [myRole]);

  // Never leave the form holding a role this person cannot issue — including
  // the initial `facility_manager`, which a facilities manager themselves may
  // not invite (equal rank is not below it).
  React.useEffect(() => {
    if (roles.length > 0 && !(roles as readonly string[]).includes(role)) {
      setRole(roles[0]);
    }
  }, [roles, role]);

  function toggleProperty(id: string) {
    setPropertyIds((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const res = await runAction(
        inviteMember({
          email,
          role,
          fullName,
          propertyIds: needsProperties ? propertyIds : [],
          propertyRelation: role === "property_owner" ? "owner" : "manager",
          nodeId: needsNode ? nodeId || null : null,
          unitId: needsUnit ? unitId || null : null,
          vendorId: needsVendor ? vendorId || null : null,
          approvalTier: needsTier ? approvalTier : null,
        })
      );
      setIssued(res);
      // Deliberately NOT "emailed to X". The provider accepting a message is
      // not the same as the person receiving it, and saying otherwise sent
      // administrators looking for a fault at the recipient's end when the
      // message had bounced. The link is always offered.
      toast.success("Invitation created", {
        description: res.accepted
          ? `Sent to ${email}. Copy the link below in case it doesn't arrive.`
          : "Email wasn't sent — copy the link below and share it directly.",
      });
      setEmail(""); setFullName(""); setPropertyIds([]); setNodeId(""); setUnitId(""); setVendorId("");
      router.refresh();
    } catch (err) {
      toast.error("Could not invite", {
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
              {ROLE_HINTS[role] && (
                <p className="text-xs text-muted-foreground">{ROLE_HINTS[role]}</p>
              )}
              {/* ⚠️ The old line read "Only an administrator can invite
                  another administrator", which was true and, sitting under a
                  list that offered every other senior role, read as though
                  everything else on it was fair game. The list is now the
                  truth; this says what is missing from it and whose it is. */}
              {myRole !== "admin" && (
                <p className="text-xs text-muted-foreground">
                  {myRole === "regional_manager"
                    ? `Managers, owners, tenants and vendors are yours to invite. An administrator, the ${roleLabel("executive", brand)} and the payment desks are an administrator's.`
                    : `You can invite the roles below your own. An administrator, the ${roleLabel("executive", brand)} and the payment desks are an administrator's.`}
                </p>
              )}
            </div>

            {needsTier && (
              <div className="space-y-1.5">
                <Label htmlFor="inv-tier">Approval limit</Label>
                <Select
                  id="inv-tier"
                  value={String(approvalTier)}
                  onChange={(e) => setApprovalTier(Number(e.target.value) as 1 | 2 | 3)}
                >
                  <option value="1">Tier 1 — up to the tier-1 limit</option>
                  <option value="2">Tier 2 — up to the approval limit</option>
                  <option value="3">Tier 3 — no limit</option>
                </Select>
                <p className="text-xs text-muted-foreground">
                  The amounts themselves are set by OE Group under Settings →
                  Payment gate, so this chooses the band rather than the figure.
                </p>
              </div>
            )}

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

          {needsNode && (
            <div className="space-y-2">
              <Label>Region, project, location or site</Label>
              <p className="text-xs text-muted-foreground">
                Pick the level they administer and stop there. They reach every
                property beneath it — including ones filed later, with no
                re-assignment. Leaving this empty issues the invitation with no
                scope at all, which means they will see nothing.
              </p>
              <HierarchyPicker
                nodes={nodes}
                value={nodeId}
                onChange={setNodeId}
                stopAtLevel="any"
              />
            </div>
          )}

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
              {issued.accepted ? "Invitation sent" : "Send this link to them"}
            </p>
            <p className="text-xs text-muted-foreground">
              {issued.accepted
                ? "Handed to the mail provider. Delivery is confirmed separately — check the Invitations list for the outcome. If it hasn't arrived in a few minutes, send this link directly (WhatsApp is fine)."
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
