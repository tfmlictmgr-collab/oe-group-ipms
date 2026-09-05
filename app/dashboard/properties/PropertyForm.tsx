"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { runAction, describeError } from "@/lib/run-action";
import { Select } from "@/components/ui/input";
import HierarchyPicker, { type OrgNode } from "@/components/patterns/hierarchy-picker";
import { saveProperty, addPropertyType, createPropertyWithUnits } from "./actions";
import { createNode } from "./hierarchy/actions";

export type { OrgNode };

/** The offered descriptions, grouped as the board asked (0198). */
export type UnitType = { id: string; label: string; category: "residential" | "commercial" };

/** The same, for the PROPERTY itself (0237). A separate catalogue on purpose. */
export type PropertyType = { id: string; label: string; category: "residential" | "commercial" };

export default function PropertyForm({
  property,
  nodes = [],
  canBuildHierarchy = false,
  unitTypes = [],
  propertyTypes = [],
  canWriteTypes = false,
}: {
  property?: {
    id: string;
    name: string;
    reference: string | null;
    address: string | null;
    property_type: string | null;
    site_node_id: string | null;
  };
  nodes?: OrgNode[];
  /** `hierarchy.write` — whether this person may add a location/project/site here. */
  canBuildHierarchy?: boolean;
  /** Offered when enrolling a property. Empty on the edit form, which has none. */
  unitTypes?: UnitType[];
  /** Offered for the property's own description (0237). Both forms use it. */
  propertyTypes?: PropertyType[];
  /** `properties.write` — whether this person may add a description. */
  canWriteTypes?: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = React.useState(false);
  const [form, setForm] = React.useState({
    name: property?.name ?? "",
    reference: property?.reference ?? "",
    address: property?.address ?? "",
    propertyType: property?.property_type ?? "",
  });
  const [siteNodeId, setSiteNodeId] = React.useState(property?.site_node_id ?? "");

  // null = the picker is showing; a string = someone is naming a new one.
  const [newPropertyType, setNewPropertyType] = React.useState<string | null>(null);
  const [addingType, setAddingType] = React.useState(false);

  async function addType(category: "residential" | "commercial") {
    const label = (newPropertyType ?? "").trim();
    if (!label) return;
    setAddingType(true);
    try {
      await runAction(addPropertyType(label, category));
      // Select what they just added, so naming it and using it are one act.
      setForm((f) => ({ ...f, propertyType: label }));
      setNewPropertyType(null);
      toast.success(`"${label}" added to the list`);
      router.refresh();
    } catch (e) {
      toast.error(describeError(e));
    } finally {
      setAddingType(false);
    }
  }

  // How many units this property has, captured while it is being enrolled
  // rather than left to a second visit. Offered only on CREATE: an existing
  // property has a units panel of its own, and a "how many" box on the edit
  // form would read like a correction while behaving like an addition.
  const [units, setUnits] = React.useState({ type: "", count: "", space: "" });
  const enrolling = !property;
  const unitCount = Number(units.count.replace(/[,\s]/g, "") || "0");
  // 0252. On CREATE the units are part of the record, not an afterthought, so
  // the button stays closed until they are there. On an EDIT the units panel
  // lives on the property's own page and this block is not rendered at all —
  // hence `!enrolling` passing straight through rather than a second branch.
  const unitsComplete =
    !enrolling ||
    (units.type.trim() !== "" &&
      Number((units.space || "").replace(/[,\s]/g, "")) > 0);

  // Widened to the select in 0237 — the Type field is a picker now, and one
  // helper serving both is what keeps the two from drifting apart.
  const set =
    (k: keyof typeof form) =>
    (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
      setForm((f) => ({ ...f, [k]: e.target.value }));

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      // ⚠️ ONE write on create (0252). This used to be two, on the argument
      // that a failed unit write should leave the property standing so the
      // person could finish on its own page — which produced, by accident, the
      // one state decision 31 forbids: a property with no units. An edit is
      // still a plain update; only creation goes through the atomic path.
      const r = property
        ? await runAction(
            saveProperty({ id: property.id, ...form, siteNodeId: siteNodeId || null })
          )
        : await runAction(
            createPropertyWithUnits({
              ...form,
              siteNodeId: siteNodeId || null,
              units,
            })
          );

      const created = property ? 0 : unitCount || 1;
      toast.success(
        property
          ? "Property updated"
          : `Property added with ${created} unit${created === 1 ? "" : "s"} — ${created === 1 ? "it is" : "all of them are"} vacant`
      );
      router.push(`/dashboard/properties/${r.id}`);
      router.refresh();
    } catch (err) {
      toast.error("Could not save", {
        description: describeError(err),
        duration: Infinity,
        closeButton: true,
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="p-name">Name</Label>
          <Input id="p-name" required value={form.name} onChange={set("name")}
                 placeholder="e.g. Lekki Gardens Estate" />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="p-ref">
            Reference <span className="font-normal text-muted-foreground">(optional)</span>
          </Label>
          <Input id="p-ref" value={form.reference} onChange={set("reference")}
                 placeholder="Your own code, e.g. LGE-01" />
          <p className="text-xs text-muted-foreground">
            Must be unique — a reference that means two properties is worse than none.
          </p>
        </div>
        <div className="space-y-1.5 sm:col-span-2">
          <Label htmlFor="p-addr">Address</Label>
          <Input id="p-addr" value={form.address} onChange={set("address")}
                 placeholder="Street, area, city" />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="p-type">
            Type <span className="font-normal text-muted-foreground">(optional)</span>
          </Label>
          {newPropertyType === null ? (
            <>
              <Select id="p-type" value={form.propertyType} onChange={set("propertyType")}>
                <option value="">Choose…</option>
                {/* ⚠️ A property filed before 0237 carries hand-typed text that
                    is on no list. Offering only the catalogue would make saving
                    an unrelated edit silently blank it, so the recorded value
                    keeps its own place until someone deliberately changes it. */}
                {form.propertyType &&
                  !propertyTypes.some((t) => t.label === form.propertyType) && (
                    <optgroup label="Recorded on this property">
                      <option value={form.propertyType}>{form.propertyType}</option>
                    </optgroup>
                  )}
                <optgroup label="Residential">
                  {propertyTypes.filter((t) => t.category === "residential").map((t) => (
                    <option key={t.id} value={t.label}>{t.label}</option>
                  ))}
                </optgroup>
                <optgroup label="Commercial">
                  {propertyTypes.filter((t) => t.category === "commercial").map((t) => (
                    <option key={t.id} value={t.label}>{t.label}</option>
                  ))}
                </optgroup>
              </Select>
              {canWriteTypes && (
                <button
                  type="button"
                  className="text-xs text-muted-foreground underline-offset-2 hover:underline"
                  onClick={() => setNewPropertyType("")}
                >
                  Not listed? Add a description
                </button>
              )}
            </>
          ) : (
            // The same affordance UnitsPanel gives for unit types (0198): the
            // person filing the first cold store in the register should not be
            // sent to a settings screen to name it. The category is asked
            // rather than guessed — guessing puts it in the wrong half of every
            // future dropdown.
            <div className="space-y-1">
              <Input
                autoFocus value={newPropertyType} placeholder="e.g. Tank Farm"
                onChange={(e) => setNewPropertyType(e.target.value)}
              />
              <div className="flex gap-1">
                <Button
                  type="button" size="sm" variant="outline" className="h-7 px-2 text-xs"
                  disabled={!newPropertyType.trim() || addingType}
                  onClick={() => void addType("residential")}
                >
                  Residential
                </Button>
                <Button
                  type="button" size="sm" variant="outline" className="h-7 px-2 text-xs"
                  disabled={!newPropertyType.trim() || addingType}
                  onClick={() => void addType("commercial")}
                >
                  Commercial
                </Button>
                <Button
                  type="button" size="sm" variant="ghost" className="h-7 px-2 text-xs"
                  onClick={() => setNewPropertyType(null)}
                >
                  Cancel
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                Which half of the list it belongs in.
              </p>
            </div>
          )}
        </div>
      </div>

      <div className="space-y-1.5">
        <Label>
          Region &amp; site <span className="font-normal text-muted-foreground">(optional)</span>
        </Label>
        <p className="text-xs text-muted-foreground">
          A property is filed under a site. Work down from the region —{" "}
          {canBuildHierarchy
            ? "if the location, project or site does not exist yet, add it here with “New”."
            : "if a level you need is missing, an administrator adds it under Regions & sites."}{" "}
          Leaving it unfiled changes nothing about what the property can do; it
          just won&apos;t appear in a regional report until someone files it.
        </p>
        <HierarchyPicker
          nodes={nodes}
          value={siteNodeId}
          onChange={setSiteNodeId}
          stopAtLevel="site"
          onCreate={
            canBuildHierarchy
              ? async (parentId, level, name) => {
                  const r = await runAction(createNode(parentId, level, name, ""));
                  return r.id;
                }
              : undefined
          }
        />
      </div>

      {enrolling && unitTypes.length > 0 && (
        <div className="space-y-3 rounded-lg border p-4">
          <div>
            <Label>
              Units <span className="font-normal text-destructive">(required)</span>
            </Label>
            <p className="mt-1 text-xs text-muted-foreground">
              How many lettable units this property has. Each one is created as
              its own row and starts vacant, so the vacancy count falls as they
              are let and rises again as they are given up — and a property on
              Auto intake takes applications for exactly as long as one is free.
              You can add more, or a second type, from the property itself.
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              At least one is needed to save: a property with no units cannot be
              let, cannot be billed a service charge, and cannot have a tenancy
              recorded against it. The property and its units are saved
              together, so neither can land without the other.
            </p>
          </div>
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="space-y-1.5">
              <Label htmlFor="u-type">Type</Label>
              <Select
                id="u-type"
                value={units.type}
                onChange={(e) => setUnits((u) => ({ ...u, type: e.target.value }))}
              >
                <option value="">Choose…</option>
                <optgroup label="Residential">
                  {unitTypes.filter((t) => t.category === "residential").map((t) => (
                    <option key={t.id} value={t.label}>{t.label}</option>
                  ))}
                </optgroup>
                <optgroup label="Commercial">
                  {unitTypes.filter((t) => t.category === "commercial").map((t) => (
                    <option key={t.id} value={t.label}>{t.label}</option>
                  ))}
                </optgroup>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="u-count">How many</Label>
              <Input id="u-count" inputMode="numeric" value={units.count} placeholder="e.g. 12"
                     onChange={(e) => setUnits((u) => ({ ...u, count: e.target.value }))} />
              <p className="text-[11px] text-muted-foreground">
                {unitCount > 1 ? `${unitCount} rows, numbered 1–${unitCount}.` : "One row each."}
              </p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="u-space">Occupied space, each</Label>
              <div className="relative">
                <Input id="u-space" inputMode="decimal" value={units.space} placeholder="85.5"
                       className="pr-9"
                       onChange={(e) => setUnits((u) => ({ ...u, space: e.target.value }))} />
                <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">
                  m²
                </span>
              </div>
              <p className="text-[11px] text-muted-foreground">
                Floor area per unit — it decides each one&apos;s share of a
                service charge.
              </p>
            </div>
          </div>
        </div>
      )}

      <div className="flex gap-2">
        <Button
          type="submit"
          variant="brand"
          disabled={busy || form.name.trim().length < 2 || !unitsComplete}
        >
          {busy ? "Saving…" : property ? "Save changes" : "Add property"}
        </Button>
        <Button type="button" variant="ghost" onClick={() => router.back()}>Cancel</Button>
      </div>
    </form>
  );
}
