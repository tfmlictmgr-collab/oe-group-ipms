import Link from "next/link";
import { redirect } from "next/navigation";
import { Building, Plus, Home } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { getSessionProfile } from "@/lib/auth";
import { PageHeader } from "@/components/patterns/page-header";
import { EmptyState } from "@/components/patterns/empty-state";
import { StatCard } from "@/components/patterns/stat-card";
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

  // RLS decides what comes back: `properties.read_all` sees the org, everyone
  // else sees the properties they are attached to. No role check here.
  const [{ data: properties }, { data: units }, { data: canWrite }] = await Promise.all([
    supabase.from("properties")
      .select("id, name, reference, address, property_type")
      .order("name"),
    supabase.from("units").select("id, property_id, occupant_user_id, apportionment_factor"),
    supabase.rpc("has_permission", { p_capability: "properties.write" }),
  ]);

  const props = properties ?? [];
  const unitRows = units ?? [];

  const byProperty = new Map<string, { count: number; occupied: number; factor: number }>();
  for (const u of unitRows) {
    const e = byProperty.get(u.property_id) ?? { count: 0, occupied: 0, factor: 0 };
    e.count += 1;
    if (u.occupant_user_id) e.occupied += 1;
    e.factor += Number(u.apportionment_factor);
    byProperty.set(u.property_id, e);
  }

  const occupied = unitRows.filter((u) => u.occupant_user_id).length;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Properties"
        description="The portfolio, its units, and who is attached to each."
        actions={
          canWrite ? (
            <Button asChild variant="brand">
              <Link href="/dashboard/properties/new"><Plus /> Add property</Link>
            </Button>
          ) : undefined
        }
      />

      <div className="grid gap-4 sm:grid-cols-3">
        <StatCard label="Properties" value={String(props.length)} icon={<Building />} />
        <StatCard label="Units" value={String(unitRows.length)} icon={<Home />} />
        <StatCard
          label="Occupied"
          value={unitRows.length ? `${Math.round((occupied / unitRows.length) * 100)}%` : "—"}
        />
      </div>

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
                    <TableHead>Type</TableHead>
                    <TableHead className="text-right">Units</TableHead>
                    <TableHead className="text-right">Occupied</TableHead>
                    <TableHead className="text-right">Total factor</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {props.map((p) => {
                    const s = byProperty.get(p.id) ?? { count: 0, occupied: 0, factor: 0 };
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
