import { supabaseAdmin } from "./supabase/admin";
import {
  storeInboundProof, discardInboundProof, OversizeMedia, UnusableMedia,
  type InboundMedia,
} from "./inbound-media";
import { PROOF_MAX_LABEL } from "./offline-payments";
import { notifyRoleWithCascade } from "./role-notify";

// "I've paid" on WhatsApp.
//
// Collecting a payment takes three facts — the evidence, the amount, and which
// demand it settles — and a person supplies them across several messages. This
// is the state machine that gathers them, and its whole design is governed by
// one asymmetry:
//
//   • Getting it WRONG creates a claim three desks then refuse. Cost: a wasted
//     review, and a tenant told their payment could not be matched.
//   • Getting it wrong in the OTHER direction — deciding a message about money
//     is nothing, or quietly dropping a receipt somebody sent — leaves a person
//     who has paid still being chased, with no record they ever told us.
//
// So every branch that cannot complete ends by telling a person, never by going
// quiet. That is decision 24's own line about the safe direction of failure,
// applied to money instead of to work orders.
//
// ⚠️ Nothing here decides who the payer is. `submit_offline_claim_for_sender`
// resolves that from the sender reference (0075) and would refuse a payer we
// tried to supply, because there is no argument for one.

export type PaymentDraft = {
  proofPath?: string;
  proofFilename?: string;
  amount?: number;
  /** Set only once a menu has been printed, so a bare number can be resolved. */
  offered?: { kind: "rent" | "service_charge"; chargeId: string; label: string; outstanding: number }[];
};

export type IntakeOutcome = {
  reply: string;
  awaiting: "payment_proof" | "payment_amount" | "payment_allocation" | null;
  draft: PaymentDraft | null;
  claimId: string | null;
};

const money = (n: number, currency = "NGN") =>
  `${currency === "NGN" ? "₦" : currency + " "}${n.toLocaleString("en-NG", {
    minimumFractionDigits: 2, maximumFractionDigits: 2,
  })}`;

/**
 * Reads a figure out of what somebody typed.
 *
 * ⚠️ Returns null on ANY ambiguity, and the caller then asks. Nigerian shorthand
 * is normal here — "500k", "1.2m", "N500,000" — but so is a message with two
 * numbers in it ("I paid 500k on the 3rd"), and guessing which one is the amount
 * is exactly the kind of confident wrongness decision 24 forbids on money. Two
 * candidates is not a reason to pick the first; it is a reason to ask.
 */
export function parseAmount(text: string): number | null {
  const cleaned = text.replace(/[₦N]\s?(?=[\d,])/gi, " ");
  const re = /(\d[\d,]*(?:\.\d+)?)\s*([km])?\b/gi;
  const candidates: number[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(cleaned)) !== null) {
    const base = Number(m[1].replace(/,/g, ""));
    if (!Number.isFinite(base) || base <= 0) continue;
    const suffix = m[2]?.toLowerCase();
    const value = suffix === "k" ? base * 1_000 : suffix === "m" ? base * 1_000_000 : base;
    // A bare 1-31 with no suffix is almost always a date or a menu choice, not
    // a rent figure. Rent in this market is six figures and up.
    if (!suffix && value <= 31) continue;
    if (!candidates.includes(value)) candidates.push(value);
  }
  return candidates.length === 1 ? candidates[0] : null;
}

/** A bare "2" answering a printed menu. */
function parseChoice(text: string, max: number): number | null {
  const m = text.trim().match(/^(\d{1,2})[.)]?$/);
  if (!m) return null;
  const n = Number(m[1]);
  return n >= 1 && n <= max ? n : null;
}

async function tellSomebody(
  orgId: string, title: string, body: string
): Promise<void> {
  try {
    await notifyRoleWithCascade({
      orgId,
      // The payment desks, plus the administrator — whoever can pick this up.
      roles: ["finance_approver", "admin"],
      kind: "payment",
      title,
      body,
      link: "/dashboard/payments/offline",
      entityType: "payment",
      entityId: null,
    });
  } catch {
    /* the person has been answered; the nudge is not the record */
  }
}

/**
 * One turn of the payment conversation.
 *
 * `media` is the attachment on THIS message, if any. `draft` is what we already
 * collected on earlier turns.
 */
export async function advancePaymentIntake(opts: {
  orgId: string;
  channel: "whatsapp" | "telegram";
  senderRef: string;
  senderName: string | null;
  messageText: string;
  media?: InboundMedia | null;
  draft: PaymentDraft | null;
  awaiting: string | null;
}): Promise<IntakeOutcome> {
  const { orgId, channel, senderRef, messageText, media, awaiting } = opts;
  const draft: PaymentDraft = { ...(opts.draft ?? {}) };

  // ── Do we know whose account this is? ────────────────────────────────────
  //
  // Everything downstream is scoped to the resolved person, so an unrecognised
  // number cannot be carried forward. It is NOT dropped: somebody is told.
  const { data: resolved } = await supabaseAdmin
    .rpc("resolve_chat_sender", { p_org_id: orgId, p_sender_ref: senderRef })
    .maybeSingle<{ user_id: string | null }>();

  if (!resolved?.user_id) {
    await tellSomebody(
      orgId,
      "Someone reported a payment from an unrecognised number",
      `${senderRef} says they have paid, and we cannot match the number to an account.`
    );
    return {
      reply:
        "Thanks for letting us know. I can't match this number to an account, so I've " +
        "passed it to our finance team — they'll be in touch. If you can, reply with " +
        "the property and unit the payment is for.",
      awaiting: null, draft: null, claimId: null,
    };
  }

  // ── The evidence ─────────────────────────────────────────────────────────
  if (media && !draft.proofPath) {
    try {
      const stored = await storeInboundProof(orgId, media);
      if (stored) {
        draft.proofPath = stored.path;
        draft.proofFilename = stored.filename;
      } else {
        // ⚠️ Said out loud. A person who has sent their receipt and hears
        // nothing about it will assume it arrived.
        return {
          reply:
            "I couldn't download that attachment — it may have expired. Could you send " +
            "the receipt again?",
          awaiting: "payment_proof", draft, claimId: null,
        };
      }
    } catch (e) {
      if (e instanceof OversizeMedia) {
        return {
          reply:
            `That file is too large for me to accept (the limit is ${PROOF_MAX_LABEL}). ` +
            "Could you send a smaller photo of the receipt, or a PDF?",
          awaiting: "payment_proof", draft, claimId: null,
        };
      }
      if (e instanceof UnusableMedia) {
        return {
          reply:
            "I can only accept a photo or a PDF as proof of payment — a voice note or " +
            "sticker won't do. Could you send a picture of the receipt?",
          awaiting: "payment_proof", draft, claimId: null,
        };
      }
      throw e;
    }
  }

  if (!draft.proofPath) {
    return {
      reply:
        "Thanks — I can log that for you. Please send a photo of the transfer receipt " +
        "or teller slip (or a PDF) so our finance team can match it against our account.",
      awaiting: "payment_proof", draft, claimId: null,
    };
  }

  // ── The amount ───────────────────────────────────────────────────────────
  if (!draft.amount) {
    const parsed = parseAmount(messageText);
    if (parsed) draft.amount = parsed;
  }
  if (!draft.amount) {
    return {
      reply:
        "Got the receipt, thank you. How much did you pay? Please reply with just the " +
        "amount — for example 500,000.",
      awaiting: "payment_amount", draft, claimId: null,
    };
  }

  // ── What it settles ──────────────────────────────────────────────────────
  //
  // A choice already offered is resolved first: `draft.offered` is the list WE
  // printed, so a bare number means the same thing to us as it did to them.
  let chosen: PaymentDraft["offered"] extends (infer T)[] | undefined ? T | null : never = null as never;
  if (awaiting === "payment_allocation" && draft.offered?.length) {
    const pick = parseChoice(messageText, draft.offered.length);
    if (pick) chosen = draft.offered[pick - 1] as never;
    if (!pick) {
      return {
        reply:
          "Sorry, I didn't catch which one. Please reply with just the number:\n" +
          draft.offered.map((o, i) => `${i + 1}. ${o.label} — ${money(o.outstanding)} outstanding`).join("\n"),
        awaiting: "payment_allocation", draft, claimId: null,
      };
    }
  }

  if (!chosen) {
    const { data: charges } = await supabaseAdmin.rpc("sender_open_charges", {
      p_org_id: orgId, p_sender_ref: senderRef, p_limit: 6,
    });
    const open = (charges ?? []) as {
      kind: "rent" | "service_charge"; charge_id: string; label: string;
      outstanding: number | string; currency: string;
    }[];

    if (open.length === 0) {
      // Nothing outstanding to attach it to. Real, and common: somebody pays in
      // advance, or the demand has not been raised yet. Not something to guess
      // at, and not something to drop.
      await tellSomebody(
        orgId,
        "A payment was reported with nothing outstanding to match it to",
        `${money(draft.amount)} reported, receipt attached, and no open demand on the account.`
      );
      await discardInboundProof(draft.proofPath);
      return {
        reply:
          `Thanks — I have your receipt for ${money(draft.amount)}, but I can't see an ` +
          "outstanding demand on your account to put it against. I've passed it to our " +
          "finance team, who will apply it and come back to you.",
        awaiting: null, draft: null, claimId: null,
      };
    }

    const fits = open.filter((o) => Number(o.outstanding) + 0.001 >= draft.amount!);
    if (open.length === 1 && fits.length === 1) {
      chosen = {
        kind: open[0].kind, chargeId: open[0].charge_id,
        label: open[0].label, outstanding: Number(open[0].outstanding),
      } as never;
    } else {
      // ⚠️ A menu, not a guess. More than one thing is owed, so which one this
      // settles is a fact only they have — and putting a payment against the
      // wrong demand is a wrong statement about somebody's arrears.
      const offered = (fits.length > 0 ? fits : open).slice(0, 6).map((o) => ({
        kind: o.kind, chargeId: o.charge_id, label: o.label,
        outstanding: Number(o.outstanding),
      }));
      draft.offered = offered;
      return {
        reply:
          `Thank you — ${money(draft.amount)}, receipt received. Which of these does it pay? ` +
          "Reply with the number:\n" +
          offered.map((o, i) => `${i + 1}. ${o.label} — ${money(o.outstanding)} outstanding`).join("\n"),
        awaiting: "payment_allocation", draft, claimId: null,
      };
    }
  }

  // ── Record it ────────────────────────────────────────────────────────────
  const pick = chosen as unknown as {
    kind: "rent" | "service_charge"; chargeId: string; label: string; outstanding: number;
  };
  const amount = Math.min(draft.amount, pick.outstanding);

  const { data: claimId, error } = await supabaseAdmin.rpc("submit_offline_claim_for_sender", {
    p_org_id: orgId,
    p_sender_ref: senderRef,
    p_method: "bank_transfer",
    p_amount: amount,
    p_paid_on: new Date().toISOString().slice(0, 10),
    p_proof_path: draft.proofPath,
    p_allocations: [{
      purpose: pick.kind,
      rent_charge_id: pick.kind === "rent" ? pick.chargeId : null,
      service_charge_id: pick.kind === "service_charge" ? pick.chargeId : null,
      amount,
    }],
    p_payer_note: `Reported on ${channel}: "${messageText.slice(0, 300)}"`,
    p_proof_filename: draft.proofFilename ?? null,
  });

  if (error) {
    // The database refused it — a rule we could not anticipate from here. Its
    // message is written for a person, so it is passed on rather than replaced
    // with something vaguer, and a human is told either way.
    await tellSomebody(
      orgId,
      "A reported payment could not be recorded",
      `${money(amount)} against ${pick.label}: ${error.message}`
    );
    await discardInboundProof(draft.proofPath);
    return {
      reply:
        `Thanks — I couldn't record that automatically (${error.message.replace(/^.*?:\s*/, "")}). ` +
        "I've passed it to our finance team with your receipt.",
      awaiting: null, draft: null, claimId: null,
    };
  }

  const { data: claim } = await supabaseAdmin
    .from("offline_payment_claims").select("reference").eq("id", claimId).maybeSingle();

  await tellSomebody(
    orgId,
    "A payment was reported on " + (channel === "whatsapp" ? "WhatsApp" : "Telegram"),
    `${claim?.reference ?? ""} — ${money(amount)} against ${pick.label}, awaiting audit verification.`
  );

  return {
    // ⚠️ Says plainly that this is NOT yet applied. The same distinction the
    // portal's printout makes with "This is not a receipt": a person who thinks
    // a payment is settled will stop chasing it.
    reply:
      `Thank you — I've recorded ${money(amount)} against ${pick.label}.\n\n` +
      `Your reference is ${claim?.reference ?? "being generated"}.\n\n` +
      "This isn't applied to your account yet: our team checks every reported payment " +
      "against our bank account first, and you'll hear from us once it's confirmed.",
    awaiting: null, draft: null, claimId: null,
  };
}
