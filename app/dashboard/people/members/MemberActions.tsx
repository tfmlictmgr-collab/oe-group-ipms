"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { ChevronDown, KeyRound, MailX, UserCheck, UserMinus } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { createClient } from "@/lib/supabase/client";
import { releaseMemberEmail, sendMemberPasswordReset } from "../actions";

// What an administrator can do to an account — lifted out of the old Members
// list (12 Sept 2026) so the Directory's rows and a person's profile offer the
// same four acts in the same words, rather than two copies drifting apart.
//
// Rendered for an administrator only; the database refuses everybody else
// regardless (`set_member_active`, `set_user_approval_tier`, 0199, 0258).

export type ManagedMember = {
  id: string;
  full_name: string | null;
  email: string | null;
  role: string;
  deactivated_at: string | null;
  email_released_at: string | null;
  approval_tier: number | null;
};

/**
 * ⚠️ Only a `payment_approver` carries an editable tier. An executive's reach is
 * theirs by role (decisions 9 and 23) — a non-delegable control under decision
 * 7, never a field — so this offers one for exactly one role and
 * `set_user_approval_tier` refuses the rest regardless.
 */
const TIER_HINT: Record<number, string> = {
  1: "clears up to the tier 1 limit",
  2: "clears up to the tier 2 limit",
  3: "clears any amount",
};

export default function MemberActions({
  member,
  currentUserId,
}: {
  member: ManagedMember;
  currentUserId: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = React.useState(false);
  const inactive = Boolean(member.deactivated_at);
  const name = member.full_name ?? member.email ?? "this member";
  const isMe = member.id === currentUserId;

  async function run(fn: () => Promise<void>) {
    setBusy(true);
    try {
      await fn();
    } finally {
      setBusy(false);
    }
  }

  const setTier = (tier: number) =>
    run(async () => {
      const { error } = await createClient().rpc("set_user_approval_tier", {
        p_user_id: member.id,
        p_tier: tier,
      });
      if (error) {
        toast.error("Could not set that tier", { description: error.message.replace(/^.*?:\s*/, "") });
        return;
      }
      toast.success(`${name} is now a tier ${tier} approver`, {
        description: `They ${TIER_HINT[tier]} at final approval. The change is on the audit trail.`,
      });
      router.refresh();
    });

  const setActive = (active: boolean) =>
    run(async () => {
      const { error } = await createClient().rpc("set_member_active", {
        p_user_id: member.id,
        p_active: active,
      });
      if (error) {
        toast.error("Could not update this account", { description: error.message });
        return;
      }
      toast.success(active ? `${name} restored` : `${name} deactivated`, {
        description: active
          ? "They can sign in and receive notifications again."
          : "They keep their history but can no longer sign in, be assigned or be notified.",
      });
      router.refresh();
    });

  // ⚠️ It sends a LINK; it never sets a password and shows it here. An
  // administrator who could choose somebody's password could sign in as them,
  // and every approval that person has given would stop being evidence (0258).
  const resetPassword = () => {
    const ok = window.confirm(
      `Send ${name} a password reset link?\n\n` +
        `It goes to ${member.email ?? "their address"}. They choose the new password themselves — you will ` +
        `not see it, and their current password keeps working until they use the link.`
    );
    if (!ok) return;
    void run(async () => {
      const r = await sendMemberPasswordReset(member.id);
      if (!r.ok) {
        toast.error("Could not send the reset link", { description: r.message });
        return;
      }
      toast.success(`Reset link sent to ${r.data.email}`, {
        description: "They set the new password themselves; nobody here can see it.",
      });
    });
  };

  // The one act here that cannot be taken back, so it asks in full.
  const releaseEmail = () => {
    const ok = window.confirm(
      `Free up ${member.email ?? "this address"} so it can be invited again?\n\n` +
        `${name}'s record, history and audit trail stay exactly as they are — only the address is released.\n\n` +
        `If ${name} ever returns they are invited as a NEW member, not restored into this one. This cannot be undone.`
    );
    if (!ok) return;
    void run(async () => {
      const r = await releaseMemberEmail(member.id);
      if (!r.ok) {
        toast.error("Could not release the address", { description: r.message });
        return;
      }
      toast.success(`${r.data.formerEmail} is free to invite again`, {
        description: "Their record and everything they did stays. Inviting that address now creates a new member.",
      });
      router.refresh();
    });
  };

  // Never offered against yourself: an administrator who deactivates or resets
  // their own account from a list is one mis-click from being locked out.
  if (isMe) return null;

  return (
    <div className="flex flex-shrink-0 items-center gap-2">
      {member.role === "payment_approver" && !inactive && (
        <select
          aria-label={`Approval tier for ${name}`}
          value={member.approval_tier ?? ""}
          disabled={busy}
          onChange={(e) => setTier(Number(e.target.value))}
          className="h-8 rounded-md border border-input bg-background px-2 text-xs"
        >
          <option value="" disabled>
            No tier — cannot approve
          </option>
          {[1, 2, 3].map((t) => (
            <option key={t} value={t}>
              Tier {t} — {TIER_HINT[t]}
            </option>
          ))}
        </select>
      )}

      <DropdownMenu>
        <DropdownMenuTrigger
          disabled={busy}
          className="inline-flex h-8 items-center gap-1 rounded-md border border-input bg-background px-2.5 text-xs font-medium hover:bg-accent disabled:opacity-50"
        >
          {busy ? "Working…" : "Manage"} <ChevronDown className="size-3.5" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {!inactive && !member.email_released_at && (
            <DropdownMenuItem onClick={resetPassword}>
              <KeyRound /> Send a password reset link
            </DropdownMenuItem>
          )}
          <DropdownMenuItem onClick={() => setActive(inactive)}>
            {inactive ? <UserCheck /> : <UserMinus />}
            {inactive ? "Restore this account" : "Deactivate this account"}
          </DropdownMenuItem>
          {inactive && !member.email_released_at && (
            <>
              <DropdownMenuSeparator />
              {/* Offered only once deactivated, beside Restore, so the
                  reversible option is the one nearest to hand. */}
              <DropdownMenuItem
                onClick={releaseEmail}
                className="text-destructive focus:bg-destructive/10 focus:text-destructive [&_svg]:text-destructive"
              >
                <MailX /> Free up their email address
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
