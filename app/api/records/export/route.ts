import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getSessionProfile } from "@/lib/auth";
import { csvCell } from "@/lib/asset-schema";
import { roleLabel } from "@/lib/roles";

// Bulk record export — a CSV roster of one record type, scoped to the
// caller's own org exactly as every other page in this dashboard is (the
// server client below carries RLS; nothing here reads or writes with the
// service role).
//
// Gated behind `records.export` (0223) — off for every role in every org,
// admin included, EXCEPT the platform operator, who reaches this through the
// hardcoded operator check below rather than the capability (same shape as
// `training.read`'s screen: the operator's own edition does not depend on a
// capability an operator could theoretically turn off for themselves). A
// client org's own admin only gets this once the operator turns it on for
// that org's `admin` row, through Settings → Permissions — nothing new to
// build there.
export const runtime = "nodejs";

type RecordType = "staff" | "tenant" | "vendor" | "landlord";

function rows(header: string[], data: (string | number | null)[][]): string {
  const lines = [header, ...data].map((r) =>
    r.map((c) => csvCell(c === null || c === undefined ? "" : String(c))).join(",")
  );
  // BOM + CRLF: Excel opens this cleanly with correct encoding, same as the
  // asset-register template.
  return "﻿" + lines.join("\r\n") + "\r\n";
}

export async function GET(req: Request) {
  const session = await getSessionProfile();
  if (!session?.profile || !session.org) {
    return new NextResponse("Sign in required", { status: 401 });
  }
  const { profile, org } = session;
  if (profile.role !== "admin") {
    return new NextResponse("Administrator access required", { status: 403 });
  }

  const supabase = await createClient();
  const isOperator = Boolean(org.is_platform_operator);
  if (!isOperator) {
    const { data: canExport } = await supabase.rpc("has_permission", {
      p_capability: "records.export",
    });
    if (!canExport) {
      return new NextResponse(
        "Record export isn't turned on for your organisation yet. Ask your OE Group contact to enable it.",
        { status: 403 }
      );
    }
  }

  const { searchParams } = new URL(req.url);
  const type = searchParams.get("type") as RecordType | null;
  if (!type || !["staff", "tenant", "vendor", "landlord"].includes(type)) {
    return new NextResponse("Unknown record type.", { status: 400 });
  }

  const brand = org.delivery_brand ?? null;
  let filename: string;
  let csv: string;

  if (type === "staff") {
    const { data } = await supabase
      .from("users")
      .select("full_name, email, role, approval_tier, deactivated_at, created_at")
      .not("role", "in", "(tenant,vendor,property_owner)")
      .order("full_name");
    csv = rows(
      ["Name", "Email", "Role", "Approval tier", "Status", "Added"],
      (data ?? []).map((u) => [
        u.full_name, u.email, roleLabel(u.role, brand), u.approval_tier ?? "",
        u.deactivated_at ? "Deactivated" : "Active",
        u.created_at ? new Date(u.created_at).toLocaleDateString("en-GB") : "",
      ])
    );
    filename = "staff";
  } else if (type === "tenant") {
    const { data: tenants } = await supabase
      .from("users")
      .select("id, full_name, email, deactivated_at, created_at")
      .eq("role", "tenant")
      .order("full_name");
    const { data: leases } = await supabase
      .from("leases")
      .select("tenant_user_id, status, properties(name), units(label)")
      .eq("status", "active");
    const unitFor = new Map<string, string>();
    for (const l of (leases ?? []) as unknown as {
      tenant_user_id: string; properties: { name: string } | null; units: { label: string } | null;
    }[]) {
      const label = [l.properties?.name, l.units?.label].filter(Boolean).join(" · ");
      if (label) unitFor.set(l.tenant_user_id, label);
    }
    csv = rows(
      ["Name", "Email", "Current unit", "Status", "Added"],
      (tenants ?? []).map((t) => [
        t.full_name, t.email, unitFor.get(t.id) ?? "",
        t.deactivated_at ? "Deactivated" : "Active",
        t.created_at ? new Date(t.created_at).toLocaleDateString("en-GB") : "",
      ])
    );
    filename = "tenants";
  } else if (type === "vendor") {
    const { data: vendors } = await supabase
      .from("vendors")
      .select("id, name, service_category, status, created_at")
      .order("name");
    const { data: regs } = await supabase
      .from("vendor_registrations")
      .select("vendor_id, tier, status, legal_name, tin, cac_number");
    const regFor = new Map((regs ?? []).map((r) => [r.vendor_id, r]));
    csv = rows(
      ["Company", "Category", "Status", "KYC tier", "KYC status", "Legal name", "TIN", "CAC number", "Added"],
      (vendors ?? []).map((v) => {
        const r = regFor.get(v.id);
        return [
          v.name, v.service_category ?? "", v.status, r?.tier ?? "", r?.status ?? "",
          r?.legal_name ?? "", r?.tin ?? "", r?.cac_number ?? "",
          v.created_at ? new Date(v.created_at).toLocaleDateString("en-GB") : "",
        ];
      })
    );
    filename = "vendors";
  } else {
    const { data: owners } = await supabase
      .from("users")
      .select("id, full_name, email, deactivated_at, created_at")
      .eq("role", "property_owner")
      .order("full_name");
    const { data: stakes } = await supabase
      .from("property_stakeholders")
      .select("user_id, properties(name)")
      .eq("relation", "owner");
    const propsFor = new Map<string, string[]>();
    for (const s of (stakes ?? []) as unknown as { user_id: string; properties: { name: string } | null }[]) {
      if (!s.properties?.name) continue;
      const list = propsFor.get(s.user_id) ?? [];
      list.push(s.properties.name);
      propsFor.set(s.user_id, list);
    }
    csv = rows(
      ["Name", "Email", "Properties owned", "Status", "Added"],
      (owners ?? []).map((o) => [
        o.full_name, o.email, (propsFor.get(o.id) ?? []).join("; "),
        o.deactivated_at ? "Deactivated" : "Active",
        o.created_at ? new Date(o.created_at).toLocaleDateString("en-GB") : "",
      ])
    );
    filename = "landlords-owners";
  }

  const niceName = `${org.name} - ${filename}.csv`.replace(/[/\\?%*:|"<>]/g, "-");
  const asciiName = niceName.replace(/[^\x20-\x7E]/g, "").trim() || `${filename}.csv`;

  return new NextResponse(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition":
        `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(niceName)}`,
      "Cache-Control": "private, no-store",
    },
  });
}
