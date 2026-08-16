import { redirect } from "next/navigation";
import Link from "next/link";
import { getSessionProfile } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import CurrencyAccountsManager from "../CurrencyAccountsManager";
import GatewayForm from "./GatewayForm";
import AdminOnly from "../AdminOnly";

export default async function BankingSettingsPage() {
  const session = await getSessionProfile();
  if (!session) redirect("/login");
  if (session.profile?.role !== "admin") return <AdminOnly what="banking configuration" />;

  const supabase = await createClient();
  // Every active client-funds account, not just one — an org can hold several
  // now, one per currency it collects in (0103: Flutterwave/FX collections).
  // `.maybeSingle()` here would throw the moment a second one existed.
  const [{ data: bankAccounts }, { data: ledgerAccounts }] = await Promise.all([
    supabase
      .from("bank_accounts")
      .select(
        "id, label, bank_name, account_name, account_number_last4, purpose, currency, opening_balance, opening_date, opening_entry_id, ledger_account_id"
      )
      .eq("purpose", "client_funds")
      .eq("active", true),
    supabase
      .from("ledger_accounts")
      .select("id, code, name, class, currency")
      .eq("active", true)
      .order("code"),
  ]);

  // What this org may know about its own gateway connection. Never the key —
  // `org_gateway_status` cannot return one, because it does not select one.
  const { data: gatewayRows } = await supabase.rpc("org_gateway_status", { p_org_id: null });
  const paystack = ((gatewayRows ?? []) as Array<{ gateway: string }>)
    .find((g) => g.gateway === "paystack") ?? null;

  return (
    <>
    <Card>
      <CardHeader>
        <CardTitle>Client funds &amp; banking</CardTitle>
        <CardDescription>
          The segregated account(s) holding money that belongs to tenants,
          landlords and owners — kept apart from the organisation&apos;s own
          operating money, one per currency you collect in — and where each
          currency&apos;s ledger starts counting from.
        </CardDescription>
        {/* The other half of the pair. Every empty state in the ledger points
            HERE; nothing pointed back, so an administrator who finished the
            setup had no route to the thing they had just enabled. */}
        <CardDescription>
          What is held in these accounts is reported in{" "}
          <Link href="/dashboard/ledger" className="font-medium text-brand underline underline-offset-2">
            Operations → Client Funds
          </Link>
          , which is also where the daily bank reconciliation runs.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <CurrencyAccountsManager
          accounts={bankAccounts ?? []}
          hasChart={(ledgerAccounts ?? []).some((a) => a.currency === "NGN")}
          ledgerAccounts={(ledgerAccounts ?? [])
            .filter((a) => a.class === "liability")
            .map((a) => ({ id: a.id, code: a.code, name: a.name, currency: a.currency }))}
        />
      </CardContent>
    </Card>

    <Card className="mt-4">
      <CardHeader>
        <CardTitle>Paystack (Naira collections &amp; payouts)</CardTitle>
        <CardDescription>
          This organisation&rsquo;s own merchant account. Collections land in it and
          payouts draw on it, so its money never moves through another
          organisation&rsquo;s balance.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <GatewayForm status={paystack as never} />
      </CardContent>
    </Card>
    </>
  );
}
