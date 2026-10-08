import { redirect } from "next/navigation";
import { getSessionProfile } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/patterns/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

// What the help assistant could not answer, or answered badly.
//
// The assistant improves through people: an administrator reads this list and
// either fixes the guide wording the question should have found, or tells the
// build team which everyday word the assistant does not yet understand. It
// never rewrites its own answers.
//
// Questions are masked for e-mail addresses and phone numbers, carry no user
// id, and are deleted after 90 days (0316). `help_bot_gaps()` returns an empty
// set to anyone who is not this organisation's administrator.
export const dynamic = "force-dynamic";

type Gap = {
  question: string;
  role: string;
  asked: number;
  thumbs_down: number;
  no_answer: number;
  last_asked: string;
};

const when = (iso: string) =>
  new Date(iso).toLocaleString("en-GB", { timeZone: "Africa/Lagos", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

export default async function HelpQuestionsPage({ searchParams }: { searchParams: Promise<{ days?: string }> }) {
  const session = await getSessionProfile();
  if (!session) redirect("/login");
  if (session.profile?.role !== "admin") redirect("/dashboard/settings/notifications");

  const { days: d } = await searchParams;
  const days = [7, 30, 90].includes(Number(d)) ? Number(d) : 30;
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("help_bot_gaps", { p_days: days });
  const rows = (data ?? []) as Gap[];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Help Questions"
        description="Questions the help assistant couldn't answer or that people marked not helpful, most asked first."
      />
      <div className="flex gap-2 text-sm">
        {[7, 30, 90].map((n) => (
          <a key={n} href={`?days=${n}`} className={`rounded-full border px-3 py-1 ${n === days ? "bg-muted font-medium" : ""}`}>
            Last {n} days
          </a>
        ))}
      </div>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">What to do with these</CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground">
          If the answer exists but was not found, the person used a word the guide does not. Tell the build team the word.
          If the answer does not exist, the guide is missing a step. Either way the fix is written once and helps everyone;
          the assistant never changes its own answers. Questions hold no names and are deleted after 90 days.
        </CardContent>
      </Card>
      {error ? (
        <p className="text-sm text-red-600">The list could not be loaded: {error.message}</p>
      ) : rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">Nothing in the last {days} days: no unanswered or downvoted questions.</p>
      ) : (
        <div className="overflow-x-auto rounded-lg border">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-left text-xs uppercase text-muted-foreground">
              <tr>
                <th className="px-3 py-2">Question</th>
                <th className="px-3 py-2">Role</th>
                <th className="px-3 py-2 text-right">Asked</th>
                <th className="px-3 py-2 text-right">No answer</th>
                <th className="px-3 py-2 text-right">Not helpful</th>
                <th className="px-3 py-2">Last asked</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i} className="border-t">
                  <td className="px-3 py-2">{r.question}</td>
                  <td className="px-3 py-2 whitespace-nowrap">{r.role.replace(/_/g, " ")}</td>
                  <td className="px-3 py-2 text-right">{r.asked}</td>
                  <td className="px-3 py-2 text-right">{r.no_answer}</td>
                  <td className="px-3 py-2 text-right">{r.thumbs_down}</td>
                  <td className="px-3 py-2 whitespace-nowrap">{when(r.last_asked)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
