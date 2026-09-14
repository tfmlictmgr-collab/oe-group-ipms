"use client";

import * as React from "react";
import { Input, Textarea } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatNaira } from "@/lib/currency";
import { OFFER_DAYS, payableOnAcceptance, termLabel } from "@/lib/tenancy-offer";
import type { OfferInput } from "./actions";

/**
 * The terms of the offer, as the reviewer states them.
 *
 * ⚠️ These fields are the whole point of 0263. Approval used to complete with
 * a unit and nothing else, so the "approved" email could only say "set up your
 * account" — there was no rent anywhere to tell anybody. Every field here is a
 * number a tenant is being asked to agree to, which is why the running total is
 * shown back: an offer letter is read once, by someone deciding whether they
 * can afford it, and a mistyped digit is not a thing to discover afterwards.
 *
 * Shared by the approval panel and the re-issue panel, so a corrected offer
 * cannot quietly ask for different fields than the original.
 */

const today = () => new Date().toISOString().slice(0, 10);

export function blankOffer(): OfferInput {
  const commences = new Date();
  // Far enough out to be plausible and near enough to be obviously a default —
  // this is a date somebody must actually choose, and a value they will read
  // past is worse than an empty box.
  commences.setDate(commences.getDate() + 30);
  const expires = new Date();
  expires.setDate(expires.getDate() + OFFER_DAYS);
  return {
    rentAmount: "",
    serviceChargeAmount: "",
    depositAmount: "",
    otherChargesAmount: "",
    otherChargesLabel: "",
    termMonths: "12",
    commencesOn: commences.toISOString().slice(0, 10),
    expiresOn: expires.toISOString().slice(0, 10),
    conditions: "",
  };
}

const num = (v: string) => {
  const n = Number((v ?? "").replace(/[,\s₦]/g, "") || "0");
  return Number.isFinite(n) ? n : 0;
};

/** The same rules `checkTerms` applies server-side, so the button that is
 *  offered is the button that will succeed. */
export function offerIsReady(o: OfferInput): boolean {
  if (num(o.rentAmount) <= 0) return false;
  if ([o.serviceChargeAmount, o.depositAmount, o.otherChargesAmount].some((v) => num(v) < 0)) return false;
  if (num(o.otherChargesAmount) > 0 && o.otherChargesLabel.trim().length < 2) return false;
  const t = Number(o.termMonths);
  if (!Number.isInteger(t) || t < 1 || t > 120) return false;
  if (!o.commencesOn || !o.expiresOn) return false;
  if (o.expiresOn < today()) return false;
  return true;
}

export default function OfferTermsFields({
  value,
  onChange,
  disabled,
}: {
  value: OfferInput;
  onChange: (next: OfferInput) => void;
  disabled?: boolean;
}) {
  const set = <K extends keyof OfferInput>(k: K, v: OfferInput[K]) =>
    onChange({ ...value, [k]: v });

  const total = payableOnAcceptance({
    rentAmount: num(value.rentAmount),
    serviceChargeAmount: num(value.serviceChargeAmount),
    depositAmount: num(value.depositAmount),
    otherChargesAmount: num(value.otherChargesAmount),
    otherChargesLabel: value.otherChargesLabel || null,
    termMonths: Number(value.termMonths) || 0,
    commencesOn: value.commencesOn,
    expiresOn: value.expiresOn,
    conditions: value.conditions || null,
  });

  return (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <Money
          id="offer-rent" label="Rent, per annum"
          hint="Billed annually in advance."
          value={value.rentAmount} onChange={(v) => set("rentAmount", v)} disabled={disabled}
        />
        <Money
          id="offer-sc" label="Service charge, per annum"
          hint="Shown beside the rent and never added to it — it funds the building."
          value={value.serviceChargeAmount} onChange={(v) => set("serviceChargeAmount", v)} disabled={disabled}
        />
        <Money
          id="offer-deposit" label="Security deposit"
          hint="One-off, refundable at the end of the term."
          value={value.depositAmount} onChange={(v) => set("depositAmount", v)} disabled={disabled}
        />
        <Money
          id="offer-other" label="Other charges"
          hint="Legal, agency, caution — anything else payable on acceptance."
          value={value.otherChargesAmount} onChange={(v) => set("otherChargesAmount", v)} disabled={disabled}
        />
      </div>

      {num(value.otherChargesAmount) > 0 && (
        <div className="space-y-1.5">
          <Label htmlFor="offer-other-label">What are the other charges for?</Label>
          <Input
            id="offer-other-label"
            value={value.otherChargesLabel}
            disabled={disabled}
            placeholder="e.g. Legal and agency fee"
            onChange={(e) => set("otherChargesLabel", e.target.value)}
          />
          <p className="text-xs text-muted-foreground">
            It appears on the offer letter under this name. A charge nobody can
            name is one the tenant cannot check.
          </p>
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-3">
        <div className="space-y-1.5">
          <Label htmlFor="offer-term">Term, in months</Label>
          <Input
            id="offer-term" inputMode="numeric" value={value.termMonths} disabled={disabled}
            onChange={(e) => set("termMonths", e.target.value.replace(/\D/g, ""))}
          />
          <p className="text-xs text-muted-foreground">
            {Number(value.termMonths) > 0 ? termLabel(Number(value.termMonths)) : " "}
          </p>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="offer-commences">Commences on</Label>
          <Input
            id="offer-commences" type="date" value={value.commencesOn} disabled={disabled}
            onChange={(e) => set("commencesOn", e.target.value)}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="offer-expires">Offer open until</Label>
          <Input
            id="offer-expires" type="date" value={value.expiresOn} disabled={disabled}
            min={today()}
            onChange={(e) => set("expiresOn", e.target.value)}
          />
          <p className="text-xs text-muted-foreground">
            After this the unit is free again.
          </p>
        </div>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="offer-conditions">
          Conditions <span className="text-muted-foreground">(optional)</span>
        </Label>
        <Textarea
          id="offer-conditions" rows={2} value={value.conditions} disabled={disabled}
          placeholder="Anything the offer is subject to — a guarantor, a reference, works to be completed before commencement…"
          onChange={(e) => set("conditions", e.target.value)}
        />
      </div>

      <div className="flex items-baseline justify-between gap-4 rounded-lg border border-border bg-muted/40 px-3 py-2.5">
        <span className="text-sm font-medium">Payable by the tenant to accept</span>
        <span className="text-base font-semibold tabular-nums">{formatNaira(total)}</span>
      </div>
    </div>
  );
}

function Money({
  id, label, hint, value, onChange, disabled,
}: {
  id: string;
  label: string;
  hint: string;
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        inputMode="decimal"
        value={value}
        disabled={disabled}
        placeholder="0"
        onChange={(e) => onChange(e.target.value.replace(/[^\d.,]/g, ""))}
      />
      <p className="text-xs text-muted-foreground">{hint}</p>
    </div>
  );
}
