import crypto from "node:crypto";

// One interface over Paystack (Naira) and Flutterwave (FX), plus a simulated
// adapter used when no keys are configured.
//
// The simulated adapter is not a stub that pretends to succeed — it exercises
// the same code path end to end (intent → checkout → webhook → verify → post),
// so the flow, the idempotency guard and the ledger posting are all genuinely
// proven before a real key exists. Swapping in live keys changes which adapter
// is selected and nothing else.
//
// Note the deliberate split between `verifySignature` and `verifyTransaction`:
// a signature proves WHO sent the message; only a server-to-server lookup
// proves WHAT was actually paid. Both are required before money is posted.

export type GatewayName = "paystack" | "flutterwave" | "simulated";

export type InitResult = {
  ok: boolean;
  checkoutUrl?: string;
  reference: string;
  error?: string;
};

export type VerifyResult = {
  ok: boolean;
  /** Authoritative amount, in major units (Naira, not kobo). */
  amount?: number;
  currency?: string;
  status?: "success" | "failed" | "pending";
  paidAt?: string;
  error?: string;
};

/** A payee the gateway will accept an instruction for. */
export type RecipientResult = {
  ok: boolean;
  recipientCode?: string;
  /** The bank's own record of the account holder, from name enquiry. */
  resolvedName?: string;
  error?: string;
};

export type TransferResult = {
  ok: boolean;
  transferCode?: string;
  /**
   * `success`  — the gateway has executed it; safe to post to the ledger.
   * `pending`  — accepted, outcome unknown. MUST NOT be posted; the transfer
   *              webhook decides. Posting on `pending` would record money as
   *              having left on a transfer that may still fail.
   * `failed`   — it will not happen.
   * `otp`      — the account requires an OTP per transfer, which no unattended
   *              system can supply. Treated as a configuration fault, not a
   *              transient error.
   */
  status?: "success" | "pending" | "failed" | "otp";
  error?: string;
};

export interface PaymentGatewayAdapter {
  readonly name: GatewayName;
  initialise(input: {
    reference: string;
    amount: number;      // major units
    currency: string;
    email: string;
    callbackUrl: string;
    metadata?: Record<string, unknown>;
  }): Promise<InitResult>;
  /** Server-to-server confirmation. The only trustworthy source of the amount. */
  verifyTransaction(reference: string): Promise<VerifyResult>;
  verifySignature(rawBody: string, signature: string | null): boolean;

  /**
   * Registers a payee. Money can only ever be sent to a recipient code, never
   * to raw account details held here — so the gateway, not this application, is
   * the system of record for where money goes.
   */
  createRecipient(input: {
    name: string;
    accountNumber: string;
    bankCode: string;
    currency: string;
  }): Promise<RecipientResult>;

  /** Sends money. `reference` is OUR idempotency key. */
  transfer(input: {
    reference: string;
    recipientCode: string;
    amount: number;      // major units
    currency: string;
    reason: string;
  }): Promise<TransferResult>;
}

// ── Paystack ───────────────────────────────────────────────────────────────
// Amounts are in KOBO. Getting this wrong by a factor of 100 is the classic
// Paystack bug, so conversion happens in exactly one place each way.
const toKobo = (naira: number) => Math.round(naira * 100);
const fromKobo = (kobo: number) => kobo / 100;

class PaystackAdapter implements PaymentGatewayAdapter {
  readonly name = "paystack" as const;
  constructor(private secret: string) {}

  async initialise(input: Parameters<PaymentGatewayAdapter["initialise"]>[0]) {
    try {
      const res = await fetch("https://api.paystack.co/transaction/initialize", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.secret}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          reference: input.reference,
          amount: toKobo(input.amount),
          currency: input.currency,
          email: input.email,
          callback_url: input.callbackUrl,
          metadata: input.metadata ?? {},
        }),
      });
      const json = (await res.json()) as {
        status?: boolean;
        message?: string;
        data?: { authorization_url?: string };
      };
      if (!res.ok || !json.status) {
        return { ok: false, reference: input.reference, error: json.message ?? `HTTP ${res.status}` };
      }
      return { ok: true, reference: input.reference, checkoutUrl: json.data?.authorization_url };
    } catch (e) {
      return {
        ok: false,
        reference: input.reference,
        error: e instanceof Error ? e.message : "gateway unreachable",
      };
    }
  }

  async verifyTransaction(reference: string): Promise<VerifyResult> {
    try {
      const res = await fetch(
        `https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`,
        { headers: { Authorization: `Bearer ${this.secret}` } }
      );
      const json = (await res.json()) as {
        status?: boolean;
        message?: string;
        data?: { amount?: number; currency?: string; status?: string; paid_at?: string };
      };
      if (!res.ok || !json.status || !json.data) {
        return { ok: false, error: json.message ?? `HTTP ${res.status}` };
      }
      return {
        ok: true,
        amount: fromKobo(json.data.amount ?? 0),
        currency: json.data.currency,
        status: json.data.status === "success" ? "success" : json.data.status === "failed" ? "failed" : "pending",
        paidAt: json.data.paid_at,
      };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : "gateway unreachable" };
    }
  }

  verifySignature(rawBody: string, signature: string | null): boolean {
    if (!signature) return false;
    // Paystack signs the raw body with HMAC-SHA512 using the secret key.
    const expected = crypto.createHmac("sha512", this.secret).update(rawBody).digest("hex");
    const a = Buffer.from(expected);
    const b = Buffer.from(signature);
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  }

  async createRecipient(
    input: Parameters<PaymentGatewayAdapter["createRecipient"]>[0]
  ): Promise<RecipientResult> {
    try {
      const res = await fetch("https://api.paystack.co/transferrecipient", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.secret}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          type: "nuban",
          name: input.name,
          account_number: input.accountNumber,
          bank_code: input.bankCode,
          currency: input.currency,
        }),
      });
      const json = (await res.json()) as {
        status?: boolean;
        message?: string;
        data?: { recipient_code?: string; details?: { account_name?: string } };
      };
      if (!res.ok || !json.status || !json.data?.recipient_code) {
        return { ok: false, error: json.message ?? `HTTP ${res.status}` };
      }
      return {
        ok: true,
        recipientCode: json.data.recipient_code,
        // Paystack performs a name enquiry against the bank. This is the
        // account's REAL holder, which is what should be shown for confirmation
        // — not the name someone typed into our form.
        resolvedName: json.data.details?.account_name,
      };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : "gateway unreachable" };
    }
  }

  async transfer(
    input: Parameters<PaymentGatewayAdapter["transfer"]>[0]
  ): Promise<TransferResult> {
    try {
      const res = await fetch("https://api.paystack.co/transfer", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.secret}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          source: "balance",
          amount: toKobo(input.amount),
          recipient: input.recipientCode,
          reason: input.reason,
          currency: input.currency,
          // Our reference. Paystack rejects a repeat, so a retry cannot pay
          // twice even if our own guard were bypassed.
          reference: input.reference,
        }),
      });
      const json = (await res.json()) as {
        status?: boolean;
        message?: string;
        data?: { transfer_code?: string; status?: string };
      };

      if (!res.ok || !json.status) {
        return { ok: false, status: "failed", error: json.message ?? `HTTP ${res.status}` };
      }

      const raw = json.data?.status ?? "pending";
      // `otp` means the account is configured to require a one-time code per
      // transfer. Nothing unattended can satisfy that, so it is reported as a
      // configuration fault rather than retried forever.
      const status: TransferResult["status"] =
        raw === "success"
          ? "success"
          : raw === "failed" || raw === "reversed"
            ? "failed"
            : raw === "otp"
              ? "otp"
              : "pending";

      return { ok: true, transferCode: json.data?.transfer_code, status };
    } catch (e) {
      // A network failure here is the dangerous case: the instruction may or may
      // not have reached them. `ok: false` with no status leaves the remittance
      // unresolved for a human rather than guessing either way.
      return { ok: false, error: e instanceof Error ? e.message : "gateway unreachable" };
    }
  }
}

// ── Flutterwave (FX / international) ───────────────────────────────────────
class FlutterwaveAdapter implements PaymentGatewayAdapter {
  readonly name = "flutterwave" as const;
  constructor(private secret: string, private webhookHash: string) {}

  async initialise(input: Parameters<PaymentGatewayAdapter["initialise"]>[0]) {
    try {
      const res = await fetch("https://api.flutterwave.com/v3/payments", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.secret}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          tx_ref: input.reference,
          amount: input.amount,          // major units, unlike Paystack
          currency: input.currency,
          redirect_url: input.callbackUrl,
          customer: { email: input.email },
          meta: input.metadata ?? {},
        }),
      });
      const json = (await res.json()) as {
        status?: string;
        message?: string;
        data?: { link?: string };
      };
      if (!res.ok || json.status !== "success") {
        return { ok: false, reference: input.reference, error: json.message ?? `HTTP ${res.status}` };
      }
      return { ok: true, reference: input.reference, checkoutUrl: json.data?.link };
    } catch (e) {
      return {
        ok: false,
        reference: input.reference,
        error: e instanceof Error ? e.message : "gateway unreachable",
      };
    }
  }

  async verifyTransaction(reference: string): Promise<VerifyResult> {
    try {
      const res = await fetch(
        `https://api.flutterwave.com/v3/transactions/verify_by_reference?tx_ref=${encodeURIComponent(reference)}`,
        { headers: { Authorization: `Bearer ${this.secret}` } }
      );
      const json = (await res.json()) as {
        status?: string;
        message?: string;
        data?: { amount?: number; currency?: string; status?: string; created_at?: string };
      };
      if (!res.ok || json.status !== "success" || !json.data) {
        return { ok: false, error: json.message ?? `HTTP ${res.status}` };
      }
      return {
        ok: true,
        amount: Number(json.data.amount ?? 0),
        currency: json.data.currency,
        status: json.data.status === "successful" ? "success" : json.data.status === "failed" ? "failed" : "pending",
        paidAt: json.data.created_at,
      };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : "gateway unreachable" };
    }
  }

  // B3 scopes Flutterwave to FX COLLECTIONS. Payouts go through Paystack
  // Transfers. Refusing here is deliberate: silently returning a fake success
  // for an unimplemented payout path is how money appears to have moved when it
  // has not.
  async createRecipient(): Promise<RecipientResult> {
    return { ok: false, error: "Flutterwave is configured for collections only, not payouts." };
  }

  async transfer(): Promise<TransferResult> {
    return {
      ok: false,
      status: "failed",
      error: "Flutterwave is configured for collections only, not payouts.",
    };
  }

  verifySignature(_rawBody: string, signature: string | null): boolean {
    // Flutterwave sends a shared secret in `verif-hash` rather than an HMAC of
    // the body. Compared in constant time all the same.
    if (!signature || !this.webhookHash) return false;
    const a = Buffer.from(signature);
    const b = Buffer.from(this.webhookHash);
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  }
}

// ── Simulated ──────────────────────────────────────────────────────────────
/**
 * Used when no keys are configured. Checkout is an in-app page that posts a
 * webhook back to us, so the full path is exercised for real.
 *
 * It refuses to run in production: a simulated gateway that reached live would
 * mark invoices paid without money arriving, which is far worse than an outage.
 */
class SimulatedAdapter implements PaymentGatewayAdapter {
  readonly name = "simulated" as const;
  constructor(private secret: string) {}

  async initialise(input: Parameters<PaymentGatewayAdapter["initialise"]>[0]): Promise<InitResult> {
    return {
      ok: true,
      reference: input.reference,
      checkoutUrl: `/pay/${encodeURIComponent(input.reference)}`,
    };
  }

  /**
   * The simulated server-to-server check. It reads the gateway's own record of
   * the charge (`simulated_charges`, written by the checkout page), exactly as
   * the live adapters query Paystack or Flutterwave. The amount therefore still
   * never comes from the webhook body — which is the rule this whole design
   * exists to enforce, and which a stub returning `success` would quietly break.
   */
  async verifyTransaction(reference: string): Promise<VerifyResult> {
    const { supabaseAdmin } = await import("@/lib/supabase/admin");
    const { data } = await supabaseAdmin
      .from("simulated_charges")
      .select("amount, currency, status, paid_at")
      .eq("reference", reference)
      .maybeSingle();

    // No record means nothing was ever presented at checkout.
    if (!data) return { ok: true, status: "pending" };
    return {
      ok: true,
      amount: Number(data.amount),
      currency: data.currency,
      status: data.status === "success" ? "success" : "failed",
      paidAt: data.paid_at,
    };
  }

  verifySignature(rawBody: string, signature: string | null): boolean {
    if (!signature) return false;
    const expected = crypto.createHmac("sha256", this.secret).update(rawBody).digest("hex");
    const a = Buffer.from(expected);
    const b = Buffer.from(signature);
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  }

  async createRecipient(
    input: Parameters<PaymentGatewayAdapter["createRecipient"]>[0]
  ): Promise<RecipientResult> {
    // Derived from the account number so the same account always yields the same
    // code, as Paystack does — a re-registration must not create a second payee.
    const digest = crypto.createHash("sha256").update(input.accountNumber).digest("hex");
    return {
      ok: true,
      recipientCode: `RCP_SIM_${digest.slice(0, 16).toUpperCase()}`,
      resolvedName: input.name,
    };
  }

  async transfer(
    input: Parameters<PaymentGatewayAdapter["transfer"]>[0]
  ): Promise<TransferResult> {
    // Reports `success` so the ledger path is exercised end to end without keys.
    // Safe because this adapter is unreachable once any real key is present, and
    // refuses outright in production (getAdapterByName).
    return {
      ok: true,
      transferCode: `TRF_SIM_${input.reference}`,
      status: "success",
    };
  }
}

// ── Selection ──────────────────────────────────────────────────────────────

export function isProduction(): boolean {
  const v = process.env.VERCEL_ENV;
  if (v) return v === "production";
  return process.env.NODE_ENV === "production";
}

/**
 * Picks the adapter for a currency. Naira goes to Paystack, anything else to
 * Flutterwave (the B3 split). Falls back to the simulated adapter only outside
 * production.
 */
export function getGateway(currency = "NGN"): PaymentGatewayAdapter {
  const paystack = process.env.PAYSTACK_SECRET_KEY;
  const flutterwave = process.env.FLUTTERWAVE_SECRET_KEY;
  const fwHash = process.env.FLUTTERWAVE_WEBHOOK_HASH ?? "";

  if (currency.toUpperCase() === "NGN" && paystack) return new PaystackAdapter(paystack);
  if (currency.toUpperCase() !== "NGN" && flutterwave) {
    return new FlutterwaveAdapter(flutterwave, fwHash);
  }
  // A live deployment must never silently fall back to simulation.
  if (isProduction()) {
    throw new Error(
      `No payment gateway configured for ${currency}. Set PAYSTACK_SECRET_KEY (NGN) or FLUTTERWAVE_SECRET_KEY (FX).`
    );
  }
  return new SimulatedAdapter(process.env.SIMULATED_GATEWAY_SECRET ?? "dev-simulated-secret");
}

/**
 * Picks the adapter for a NAMED gateway — used by the webhook route, which
 * knows which gateway called it from the URL and must not infer it.
 *
 * Selecting by currency there happened to fail closed, but only incidentally:
 * a Paystack notification was being verified with whichever adapter "NGN"
 * resolved to. Verification must use the credentials of the gateway that
 * actually sent the message, so the caller names it.
 *
 * Throws when that gateway has no key. The caller answers 403 — we cannot
 * verify the sender, so the only safe response is to refuse.
 */
export function getAdapterByName(name: GatewayName): PaymentGatewayAdapter {
  if (name === "paystack") {
    const key = process.env.PAYSTACK_SECRET_KEY;
    if (!key) throw new Error("Paystack is not configured.");
    return new PaystackAdapter(key);
  }
  if (name === "flutterwave") {
    const key = process.env.FLUTTERWAVE_SECRET_KEY;
    if (!key) throw new Error("Flutterwave is not configured.");
    return new FlutterwaveAdapter(key, process.env.FLUTTERWAVE_WEBHOOK_HASH ?? "");
  }
  // Simulation must be unreachable wherever real money is possible — otherwise
  // it is an endpoint that marks invoices paid without money arriving.
  if (isProduction() || process.env.PAYSTACK_SECRET_KEY || process.env.FLUTTERWAVE_SECRET_KEY) {
    throw new Error("The simulated gateway is disabled here.");
  }
  return new SimulatedAdapter(process.env.SIMULATED_GATEWAY_SECRET ?? "dev-simulated-secret");
}

/**
 * Whether the configured gateway will move REAL money.
 *
 * Both Paystack and Flutterwave distinguish test from live purely by which
 * secret key is set — same endpoints, same code path, same success response.
 * Nothing in the application can tell the difference at runtime, which means a
 * live key pasted into a demo environment charges real cards and looks
 * completely normal while doing it.
 *
 * So the mode is surfaced on screen rather than assumed. This is a label, not
 * a control: it cannot stop a live key being used, only stop it being used
 * unknowingly.
 */
export function gatewayMode(currency = "NGN"): "live" | "test" | "simulated" {
  const key =
    currency.toUpperCase() === "NGN"
      ? process.env.PAYSTACK_SECRET_KEY
      : process.env.FLUTTERWAVE_SECRET_KEY;
  if (!key) return "simulated";
  // Paystack: sk_test_… / sk_live_…   Flutterwave: FLWSECK_TEST-… / FLWSECK-…
  return /(^sk_test_)|(_TEST-)|(^FLWSECK_TEST)/i.test(key) ? "test" : "live";
}

export function gatewayConfigured(currency = "NGN"): boolean {
  return currency.toUpperCase() === "NGN"
    ? Boolean(process.env.PAYSTACK_SECRET_KEY)
    : Boolean(process.env.FLUTTERWAVE_SECRET_KEY);
}

/** Our own reference. Prefixed so it is recognisable on a bank statement. */
export function newPaymentReference(purpose: string): string {
  const tag = purpose.slice(0, 2).toUpperCase();
  return `OE-${tag}-${Date.now().toString(36).toUpperCase()}-${crypto.randomBytes(3).toString("hex").toUpperCase()}`;
}
