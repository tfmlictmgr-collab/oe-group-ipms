// Vendor payment gate (CLAUDE.md B4):
// pending_verification → verified → recommended → approved → remitted
// (or → rejected if the performance gate fails).

export type PaymentStatus =
  | "pending_verification"
  | "verified"
  | "recommended"
  | "approved"
  | "remitted"
  | "rejected"
  | "pending_evaluation"
  | "pending_approval";

export const PAYMENT_STATUS_STYLES: Record<string, string> = {
  pending_verification: "bg-neutral-100 text-neutral-600 ring-neutral-200",
  verified: "bg-sky-100 text-sky-700 ring-sky-200",
  recommended: "bg-indigo-100 text-indigo-700 ring-indigo-200",
  approved: "bg-emerald-100 text-emerald-700 ring-emerald-200",
  remitted: "bg-emerald-600 text-white ring-emerald-700",
  rejected: "bg-red-100 text-red-700 ring-red-200",
};

export function statusLabel(status: string): string {
  return status.replace(/_/g, " ");
}

// The four gate stages, in order, for the stepper UI.
export const GATE_STAGES = [
  { key: "verification", label: "Service verification" },
  { key: "performance", label: "Performance validation" },
  { key: "approval", label: "Approval" },
  { key: "remittance", label: "Remittance" },
] as const;

export type PaymentRow = {
  id: string;
  vendor_id: string;
  invoice_reference: string | null;
  amount: number | string;
  status: string;
  service_verified_by: string | null;
  service_verified_at: string | null;
  performance_validated: boolean;
  approved_by: string | null;
  approved_at: string | null;
  remittance_reference: string | null;
  created_at: string;
};
