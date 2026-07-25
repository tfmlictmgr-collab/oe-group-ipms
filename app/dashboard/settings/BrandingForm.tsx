"use client";

import * as React from "react";
import { toast } from "sonner";
import { Palette, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { updateOrgBranding } from "./actions";

const HEX = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

export default function BrandingForm({
  orgId,
  initial,
  defaults,
  logoSlot,
}: {
  orgId: string;
  initial: { name: string; primary: string; accent: string; logoText: string };
  defaults: { name: string; primary: string; accent: string; logoText: string };
  logoSlot?: React.ReactNode;
}) {
  const [name, setName] = React.useState(initial.name);
  const [primary, setPrimary] = React.useState(initial.primary);
  const [accent, setAccent] = React.useState(initial.accent);
  const [logoText, setLogoText] = React.useState(initial.logoText);
  const [saving, setSaving] = React.useState(false);

  const primaryValid = HEX.test(primary);
  const accentValid = HEX.test(accent);
  const canSave = name.trim().length >= 2 && primaryValid && accentValid && !saving;

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      await updateOrgBranding(orgId, { name, primary, accent, logoText });
      toast.success("Branding updated", {
        description: "Your portal now uses the new theme.",
      });
    } catch (err) {
      toast.error("Could not save branding", {
        description: err instanceof Error ? err.message : "Unexpected error.",
      });
    } finally {
      setSaving(false);
    }
  }

  function resetToBrand() {
    setName(defaults.name);
    setPrimary(defaults.primary);
    setAccent(defaults.accent);
    setLogoText(defaults.logoText);
    toast.info("Reset to brand defaults — remember to save.");
  }

  const mono = (logoText || name).slice(0, 2).toUpperCase();

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div className="space-y-1">
            <CardTitle className="flex items-center gap-2">
              <Palette className="size-4 text-brand" /> Portal branding
            </CardTitle>
            <CardDescription>
              Set how your organisation&rsquo;s portal looks for everyone in it.
            </CardDescription>
          </div>
          <Button type="button" variant="ghost" size="sm" onClick={resetToBrand}>
            <RotateCcw /> Reset
          </Button>
        </div>
      </CardHeader>

      <CardContent className="space-y-6">
        {/* Live preview — updates as you type, before saving. */}
        <div
          className="overflow-hidden rounded-lg border border-border"
          style={
            {
              "--brand": primaryValid ? primary : defaults.primary,
              "--brand-accent": accentValid ? accent : defaults.accent,
            } as React.CSSProperties
          }
        >
          <div className="flex items-center gap-3 bg-sidebar px-4 py-3">
            <span
              className="flex h-9 w-9 items-center justify-center rounded-lg text-sm font-bold"
              style={{ background: "var(--brand)", color: "#fff" }}
            >
              {mono}
            </span>
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold text-white">
                {name || "Organisation name"}
              </p>
              <p className="text-xs text-sidebar-muted">FM / PM Portal</p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2 bg-card px-4 py-3">
            <Button type="button" variant="brand" size="sm">
              Primary action
            </Button>
            <Badge variant="brand">Active</Badge>
            <span
              className="inline-flex h-6 items-center rounded-full px-2.5 text-xs font-medium"
              style={{ background: "var(--brand-accent)", color: "#fff" }}
            >
              Accent
            </span>
            <span className="text-xs text-muted-foreground">Live preview</span>
          </div>
        </div>

        {logoSlot}

        <form onSubmit={onSubmit} className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5 sm:col-span-2">
              <Label htmlFor="org-name">Display name</Label>
              <Input
                id="org-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={80}
                placeholder="e.g. Total Facilities Management"
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="primary">Primary colour</Label>
              <div className="flex items-center gap-2">
                <input
                  aria-label="Pick primary colour"
                  type="color"
                  value={primaryValid ? primary : defaults.primary}
                  onChange={(e) => setPrimary(e.target.value)}
                  className="h-10 w-12 flex-shrink-0 cursor-pointer rounded-md border border-input bg-card p-1"
                />
                <Input
                  id="primary"
                  value={primary}
                  onChange={(e) => setPrimary(e.target.value)}
                  placeholder="#8B1D1D"
                  aria-invalid={!primaryValid}
                  className="font-mono"
                />
              </div>
              {!primaryValid && (
                <p className="text-xs text-destructive">Enter a hex colour, e.g. #8B1D1D.</p>
              )}
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="accent">Accent colour</Label>
              <div className="flex items-center gap-2">
                <input
                  aria-label="Pick accent colour"
                  type="color"
                  value={accentValid ? accent : defaults.accent}
                  onChange={(e) => setAccent(e.target.value)}
                  className="h-10 w-12 flex-shrink-0 cursor-pointer rounded-md border border-input bg-card p-1"
                />
                <Input
                  id="accent"
                  value={accent}
                  onChange={(e) => setAccent(e.target.value)}
                  placeholder="#C9A227"
                  aria-invalid={!accentValid}
                  className="font-mono"
                />
              </div>
              {!accentValid && (
                <p className="text-xs text-destructive">Enter a hex colour, e.g. #C9A227.</p>
              )}
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="logo-text">Monogram</Label>
              <Input
                id="logo-text"
                value={logoText}
                onChange={(e) => setLogoText(e.target.value.toUpperCase())}
                maxLength={2}
                placeholder="OE"
                className="w-24 font-mono uppercase"
              />
              <p className="text-xs text-muted-foreground">Up to 2 characters.</p>
            </div>
          </div>

          <Button type="submit" variant="brand" disabled={!canSave}>
            {saving ? "Saving…" : "Save branding"}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
