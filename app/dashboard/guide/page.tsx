import { redirect } from "next/navigation";
import { BookOpen, Download, ShieldAlert } from "lucide-react";
import { getSessionProfile } from "@/lib/auth";
import { roleLabel } from "@/lib/roles";
import { guideForRole } from "@/lib/guides/content";
import { PageHeader } from "@/components/patterns/page-header";
import { Button } from "@/components/ui/button";
import {
  Card, CardContent, CardDescription, CardHeader, CardTitle,
} from "@/components/ui/card";
import { EmptyState } from "@/components/patterns/empty-state";

// The same guide the PDF carries, on screen.
//
// Both read the one source in `lib/guides/content.ts` rather than each holding
// its own copy — a printed handbook that disagrees with the screen is worse
// than having only one of them, and two hand-maintained copies always drift.
export default async function GuidePage() {
  const session = await getSessionProfile();
  if (!session?.profile || !session.org) redirect("/login");

  const { profile, org } = session;
  const label = roleLabel(profile.role, org.delivery_brand);
  const guide = guideForRole(profile.role, label);

  if (!guide) {
    return (
      <div className="space-y-6">
        <PageHeader title="Guide" />
        <EmptyState
          icon={<BookOpen />}
          title="No guide for your role yet"
          description="Ask your administrator — one can be written for this role."
        />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title={guide.title}
        description={guide.audience}
        actions={
          <Button asChild variant="brand">
            {/* Plain link, not a fetch: the browser's own download handles a
                large PDF on a weak connection far better than anything we would
                write, and it works with the connection dropping mid-transfer. */}
            <a href="/api/guides" download>
              <Download className="size-4" /> Download as PDF
            </a>
          </Button>
        }
      />

      {guide.sections.map((section) => (
        <Card key={section.heading}>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">{section.heading}</CardTitle>
            {section.intro ? (
              <CardDescription>{section.intro}</CardDescription>
            ) : null}
          </CardHeader>
          <CardContent className="space-y-4">
            {section.steps.map((step) => (
              <div key={step.title} className="border-l-2 border-border pl-4">
                <p className="text-sm font-medium">{step.title}</p>
                <p className="mt-1 text-sm text-muted-foreground">{step.body}</p>
              </div>
            ))}
          </CardContent>
        </Card>
      ))}

      {/* Given the same weight as everything above it. Most support calls are
          someone asking for a thing their role was never meant to have, and
          answering that here costs nothing. */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <ShieldAlert className="size-4 text-muted-foreground" />
            What this role cannot do
          </CardTitle>
          <CardDescription>
            Not faults, and not oversights — these are set deliberately, and a
            refusal on one of them is the system working.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ul className="space-y-2">
            {guide.cannot.map((c) => (
              <li key={c} className="flex gap-2 text-sm text-muted-foreground">
                <span aria-hidden className="text-muted-foreground">•</span>
                <span>{c}</span>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>
    </div>
  );
}
