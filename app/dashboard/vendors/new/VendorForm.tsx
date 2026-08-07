"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Loader2, Building2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { runAction, messageOf, hintOf } from "@/lib/run-action";
import { createVendor } from "./actions";

const CATEGORIES = [
  ["cleaning", "Cleaning"],
  ["security", "Security"],
  ["plumbing", "Plumbing"],
  ["electrical", "Electrical"],
  ["hvac", "HVAC"],
  ["landscaping", "Landscaping"],
  ["waste", "Waste"],
  ["pest", "Pest control"],
  ["maintenance", "General maintenance"],
  ["other", "Other"],
] as const;

export type UnlinkedUser = { id: string; label: string };

export default function VendorForm({ unlinked }: { unlinked: UnlinkedUser[] }) {
  const router = useRouter();
  const [busy, setBusy] = React.useState(false);
  const [name, setName] = React.useState("");
  const [category, setCategory] = React.useState<string>("cleaning");
  const [email, setEmail] = React.useState("");
  const [phone, setPhone] = React.useState("");
  const [linkUserId, setLinkUserId] = React.useState("");

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const r = await runAction(
        createVendor({
          name,
          serviceCategory: category,
          contactEmail: email || null,
          contactPhone: phone || null,
          linkUserId: linkUserId || null,
        })
      );
      toast.success("Vendor created", {
        description: "They can now be assigned requests. Approve them when their checks are done.",
      });
      router.push(`/dashboard/vendors/${r.id}`);
    } catch (err) {
      toast.error(messageOf(err, "Could not create that vendor."), {
        description: hintOf(err),
        duration: Infinity,
        closeButton: true,
      });
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-5">
      <div className="space-y-2">
        <Label htmlFor="v-name">Company name</Label>
        <Input
          id="v-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Sparkle Cleaning Services"
          required
          minLength={2}
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="v-cat">Service category</Label>
        <select
          id="v-cat"
          value={category}
          onChange={(e) => setCategory(e.target.value)}
          className="h-10 w-full rounded-md border border-input bg-card px-3 text-sm"
        >
          {CATEGORIES.map(([v, label]) => (
            <option key={v} value={v}>{label}</option>
          ))}
        </select>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="v-email">Contact email</Label>
          <Input
            id="v-email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="ops@vendor.example"
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="v-phone">Contact phone</Label>
          <Input
            id="v-phone"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            placeholder="+234…"
          />
        </div>
      </div>

      {/* Only rendered when there IS an orphan to rescue — an empty picker
          asking a question with no answers is what created this situation in
          the first place. */}
      {unlinked.length > 0 && (
        <div className="space-y-2 rounded-lg border border-warning/40 bg-warning/5 p-4">
          <Label htmlFor="v-link">Attach an existing vendor login</Label>
          <select
            id="v-link"
            value={linkUserId}
            onChange={(e) => setLinkUserId(e.target.value)}
            className="h-10 w-full rounded-md border border-input bg-card px-3 text-sm"
          >
            <option value="">— none —</option>
            {unlinked.map((u) => (
              <option key={u.id} value={u.id}>{u.label}</option>
            ))}
          </select>
          <p className="text-xs text-muted-foreground">
            {unlinked.length === 1 ? "This person was" : "These people were"} invited as a vendor
            but {unlinked.length === 1 ? "is" : "are"} not attached to any company, so{" "}
            {unlinked.length === 1 ? "their" : "their"} work page is empty and{" "}
            {unlinked.length === 1 ? "they cannot" : "they cannot"} be assigned anything. Attach{" "}
            {unlinked.length === 1 ? "them" : "one"} here if this is their company.
          </p>
        </div>
      )}

      <div className="flex items-center gap-3">
        <Button type="submit" variant="brand" disabled={busy}>
          {busy ? <Loader2 className="animate-spin" /> : <Building2 />}
          {busy ? "Creating…" : "Create vendor"}
        </Button>
        <p className="text-xs text-muted-foreground">
          Created as <strong>pending approval</strong> — they can be assigned work straight away,
          but approve them before any payment runs.
        </p>
      </div>
    </form>
  );
}
