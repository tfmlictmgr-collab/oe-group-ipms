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

type RecordType = "staff" | "tenant" | "vendor" | "landlord" | "schedule" | "collections";

/**
 * Who may reach this route at all, BEFORE the capability is consulted.
 *
 * ⚠️ Widened from `admin` alone (5 Sept 2026). The board asked that the
 * tenant, property and owner lists be downloadable by the RM/PM, and this
 * route refused them with "Administrator access required" no matter what the
 * permissions matrix said — so `records.export` could be turned on for a
 * property manager and change nothing, which is a control that looks like it
 * works and does not.
 *
 * The capability gate below is UNTOUCHED: 0239 turned bulk export off for
 * every role including admin, and it stays off until an operator turns it on
 * for that org through Settings → Permissions. What changes here is only that
 * the role check no longer contradicts the capability.
 *
 * Scoping needs no new rule: the client below is the caller's own session, so
 * a property manager's CSV contains exactly the rows RLS already admits —
 * their own properties, and nothing else.
 */
const MAY_EXPORT = new Set([
  "admin",
  // The board's own words: the payment officer and the payment approver are the
  // accounting desks, and they need "reporting, record generation and
  // accounting purposes". Both already hold org-wide READ on leases, service
  // charges and the client-funds ledger through `oversight_roles()`; refusing
  // them a CSV of what they can already open on screen was a control in the
  // wrong place. The executive holds the same read (decision 9).
  "finance_approver",
  "payment_approver",
  "executive",
  // Place-scoped: RLS gives them their own properties and nothing else.
  "property_manager",
  "regional_manager",
]);

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
  if (!MAY_EXPORT.has(profile.role)) {
    return new NextResponse(
      "Record export is held by administrators and property/regional managers.",
      { status: 403 }
    );
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
  if (!type || !["staff", "tenant", "vendor", "landlord", "schedule", "collections"].includes(type)) {
    return new NextResponse("Unknown record type.", { status: 400 });
  }

  // Client-funds collections, for the audience actually being looked at —
  // tenants, or owners/vendors/other. Same rule as the schedule: a download
  // button under a filtered list must download the filtered list.
  if (type === "collections") {
    const audience = searchParams.get("audience") ?? "all";
    const TENANT_PURPOSES = ["service_charge", "rent", "deposit"];

    let q = supabase
      .from("payment_intents")
      .select(
        "gateway_reference, purpose, currency, amount_expected, amount_paid, status, paid_at, created_at, payer_email, users:payer_user_id(full_name, email)"
      )
      .order("created_at", { ascending: false })
      .limit(2000);

    if (audience === "tenant") q = q.in("purpose", TENANT_PURPOSES);
    if (audience === "other") q = q.not("purpose", "in", `(${TENANT_PURPOSES.join(",")})`);

    const { data } = await q;

    const csvOut = rows(
      ["Reference", "Payer", "Email", "For", "Currency", "Invoiced", "Received", "Status", "Raised", "Paid"],
      (data ?? []).map((r) => {
        const u = r.users as { full_name?: string; email?: string } | null;
        return [
          r.gateway_reference ?? "",
          u?.full_name ?? "Unassigned",
          (r.payer_email as string | null) ?? u?.email ?? "",
          String(r.purpose ?? "").replace(/_/g, " "),
          r.currency ?? "",
          r.amount_expected ?? "",
          r.amount_paid ?? "",
          r.status ?? "",
          r.created_at ?? "",
          r.paid_at ?? "",
        ];
      })
    );

    return new NextResponse(csvOut, {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="collections-${audience}-${new Date()
          .toISOString()
          .slice(0, 10)}.csv"`,
      },
    });
  }

  // ── The tenancy schedule, filtered exactly as it was on screen ────────────
  //
  // 📌 Asked for directly: "can printing be done based on specific criteria
  // like owner/tenant, instead of printing everything just like that?" So the
  // same filters the page carries are read here and applied to the query — a
  // download button that ignores the filter above it hands somebody the whole
  // portfolio when they asked for one landlord, which is both useless and, for
  // a report leaving the platform, the wrong default.
  if (type === "schedule") {
    let q = supabase
      .from("tenancy_schedule")
      .select(
        "property_name, property_address, owner_name, unit_label, tenant_name, tenant_phone, tenant_email, status, start_date, end_date, rent_amount, rent_frequency, rent_billed, rent_collected, rent_outstanding, management_fee_pct, management_fees, landlord_net, service_charge_billed, service_charge_collected, remark, recorded_at"
      );

    const owner = searchParams.get("owner");
    const property = searchParams.get("property");
    const tenant = searchParams.get("tenant");
    const status = searchParams.get("status");
    const from = searchParams.get("from");
    const to = searchParams.get("to");
    if (owner) q = q.eq("owner_name", owner);
    if (property) q = q.eq("property_name", property);
    if (tenant) q = q.eq("tenant_name", tenant);
    if (status) q = q.eq("status", status);
    if (from) q = q.gte("start_date", from);
    if (to) q = q.lte("start_date", to);

    const { data } = await q.order("property_name").order("unit_label");

    const csvOut = rows(
      [
        "S/N", "Landlord", "Property", "Property address", "Unit",
        "Tenant", "Phone", "Email", "Tenancy status",
        "Term starts", "Term ends", "Rent", "Billed as",
        "Rent billed", "Rent received", "Rent outstanding",
        "Mgt fee %", "Mgt fee", "Landlord net",
        "Service charge billed", "Service charge received", "Remark",
      ],
      (data ?? []).map((r, i) => [
        i + 1,
        r.owner_name ?? "",
        r.property_name ?? "",
        r.property_address ?? "",
        r.unit_label ?? "",
        r.tenant_name ?? "",
        r.tenant_phone ?? "",
        r.tenant_email ?? "",
        r.status ?? "",
        r.start_date ?? "",
        r.end_date ?? "",
        r.rent_amount ?? "",
        r.rent_frequency ?? "",
        r.rent_billed ?? "",
        r.rent_collected ?? "",
        r.rent_outstanding ?? "",
        r.management_fee_pct ?? "",
        r.management_fees ?? "",
        r.landlord_net ?? "",
        r.service_charge_billed ?? "",
        r.service_charge_collected ?? "",
        r.remark ?? "",
      ])
    );

    const scope = owner ?? property ?? tenant ?? "portfolio";
    return new NextResponse(csvOut, {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="tenancy-schedule-${scope
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-|-$/g, "")}-${new Date().toISOString().slice(0, 10)}.csv"`,
      },
    });
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
