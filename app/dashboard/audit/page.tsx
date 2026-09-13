import Link from "next/link";
import { redirect } from "next/navigation";
import { ShieldCheck } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { getSessionProfile } from "@/lib/auth";
import { roleLabel } from "@/lib/roles";
import { cn } from "@/lib/utils";
import { PageHeader } from "@/components/patterns/page-header";
import { EmptyState } from "@/components/patterns/empty-state";
import { PrintButton } from "@/components/patterns/print-button";
import { PrintMasthead } from "@/components/patterns/print-masthead";
import {
  type AuditEntry,
  ENTITY_FILTERS,
  filterFor,
  subjectOf,
  attributedActor,
  automaticSource,
  actorKind,
  describeEntry,
} from "@/lib/audit-format";
import AuditTable, { type AuditRow } from "./AuditTable";

// The audit trail, read as a person reads it (12 Sept 2026).
//
// Asked for directly: "make the audit trail/log a little more descriptive and
// include the fields in the attached snapshot that is missing in the current
// design" — the old AURA log's Subject, Action (as a sentence), User and
// Project. Each row now carries: when, the subject, what happened in words, who
// did it (and in what role), the property it concerns, and what it is about,
// with a link to it where the reader can open it.
//
// The rows are read through the caller's own session — `audit_log_select`
// gives oversight their whole organisation and everybody else their own acts —
// and nothing on this page can change that. Names, places and references are
// resolved for rows the reader has ALREADY been given, within their own
// organisation, and never widen what they see.
//
// ⚠️ The trail is immutable by trigger (`prevent_audit_mutation`) and stays
// so. Nothing here rewrites a row; a row written by a test run or a demo login
// is LABELLED, never removed.

const LIMITS = [200, 1000] as const;

/** Who may follow a link from here into the thing a row is about — the rest
 *  would follow it into a refusal, which is the dead end this page must not be. */
const ORG_WIDE = new Set(["admin", "executive"]);
const MONEY_DESKS = new Set(["admin", "executive", "finance_approver", "payment_approver"]);

export default async function AuditPage({
  searchParams,
}: {
  searchParams: Promise<{ type?: string; limit?: string }>;
}) {
  const { type, limit: limitParam } = await searchParams;
  const session = await getSessionProfile();
  if (!session?.profile) redirect("/login");
  const viewerRole = session.profile.role;
  const orgId = session.profile.org_id;
  const brand = session.org?.delivery_brand ?? null;

  const filter = filterFor(type);
  const limit = LIMITS.includes(Number(limitParam) as 200 | 1000) ? Number(limitParam) : 200;

  const supabase = await createClient();
  let query = supabase
    .from("audit_log")
    .select("id, actor_id, action, entity_type, entity_id, before_state, after_state, created_at")
    .order("created_at", { ascending: false })
    .limit(limit);
  if (filter.types) query = query.in("entity_type", filter.types);
  if (filter.actions) query = query.in("action", filter.actions);
  if (filter.key === "security") {
    // Sign-ins are written against the person, so they belong here too.
    query = supabase
      .from("audit_log")
      .select("id, actor_id, action, entity_type, entity_id, before_state, after_state, created_at")
      .or(`entity_type.in.(${filter.types!.join(",")}),action.like.session.%`)
      .order("created_at", { ascending: false })
      .limit(limit);
  }

  const { data } = await query;
  const entries = (data as AuditEntry[]) ?? [];

  // ── Resolve people, places and references — batched, one query each ─────
  const { supabaseAdmin } = await import("@/lib/supabase/admin");

  const actorIds = new Set<string>();
  const alsoNamed = new Set<string>();
  for (const e of entries) {
    const who = attributedActor(e).id;
    if (who) actorIds.add(who);
    const a = e.after_state ?? {};
    if (typeof a.assigned_to_user_id === "string") alsoNamed.add(a.assigned_to_user_id);
    if (typeof a.occupant_user_id === "string") alsoNamed.add(a.occupant_user_id);
  }
  const people = new Map<string, { name: string; email: string | null; role: string }>();
  const ids = Array.from(new Set([...Array.from(actorIds), ...Array.from(alsoNamed)]));
  if (ids.length) {
    const { data: users } = await supabaseAdmin
      .from("users").select("id, full_name, email, role").eq("org_id", orgId).in("id", ids);
    for (const u of users ?? []) {
      people.set(u.id, { name: u.full_name ?? u.email ?? "Unnamed", email: u.email, role: u.role });
    }
  }

  // Which property each row concerns: named on the row, or one step away —
  // through the request a payment or requisition was raised against, or the
  // payable an approval decided.
  const directProperty = (e: AuditEntry): string | null => {
    const s = { ...(e.before_state ?? {}), ...(e.after_state ?? {}) } as Record<string, unknown>;
    return typeof s.property_id === "string" ? s.property_id : null;
  };
  const ticketOf = new Map<string, string>();      // row id → ticket id
  const payableOf = new Map<string, { type: string; id: string }>();
  for (const e of entries) {
    const s = { ...(e.before_state ?? {}), ...(e.after_state ?? {}) } as Record<string, unknown>;
    if (directProperty(e)) continue;
    if (typeof s.ticket_id === "string") ticketOf.set(e.id, s.ticket_id);
    else if (e.entity_type === "tickets" && e.entity_id) ticketOf.set(e.id, e.entity_id);
    else if (e.entity_type === "payment_approvals" && typeof s.payable_id === "string") {
      payableOf.set(e.id, { type: String(s.payable_type), id: s.payable_id });
    }
  }
  const payIds = Array.from(new Set(Array.from(payableOf.values()).filter((p) => p.type === "vendor_payment").map((p) => p.id)));
  const reqIds = Array.from(new Set(Array.from(payableOf.values()).filter((p) => p.type === "ops_requisition").map((p) => p.id)));
  const remIds = Array.from(new Set(Array.from(payableOf.values()).filter((p) => p.type === "landlord_payout").map((p) => p.id)));
  const [payRows, reqRows, remRows] = await Promise.all([
    payIds.length ? supabaseAdmin.from("payments").select("id, ticket_id, invoice_reference").eq("org_id", orgId).in("id", payIds) : Promise.resolve({ data: [] }),
    reqIds.length ? supabaseAdmin.from("ops_requisitions").select("id, ticket_id, reference").eq("org_id", orgId).in("id", reqIds) : Promise.resolve({ data: [] }),
    remIds.length ? supabaseAdmin.from("remittances").select("id, property_id, reference").eq("org_id", orgId).in("id", remIds) : Promise.resolve({ data: [] }),
  ]);
  const payableRef = new Map<string, string>();
  const payableTicket = new Map<string, string>();
  const payableProperty = new Map<string, string>();
  for (const p of (payRows.data ?? []) as { id: string; ticket_id: string | null; invoice_reference: string | null }[]) {
    if (p.ticket_id) payableTicket.set(p.id, p.ticket_id);
    if (p.invoice_reference) payableRef.set(p.id, p.invoice_reference);
  }
  for (const r of (reqRows.data ?? []) as { id: string; ticket_id: string | null; reference: string | null }[]) {
    if (r.ticket_id) payableTicket.set(r.id, r.ticket_id);
    if (r.reference) payableRef.set(r.id, r.reference);
  }
  for (const r of (remRows.data ?? []) as { id: string; property_id: string | null; reference: string | null }[]) {
    if (r.property_id) payableProperty.set(r.id, r.property_id);
    if (r.reference) payableRef.set(r.id, r.reference);
  }
  const allTickets = Array.from(new Set([...Array.from(ticketOf.values()), ...Array.from(payableTicket.values())]));
  const { data: ticketRows } = allTickets.length
    ? await supabaseAdmin.from("tickets").select("id, property_id").eq("org_id", orgId).in("id", allTickets)
    : { data: [] };
  const ticketProperty = new Map((ticketRows ?? []).map((t) => [t.id, t.property_id as string | null]));

  const propertyOf = (e: AuditEntry): string | null => {
    const d = directProperty(e);
    if (d) return d;
    const t = ticketOf.get(e.id);
    if (t) return ticketProperty.get(t) ?? null;
    const p = payableOf.get(e.id);
    if (p) return payableProperty.get(p.id) ?? (payableTicket.get(p.id) ? ticketProperty.get(payableTicket.get(p.id)!) ?? null : null);
    return null;
  };
  const propertyIds = Array.from(new Set(entries.map(propertyOf).filter((x): x is string => Boolean(x))));
  const { data: propRows } = propertyIds.length
    ? await supabaseAdmin.from("properties").select("id, name").eq("org_id", orgId).in("id", propertyIds)
    : { data: [] };
  const propertyName = new Map((propRows ?? []).map((p) => [p.id, p.name as string]));

  // ── Where a row can be opened — only for readers the destination admits ─
  const linkFor = (e: AuditEntry): string | null => {
    const s = { ...(e.before_state ?? {}), ...(e.after_state ?? {}) } as Record<string, unknown>;
    const money = MONEY_DESKS.has(viewerRole);
    const all = ORG_WIDE.has(viewerRole);
    const id = e.entity_id;
    switch (e.entity_type) {
      case "payments": return money && id ? `/dashboard/payments/${id}` : null;
      case "ops_requisitions": return money && id ? `/dashboard/approvals/requisitions/${id}` : null;
      case "remittances": return money && id ? `/dashboard/remittances/${id}` : null;
      case "manual_remittance_records":
        return money && typeof s.remittance_id === "string" ? `/dashboard/remittances/${s.remittance_id}` : null;
      case "payment_approvals": {
        const p = payableOf.get(e.id);
        if (!money || !p) return null;
        return p.type === "vendor_payment" ? `/dashboard/payments/${p.id}`
          : p.type === "ops_requisition" ? `/dashboard/approvals/requisitions/${p.id}`
          : `/dashboard/remittances/${p.id}`;
      }
      case "offline_payment_claims": return money && id ? `/dashboard/payments/offline/${id}` : null;
      case "tickets": return all && id ? `/dashboard/tickets/${id}` : null;
      case "leases": return all && id ? `/dashboard/leases/${id}` : null;
      case "vendors": return all && id ? `/dashboard/vendors/${id}` : null;
      case "properties": return all && id ? `/dashboard/properties/${id}` : null;
      default: return null;
    }
  };

  const aboutFor = (e: AuditEntry): string | null => {
    const s = { ...(e.before_state ?? {}), ...(e.after_state ?? {}) } as Record<string, unknown>;
    const p = payableOf.get(e.id);
    if (p) return payableRef.get(p.id) ?? null;
    return (s.reference ?? s.invoice_reference ?? s.gateway_reference ?? null) as string | null;
  };

  const rows: AuditRow[] = entries.map((e) => {
    const who = attributedActor(e);
    const person = who.id ? people.get(who.id) : undefined;
    const pid = propertyOf(e);
    return {
      id: e.id,
      at: e.created_at,
      subject: subjectOf(e),
      what: describeEntry(e, (id) => (typeof id === "string" ? people.get(id)?.name ?? null : null)),
      code: e.action,
      actor: person?.name ?? (who.id ? "Someone no longer listed" : automaticSource(e)),
      actorRole: person ? roleLabel(person.role, brand) : null,
      automatic: !who.id,
      fromRecord: who.fromRecord,
      kind: actorKind(person?.email),
      property: pid ? propertyName.get(pid) ?? null : null,
      about: aboutFor(e),
      href: linkFor(e),
      tone: /reject|refus|fail|removed|suspend/i.test(e.action + (String(e.after_state?.decision ?? "")))
        ? "destructive"
        : /approved|sent|paid|signed_in|confirm/i.test(e.action + String(e.after_state?.decision ?? "") + String(e.after_state?.status ?? ""))
          ? "success"
          : "muted",
    };
  });

  const hasLabelled = rows.some((r) => r.kind);

  return (
    <div className="printable space-y-6">
      <PrintMasthead
        org={session.org?.name ?? "Audit trail"}
        title="Audit Trail"
        subtitle={`${filter.label} · latest ${rows.length.toLocaleString()} entries`}
        by={session.profile.full_name || session.profile.email || undefined}
      />

      <div data-print="screen-only">
        <PageHeader
          title="Audit Trail"
          description="Every change, decision and sign-in, with who made it and when. Entries are permanent: nobody can edit or delete them."
          actions={<PrintButton />}
        />
      </div>

      <div className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1" data-print="screen-only">
        {ENTITY_FILTERS.map((f) => {
          const isActive = filter.key === f.key;
          const q = new URLSearchParams();
          if (f.key !== "all") q.set("type", f.key);
          if (limit !== 200) q.set("limit", String(limit));
          return (
            <Link
              key={f.key}
              href={`/dashboard/audit${q.toString() ? `?${q}` : ""}`}
              aria-current={isActive ? "page" : undefined}
              className={cn(
                "flex-shrink-0 rounded-full border px-3 py-1.5 text-xs font-medium transition-colors",
                isActive
                  ? "border-transparent bg-[var(--brand)] text-[var(--brand-fg)]"
                  : "border-border bg-card text-muted-foreground hover:bg-accent hover:text-foreground"
              )}
            >
              {f.label}
            </Link>
          );
        })}
      </div>

      {rows.length === 0 ? (
        <EmptyState
          icon={<ShieldCheck />}
          title="Nothing recorded here yet"
          description="Every change, approval, payment, document and sign-in is written here automatically as it happens."
        />
      ) : (
        <AuditTable
          rows={rows}
          limit={limit}
          limits={[...LIMITS]}
          typeKey={filter.key}
          hasLabelled={hasLabelled}
        />
      )}
    </div>
  );
}
