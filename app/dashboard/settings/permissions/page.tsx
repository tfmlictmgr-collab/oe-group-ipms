import { redirect } from "next/navigation";
import { getSessionProfile } from "@/lib/auth";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import AdminOnly from "../AdminOnly";
import { loadMatrix } from "./actions";
import MatrixEditor from "./MatrixEditor";

export default async function PermissionsPage({
  searchParams,
}: {
  searchParams: Promise<{ org?: string }>;
}) {
  const session = await getSessionProfile();
  if (!session) redirect("/login");
  if (session.profile?.role !== "admin") return <AdminOnly what="permissions" />;

  const { org } = await searchParams;
  const view = await loadMatrix(org);

  if (!view.ok) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Permissions</CardTitle>
          <CardDescription>{view.message}</CardDescription>
        </CardHeader>
      </Card>
    );
  }

  const currentOrgId = org ?? session.profile.org_id;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Role permissions</CardTitle>
        <CardDescription>
          What each role may reach. Seeded from the board-approved B7 matrix, and
          governed centrally by OE Group — a capability granted here changes what
          the database returns, not merely what the menu shows.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <MatrixEditor
          view={view.data}
          brand={session.org?.delivery_brand ?? null}
          currentOrgId={currentOrgId}
        />
      </CardContent>
    </Card>
  );
}
