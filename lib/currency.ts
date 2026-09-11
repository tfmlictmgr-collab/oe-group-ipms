export function formatNaira(n: number | string | null | undefined): string {
  if (n == null) return "—";
  return (
    "₦" +
    Number(n).toLocaleString("en-NG", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })
  );
}

// Symbols for the currencies this build actually issues checkout links in
// (NGN via Paystack; USD/GBP/EUR via Flutterwave — B3's "FX / international
// collections"). Deliberately not a symbol-per-ISO-4217-code table: guessing a
// symbol for a currency nobody has configured a gateway for is how "CA$" and
// "AU$" get silently conflated with "$". Anything outside this set falls back
// to the ISO code itself, which is unambiguous even if less pretty — the same
// choice `lib/pdf/receipt.tsx`'s `naira()` helper already made.
const SYMBOL: Record<string, string> = { NGN: "₦", USD: "$", GBP: "£", EUR: "€" };

/**
 * Formats an amount in whatever currency it actually is.
 *
 * `formatNaira` stays as its own export — it is still correct for every rent,
 * service-charge and vendor-payment figure in the system, which are Naira by
 * design (decision 15) — but a payment_intents/ledger_accounts row now carries
 * a `currency` column that is not always `'NGN'` (Flutterwave FX collections),
 * and rendering one of those with a ₦ prefix would misstate what was actually
 * collected.
 */
export function formatMoney(n: number | string | null | undefined, currency: string | null | undefined): string {
  if (n == null) return "—";
  const code = (currency || "NGN").toUpperCase();
  const amount = Number(n).toLocaleString("en-NG", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  const symbol = SYMBOL[code];
  return symbol ? `${symbol}${amount}` : `${code} ${amount}`;
}

/** The currencies this build can actually raise a checkout link in. */
export const SUPPORTED_CURRENCIES = ["NGN", "USD", "GBP", "EUR"] as const;
export type SupportedCurrency = (typeof SUPPORTED_CURRENCIES)[number];

/**
 * Sums amounts PER CURRENCY and states each — "₦158,400,000.00 and $8,000.00".
 *
 * ⚠️ 11 Sept 2026. My Rent added a tenant's demands into one number and
 * printed it in the FIRST demand's currency, so a tenant owing Naira rent and a
 * dollar lease read "$158,400,000.00 outstanding" — a figure that exists in no
 * currency. Amounts in different currencies are never added (0103, and decision
 * 25 for rent beside service charge); they are listed.
 */
export function totalsByCurrency(
  rows: { amount: number | string | null | undefined; currency: string | null | undefined }[]
): string {
  const sums = new Map<string, number>();
  for (const r of rows) {
    const code = (r.currency || "NGN").toUpperCase();
    sums.set(code, (sums.get(code) ?? 0) + Number(r.amount ?? 0));
  }
  const parts = Array.from(sums.entries())
    .sort(([a], [b]) => (a === "NGN" ? -1 : b === "NGN" ? 1 : a.localeCompare(b)))
    .map(([code, n]) => formatMoney(n, code));
  if (parts.length === 0) return formatMoney(0, "NGN");
  return parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}
