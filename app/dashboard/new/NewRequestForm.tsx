"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { AlertCircle, CheckCircle2, Sparkles, ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input, Textarea, Select } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent } from "@/components/ui/card";
import { StatusBadge } from "@/components/patterns/status-badge";
import { raiseRequest, correctMyUrgency, type RaisedRequest } from "./actions";

const CATEGORIES = ["maintenance", "billing", "vendor", "complaint", "general"];
const URGENCIES = ["low", "normal", "high", "critical"];

/**
 * Report an issue, then see what we made of it.
 *
 * The form is deliberately one box. Everything else is optional, because the
 * classifier reads the sentence — asking a tenant with a burst pipe to
 * categorise it first is asking them to do the triage we built a model for.
 *
 * The second half is the part the portal never had: an acknowledgement that
 * names the reference, states the priority we assigned, and lets them say we
 * got it wrong. That exchange existed on WhatsApp since 0075 and on the web
 * not at all.
 */
export default function NewRequestForm() {
  const router = useRouter();
  const [messageText, setMessageText] = useState("");
  const [category, setCategory] = useState("");
  const [propertyOrUnit, setPropertyOrUnit] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const [raised, setRaised] = useState<RaisedRequest | null>(null);
  const [urgency, setUrgency] = useState<string>("");
  const [correcting, setCorrecting] = useState(false);
  const [correction, setCorrection] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);

    const result = await raiseRequest({
      messageText,
      category: category || null,
      propertyOrUnit: propertyOrUnit || null,
    });

    setLoading(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    setRaised(result.data);
    setUrgency(result.data.urgency);
  }

  async function handleCorrection(next: string) {
    if (!raised || next === urgency) return;
    setCorrecting(true);
    setCorrection(null);
    const result = await correctMyUrgency(raised.ticketId, next);
    setCorrecting(false);

    if (!result.ok) {
      setCorrection(result.message);
      return;
    }
    if (result.data.applied) {
      setUrgency(next);
      setCorrection(`Priority updated to ${next}. Our team has been told.`);
    } else {
      // `set_my_ticket_urgency` returns false when an operator has already
      // judged it. Say that plainly rather than showing a changed badge for an
      // update that did not happen.
      setCorrection(
        "Our team had already set the priority on this one, so it stays as it is — your note has been added to the request."
      );
    }
  }

  // ── Acknowledged ────────────────────────────────────────────────────────
  if (raised) {
    return (
      <Card>
        <CardContent className="space-y-5 pt-5">
          <div className="flex items-start gap-3">
            <span className="flex size-9 flex-shrink-0 items-center justify-center rounded-full bg-success/12 text-success">
              <CheckCircle2 className="size-5" />
            </span>
            <div className="min-w-0 space-y-1">
              <p className="font-medium">Request logged</p>
              <p className="text-sm text-muted-foreground">
                Your reference is{" "}
                <span className="font-mono font-medium text-foreground">
                  {raised.reference}
                </span>
                . Quote it if you contact us about this.
              </p>
            </div>
          </div>

          <div className="space-y-3 rounded-lg border border-border bg-muted/30 p-4">
            <p className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
              <Sparkles className="size-3.5" />
              {/* Honest about provenance. `classified_by = 'none'` means both
                  providers were unreachable and the row carries the safe
                  human-review default — claiming it was assessed would be a
                  lie on exactly the request most likely to need a person. */}
              {raised.classifiedBy === "none"
                ? "Logged for a person to assess"
                : "What we understood"}
            </p>
            <p className="text-sm">{raised.summary}</p>
            <div className="flex flex-wrap items-center gap-2 pt-0.5">
              <StatusBadge status={raised.category} />
              <StatusBadge status={urgency} />
              {raised.categoryOverridden && (
                <span className="text-xs text-muted-foreground">
                  category as you set it
                </span>
              )}
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="correct">Is that priority right?</Label>
            <div className="flex flex-wrap gap-2">
              {URGENCIES.map((u) => (
                <Button
                  key={u}
                  type="button"
                  size="sm"
                  variant={u === urgency ? "brand" : "outline"}
                  disabled={correcting}
                  onClick={() => handleCorrection(u)}
                  className="capitalize"
                >
                  {u}
                </Button>
              ))}
            </div>
            {correction && (
              <p className="text-xs text-muted-foreground">{correction}</p>
            )}
          </div>

          <div className="flex flex-col-reverse gap-2 pt-1 sm:flex-row sm:justify-end">
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                setRaised(null);
                setMessageText("");
                setCategory("");
                setPropertyOrUnit("");
                setCorrection(null);
              }}
            >
              Report something else
            </Button>
            <Button asChild variant="brand">
              <Link href="/dashboard/my-requests">
                Track this request <ArrowRight />
              </Link>
            </Button>
          </div>
        </CardContent>
      </Card>
    );
  }

  // ── Reporting ───────────────────────────────────────────────────────────
  return (
    <Card>
      <CardContent className="pt-5">
        <form onSubmit={handleSubmit} className="space-y-5">
          <div className="space-y-1.5">
            <Label htmlFor="message">What&apos;s the issue?</Label>
            <Textarea
              id="message"
              required
              rows={4}
              value={messageText}
              onChange={(e) => setMessageText(e.target.value)}
              placeholder="e.g. The lift on the 3rd floor has been out since Friday and the alarm inside is not working."
            />
            <p className="text-xs text-muted-foreground">
              Say what is wrong and where. We work out the category and how
              urgent it is, and you can correct us on the next screen.
            </p>
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="category">
                Category{" "}
                <span className="font-normal text-muted-foreground">
                  (optional)
                </span>
              </Label>
              <Select
                id="category"
                value={category}
                onChange={(e) => setCategory(e.target.value)}
                className="capitalize"
              >
                <option value="">Work it out for me</option>
                {CATEGORIES.map((c) => (
                  <option key={c} value={c} className="capitalize">
                    {c}
                  </option>
                ))}
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="property">
                Property / Unit{" "}
                <span className="font-normal text-muted-foreground">
                  (optional)
                </span>
              </Label>
              <Input
                id="property"
                type="text"
                value={propertyOrUnit}
                onChange={(e) => setPropertyOrUnit(e.target.value)}
                placeholder="e.g. Block B, Unit 12"
              />
            </div>
          </div>

          {error && (
            <p
              role="alert"
              className="flex items-start gap-2 rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive"
            >
              <AlertCircle className="mt-0.5 size-4 flex-shrink-0" />
              {error}
            </p>
          )}

          <div className="flex flex-col-reverse gap-2 pt-1 sm:flex-row sm:justify-end">
            <Button
              type="button"
              variant="ghost"
              onClick={() => router.back()}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              variant="brand"
              disabled={loading || !messageText.trim()}
            >
              {loading ? "Logging your request…" : "Submit Request"}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
