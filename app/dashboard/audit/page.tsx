import Link from "next/link";
import { redirect } from "next/navigation";
import { ShieldCheck } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { getSessionProfile } from "@/lib/auth";
import { cn } from "@/lib/utils";
import { PageHeader } from "@/components/patterns/page-header";
import { EmptyState } from "@/components/patterns/empty-state";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from "@/components/ui/table";
import {
  type AuditEntry,
  ENTITY_FILTERS,
  summarizeChange,
  formatAuditTime,
} from "@/lib/audit-format";

// Semantic variant per action family, so the trail reads in dark mode too.
function actionVariant(action: string) {
  if (/reject|delete|fail/i.test(action)) return "destructive" as const;
  if (/approve|remit|paid|complete|resolve/i.test(action)) return "success" as const;
  if (/created|updated|write/i.test(action)) return "info" as const;
  return "muted" as const;
}

export default async function AuditPage({
  searchParams,
}: {
  searchParams: Promise<{ type?: string }>;
}) {
  const { type } = await searchParams;
  const session = await getSessionProfile();
  if (!session) redirect("/login");

  const supabase = await createClient();

  // RLS already scopes this (admin/finance see all in-org; everyone else only
  // their own actions), so no extra role filter is needed here.
  let query = supabase
    .from("audit_log")
    .select(
      "id, actor_id, action, entity_type, entity_id, before_state, after_state, created_at"
    )
    .order("created_at", { ascending: false })
    .limit(200);

  if (type && type !== "all") query = query.eq("entity_type", type);

  const { data } = await query;
  const entries = (data as AuditEntry[]) ?? [];

  // Resolve actor names in one round-trip.
  const actorIds = Array.from(
    new Set(entries.map((e) => e.actor_id).filter(Boolean))
  );
  const actorNames = new Map<string, string>();
  if (actorIds.length > 0) {
    const { data: users } = await supabase
      .from("users")
      .select("id, full_name, email")
      .in("id", actorIds as string[]);
    for (const u of users ?? []) {
      actorNames.set(u.id, u.full_name ?? u.email ?? "Unknown");
    }
  }

  const active = type ?? "all";

  return (
    <div className="space-y-6">
      <PageHeader
        title="Audit Trail"
        description="Append-only record of status changes and configuration updates. Entries cannot be edited or deleted."
      />

      <div className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1">
        {ENTITY_FILTERS.map((f) => {
          const isActive = active === f.key;
          return (
            <Link
              key={f.key}
              href={f.key === "all" ? "/dashboard/audit" : `/dashboard/audit?type=${f.key}`}
              className={cn(
                "flex-shrink-0 rounded-full border px-3 py-1.5 text-xs font-medium transition-colors",
                isActive
                  ? "border-transparent bg-[var(--brand)] text-[var(--brand-fg)]"
                  : "border-border bg-card text-muted-foreground hover:bg-accent hover:text-foreground"
              )}
            >
              {f.label}
            </Link>
          );
        })}
      </div>

      {entries.length === 0 ? (
        <EmptyState
          icon={<ShieldCheck />}
          title="No audit entries yet"
          description="Every status change, approval and configuration update is recorded here automatically."
        />
      ) : (
        <Card>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Time</TableHead>
                <TableHead>Actor</TableHead>
                <TableHead>Action</TableHead>
                <TableHead>Change</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {entries.map((e) => (
                <TableRow key={e.id}>
                  <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                    {formatAuditTime(e.created_at)}
                  </TableCell>
                  <TableCell>
                    {e.actor_id ? (
                      actorNames.get(e.actor_id) ?? "Unknown user"
                    ) : (
                      <span className="text-muted-foreground">System</span>
                    )}
                  </TableCell>
                  <TableCell>
                    <Badge variant={actionVariant(e.action)} className="whitespace-nowrap">
                      {e.action}
                    </Badge>
                  </TableCell>
                  <TableCell className="font-mono text-xs text-muted-foreground">
                    {summarizeChange(e)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      )}
    </div>
  );
}
