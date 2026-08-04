import { notFound } from "next/navigation";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { gatewayConfigured, isProduction } from "@/lib/gateway";
import { formatMoney } from "@/lib/currency";
import SimulatedCheckout from "./SimulatedCheckout";

// The simulated gateway's checkout page. It exists so the whole path — intent →
// checkout → signed webhook → server-side verification → ledger posting — can be
// exercised before a real key exists, and so a lost key never blocks a demo.
//
// It refuses to run in production, and refuses to run at all once a real gateway
// is configured for the currency. A page that can mark an invoice paid without
// money arriving must be unreachable the moment real money is possible.

export default async function SimulatedCheckoutPage({
  params,
}: {
  params: Promise<{ reference: string }>;
}) {
  const { reference } = await params;

  // Read with the service role: the payer following a link is not signed in.
  // Only the reference — an unguessable, single-purpose token — is exposed, and
  // only the figures the payer is entitled to see are read out of it.
  const { data: intent } = await supabaseAdmin
    .from("payment_intents")
    .select("id, amount_expected, amount_paid, currency, status, gateway, ledger_entry_id, org_id")
    .eq("gateway_reference", reference)
    .maybeSingle();

  if (!intent) notFound();
  if (isProduction() || gatewayConfigured(intent.currency) || intent.gateway !== "simulated") {
    notFound();
  }

  const { data: org } = await supabaseAdmin
    .from("orgs")
    .select("name, portal_name, theme_primary, logo_url")
    .eq("id", intent.org_id)
    .single();

  const settled = Boolean(intent.ledger_entry_id);

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center px-5 py-10">
      <div className="rounded-2xl border border-border bg-card p-7 shadow-sm">
        <p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
          {org?.portal_name || org?.name || "Client portal"}
        </p>
        <h1 className="mt-1 text-lg font-semibold">Payment</h1>

        <div className="my-6 rounded-xl bg-muted/50 p-5">
          <p className="text-xs uppercase tracking-wide text-muted-foreground">Amount due</p>
          <p className="mt-1 text-3xl font-semibold tabular-nums">
            {formatMoney(intent.amount_expected, intent.currency)}
          </p>
          <p className="mt-2 font-mono text-xs text-muted-foreground">{reference}</p>
        </div>

        {settled ? (
          <p className="rounded-lg bg-success/10 px-4 py-3 text-sm text-success">
            This payment has already been received — {formatMoney(intent.amount_paid, intent.currency)}.
          </p>
        ) : (
          <SimulatedCheckout
            reference={reference}
            amount={Number(intent.amount_expected)}
            currency={intent.currency}
          />
        )}

        <p className="mt-6 text-center text-[0.7rem] leading-relaxed text-muted-foreground">
          Test environment. No card is charged and no money moves — the payment
          notification, its signature check and the ledger posting are real.
        </p>
      </div>
    </main>
  );
}
