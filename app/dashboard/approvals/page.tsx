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
/**
 * ⚠️ SORT AND DATE ARE SERVER-SIDE, and that is a correctness fix rather than a
 * preference (5 Sept 2026).
 *
 * Each of the three queries below is capped. The cap is necessary — every row
 * costs a `getChainState`, which is three round trips — but while the sort was
 * applied in the browser it was applied to *whichever rows the cap had already
 * kept*, and the cap kept the NEWEST. So "Oldest first" re-ordered the newest
 * hundred and confidently showed them oldest-first: the longest-waiting payment,
 * the one the option exists to find, was the one row it could never return.
 *
 * Ordering in the query fixes it exactly: "oldest first" now fetches the oldest.
 * The browser still re-sorts, harmlessly, over a set that is already the right
 * one.
 */
const QUEUE_CAP = 100;

export default async function ApprovalsPage({
  searchParams,
}: {
  searchParams: Promise<{ sort?: string; from?: string; to?: string; q?: string }>;
}) {
  const session = await getSessionProfile();
  if (!session?.profile) redirect("/login");

  const role = session.profile.role;
  const supabase = await createClient();

  const sp = await searchParams;
  const sort: "newest" | "oldest" = sp.sort === "oldest" ? "oldest" : "newest";
  const ascending = sort === "oldest";
  // Dates arrive as yyyy-mm-dd from a native date input. `to` is pushed to the
  // end of its day so "to 5 Sept" includes the 5th — an exclusive upper bound on
  // a date the person typed is the classic off-by-one that hides a whole day.
  const from = /^\d{4}-\d{2}-\d{2}$/.test(sp.from ?? "") ? sp.from! : null;
  const to = /^\d{4}-\d{2}-\d{2}$/.test(sp.to ?? "") ? sp.to! : null;

  const dated = <T extends { gte: (c: string, v: string) => T; lte: (c: string, v: string) => T }>(
    q: T
  ): T => {
    let out = q;
    if (from) out = out.gte("created_at", `${from}T00:00:00.000Z`);
    if (to) out = out.lte("created_at", `${to}T23:59:59.999Z`);
    return out;
  };

  const { data: me } = await supabase
    .from("users").select("id, role, approval_tier").eq("id", session.profile.id).single();

  const actor = {
    id: me?.id ?? session.profile.id,
    role: me?.role ?? role,
    approvalTier: me?.approval_tier ?? null,
  };
  const myTier = effectiveTier(actor.role, actor.approvalTier);
  const { data: tiersOn } = await supabase.rpc("org_approval_tiers_enabled", {
    p_org_id: session.profile.org_id,
  });
  const tiersEnabled = Boolean(tiersOn);

  // Vendor invoices that have passed the B4 gate, landlord payouts raised and
  // not yet sent, and FM/PM ops requisitions awaiting the same chain (0170).
  const [{ data: payments }, { data: payouts }, { data: requisitions }] = await Promise.all([
    dated(
      supabase
        .from("payments")
        .select("id, amount, invoice_reference, status, created_at, invoice_attachment_path, vendors(name), tickets(id, summary, category, urgency, property_or_unit)")
        // `returned_for_correction` belongs here (0250b): it is not a refusal
        // and it has not left the pipeline — it is sitting with whoever raised
        // it, and the desks above are entitled to see that is where it went
        // rather than watch it disappear.
        .in("status", ["recommended", "approved", "returned_for_correction"])
    )
      .order("created_at", { ascending })
      .limit(QUEUE_CAP),
    dated(
      supabase
        .from("remittances")
        .select("id, net_amount, period, reference, status, created_at, properties(name)")
        .eq("party", "landlord")
        .eq("status", "queued")
    )
      .order("created_at", { ascending })
      .limit(QUEUE_CAP),
    dated(
      supabase
      .from("ops_requisitions")
      .select("id, total_amount, reference, description, status, created_at, invoice_attachment_path, users!ops_requisitions_raised_by_fkey(full_name), tickets(id, summary, category, urgency, property_or_unit)")
      // ⚠️ `approved` as well as `pending_approval`. A requisition that clears
      // the chain moves to `approved`, and this query excluded it — so the one
      // person who exists to send it could not see it anywhere. There is no
      // requisitions list page and no nav entry, and the Send card renders only
      // on the detail page and only when status IS `approved`: the payable was
      // reachable by typed URL and nothing else. That is the dead end.
      .in("status", ["pending_approval", "approved", "returned_for_correction"])
    )
      .order("created_at", { ascending })
      .limit(QUEUE_CAP),
  ]);

  // Honest about the cap. If a bucket came back full, the page is showing a
  // window rather than everything, and saying so is the difference between a
  // bounded list and a wrong one.
  const truncated =
    (payments?.length ?? 0) >= QUEUE_CAP ||
    (payouts?.length ?? 0) >= QUEUE_CAP ||
    (requisitions?.length ?? 0) >= QUEUE_CAP;

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
        sortKey: p.created_at ?? "",
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
        sortKey: r.created_at ?? "",
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
        sortKey: q.created_at ?? "",
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
  const openRows = described.filter((r) => !r.state.rejected);

  // ── Can the fund actually bear this? Asked before the send, not at COMMIT ──
  //
  // Only for rows that have cleared the chain, which are the only rows anyone
  // can send today. `payable_funding_state` (0247) is one query, and asking it
  // for a payable three approvals away would cost one per row to answer a
  // question nobody is holding yet.
  //
  // `landlord_payout` is excluded on purpose: a rent remittance is paid out of
  // rent collected for that landlord, not out of a building's service-charge
  // fund, and running it through this check would print a shortfall against a
  // fund it never draws on. Decision 25's rule — the two are reported side by
  // side and never added — applies to the guard as much as to the report.
  const fundable = openRows.filter(
    (r) => r.state.clearedForDisbursement && r.payableType !== "landlord_payout"
  );
  const fundingById = new Map<string, QueueRow["funding"]>();
  await Promise.all(
    fundable.map(async (r) => {
      const { data } = await supabase
        .rpc("payable_funding_state", {
          p_payable_type: r.payableType,
          p_payable_id: r.payableId,
        })
        .maybeSingle();
      const f = data as {
        property_name: string | null; required: number;
        available: number; shortfall: number; sufficient: boolean;
      } | null;
      if (f) {
        fundingById.set(r.payableId, {
          propertyName: f.property_name,
          required: Number(f.required),
          available: Number(f.available),
          shortfall: Number(f.shortfall),
          sufficient: Boolean(f.sufficient),
        });
      }
    })
  );

  const rows: QueueRow[] = openRows.map((r) => ({
    ...r,
    funding: fundingById.get(r.payableId) ?? null,
  }));

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
          {/* ⚠️ The band sentence is printed only where bands are actually in
              force (0261). "You hold no approval limit, so nothing waits on you
              here" was, on a tierless org, both wrong and the most discouraging
              thing on the page — it told an approver who could clear every
              payment in the queue that none of them were theirs. */}
          {tiersEnabled
            ? myTier
              ? ` You approve up to ${tierLabel(myTier).toLowerCase()}.`
              : " You hold no approval limit, so nothing waits on you here."
            : " Approval bands are off for this organisation, so any approver at a stage can clear it."}
        </p>
      </div>

      {/* Tabs, search and collapse live in the board: they are view state, and
          view state belongs in the browser. The SCOPING — which rows exist at
          all — stayed on the server and in RLS. */}
      <ApprovalsBoard
        rows={rows}
        actor={actor}
        inChain={inChain}
        sort={sort}
        from={from ?? ""}
        to={to ?? ""}
        truncated={truncated}
      />
    </div>
  );
}
