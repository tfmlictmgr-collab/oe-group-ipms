"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

const CATEGORIES = [
  "maintenance",
  "billing",
  "vendor",
  "complaint",
  "general",
];
const URGENCIES = ["low", "normal", "high", "critical"];

export default function NewRequestForm({ orgId }: { orgId: string }) {
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
    });

    if (error) {
      setError(error.message);
      setLoading(false);
      return;
    }

    router.push("/dashboard");
    router.refresh();
  }

  const fieldClass =
    "w-full rounded-lg border border-neutral-300 px-3 py-2 text-sm outline-none focus:border-neutral-800 focus:ring-1 focus:ring-neutral-800";

  return (
    <form
      onSubmit={handleSubmit}
      className="space-y-4 rounded-xl bg-white p-6 shadow-sm ring-1 ring-black/5"
    >
      <div>
        <label className="mb-1 block text-sm font-medium text-neutral-700">
          What&apos;s the issue?
        </label>
        <textarea
          required
          rows={4}
          value={messageText}
          onChange={(e) => setMessageText(e.target.value)}
          className={fieldClass}
          placeholder="e.g. The lift on the 3rd floor is not working."
        />
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div>
          <label className="mb-1 block text-sm font-medium text-neutral-700">
            Category
          </label>
          <select
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            className={`${fieldClass} capitalize`}
          >
            {CATEGORIES.map((c) => (
              <option key={c} value={c} className="capitalize">
                {c}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="mb-1 block text-sm font-medium text-neutral-700">
            Urgency
          </label>
          <select
            value={urgency}
            onChange={(e) => setUrgency(e.target.value)}
            className={`${fieldClass} capitalize`}
          >
            {URGENCIES.map((u) => (
              <option key={u} value={u} className="capitalize">
                {u}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div>
        <label className="mb-1 block text-sm font-medium text-neutral-700">
          Property / Unit{" "}
          <span className="font-normal text-neutral-400">(optional)</span>
        </label>
        <input
          type="text"
          value={propertyOrUnit}
          onChange={(e) => setPropertyOrUnit(e.target.value)}
          className={fieldClass}
          placeholder="e.g. Block B, Unit 12"
        />
      </div>

      {error && (
        <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-600">
          {error}
        </p>
      )}

      <div className="flex items-center justify-end gap-3 pt-2">
        <button
          type="button"
          onClick={() => router.push("/dashboard")}
          className="rounded-lg px-4 py-2 text-sm font-medium text-neutral-600 hover:bg-neutral-100"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={loading}
          className="rounded-lg bg-neutral-900 px-4 py-2 text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          {loading ? "Submitting…" : "Submit Request"}
        </button>
      </div>
    </form>
  );
}
