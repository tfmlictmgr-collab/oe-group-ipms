"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Pencil, X } from "lucide-react";
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
 *
 * The name itself is view-first: once a name is already on file, it renders
 * as plain text with a pencil to open editing, rather than an open text field
 * sitting there permanently. Someone who has never set a name (a fresh
 * account) has nothing to view, so editing opens straight away.
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
  const [editing, setEditing] = React.useState(!initial.fullName.trim());
  const [saving, setSaving] = React.useState(false);

  const dirty = fullName.trim() !== initial.fullName.trim();

  function cancel() {
    setFullName(initial.fullName);
    setEditing(false);
  }

  async function save() {
    setSaving(true);
    try {
      const supabase = createClient();
      const { error } = await supabase.rpc("update_my_profile", {
        p_full_name: fullName,
      });
      if (error) throw new Error(error.message.replace(/^.*?:\s*/, ""));
      toast.success("Your name has been updated");
      setEditing(false);
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
        <Label htmlFor={editing ? "full-name" : undefined}>Your name</Label>
        {editing ? (
          <>
            <Input
              id="full-name"
              value={fullName}
              onChange={(e) => setFullName(e.target.value)}
              placeholder="e.g. Amaka Obi"
              maxLength={120}
              autoFocus={Boolean(initial.fullName.trim())}
            />
            <p className="text-xs text-muted-foreground">
              How you appear to your property manager and on anything you raise.
            </p>
          </>
        ) : (
          <div className="flex items-center gap-2">
            <p className="text-sm">{initial.fullName}</p>
            <button
              type="button"
              onClick={() => setEditing(true)}
              aria-label="Edit your name"
              title="Edit"
              className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              <Pencil className="size-3.5" />
            </button>
          </div>
        )}
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

      {editing && (
        <div className="flex gap-2">
          <Button variant="brand" onClick={save} disabled={saving || !dirty || !fullName.trim()}>
            {saving ? "Saving…" : "Save"}
          </Button>
          {Boolean(initial.fullName.trim()) && (
            <Button variant="ghost" onClick={cancel} disabled={saving}>
              <X /> Cancel
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
