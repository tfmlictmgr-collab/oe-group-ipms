// How a gateway is named to a person. Pure, so a client component, a PDF and a
// server action all read the same words.
//
// 📌 Written when Flutterwave became the Naira collector (23 Sept 2026). Four
// places each said `gateway === "paystack" ? "Paystack" : gateway`, which named
// every Flutterwave payment by its lowercase identifier on a receipt.

export function gatewayLabel(gateway: string | null | undefined): string {
  switch (gateway) {
    case "paystack": return "Paystack";
    case "flutterwave": return "Flutterwave";
    case "manual": return "Bank transfer";
    case "simulated": return "Simulated gateway";
    default: return gateway ?? "—";
  }
}
