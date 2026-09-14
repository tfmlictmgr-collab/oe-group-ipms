import Link from "next/link";
import { redirect } from "next/navigation";
import { Building, Plus, Map } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { getSessionProfile } from "@/lib/auth";
import { PageHeader } from "@/components/patterns/page-header";
import { EmptyState } from "@/components/patterns/empty-state";
import PropertyStats from "./PropertyStats";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import {
  Table, TableHeader, TableBody, TableRow, TableHead, TableCell,
} from "@/components/ui/table";

export default async function PropertiesPage() {
  const session = await getSessionProfile();
  if (!session) redirect("/login");

  const supabase = await createClient();

  // Counted in the database. Fetching every unit and tallying them here broke
  // silently past PostgREST's 1000-row cap — and understated the numbers rather
  // than failing, which is the worse way to be wrong.
  //
  // RLS still decides what comes back: `properties.read_all` sees the org,
  // everyone else sees the properties they are attached to.
  const [{ data: summary }, { data: canWrite }, { data: canManageHierarchy }] = await Promise.all([
    supabase.from("property_summary")
      .select("id, name, reference, address, property_type, unit_count, occupied_count, total_factor, node_path")
      .order("name"),
    supabase.rpc("has_permission", { p_capability: "properties.write" }),
    supabase.rpc("has_permission", { p_capability: "hierarchy.write" }),
  ]);

  const props = (summary ?? []) as {
    id: string; name: string; reference: string | null;
    address: string | null; property_type: string | null;
    unit_count: number; occupied_count: number; total_factor: number | string;
    node_path: string | null;
  }[];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Properties"
        description="The portfolio, its units, and who is attached to each."
        actions={
          <div className="flex gap-2">
            {canManageHierarchy && (
              <Button asChild variant="outline">
                <Link href="/dashboard/properties/hierarchy"><Map /> Regions & sites</Link>
              </Button>
            )}
            {canWrite && (
              <Button asChild variant="brand">
                <Link href="/dashboard/properties/new"><Plus /> Add property</Link>
              </Button>
            )}
          </div>
        }
      />

      <PropertyStats props={props} />

      {props.length === 0 ? (
        <EmptyState
          icon={<Building />}
          title="No properties yet"
          description={
            canWrite
              ? "Add the first property, then its units. Units carry the apportionment factors that decide what each one pays of a service-charge budget."
              : "You are not attached to any property yet. An administrator or your FM/PM assigns those."
          }
          action={
            canWrite ? (
              <Button asChild variant="brand" size="sm">
                <Link href="/dashboard/properties/new">Add property</Link>
              </Button>
            ) : undefined
          }
        />
      ) : (
        <Card>
          <CardContent className="px-0 pb-0">
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Property</TableHead>
                    <TableHead>Region / site</TableHead>
                    <TableHead>Type</TableHead>
                    <TableHead className="text-right">Units</TableHead>
                    <TableHead className="text-right">Occupied</TableHead>
                    <TableHead className="text-right">Total factor</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {props.map((p) => {
                    const s = {
                      count: Number(p.unit_count),
                      occupied: Number(p.occupied_count),
                      factor: Number(p.total_factor),
                    };
                    return (
                      <TableRow key={p.id}>
                        <TableCell>
                          <Link
                            href={`/dashboard/properties/${p.id}`}
                            className="font-medium hover:text-brand hover:underline"
                          >
                            {p.name}
                          </Link>
                          <span className="block text-xs text-muted-foreground">
                            {p.reference ? `${p.reference} · ` : ""}{p.address ?? "No address recorded"}
                          </span>
                        </TableCell>
                        <TableCell className="max-w-[220px] truncate text-xs text-muted-foreground">
                          {p.node_path ?? "Unfiled"}
                        </TableCell>
                        <TableCell className="text-muted-foreground">
                          {p.property_type ?? "—"}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">{s.count}</TableCell>
                        <TableCell className="text-right">
                          {s.count === 0 ? (
                            <span className="text-muted-foreground">—</span>
                          ) : (
                            <Badge variant={s.occupied === s.count ? "success" : "muted"}>
                              {s.occupied}/{s.count}
                            </Badge>
                          )}
                        </TableCell>
                        <TableCell className="text-right tabular-nums text-muted-foreground">
                          {s.factor ? s.factor.toLocaleString() : "—"}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
