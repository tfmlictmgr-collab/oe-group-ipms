"use client";

import * as React from "react";
import { toast } from "sonner";
import { Activity, CheckCircle2, XCircle, MinusCircle, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { runAction, messageOf } from "@/lib/run-action";
import { testProviders } from "./actions";

export type ProviderHealth = {
  name: string;
  role: "primary" | "fallback";
  configured: boolean;
  reachable: boolean | null;
  detail: string;
};

const LABEL: Record<string, string> = {
  anthropic: "Claude (Anthropic)",
  gemini: "Gemini (Google)",
};

export default function AiHealth({ initial }: { initial: ProviderHealth[] }) {
  const [health, setHealth] = React.useState<ProviderHealth[] | null>(null);
  const [busy, setBusy] = React.useState(false);

  async function test() {
    setBusy(true);
    try {
      const r = await runAction(testProviders());
      setHealth(r.health);
      const broken = r.health.filter((h) => h.configured && h.reachable === false);
      if (broken.length === 0) toast.success("Both providers answered.");
      else toast.warning(`${broken.length} provider(s) did not answer`, { duration: 8000 });
    } catch (e) {
      toast.error(messageOf(e, "Could not test the providers."));
    } finally {
      setBusy(false);
    }
  }

  // Before a live test, all we honestly know is whether a key is present.
  const rows = health ?? initial;

  return (
    <div className="space-y-4">
      <div className="space-y-3">
        {rows.map((h) => {
          const untested = health === null;
          const state = !h.configured
            ? "missing"
            : untested
              ? "unknown"
              : h.reachable
                ? "ok"
                : "broken";
          return (
            <div
              key={h.name}
              className="flex flex-wrap items-start justify-between gap-3 rounded-lg border border-border bg-card p-4"
            >
              <div className="min-w-0 space-y-1">
                <p className="flex items-center gap-2 font-medium">
                  {state === "ok" && <CheckCircle2 className="size-4 text-success" />}
                  {state === "broken" && <XCircle className="size-4 text-destructive" />}
                  {state === "missing" && <MinusCircle className="size-4 text-muted-foreground" />}
                  {state === "unknown" && <Activity className="size-4 text-muted-foreground" />}
                  {LABEL[h.name] ?? h.name}
                  <Badge variant="outline" className="capitalize">
                    {h.role}
                  </Badge>
                </p>
                <p
                  className={cn(
                    "text-xs",
                    state === "broken" ? "text-destructive" : "text-muted-foreground"
                  )}
                >
                  {untested && h.configured
                    ? "Key is set. Run a test to find out whether it actually answers."
                    : h.detail}
                </p>
              </div>
            </div>
          );
        })}
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <Button variant="outline" onClick={test} disabled={busy}>
          {busy ? <Loader2 className="animate-spin" /> : <Activity />}
          {busy ? "Testing…" : "Test both providers now"}
        </Button>
        <p className="text-xs text-muted-foreground">
          Sends a one-word prompt to each. Costs a fraction of a penny.
        </p>
      </div>
    </div>
  );
}
