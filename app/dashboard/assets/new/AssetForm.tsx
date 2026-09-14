"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input, Select, Textarea } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  ASSET_FIELDS, GROUP_LABELS, humanize, type AssetField,
} from "@/lib/asset-schema";
import { createAsset } from "../actions";
import { runAction, describeError } from "@/lib/run-action";

type Option = { id: string; label: string; propertyId?: string };
type CustomDef = {
  field_key: string; label: string; field_type: string;
  options: string[] | null; help_text: string | null; required: boolean;
};

// Rendered from the shared field list, so the form and the CSV template can
// never drift apart.
const SKIP = new Set(["property_name", "unit_label", "vendor_name", "custodian_email"]);

export default function AssetForm({
  properties, units, vendors, users, customDefs, assets = [],
}: {
  properties: Option[];
  units: Option[];
  vendors: Option[];
  users: Option[];
  customDefs: CustomDef[];
  /** Existing assets, for the "Part of" assembly picker (0121). */
  assets?: Option[];
}) {
  const router = useRouter();
  const [form, setForm] = React.useState<Record<string, string>>({
    category: "other", status: "in_service", condition: "good", criticality: "medium",
    property_id: properties[0]?.id ?? "",
  });
  const [custom, setCustom] = React.useState<Record<string, string>>({});
  const [saving, setSaving] = React.useState(false);

  const set = (k: string) => (
    e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>
  ) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const unitsForProperty = units.filter((u) => u.propertyId === form.property_id);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      const payload = { ...form };
      if (Object.keys(custom).length) payload.custom_fields = JSON.stringify(custom);
      const id = await runAction(createAsset(payload));
      toast.success("Asset added to the register");
      router.push(`/dashboard/assets/${id}`);
      router.refresh();
    } catch (err) {
      toast.error("Could not save asset", {
        description: describeError(err),
      });
    } finally {
      setSaving(false);
    }
  }

  function field(f: AssetField) {
    const id = `f-${f.key}`;
    const common = { id, value: form[f.key] ?? "", onChange: set(f.key) };
    return (
      <div key={f.key} className="space-y-1.5">
        <Label htmlFor={id}>
          {f.label}
          {!f.required && <span className="ml-1 font-normal text-muted-foreground">(optional)</span>}
        </Label>
        {f.type === "enum" ? (
          <Select {...common} className="capitalize">
            {(f.enumValues ?? []).map((v) => (
              <option key={v} value={v}>{humanize(v)}</option>
            ))}
          </Select>
        ) : f.type === "boolean" ? (
          <Select {...common}>
            <option value="">No</option>
            <option value="true">Yes</option>
          </Select>
        ) : f.key === "description" || f.key === "notes" ? (
          <Textarea {...common} rows={3} placeholder={f.example} />
        ) : (
          <Input
            {...common}
            type={f.type === "date" ? "date" : f.type === "number" ? "number" : "text"}
            min={f.type === "number" ? 0 : undefined}
            step={f.type === "number" ? "any" : undefined}
            placeholder={f.type === "date" ? undefined : f.example}
            required={f.required}
          />
        )}
      </div>
    );
  }

  const groups = ["identity", "location", "lifecycle", "commercial", "responsibility", "compliance", "insurance"] as const;

  return (
    <form onSubmit={onSubmit} className="space-y-5">
      {groups.map((g) => {
        const fields = ASSET_FIELDS.filter((f) => f.group === g && !SKIP.has(f.key));
        return (
          <Card key={g}>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">{GROUP_LABELS[g]}</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-4 sm:grid-cols-2">
              {/* Location group needs the real property/unit pickers, not text. */}
              {g === "location" && (
                <>
                  <div className="space-y-1.5">
                    <Label htmlFor="property_id">Property</Label>
                    <Select
                      id="property_id"
                      value={form.property_id}
                      onChange={(e) => setForm((f) => ({ ...f, property_id: e.target.value, unit_id: "" }))}
                      required
                    >
                      {properties.length === 0 && <option value="">No properties available</option>}
                      {properties.map((p) => (
                        <option key={p.id} value={p.id}>{p.label}</option>
                      ))}
                    </Select>
                    <p className="text-xs text-muted-foreground">Only properties you manage are listed.</p>
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="unit_id">
                      Unit <span className="font-normal text-muted-foreground">(optional)</span>
                    </Label>
                    <Select id="unit_id" value={form.unit_id ?? ""} onChange={set("unit_id")}>
                      <option value="">— building-wide —</option>
                      {unitsForProperty.map((u) => (
                        <option key={u.id} value={u.id}>{u.label}</option>
                      ))}
                    </Select>
                  </div>
                </>
              )}
              {fields.map(field)}
              {g === "responsibility" && (
                <>
                  <div className="space-y-1.5">
                    <Label htmlFor="parent_asset_id">
                      Part of <span className="font-normal text-muted-foreground">(optional)</span>
                    </Label>
                    {/* Same property only — the trigger refuses anything else,
                        and a picker offering cross-property parents would be a
                        control built to be rejected. */}
                    <Select
                      id="parent_asset_id"
                      value={form.parent_asset_id ?? ""}
                      onChange={set("parent_asset_id")}
                    >
                      <option value="">— a standalone asset —</option>
                      {assets
                        .filter((a) => a.propertyId === form.property_id)
                        .map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}
                    </Select>
                    <p className="text-xs text-muted-foreground">
                      Choose the assembly this is a component of, so spend and servicing
                      can be rolled up to the whole system.
                    </p>
                  </div>

                  <div className="space-y-1.5">
                    <Label htmlFor="assigned_vendor_id">
                      Maintaining vendor <span className="font-normal text-muted-foreground">(optional)</span>
                    </Label>
                    <Select id="assigned_vendor_id" value={form.assigned_vendor_id ?? ""} onChange={set("assigned_vendor_id")}>
                      <option value="">— none —</option>
                      {vendors.map((v) => <option key={v.id} value={v.id}>{v.label}</option>)}
                    </Select>
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="custodian_user_id">
                      In-house custodian <span className="font-normal text-muted-foreground">(optional)</span>
                    </Label>
                    <Select id="custodian_user_id" value={form.custodian_user_id ?? ""} onChange={set("custodian_user_id")}>
                      <option value="">— none —</option>
                      {users.map((u) => <option key={u.id} value={u.id}>{u.label}</option>)}
                    </Select>
                  </div>
                </>
              )}
            </CardContent>
          </Card>
        );
      })}

      {customDefs.length > 0 && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Additional fields</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-4 sm:grid-cols-2">
            {customDefs.map((d) => {
              const id = `c-${d.field_key}`;
              const val = custom[d.field_key] ?? "";
              const onChange = (
                e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>
              ) => setCustom((c) => ({ ...c, [d.field_key]: e.target.value }));
              return (
                <div key={d.field_key} className="space-y-1.5">
                  <Label htmlFor={id}>
                    {d.label}
                    {!d.required && <span className="ml-1 font-normal text-muted-foreground">(optional)</span>}
                  </Label>
                  {d.field_type === "select" ? (
                    <Select id={id} value={val} onChange={onChange} required={d.required}>
                      <option value="">— select —</option>
                      {(d.options ?? []).map((o) => <option key={o} value={o}>{o}</option>)}
                    </Select>
                  ) : (
                    <Input
                      id={id}
                      value={val}
                      onChange={onChange}
                      required={d.required}
                      type={d.field_type === "number" ? "number" : d.field_type === "date" ? "date" : "text"}
                    />
                  )}
                  {d.help_text && <p className="text-xs text-muted-foreground">{d.help_text}</p>}
                </div>
              );
            })}
          </CardContent>
        </Card>
      )}

      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <Button type="button" variant="ghost" onClick={() => router.push("/dashboard/assets")}>
          Cancel
        </Button>
        <Button
          type="submit"
          variant="brand"
          disabled={saving || !form.property_id || !form.asset_tag || !form.name}
        >
          {saving ? "Saving…" : "Add asset"}
        </Button>
      </div>
    </form>
  );
}
