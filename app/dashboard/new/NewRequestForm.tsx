"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { AlertCircle } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { Input, Textarea, Select } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent } from "@/components/ui/card";

const CATEGORIES = ["maintenance", "billing", "vendor", "complaint", "general"];
const URGENCIES = ["low", "normal", "high", "critical"];

export default function NewRequestForm({
  orgId,
  propertyId,
}: {
  orgId: string;
  propertyId?: string | null;
}) {
  const router = useRouter();
  const [messageText, setMessageText] = useState("");
  const [category, setCategory] = useState("maintenance");
  const [urgency, setUrgency] = useState("normal");
  const [propertyOrUnit, setPropertyOrUnit] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);

    const supabase = createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      setError("Your session expired. Please sign in again.");
      setLoading(false);
      return;
    }

    const { error } = await supabase.from("tickets").insert({
      org_id: orgId,
      sender_id: user.id,
      channel: "portal",
      message_text: messageText,
      category,
      urgency,
      summary: messageText.slice(0, 140),
      property_or_unit: propertyOrUnit || null,
      property_id: propertyId ?? null,
    });

    if (error) {
      setError(error.message);
      setLoading(false);
      return;
    }

    router.push("/dashboard");
    router.refresh();
  }

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
              placeholder="e.g. The lift on the 3rd floor is not working."
            />
            <p className="text-xs text-muted-foreground">
              Be as specific as you can — it helps us route the job correctly.
            </p>
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="category">Category</Label>
              <Select
                id="category"
                value={category}
                onChange={(e) => setCategory(e.target.value)}
                className="capitalize"
              >
                {CATEGORIES.map((c) => (
                  <option key={c} value={c} className="capitalize">
                    {c}
                  </option>
                ))}
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="urgency">Urgency</Label>
              <Select
                id="urgency"
                value={urgency}
                onChange={(e) => setUrgency(e.target.value)}
                className="capitalize"
              >
                {URGENCIES.map((u) => (
                  <option key={u} value={u} className="capitalize">
                    {u}
                  </option>
                ))}
              </Select>
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="property">
              Property / Unit{" "}
              <span className="font-normal text-muted-foreground">(optional)</span>
            </Label>
            <Input
              id="property"
              type="text"
              value={propertyOrUnit}
              onChange={(e) => setPropertyOrUnit(e.target.value)}
              placeholder="e.g. Block B, Unit 12"
            />
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
            <Button type="button" variant="ghost" onClick={() => router.push("/dashboard")}>
              Cancel
            </Button>
            <Button type="submit" variant="brand" disabled={loading || !messageText.trim()}>
              {loading ? "Submitting…" : "Submit Request"}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
