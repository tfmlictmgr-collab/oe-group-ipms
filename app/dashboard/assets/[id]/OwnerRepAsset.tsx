import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { humanize } from "@/lib/asset-schema";
import { PageHeader } from "@/components/patterns/page-header";
import { StatusBadge } from "@/components/patterns/status-badge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";

type Row = {
  id: string; property_name: string; unit_label: string | null; asset_tag: string; name: string;
  category: string; description: string | null; manufacturer: string | null; model: string | null;
  serial_number: string | null; location_detail: string | null; quantity: number;
  status: string; condition: string; criticality: string;
  purchase_date: string | null; commissioned_date: string | null; warranty_expiry: string | null;
  expected_life_years: number | null; last_serviced_at: string | null; next_service_due: string | null;
  maintenance_strategy: string | null; compliance_required: boolean; regulatory_standard: string | null;
  certificate_expiry: string | null; next_inspection_due: string | null;
};

const fmtDate = (d: string | null) =>
  d ? new Date(d).toLocaleDateString("en-GB", { timeZone: "Africa/Lagos", day: "numeric", month: "short", year: "numeric" }) : null;

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-0.5">
      <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className="text-sm">{children ?? "—"}</dd>
    </div>
  );
}

/**
 * An asset as an Owner Rep may read it (0327), through
 * `owner_rep_asset_register`: no purchase, replacement or insured value, no
 * notes and no custom fields. A separate view rather than the full page with
 * sections hidden, because the full page reads the table (which refuses them)
 * and hiding a money field in the browser is not the same as never sending it.
 */
export default async function OwnerRepAsset({ id }: { id: string }) {
  const supabase = await createClient();
  const { data } = await supabase.rpc("owner_rep_asset_register", { p_asset_id: id });
  const asset = ((data ?? []) as Row[])[0];
  if (!asset) notFound();

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <PageHeader
        title="Asset"
        description={
          <span className="flex flex-wrap items-center gap-1.5">
            <span className="font-medium text-foreground">{asset.name}</span>
            <span className="font-mono text-xs text-muted-foreground">{asset.asset_tag}</span>
            <Badge variant="outline">{humanize(asset.category)}</Badge>
            <StatusBadge status={asset.status} />
            <StatusBadge status={asset.condition} />
            <StatusBadge status={asset.criticality} />
          </span>
        }
        actions={
          <Button asChild variant="ghost" size="sm">
            <Link href="/dashboard/assets"><ArrowLeft /> Back</Link>
          </Button>
        }
      />
      <Card>
        <CardContent className="pt-5">
          <dl className="grid grid-cols-1 gap-5 sm:grid-cols-3">
            <Field label="Property">{asset.property_name}</Field>
            <Field label="Unit">{asset.unit_label ?? "Building-wide"}</Field>
            <Field label="Location">{asset.location_detail}</Field>
            <Field label="Quantity">{asset.quantity.toLocaleString()}</Field>
            <Field label="Manufacturer">{asset.manufacturer}</Field>
            <Field label="Model">{asset.model}</Field>
            <Field label="Serial number">{asset.serial_number}</Field>
            <Field label="Purchased">{fmtDate(asset.purchase_date)}</Field>
            <Field label="Commissioned">{fmtDate(asset.commissioned_date)}</Field>
            <Field label="Warranty expiry">{fmtDate(asset.warranty_expiry)}</Field>
            <Field label="Expected life">
              {asset.expected_life_years ? `${asset.expected_life_years} years` : null}
            </Field>
            <Field label="Last serviced">{fmtDate(asset.last_serviced_at)}</Field>
            <Field label="Next service">{fmtDate(asset.next_service_due)}</Field>
            <Field label="Maintenance">
              {asset.maintenance_strategy ? humanize(asset.maintenance_strategy) : null}
            </Field>
            <Field label="Compliance required">{asset.compliance_required ? "Yes" : "No"}</Field>
            <Field label="Standard">{asset.regulatory_standard}</Field>
            <Field label="Certificate expiry">{fmtDate(asset.certificate_expiry)}</Field>
            <Field label="Next inspection">{fmtDate(asset.next_inspection_due)}</Field>
          </dl>
          {asset.description && <p className="mt-5 text-sm text-muted-foreground">{asset.description}</p>}
        </CardContent>
      </Card>
    </div>
  );
}
