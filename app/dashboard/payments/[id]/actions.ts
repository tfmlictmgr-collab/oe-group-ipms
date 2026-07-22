"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { averageComposite } from "@/lib/vendor-score";
import { sendCascade } from "@/lib/cascade";
import { formatNaira } from "@/lib/currency";

async function loadPayment(supabase: Awaited<ReturnType<typeof createClient>>, id: string) {
  const { data, error } = await supabase
    .from("payments")
    .select(
      "id, org_id, vendor_id, amount, status, service_verified_at, performance_validated, approved_at"
    )
    .eq("id", id)
    .single();
  if (error || !data) throw new Error(error?.message ?? "Payment not found");
  return data;
}

// Stage 1 — Service verification (FM/admin, enforced by RLS update policy).
export async function verifyService(paymentId: string) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { error } = await supabase
    .from("payments")
    .update({
      service_verified_by: user?.id ?? null,
      service_verified_at: new Date().toISOString(),
      status: "verified",
    })
    .eq("id", paymentId)
    .eq("status", "pending_verification");
  if (error) throw new Error(error.message);
  revalidatePath(`/dashboard/payments/${paymentId}`);
}

// Stage 2 — Performance validation. Auto-pulls the vendor's composite score and
// compares to the admin-configured threshold. Pass → recommended; fail →
// rejected (blocked). This is the KPI gate.
export async function runPerformanceCheck(paymentId: string) {
  const supabase = await createClient();
  const payment = await loadPayment(supabase, paymentId);

  if (!payment.service_verified_at) {
    throw new Error("Service must be verified before performance validation.");
  }

  const { data: settings } = await supabase
    .from("payment_settings")
    .select("min_performance_score")
    .eq("org_id", payment.org_id)
    .single();
  const threshold = Number(settings?.min_performance_score ?? 70);

  const { data: evals } = await supabase
    .from("vendor_evaluations")
    .select("composite_score")
    .eq("vendor_id", payment.vendor_id);
  const avg = averageComposite(evals ?? []);

  const passed = avg != null && avg >= threshold;

  const { error } = await supabase
    .from("payments")
    .update({
      performance_validated: passed,
      status: passed ? "recommended" : "rejected",
    })
    .eq("id", paymentId);
  if (error) throw new Error(error.message);
  revalidatePath(`/dashboard/payments/${paymentId}`);
}

// Stage 3 — Approval (finance/admin). Re-checks the gate from the DB so it
// cannot be bypassed: both verification and performance must have passed.
export async function approvePayment(paymentId: string) {
  const supabase = await createClient();
  const payment = await loadPayment(supabase, paymentId);

  if (!payment.service_verified_at) {
    throw new Error("Gate not satisfied: service not verified.");
  }
  if (!payment.performance_validated) {
    throw new Error("Gate not satisfied: vendor failed the performance check.");
  }
  if (payment.status !== "recommended") {
    throw new Error(`Cannot approve from status '${payment.status}'.`);
  }

  const {
    data: { user },
  } = await supabase.auth.getUser();
  const { error } = await supabase
    .from("payments")
    .update({
      approved_by: user?.id ?? null,
      approved_at: new Date().toISOString(),
      status: "approved",
    })
    .eq("id", paymentId);
  if (error) throw new Error(error.message);

  // Notify the vendor of approval via the B8 cascade (best-effort; never blocks
  // the approval itself).
  try {
    const { data: vendor } = await supabase
      .from("vendors")
      .select("contact_phone, contact_email")
      .eq("id", payment.vendor_id)
      .single();
    if (vendor) {
      await sendCascade({
        orgId: payment.org_id,
        entityType: "payment",
        entityId: paymentId,
        message: `Your payment of ${formatNaira(payment.amount)} has been approved and is queued for remittance.`,
        phone: vendor.contact_phone,
        email: vendor.contact_email,
      });
    }
  } catch (e) {
    console.error("Approval notification cascade failed:", e);
  }

  revalidatePath(`/dashboard/payments/${paymentId}`);
}

// Stage 4 — Remittance (SIMULATED — POC ONLY; no live gateway).
export async function executeRemittance(paymentId: string) {
  const supabase = await createClient();
  const payment = await loadPayment(supabase, paymentId);

  if (payment.status !== "approved") {
    throw new Error("Only approved payments can be remitted.");
  }

  const fakeRef = `SIMULATED-POC-${Date.now()}`;
  const { error } = await supabase
    .from("payments")
    .update({ status: "remitted", remittance_reference: fakeRef })
    .eq("id", paymentId);
  if (error) throw new Error(error.message);
  revalidatePath(`/dashboard/payments/${paymentId}`);
}
