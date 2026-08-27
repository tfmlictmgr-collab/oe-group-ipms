import { NextResponse } from "next/server";
import { renderToBuffer } from "@react-pdf/renderer";
import { createClient } from "@/lib/supabase/server";
import { getSessionProfile } from "@/lib/auth";
import { roleLabel } from "@/lib/roles";
import {
  processesForEdition, processesForRole, type Edition, type Process,
} from "@/lib/guides/processes";
import { TrainingGuideDocument } from "@/lib/pdf/training-guide";

// The training handbook as a branded PDF — the whole catalogue
// (`?scope=all`, the default), one role's chapter (`?scope=role&role=…`), or
// a single process as a one-page job aid (`?scope=process&id=…`).
//
// Admin-only, same boundary as the screen this mirrors
// (`/dashboard/training`): this route reads nothing off the request to decide
// WHICH organisation's material to build — that comes from the caller's own
// session, exactly like `/api/guides`. The `role`/`id` a caller may ask for
// are real parameters (an admin legitimately wants any one of THEIR OWN org's
// role chapters or processes), but they are validated against that org's own
// edition-filtered catalogue before anything is rendered — never trusted to
// pick an operator-only process for a brand admin, or a lettings process for
// an org without the module.
export const runtime = "nodejs";

export async function GET(req: Request) {
  const session = await getSessionProfile();
  if (!session?.profile || !session.org) {
    return new NextResponse("Sign in required", { status: 401 });
  }
  const { profile, org } = session;
  if (profile.role !== "admin") {
    return new NextResponse("Administrator access required", { status: 403 });
  }

  const isOperator = Boolean(org.is_platform_operator);
  const edition: Edition = isOperator ? "operator" : org.delivery_brand === "OEA" ? "OEA" : "TFML";

  const supabase = await createClient();
  const { data: moduleRows } = await supabase
    .from("org_modules")
    .select("module")
    .eq("org_id", profile.org_id)
    .eq("enabled", true);
  const orgFeatures = new Set((moduleRows ?? []).map((r) => r.module as string));

  const { searchParams } = new URL(req.url);
  const scope = searchParams.get("scope") ?? "all";
  const trainerView = searchParams.get("view") !== "team";
  const brand = org.delivery_brand ?? null;
  const roleLabelFor = (r: string) => (r === "system" ? "Automatic" : roleLabel(r, brand));

  const groupByModule = (items: Process[]) => {
    const groups: { module: string; items: Process[] }[] = [];
    for (const p of items) {
      const last = groups[groups.length - 1];
      if (last && last.module === p.module) last.items.push(p);
      else groups.push({ module: p.module, items: [p] });
    }
    return groups;
  };

  let title: string;
  let subtitle: string;
  let groups: { module: string; items: Process[] }[];
  let fileTag: string;

  if (scope === "role") {
    const role = searchParams.get("role") ?? "";
    const items = processesForRole(role, edition, orgFeatures);
    if (items.length === 0) {
      return new NextResponse("No processes for that role in this organisation.", { status: 404 });
    }
    title = `${roleLabelFor(role)} — training chapter`;
    subtitle = `${org.name} · every process this role appears in`;
    groups = groupByModule(items);
    fileTag = roleLabelFor(role);
  } else if (scope === "process") {
    const id = searchParams.get("id") ?? "";
    const process = processesForEdition(edition, orgFeatures).find((p) => p.id === id);
    if (!process) {
      return new NextResponse("No such process in this organisation.", { status: 404 });
    }
    title = process.title;
    subtitle = `${org.name} · job aid`;
    groups = [{ module: process.module, items: [process] }];
    fileTag = process.title;
  } else {
    const items = processesForEdition(edition, orgFeatures);
    title = isOperator ? "Operator training handbook" : `${org.name} — training handbook`;
    subtitle = isOperator
      ? "Every journey that belongs to running the platform itself."
      : "Every process in this organisation, by module.";
    groups = groupByModule(items);
    fileTag = "handbook";
  }

  const buffer = await renderToBuffer(
    <TrainingGuideDocument
      org={{
        name: org.name,
        logoUrl: org.logo_url ?? null,
        primary: org.theme_primary ?? "#003366",
        tagline: org.tagline ?? null,
        supportEmail: org.support_email ?? null,
        supportPhone: org.support_phone ?? null,
        portalName: org.portal_name ?? null,
      }}
      title={title}
      subtitle={subtitle}
      groups={groups}
      trainerView={trainerView}
      roleLabelFor={roleLabelFor}
      generatedFor={profile.full_name || profile.email || "an administrator"}
      generatedAt={new Date().toLocaleDateString("en-GB", {
        timeZone: "Africa/Lagos",
        day: "numeric", month: "long", year: "numeric",
      })}
    />
  );

  // Same Latin-1 header trap as `/api/guides`: a plain ASCII filename for
  // `filename`, the real one in RFC 5987 `filename*`.
  const niceName = `${org.name} - ${fileTag}.pdf`.replace(/[/\\?%*:|"<>]/g, "-");
  const asciiName = niceName.replace(/[^\x20-\x7E]/g, "").trim() || "training.pdf";

  return new NextResponse(buffer as unknown as BodyInit, {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition":
        `attachment; filename="${asciiName}"; ` +
        `filename*=UTF-8''${encodeURIComponent(niceName)}`,
      "Cache-Control": "private, no-store",
    },
  });
}
