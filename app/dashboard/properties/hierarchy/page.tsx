import Link from "next/link";
import { redirect } from "next/navigation";
import { ArrowLeft, ShieldAlert } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { getSessionProfile } from "@/lib/auth";
import { PageHeader } from "@/components/patterns/page-header";
import { EmptyState } from "@/components/patterns/empty-state";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import HierarchyTree, { type Node, type Manager } from "./HierarchyTree";

// The board's structure (29 July 2026): REGION → PROJECT → LOCATION → SITE,
// one table hanging above the property register (0066). Everyone in the org
// may read this tree — it is the org chart of the portfolio, and every
// screen that groups by place needs it. Only `hierarchy.write` may reshape
// it, seeded to admin-only by default (B7 silence means off).
export default async function HierarchyPage() {
  const session = await getSessionProfile();
  if (!session) redirect("/login");

  const supabase = await createClient();
  const [nodesRes, canWriteRes] = await Promise.all([
    supabase
      .from("org_nodes_overview")
      .select("id, parent_id, level, name, code, child_count, direct_property_count, subtree_property_count")
      .order("name"),
    supabase.rpc("has_permission", { p_capability: "hierarchy.write" }),
  ]);

  const canWrite = Boolean(canWriteRes.data);

  // Regional managers and their current node assignments — only fetched for
  // someone who can actually change them; a read-only visitor doesn't need
  // the member list to see the tree.
  let managers: Manager[] = [];
  let assignments: { node_id: string; user_id: string }[] = [];
  if (canWrite) {
    const [membersRes, assignRes] = await Promise.all([
      supabase
        .from("users")
        .select("id, full_name, email")
        .eq("role", "regional_manager")
        .is("deactivated_at", null)
        .order("full_name"),
      supabase
        .from("property_stakeholders")
        .select("node_id, user_id")
        .not("node_id", "is", null),
    ]);
    managers = (membersRes.data ?? []).map((m) => ({
      id: m.id, name: m.full_name ?? m.email ?? "Unnamed",
    }));
    assignments = (assignRes.data ?? []) as { node_id: string; user_id: string }[];
  }

  const nodes = (nodesRes.data ?? []) as Node[];

  return (
    <div className="space-y-6">
      <Button asChild variant="ghost" size="sm" className="-ml-2">
        <Link href="/dashboard/properties"><ArrowLeft className="size-4" /> All properties</Link>
      </Button>

      <PageHeader
        title="Regions & sites"
        description="Region, project, location, site — the shape the board asked for, hanging above the property register. A property is filed under a site; a regional manager assigned anywhere in the tree reaches everything beneath it, including properties filed later."
      />

      {!canWrite && nodes.length === 0 ? (
        <EmptyState
          icon={<ShieldAlert />}
          title="No regional structure yet"
          description="An administrator sets up regions, projects, locations and sites. Ask one if your portfolio needs this."
        />
      ) : (
        <Card>
          <CardContent className="pt-6">
            <HierarchyTree
              nodes={nodes}
              managers={managers}
              assignments={assignments}
              canWrite={canWrite}
            />
            {!canWrite && (
              <p className="mt-4 text-xs text-muted-foreground">
                Read-only — reshaping the portfolio needs the regional-structure permission.
              </p>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
