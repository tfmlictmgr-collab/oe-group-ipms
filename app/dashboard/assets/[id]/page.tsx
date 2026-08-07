import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { ArrowLeft, Wrench, ShieldCheck, Umbrella } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { getSessionProfile } from "@/lib/auth";
import { formatNaira } from "@/lib/currency";
import { humanize } from "@/lib/asset-schema";
import { formatDateTime } from "@/lib/ticket-format";
import { PageHeader } from "@/components/patterns/page-header";
import { StatusBadge } from "@/components/patterns/status-badge";
import { EmptyState } from "@/components/patterns/empty-state";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-0.5">
      <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className="text-sm">{children ?? "—"}</dd>
    </div>
  );
}

const fmtDate = (d: string | null) =>
  d ? new Date(d).toLocaleDateString("en-GB", { timeZone: "Africa/Lagos", day: "numeric", month: "short", year: "numeric" }) : null;

export default async function AssetDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const session = await getSessionProfile();
  if (!session) redirect("/login");

  const supabase = await createClient();
  const { data: asset } = await supabase
    .from("assets")
    .select(
      "*, properties(name, address), units(label), vendors(name), users:custodian_user_id(full_name, email)"
    )
    .eq("id", id)
    .single();

  if (!asset) notFound();

  // The assembly this belongs to, and the components that belong to it (0121).
  // Both RLS-scoped: a component on a property the caller cannot see simply
  // does not come back, which is the same answer the register itself gives.
  const [parentRes, componentsRes] = await Promise.all([
    asset.parent_asset_id
      ? supabase.from("assets").select("id, name, asset_tag")
          .eq("id", asset.parent_asset_id).maybeSingle()
      : Promise.resolve({ data: null }),
    supabase.from("assets").select("id, name, asset_tag, status")
      .eq("parent_asset_id", id).is("deleted_at", null).order("name"),
  ]);
  const parentAsset = parentRes.data as { id: string; name: string; asset_tag: string | null } | null;
  const components = (componentsRes.data ?? []) as
    { id: string; name: string; asset_tag: string | null; status: string }[];

  const [certsRes, ticketsRes] = await Promise.all([
    supabase
      .from("asset_certificates")
      .select("id, kind, reference, issuer, issued_date, expiry_date")
      .eq("asset_id", id)
      .order("expiry_date", { ascending: true }),
    supabase
      .from("tickets")
      .select("id, summary, message_text, status, urgency, created_at")
      .eq("asset_id", id)
      .order("created_at", { ascending: false })
      .limit(10),
  ]);

  const property = asset.properties as unknown as { name: string; address: string | null } | null;
  const unit = asset.units as unknown as { label: string } | null;
  const vendor = asset.vendors as unknown as { name: string } | null;
  const custodian = asset.users as unknown as { full_name: string | null; email: string | null } | null;
  const certs = certsRes.data ?? [];
  const tickets = ticketsRes.data ?? [];
  const custom = (asset.custom_fields ?? {}) as Record<string, string>;

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <PageHeader
        title={asset.name}
        description={
          <span className="flex flex-wrap items-center gap-1.5">
            <span className="font-mono text-xs text-muted-foreground">{asset.asset_tag}</span>
            <Badge variant="outline">{humanize(asset.category)}</Badge>
            <StatusBadge status={asset.status} />
            <StatusBadge status={asset.condition} />
            <StatusBadge status={asset.criticality} />
          </span>
        }
        actions={
          <Button asChild variant="ghost" size="sm">
            <Link href="/dashboard/assets">
              <ArrowLeft /> Back
            </Link>
          </Button>
        }
      />

      {/* Where this sits in its assembly. Shown above the detail because
          "this is one of four AHUs on the chiller plant" changes how you read
          everything below it. */}
      {(parentAsset || components.length > 0) && (
        <Card>
          <CardContent className="space-y-3 pt-5">
            {parentAsset && (
              <p className="text-sm">
                <span className="text-muted-foreground">Part of </span>
                <Link
                  href={`/dashboard/assets/${parentAsset.id}`}
                  className="font-medium underline underline-offset-4"
                >
                  {parentAsset.name}
                  {parentAsset.asset_tag ? ` (${parentAsset.asset_tag})` : ""}
                </Link>
              </p>
            )}
            {components.length > 0 && (
              <div className="space-y-1.5">
                <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Components ({components.length})
                </p>
                <ul className="space-y-1">
                  {components.map((c) => (
                    <li key={c.id} className="text-sm">
                      <Link
                        href={`/dashboard/assets/${c.id}`}
                        className="underline underline-offset-4"
                      >
                        {c.name}{c.asset_tag ? ` (${c.asset_tag})` : ""}
                      </Link>
                      <span className="ml-2 text-xs text-muted-foreground">
                        {String(c.status).replace(/_/g, " ")}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardContent className="space-y-5 pt-5">
          <dl className="grid grid-cols-1 gap-5 sm:grid-cols-3">
            <Field label="Property">{property?.name}</Field>
            <Field label="Unit">{unit?.label ?? "Building-wide"}</Field>
            <Field label="Location">{asset.location_detail}</Field>
            <Field label="Manufacturer">{asset.manufacturer}</Field>
            <Field label="Model">{asset.model}</Field>
            <Field label="Serial number">
              {asset.serial_number ? <span className="font-mono text-xs">{asset.serial_number}</span> : null}
            </Field>
          </dl>
          {asset.description && (
            <>
              <Separator />
              <p className="text-sm text-muted-foreground">{asset.description}</p>
            </>
          )}
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-base">
              <Wrench className="size-4 text-brand" /> Lifecycle
            </CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="grid grid-cols-2 gap-4">
              <Field label="Purchased">{fmtDate(asset.purchase_date)}</Field>
              <Field label="Commissioned">{fmtDate(asset.commissioned_date)}</Field>
              <Field label="Warranty expiry">{fmtDate(asset.warranty_expiry)}</Field>
              <Field label="Expected life">
                {asset.expected_life_years ? `${asset.expected_life_years} years` : null}
              </Field>
              <Field label="Last serviced">{fmtDate(asset.last_serviced_at)}</Field>
              <Field label="Next service">{fmtDate(asset.next_service_due)}</Field>
              <Field label="Purchase cost">
                {asset.purchase_cost != null ? formatNaira(asset.purchase_cost) : null}
              </Field>
              <Field label="Replacement cost">
                {asset.replacement_cost != null ? formatNaira(asset.replacement_cost) : null}
              </Field>
              <Field label="Maintained by">{vendor?.name}</Field>
              <Field label="Custodian">{custodian?.full_name ?? custodian?.email}</Field>
            </dl>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-base">
              <ShieldCheck className="size-4 text-brand" /> Compliance &amp; insurance
            </CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="grid grid-cols-2 gap-4">
              <Field label="Compliance required">
                {asset.compliance_required ? "Yes" : "No"}
              </Field>
              <Field label="Standard">{asset.regulatory_standard}</Field>
              <Field label="Certifying body">{asset.certifying_body}</Field>
              <Field label="Certificate no.">{asset.certificate_number}</Field>
              <Field label="Certificate expiry">{fmtDate(asset.certificate_expiry)}</Field>
              <Field label="Next inspection">{fmtDate(asset.next_inspection_due)}</Field>
              <Field label="Insurer">
                <span className="flex items-center gap-1.5">
                  {asset.insurer_name ? <Umbrella className="size-3.5 text-muted-foreground" /> : null}
                  {asset.insurer_name}
                </span>
              </Field>
              <Field label="Policy no.">{asset.insurance_policy_no}</Field>
              <Field label="Insured value">
                {asset.insured_value != null ? formatNaira(asset.insured_value) : null}
              </Field>
              <Field label="Insurance expiry">{fmtDate(asset.insurance_expiry)}</Field>
            </dl>
          </CardContent>
        </Card>
      </div>

      {Object.keys(custom).length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Additional fields</CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="grid grid-cols-2 gap-4 sm:grid-cols-3">
              {Object.entries(custom).map(([k, v]) => (
                <Field key={k} label={humanize(k)}>{String(v)}</Field>
              ))}
            </dl>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Certificates &amp; documents</CardTitle>
        </CardHeader>
        <CardContent className={certs.length ? "space-y-2" : ""}>
          {certs.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No documents recorded against this asset yet.
            </p>
          ) : (
            certs.map((c) => (
              <div key={c.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border p-3">
                <div className="min-w-0">
                  <p className="text-sm font-medium">{humanize(c.kind)}</p>
                  <p className="text-xs text-muted-foreground">
                    {[c.reference, c.issuer].filter(Boolean).join(" · ") || "—"}
                  </p>
                </div>
                <div className="text-right text-xs text-muted-foreground">
                  {c.expiry_date ? `Expires ${fmtDate(c.expiry_date)}` : "No expiry"}
                </div>
              </div>
            ))
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Related requests</CardTitle>
        </CardHeader>
        <CardContent className={tickets.length ? "space-y-2" : ""}>
          {tickets.length === 0 ? (
            <EmptyState
              title="No requests against this asset"
              description="Faults raised for this asset will appear here."
            />
          ) : (
            tickets.map((t) => (
              <Link
                key={t.id}
                href={`/dashboard/tickets/${t.id}`}
                className="flex items-center justify-between gap-3 rounded-md border border-border p-3 transition-colors hover:bg-accent"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{t.summary ?? t.message_text}</p>
                  <p className="text-xs text-muted-foreground">{formatDateTime(t.created_at)}</p>
                </div>
                <div className="flex flex-shrink-0 gap-1.5">
                  <StatusBadge status={t.status} />
                  {t.urgency && <StatusBadge status={t.urgency} />}
                </div>
              </Link>
            ))
          )}
        </CardContent>
      </Card>
    </div>
  );
}
