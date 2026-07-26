import { redirect } from "next/navigation";
import { getSessionProfile } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import BankAccountForm from "../BankAccountForm";
import AdminOnly from "../AdminOnly";

export default async function BankingSettingsPage() {
  const session = await getSessionProfile();
  if (!session) redirect("/login");
  if (session.profile?.role !== "admin") return <AdminOnly what="banking configuration" />;

  const supabase = await createClient();
  const [{ data: bankAccount }, { data: ledgerAccounts }] = await Promise.all([
    supabase
      .from("bank_accounts")
      .select(
        "id, label, bank_name, account_name, account_number_last4, purpose, opening_balance, opening_date, opening_entry_id, ledger_account_id"
      )
      .eq("purpose", "client_funds")
      .eq("active", true)
      .maybeSingle(),
    supabase
      .from("ledger_accounts")
      .select("id, code, name, class")
      .eq("active", true)
      .order("code"),
  ]);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Client funds &amp; banking</CardTitle>
        <CardDescription>
          The segregated account holding money that belongs to tenants, landlords
          and owners — kept apart from the organisation&apos;s own operating money —
          and where the ledger starts counting from.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <BankAccountForm
          account={bankAccount ?? null}
          hasChart={(ledgerAccounts ?? []).length > 0}
          liabilityAccounts={(ledgerAccounts ?? [])
            .filter((a) => a.class === "liability")
            .map((a) => ({ id: a.id, code: a.code, name: a.name }))}
        />
      </CardContent>
    </Card>
  );
}
