"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { UserMinus, UserCheck, Search } from "lucide-react";
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
  roleName?: string;
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
                  <p className="truncate text-xs text-muted-foreground">{m.email}</p>
                </div>
                <div className="flex flex-shrink-0 items-center gap-2">
                  {inactive && <Badge variant="muted">Deactivated</Badge>}
                  <Badge variant="outline">{m.roleName ?? m.role}</Badge>
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
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <p className="text-xs text-muted-foreground">
        Members are deactivated, never deleted — anyone who has acted in the
        system is referenced by the audit trail, which must stay intact.
      </p>
    </div>
  );
}
