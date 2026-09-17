// Asking a bank who holds an account — on the account of the organisation
// that is asking.
//
// ⚠️ Server-only, and deliberately not a "use server" module: nothing here may
// be callable from a browser on its own. Callers check who is asking first.
//
// 📌 Why the organisation's own key. `GET /bank/resolve` moves no money, but it
// does send an account number to Paystack under whichever merchant account's
// key is used — and appears in that merchant's API log. Resolving an OEA
// payee's account on the platform key would process OEA's counterparty's data
// under TFML's account, which is decision 47's rule broken on a read rather
// than on a payment. So: the organisation's own connected key, or the platform
// key only for the one organisation that owns it (`uses_platform_gateway`,
// 0288), or no lookup at all — in which case the name is typed and a person
// confirms it against the document before anything can be paid.

export type NameLookup =
  | { ok: true; accountName: string; last4: string }
  | { ok: false; reason: string; unavailable: boolean; last4: string };

async function paystackKeyFor(orgId: string): Promise<string | null> {
  const { getOrgCredential } = await import("@/lib/gateway/credentials");
  try {
    const cred = await getOrgCredential(orgId, "paystack");
    if (cred) return cred.secretKey;
  } catch {
    // An unreadable credential is not a reason to borrow somebody else's key.
    return null;
  }
  const { supabaseAdmin } = await import("@/lib/supabase/admin");
  const { data: org } = await supabaseAdmin
    .from("orgs").select("uses_platform_gateway").eq("id", orgId).maybeSingle();
  if (org?.uses_platform_gateway && process.env.PAYSTACK_SECRET_KEY) {
    return process.env.PAYSTACK_SECRET_KEY;
  }
  return null;
}

/**
 * The name the bank holds an account under, or why it could not be asked.
 * The account number is used for this one call and never returned or stored;
 * the caller keeps the last four.
 */
export async function lookUpAccountName(
  orgId: string,
  accountNumber: string,
  bankCode: string
): Promise<NameLookup> {
  const number = (accountNumber ?? "").replace(/\D/g, "");
  const last4 = number.slice(-4);
  if (number.length !== 10) {
    return { ok: false, reason: "A Nigerian account number is 10 digits.", unavailable: false, last4 };
  }
  if (!bankCode) {
    return { ok: false, reason: "Choose the bank the account is held at first.", unavailable: false, last4 };
  }

  const key = await paystackKeyFor(orgId);
  if (!key) {
    return {
      ok: false,
      reason: "The bank cannot be asked automatically here, so type the account name exactly as your bank shows it.",
      unavailable: true,
      last4,
    };
  }

  try {
    const res = await fetch(
      `https://api.paystack.co/bank/resolve?account_number=${encodeURIComponent(number)}&bank_code=${encodeURIComponent(bankCode)}`,
      { headers: { Authorization: `Bearer ${key}` }, cache: "no-store" }
    );
    const json = (await res.json()) as { status?: boolean; message?: string; data?: { account_name?: string } };
    // ⚠️ 14 Sept 2026. A rate limit is not "that account does not exist".
    // Paystack answers a TEST secret key's fourth real lookup of the day with
    // 429 "Test mode daily limit of 3 live bank resolves exceeded" — measured
    // on OEA's own key — and this branch used to fall through to "could not
    // be found at the bank you chose", telling a payer their correct account
    // was wrong. Said as what it is, and the name box opens for them to type.
    if (res.status === 429) {
      return {
        ok: false,
        reason: /test mode/i.test(json.message ?? "")
          ? "The bank lookup is not available right now (this organisation's Paystack account is in test mode). Type the account name exactly as your bank shows it."
          : "The bank lookup is busy right now. Type the account name exactly as your bank shows it.",
        unavailable: true,
        last4,
      };
    }
    if (!res.ok || !json.status || !json.data?.account_name) {
      return {
        ok: false,
        reason: "That account could not be found at the bank you chose. Check the number and the bank.",
        unavailable: false,
        last4,
      };
    }
    return { ok: true, accountName: json.data.account_name.trim(), last4 };
  } catch {
    return {
      ok: false,
      reason: "We could not reach the bank to check that account. Type the account name exactly as your bank shows it.",
      unavailable: true,
      last4,
    };
  }
}
