import { redirect } from "next/navigation";
import { getSessionProfile } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import {
  type PayableDetailData, type PayableLine, type JobCard,
} from "@/components/approvals/PayableDetail";
import ApprovalsBoard, { type QueueRow } from "./ApprovalsBoard";
import {
  ALL_CHAIN_ROLES, getChainState, formatNaira, effectiveTier, tierLabel,
} from "@/lib/approvals/chain";
import { payableRef } from "@/lib/acknowledgement";

export const dynamic = "force-dynamic";

/**
 * The outbound-payment approval queue.
 *
 * ⚠️ Scoped by what the viewer can ACTUALLY ACTION, not by what exists. A tier-1
 * approver shown a queue of ₦5m payments they cannot clear learns only that the
 * screen is lying to them, and the useful signal — the three they can action
 * today — is buried.
 *
 * Rows they cannot action appear under "Waiting on someone else", because
 * knowing a payment is moving is different from being able to move it — but
 * only for someone who is IN THE CHAIN (board, 22 Aug 2026). A person who
 * appears at no stage has no reason to watch other people's payments queue up,
 * and showing them the whole outbound pipeline is a disclosure nobody asked
 * for. Finance is included despite holding no stage: they disburse what the
 * chain clears (decision 16), so what is climbing toward them is their work.
 */
export default async function ApprovalsPage() {
  const session = await getSessionProfile();
  if (!session?.profile) redirect("/login");

  const role = session.profile.role;
  const supabase = await createClient();

  const { data: me } = await supabase
    .from("users").select("id, role, approval_tier").eq("id", session.profile.id).single();

  const actor = {
    id: me?.id ?? session.profile.id,
    role: me?.role ?? role,
    approvalTier: me?.approval_tier ?? null,
  };
  const myTier = effectiveTier(actor.role, actor.approvalTier);

  // Vendor invoices that have passed the B4 gate, landlord payouts raised and
  // not yet sent, and FM/PM ops requisitions awaiting the same chain (0170).
  const [{ data: payments }, { data: payouts }, { data: requisitions }] = await Promise.all([
    supabase
      .from("payments")
      .select("id, amount, invoice_reference, status, created_at, invoice_attachment_path, vendors(name), tickets(id, summary, category, urgency, property_or_unit)")
      .in("status", ["recommended", "approved"])
      .order("created_at", { ascending: true })
      .limit(100),
    supabase
      .from("remittances")
      .select("id, net_amount, period, reference, status, properties(name)")
      .eq("party", "landlord")
      .eq("status", "queued")
      .order("created_at", { ascending: true })
      .limit(100),
    supabase
      .from("ops_requisitions")
      .select("id, total_amount, reference, description, status, created_at, invoice_attachment_path, users!ops_requisitions_raised_by_fkey(full_name), tickets(id, summary, category, urgency, property_or_unit)")
      // ⚠️ `approved` as well as `pending_approval`. A requisition that clears
      // the chain moves to `approved`, and this query excluded it — so the one
      // person who exists to send it could not see it anywhere. There is no
      // requisitions list page and no nav entry, and the Send card renders only
      // on the detail page and only when status IS `approved`: the payable was
      // reachable by typed URL and nothing else. That is the dead end.
      .in("status", ["pending_approval", "approved"])
      .order("created_at", { ascending: true })
      .limit(100),
  ]);

  // ── The evidence, fetched in BATCHES rather than per row ────────────────
  //
  // The board asked that every touch point sees the detail at their desk
  // (decision 23), and the queue previously showed only the words "invoice
  // attached". Rendering the substance costs two more queries and one signing
  // call TOTAL — not one per card, which on a `force-dynamic` page of up to 300
  // rows is the difference between a page and a timeout. Same reasoning the
  // parallel `getChainState` note below already records.
  const reqIds = (requisitions ?? []).map((q) => q.id);
  const { data: allLines } = reqIds.length
    ? await supabase
        .from("ops_requisition_lines")
        .select("id, requisition_id, description, amount, vendors(name), payout_recipients(display_name)")
        .in("requisition_id", reqIds)
        .order("line_order")
    : { data: [] };

  const linesByReq = new Map<string, PayableLine[]>();
  for (const l of (allLines ?? []) as unknown as Array<{
    id: string; requisition_id: string; description: string; amount: number;
    vendors: { name?: string } | null; payout_recipients: { display_name?: string } | null;
  }>) {
    const list = linesByReq.get(l.requisition_id) ?? [];
    list.push({
      id: l.id,
      description: l.description,
      amount: l.amount,
      payee: l.vendors?.name ?? l.payout_recipients?.display_name ?? null,
    });
    linesByReq.set(l.requisition_id, list);
  }

  // One signing call for every attachment on the page. The paths are read off
  // rows RLS already admitted, so signing them needs no second authorisation —
  // and a path that 0217's policy does not admit simply fails to sign, which is
  // rendered as "could not be opened" rather than as "none attached".
  const invoicePaths = [
    ...(requisitions ?? []).map((q) => q.invoice_attachment_path),
    ...(payments ?? []).map((p) => p.invoice_attachment_path),
  ].filter((x): x is string => Boolean(x));

  const signedByPath = new Map<string, string>();
  if (invoicePaths.length > 0) {
    const { data: signed } = await supabase.storage
      .from("invoice-attachments")
      .createSignedUrls(invoicePaths, 600);
    for (const row of signed ?? []) {
      if (row.signedUrl && row.path) signedByPath.set(row.path, row.signedUrl);
    }
  }

  const isImagePath = (p: string | null) => /\.(png|jpe?g|webp|gif)$/i.test(p ?? "");
  const detailFor = (
    path: string | null,
    reference: string | null,
    raisedBy: string | null,
    raisedAt: string | null,
    jobCard: JobCard,
    lines: PayableLine[],
    description: string | null = null
  ): PayableDetailData => ({
    reference,
    raisedBy,
    raisedAt,
    description,
    jobCard,
    lines,
    invoiceUrl: path ? (signedByPath.get(path) ?? null) : null,
    invoiceIsImage: isImagePath(path),
    invoiceUnavailable: Boolean(path) && !signedByPath.has(path as string),
  });

  // ⚠️ Resolved in PARALLEL, and the difference is not cosmetic. Each
  // `getChainState` is three round trips, and these were three sequential `for`
  // loops over three hundred rows — up to nine hundred queries end to end on a
  // `force-dynamic` page, which at any realistic latency is past the function's
  // time budget before it renders a single card. The per-row states are wholly
  // independent of each other, so there was never a reason to await them in
  // turn.
  const described = await Promise.all([
    ...(payments ?? []).map(async (p) => {
      const state = await getChainState(supabase, "vendor_payment", p.id);
      const vendor = (p.vendors as { name?: string } | null)?.name ?? "Vendor";
      return {
        payableType: "vendor_payment" as const,
        payableId: p.id,
        ref: payableRef("vendor_payment", p.id),
        haystack: [
          payableRef("vendor_payment", p.id), p.invoice_reference, vendor,
          (p.tickets as unknown as JobCard)?.summary,
        ].filter(Boolean).join(" ").toLowerCase(),
        title: `${vendor} — ${formatNaira(state.amount)}`,
        subtitle: p.invoice_reference
          ? `Invoice ${p.invoice_reference}`
          : "Vendor invoice",
        href: `/dashboard/payments/${p.id}`,
        state,
        detail: detailFor(
          p.invoice_attachment_path,
          p.invoice_reference ? `Invoice ${p.invoice_reference}` : "Vendor invoice",
          vendor,
          p.created_at,
          (p.tickets as unknown as JobCard) ?? null,
          []
        ),
      };
    }),
    ...(payouts ?? []).map(async (r) => {
      const state = await getChainState(supabase, "landlord_payout", r.id);
      const prop = (r.properties as { name?: string } | null)?.name ?? "Property";
      return {
        payableType: "landlord_payout" as const,
        payableId: r.id,
        ref: payableRef("landlord_payout", r.id),
        haystack: [payableRef("landlord_payout", r.id), r.reference, prop, r.period]
          .filter(Boolean).join(" ").toLowerCase(),
        title: `${prop} — ${formatNaira(state.amount)}`,
        subtitle: `Landlord payout${r.period ? ` · ${r.period}` : ""}`,
        href: "/dashboard/ledger/payouts",
        state,
      };
    }),
    ...(requisitions ?? []).map(async (q) => {
      const state = await getChainState(supabase, "ops_requisition", q.id);
      const job = (q.tickets as { summary?: string } | null)?.summary;
      // Say whether there is evidence to open. The auditor's stage is a check
      // of the invoice against the job card, and a queue that does not
      // distinguish "nothing attached" from "an invoice is waiting for you"
      // makes them open every row to find out.
      const hasInvoice = Boolean(q.invoice_attachment_path);
      return {
        payableType: "ops_requisition" as const,
        payableId: q.id,
        // ⚠️ The AUTO reference is the identifier; `q.reference` is whatever the
        // person raising it typed ("Job101-M", "PO-10001"), which is a useful
        // label and a poor key — it is not unique, not present on older rows,
        // and not what anyone else can guess. Both are searchable.
        ref: payableRef("ops_requisition", q.id),
        haystack: [
          payableRef("ops_requisition", q.id), q.reference, job,
          (q.users as unknown as { full_name?: string } | null)?.full_name,
        ].filter(Boolean).join(" ").toLowerCase(),
        title: `${q.reference} — ${formatNaira(state.amount)}`,
        subtitle: [
          job
            ? `Requisition for: ${job}`
            : q.description
              ? q.description.slice(0, 80)
              : "Standalone requisition",
          hasInvoice ? "invoice attached" : "no invoice attached",
        ].join(" · "),
        href: `/dashboard/approvals/requisitions/${q.id}`,
        state,
        detail: detailFor(
          q.invoice_attachment_path,
          q.reference,
          (q.users as unknown as { full_name?: string } | null)?.full_name ?? null,
          q.created_at,
          (q.tickets as unknown as JobCard) ?? null,
          linesByReq.get(q.id) ?? [],
          q.description ?? null
        ),
      };
    }),
  ]);

  // ⚠️ A refusal is terminal, so it leaves. A CLEARED payable does not: it is
  // waiting on the payment officer, which is a desk like any other. Dropping it
  // here is what left them with nothing to act on.
  const rows: QueueRow[] = described.filter((r) => !r.state.rejected);

  // Every role named at any stage of EITHER ladder, read from the shapes rather
  // than retyped — so a role added to a stage reaches this automatically and
  // cannot be forgotten here. Plus the payment officer, who releases what the
  // chain clears.
  const inChain = ALL_CHAIN_ROLES.has(role);

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">Approvals</h1>
        <p className="text-sm text-muted-foreground">
          Every payment leaving the organisation — vendor invoices, landlord
          payouts and ops requisitions alike — passes three pairs of hands
          before the payment officer sends it.
          {myTier
            ? ` You approve up to ${tierLabel(myTier).toLowerCase()}.`
            : " You hold no approval limit, so nothing waits on you here."}
        </p>
      </div>

      {/* Tabs, search and collapse live in the board: they are view state, and
          view state belongs in the browser. The SCOPING — which rows exist at
          all — stayed on the server and in RLS. */}
      <ApprovalsBoard rows={rows} actor={actor} inChain={inChain} />
    </div>
  );
}
