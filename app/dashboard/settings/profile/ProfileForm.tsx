"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/**
 * The one thing about their own account a person may change.
 *
 * ⚠️ Saved through `update_my_profile` (0135), which touches `full_name` and
 * nothing else. `users` has no UPDATE policy at all — the row carries `role`
 * and `org_id`, the two columns every RLS policy in the system reads — so a
 * narrow definer function is the whole of what self-service can be here.
 *
 * Email and role are shown but not editable, and that is the point: a person
 * should be able to SEE what the system thinks they are, and ask if it is
 * wrong, without being able to change it themselves.
 */
export default function ProfileForm({
  initial,
  email,
  roleLabel,
  orgName,
}: {
  initial: { fullName: string };
  email: string;
  roleLabel: string;
  orgName: string;
}) {
  const router = useRouter();
  const [fullName, setFullName] = React.useState(initial.fullName);
  const [saving, setSaving] = React.useState(false);

  const dirty = fullName.trim() !== initial.fullName.trim();

  async function save() {
    setSaving(true);
    try {
      const supabase = createClient();
      const { error } = await supabase.rpc("update_my_profile", {
        p_full_name: fullName,
      });
      if (error) throw new Error(error.message.replace(/^.*?:\s*/, ""));
      toast.success("Your name has been updated");
      router.refresh();
    } catch (e) {
      toast.error("Could not save your profile", {
        description: e instanceof Error ? e.message : "Unexpected error.",
      });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-5">
      <div className="space-y-1.5">
        <Label htmlFor="full-name">Your name</Label>
        <Input
          id="full-name"
          value={fullName}
          onChange={(e) => setFullName(e.target.value)}
          placeholder="e.g. Amaka Obi"
          maxLength={120}
        />
        <p className="text-xs text-muted-foreground">
          How you appear to your property manager and on anything you raise.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <div className="space-y-0.5">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Email
          </p>
          <p className="text-sm">{email}</p>
        </div>
        <div className="space-y-0.5">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Role
          </p>
          <p className="text-sm">{roleLabel}</p>
        </div>
        <div className="space-y-0.5">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Organisation
          </p>
          <p className="text-sm">{orgName}</p>
        </div>
      </div>

      <p className="text-xs text-muted-foreground">
        {/* Said plainly, because "why can't I edit this?" is the next question.
            Both are answered rather than left as greyed-out fields. */}
        Your email address and role are set by your organisation. Ask an
        administrator if either is wrong — your email is also how you sign in, so
        it cannot be changed from here.
      </p>

      <Button variant="brand" onClick={save} disabled={saving || !dirty || !fullName.trim()}>
        {saving ? "Saving…" : "Save"}
      </Button>
    </div>
  );
}
