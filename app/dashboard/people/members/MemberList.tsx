"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { releaseMemberEmail, sendMemberPasswordReset } from "../actions";
import { UserMinus, UserCheck, Search, MailX, KeyRound } from "lucide-react";
import { cn } from "@/lib/utils";
import { createClient } from "@/lib/supabase/client";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export type Member = {
  id: string;
  full_name: string | null;
  email: string | null;
  role: string;
  deactivated_at: string | null;
  /** 0199 — the address they held before it was released, if it has been. */
  former_email: string | null;
  email_released_at: string | null;
  roleName?: string;
  /** Stage-3 band, for `payment_approver` only. Null on every other role. */
  approval_tier: number | null;
};

/**
 * ⚠️ Only a `payment_approver` carries an editable tier.
 *
 * An executive is tier 3 and an administrator tier 2 BY ROLE
 * (`effective_approval_tier`, decisions 9 and 16) — non-delegable controls
 * under decision 7, which "are what an auditor checks; they are not
 * preferences". They must never appear as a field, so this offers one for
 * exactly one role and `set_user_approval_tier` refuses the rest regardless.
 */
const TIER_HINT: Record<number, string> = {
  1: "clears up to the tier 1 limit",
  2: "clears up to the tier 2 limit",
  3: "clears any amount",
};

export default function MemberList({
  members,
  currentUserId,
  isAdmin,
}: {
  members: Member[];
  currentUserId: string;
  isAdmin: boolean;
}) {
  const router = useRouter();
  const [query, setQuery] = React.useState("");
  const [showInactive, setShowInactive] = React.useState(false);
  const [busy, setBusy] = React.useState<string | null>(null);

  const visible = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    return members.filter((m) => {
      if (!showInactive && m.deactivated_at) return false;
      if (!q) return true;
      return [m.full_name, m.email, m.roleName].some((v) =>
        (v ?? "").toLowerCase().includes(q)
      );
    });
  }, [members, query, showInactive]);

  const inactiveCount = members.filter((m) => m.deactivated_at).length;

  async function setTier(id: string, tier: number, name: string) {
    setBusy(id);
    try {
      const supabase = createClient();
      const { error } = await supabase.rpc("set_user_approval_tier", {
        p_user_id: id,
        p_tier: tier,
      });
      if (error) throw new Error(error.message.replace(/^.*?:\s*/, ""));
      toast.success(`${name} is now a tier ${tier} approver`, {
        description: `They ${TIER_HINT[tier]} at final approval. The change is on the audit trail.`,
      });
      router.refresh();
    } catch (e) {
      toast.error("Could not set that tier", {
        description: e instanceof Error ? e.message : "Unexpected error.",
      });
    } finally {
      setBusy(null);
    }
  }

  // Releasing an address is not undoable, so it asks — the one destructive-ish
  // act on this screen, among several that are all reversible. Deactivate,
  // restore and tier changes can all be taken back; this cannot, because the
  // moment it succeeds the address may be invited to somebody else.
  async function releaseEmail(id: string, email: string, name: string) {
    const confirmed = window.confirm(
      `Free up ${email} so it can be invited again?\n\n` +
        `${name}'s record, history and audit trail stay exactly as they are — ` +
        `only the address is released.\n\n` +
        `If ${name} ever returns they are invited as a NEW member, not restored ` +
        `into this one. This cannot be undone.`
    );
    if (!confirmed) return;

    setBusy(id);
    try {
      const res = await releaseMemberEmail(id);
      if (!res.ok) throw new Error(res.message);
      toast.success(`${res.data.formerEmail} is free to invite again`, {
        description:
          "Their record and everything they did stays. Inviting that address now creates a new member.",
      });
      router.refresh();
    } catch (e) {
      toast.error("Could not release the address", {
        description: e instanceof Error ? e.message : "Unexpected error.",
      });
    } finally {
      setBusy(null);
    }
  }

  /**
   * Send a member a reset link (0258).
   *
   * ⚠️ It sends a LINK to them; it does not set a password and show it here.
   * An administrator who could choose somebody's password could sign in as
   * them, and every approval that person has given would stop being evidence
   * that they acted. The confirm text says so, because an administrator asked
   * to "reset a password" reasonably expects to be handed one.
   */
  async function resetPassword(id: string, name: string, email: string) {
    const confirmed = window.confirm(
      `Send ${name} a password reset link?

` +
        `It goes to ${email}. They choose the new password themselves — you will ` +
        `not see it, and their current password keeps working until they use the link.`
    );
    if (!confirmed) return;

    setBusy(id);
    try {
      const res = await sendMemberPasswordReset(id);
      if (!res.ok) throw new Error(res.message);
      toast.success(`Reset link sent to ${res.data.email}`, {
        description: "They set the new password themselves; nobody here can see it.",
      });
    } catch (e) {
      toast.error("Could not send the reset link", {
        description: e instanceof Error ? e.message : "Unexpected error.",
      });
    } finally {
      setBusy(null);
    }
  }

  async function setActive(id: string, active: boolean, name: string) {
    setBusy(id);
    try {
      const supabase = createClient();
      const { error } = await supabase.rpc("set_member_active", {
        p_user_id: id,
        p_active: active,
      });
      if (error) throw new Error(error.message);
      toast.success(active ? `${name} restored` : `${name} deactivated`, {
        description: active
          ? "They can sign in and receive notifications again."
          : "They keep their history but can no longer be assigned or notified.",
      });
      router.refresh();
    } catch (e) {
      toast.error("Could not update member", {
        description: e instanceof Error ? e.message : "Unexpected error.",
      });
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative min-w-0 flex-1 sm:max-w-xs">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search name, email or role…"
            aria-label="Search members"
            className="pl-9"
          />
        </div>
        {inactiveCount > 0 && (
          <label className="flex cursor-pointer items-center gap-2 text-sm text-muted-foreground">
            <input
              type="checkbox"
              checked={showInactive}
              onChange={(e) => setShowInactive(e.target.checked)}
              className="size-4 rounded border-input"
            />
            Show deactivated ({inactiveCount})
          </label>
        )}
      </div>

      {visible.length === 0 ? (
        <p className="py-6 text-center text-sm text-muted-foreground">
          No members match that search.
        </p>
      ) : (
        <ul className="space-y-2">
          {visible.map((m) => {
            const inactive = Boolean(m.deactivated_at);
            const name = m.full_name ?? m.email ?? "User";
            return (
              <li
                key={m.id}
                className={cn(
                  "flex flex-wrap items-center justify-between gap-3 rounded-md border border-border p-3",
                  inactive && "opacity-60"
                )}
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">
                    {name}
                    {m.id === currentUserId && (
                      <span className="ml-2 text-xs font-normal text-muted-foreground">(you)</span>
                    )}
                  </p>
                  {/* Once released, showing the tombstone would be useless —
                      "released+<uuid>@invalid" tells a reader nothing about who
                      this was. Show who they WERE, and say the address is gone. */}
                  <p className="truncate text-xs text-muted-foreground">
                    {m.email_released_at ? (
                      <>
                        <span className="line-through">{m.former_email}</span>
                        <span className="ml-2">— address released</span>
                      </>
                    ) : (
                      m.email
                    )}
                  </p>
                </div>
                <div className="flex flex-shrink-0 items-center gap-2">
                  {inactive && <Badge variant="muted">Deactivated</Badge>}
                  <Badge variant="outline">{m.roleName ?? m.role}</Badge>

                  {/* The band this approver may clear at stage 3. Written only
                      at invitation until now (0153), so an approver invited at
                      the wrong tier — or with none at all, which refuses them
                      every payment — could be corrected only by someone with
                      database access. */}
                  {m.role === "payment_approver" && !inactive && (
                    isAdmin && m.id !== currentUserId ? (
                      <select
                        aria-label={`Approval tier for ${name}`}
                        value={m.approval_tier ?? ""}
                        disabled={busy === m.id}
                        onChange={(e) => setTier(m.id, Number(e.target.value), name)}
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
                    ) : (
                      <Badge variant={m.approval_tier ? "outline" : "warning"}>
                        {m.approval_tier ? `Tier ${m.approval_tier}` : "No tier"}
                      </Badge>
                    )
                  )}
                  {/* A live account only: a reset link to a closed one would
                      let it back in, which the database also refuses. */}
                  {isAdmin && !inactive && !m.email_released_at && m.id !== currentUserId && (
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={busy === m.id}
                      onClick={() => resetPassword(m.id, name, m.email ?? "their address")}
                      title="Email them a link to set a new password"
                    >
                      <KeyRound />
                      Reset password
                    </Button>
                  )}

                  {/* Never offer an admin the button that would lock them out. */}
                  {isAdmin && m.id !== currentUserId && (
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={busy === m.id}
                      onClick={() => setActive(m.id, inactive, name)}
                    >
                      {inactive ? <UserCheck /> : <UserMinus />}
                      {inactive ? "Restore" : "Deactivate"}
                    </Button>
                  )}

                  {/* Deactivated only, and only once — offered beside Restore so
                      the reversible option is the one nearest to hand. The
                      database refuses this for a live account regardless of what
                      the screen shows. */}
                  {isAdmin && inactive && !m.email_released_at && m.id !== currentUserId && (
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={busy === m.id}
                      onClick={() => releaseEmail(m.id, m.email ?? "this address", name)}
                      title="Free this email address so it can be invited again"
                    >
                      <MailX />
                      Free up email
                    </Button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {/* ⚠️ Stating the whole path, not just the prohibition.
          The old note said only "never deleted", which reads as a missing
          feature — an administrator wanting somebody gone had no way of knowing
          the product can do exactly that, in two deliberate steps. It can:
          Deactivate closes the account, then Free up email bans the login and
          releases the address. What survives is the RECORD, not the access. */}
      <p className="text-xs text-muted-foreground">
        To remove somebody completely: <strong>Deactivate</strong> closes the
        account, then <strong>Free up email</strong> bans the sign-in and frees
        their address to be invited again. Their name stays on what they did —
        66 records reference a person, from approvals to the audit trail, and a
        decision nobody can be traced to is not a decision.
      </p>
    </div>
  );
}
