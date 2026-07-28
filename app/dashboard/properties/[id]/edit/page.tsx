import { notFound, redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getSessionProfile } from "@/lib/auth";
import { PageHeader } from "@/components/patterns/page-header";
import { Card, CardContent } from "@/components/ui/card";
import PropertyForm from "../../PropertyForm";

export default async function EditPropertyPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const session = await getSessionProfile();
  if (!session) redirect("/login");

  const supabase = await createClient();
  const { data: property } = await supabase
    .from("properties")
    .select("id, name, reference, address, property_type")
    .eq("id", id)
    .maybeSingle();

  if (!property) notFound();

  return (
    <div className="space-y-6">
      <PageHeader title={`Edit ${property.name}`} />
      <Card>
        <CardContent className="pt-6">
          <PropertyForm property={property} />
        </CardContent>
      </Card>
    </div>
  );
}
