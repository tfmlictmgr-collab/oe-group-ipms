import { redirect } from "next/navigation";
import { AlertTriangle } from "lucide-react";
import { getSessionProfile } from "@/lib/auth";
import { llmProviderStatus } from "@/lib/llm";
import { recentClassifierMix } from "./actions";
import { PageHeader } from "@/components/patterns/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import AiHealth, { type ProviderHealth } from "./AiHealth";

// "Is the failover actually working?" — answerable from the app, by a person,
// without reading logs or a database.
//
// It exists because that question had no answer. B3 has specified a Gemini
// fallback since the start; there was none, and an Anthropic outage quietly
// turned every inbound message into an unclassified "needs human review"
// ticket with nothing anywhere recording why. Now there is a failover — and a
// failover you cannot inspect is only marginally better, because the state you
// most need to know (running on the fallback, or on neither) looks exactly
// like a quiet week.

export const dynamic = "force-dynamic";

export default async function AiSettingsPage() {
  const session = await getSessionProfile();
  if (!session) redirect("/login");
  if (session.profile?.role !== "admin") redirect("/dashboard/settings/notifications");

  // Free: reads env presence only. The live probe costs a request per
  // provider, so it is a button, not something every page load pays for.
  const status = llmProviderStatus();
  const initial: ProviderHealth[] = [
    {
      name: "anthropic",
      role: "primary",
      configured: status.primary,
      reachable: null,
      detail: status.primary ? "Key is set." : "No API key set — classification is unavailable.",
    },
    {
      name: "gemini",
      role: "fallback",
      configured: status.fallback,
      reachable: null,
      detail: status.fallback
        ? "Key is set."
        : "No API key set. Failover is skipped — an outage on the primary degrades to human review.",
    },
  ];

  const mixResult = await recentClassifierMix();
  const mix = mixResult.ok ? mixResult.data.mix : [];
  const total = mix.reduce((a, m) => a + m.count, 0);
  const degraded = mix.find((m) => m.provider === "none")?.count ?? 0;
  const onFallback = mix.find((m) => m.provider === "gemini")?.count ?? 0;

  return (
    <div className="space-y-6">
      <PageHeader
        title="AI & Classification"
        description="Which model reads incoming requests, and what happens when it cannot."
      />

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Providers</CardTitle>
        </CardHeader>
        <CardContent>
          <AiHealth initial={initial} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">What actually classified the last 7 days</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {total === 0 ? (
            <p className="text-sm text-muted-foreground">
              No requests classified in the last 7 days.
            </p>
          ) : (
            <>
              <div className="space-y-2">
                {mix.map((m) => (
                  <div key={m.provider} className="flex items-center justify-between gap-4 text-sm">
                    <span className="capitalize">
                      {m.provider === "none"
                        ? "Neither — fell back to human review"
                        : m.provider === "anthropic"
                          ? "Claude (primary)"
                          : m.provider === "gemini"
                            ? "Gemini (fallback)"
                            : m.provider}
                    </span>
                    <span className="tabular-nums text-muted-foreground">
                      {m.count} ({Math.round((m.count / total) * 100)}%)
                    </span>
                  </div>
                ))}
              </div>

              {/* The point of recording it: a provider can be reachable NOW and
                  have been failing all day. A live probe cannot see that. */}
              {(degraded > 0 || onFallback > 0) && (
                <p className="flex items-start gap-2 rounded-md bg-warning/10 p-3 text-sm">
                  <AlertTriangle className="mt-0.5 size-4 flex-shrink-0 text-warning" />
                  <span>
                    {degraded > 0 && (
                      <>
                        <strong>{degraded}</strong> request{degraded === 1 ? "" : "s"} could not be
                        classified by any provider and went to human review.{" "}
                      </>
                    )}
                    {onFallback > 0 && (
                      <>
                        <strong>{onFallback}</strong> were classified by the fallback, meaning the
                        primary was unavailable at the time.
                      </>
                    )}
                  </span>
                </p>
              )}
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
