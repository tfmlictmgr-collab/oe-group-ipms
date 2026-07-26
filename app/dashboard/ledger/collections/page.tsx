import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getSessionProfile } from "@/lib/auth";
import { gatewayConfigured } from "@/lib/gateway";
import CollectionsClient, { type IntentRow, type BillableRow } from "./CollectionsClient";

export default async function CollectionsPage({
  searchParams,
}: {
  searchParams: Promise<{ ref?: string }>;
}) {
  const session = await getSessionProfile();
  if (!session) redirect("/login");
  const { ref } = await searchParams;

  const supabase = await createClient();

  const [{ data: intents }, { data: charges }] = await Promise.all([
    supabase
      .from("payment_intents")
      .select(
        "id, purpose, amount_expected, amount_paid, currency, status, gateway, gateway_reference, checkout_url, paid_at, amount_mismatch, ledger_entry_id, created_at, service_charge_id, users:payer_user_id(full_name, email)"
      )
      .order("created_at", { ascending: false })
      .limit(60),
    // Anything still owed, so a request can be raised without leaving the page.
    supabase
      .from("service_charges")
      .select("id, amount, status, billing_period, property_or_unit, due_date, users:billed_to_user_id(full_name, email)")
      .neq("status", "paid")
      .is("deleted_at", null)
      .order("due_date", { ascending: true, nullsFirst: false })
      .limit(50),
  ]);

  const rows = (intents ?? []) as unknown as IntentRow[];
  const requested = ref ? rows.find((r) => r.gateway_reference === ref) ?? null : null;

  // Exclude charges that already have a live request — the action refuses them
  // anyway, and offering the button would just produce an error.
  const live = new Set(
    rows.filter((r) => ["pending", "part_paid"].includes(r.status) && r.service_charge_id)
        .map((r) => r.service_charge_id as string)
  );
  const billable = ((charges ?? []) as unknown as BillableRow[]).filter((c) => !live.has(c.id));

  return (
    <CollectionsClient
      intents={rows}
      billable={billable}
      returnedRef={ref ?? null}
      returnedIntentId={requested?.id ?? null}
      live={gatewayConfigured("NGN")}
    />
  );
}
