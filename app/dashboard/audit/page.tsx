import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getSessionProfile } from "@/lib/auth";
import {
  type AuditEntry,
  ACTION_STYLES,
  ENTITY_FILTERS,
  summarizeChange,
  formatAuditTime,
} from "@/lib/audit-format";

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
    <div>
      <div className="mb-4">
        <h1 className="text-xl font-semibold text-neutral-800">Audit Trail</h1>
        <p className="text-sm text-neutral-500">
          Append-only record of status changes and configuration updates.
          Entries cannot be edited or deleted.
        </p>
      </div>

      <div className="mb-4 flex flex-wrap gap-2">
        {ENTITY_FILTERS.map((f) => (
          <Link
            key={f.key}
            href={f.key === "all" ? "/dashboard/audit" : `/dashboard/audit?type=${f.key}`}
            className={`rounded-full px-3 py-1 text-xs font-medium ring-1 transition-colors ${
              active === f.key
                ? "bg-neutral-900 text-white ring-neutral-900"
                : "bg-white text-neutral-600 ring-neutral-200 hover:bg-neutral-50"
            }`}
          >
            {f.label}
          </Link>
        ))}
      </div>

      {entries.length === 0 ? (
        <div className="rounded-xl border border-dashed border-neutral-300 bg-white/60 p-10 text-center text-sm text-neutral-500">
          No audit entries yet.
        </div>
      ) : (
        <div className="overflow-x-auto rounded-xl bg-white shadow-sm ring-1 ring-black/5">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-neutral-100 text-left text-xs text-neutral-400">
                <th className="px-4 py-2 font-medium">Time</th>
                <th className="px-3 py-2 font-medium">Actor</th>
                <th className="px-3 py-2 font-medium">Action</th>
                <th className="px-3 py-2 font-medium">Change</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((e) => (
                <tr key={e.id} className="border-b border-neutral-50 last:border-0">
                  <td className="whitespace-nowrap px-4 py-2 text-xs text-neutral-500">
                    {formatAuditTime(e.created_at)}
                  </td>
                  <td className="px-3 py-2 text-neutral-700">
                    {e.actor_id ? (
                      actorNames.get(e.actor_id) ?? "Unknown user"
                    ) : (
                      <span className="text-neutral-400">System</span>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    <span
                      className={`whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ring-1 ${
                        ACTION_STYLES[e.action] ??
                        "bg-neutral-100 text-neutral-600 ring-neutral-200"
                      }`}
                    >
                      {e.action}
                    </span>
                  </td>
                  <td className="px-3 py-2 font-mono text-xs text-neutral-600">
                    {summarizeChange(e)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
