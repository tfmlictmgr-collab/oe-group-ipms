import { Lock } from "lucide-react";
import { PageHeader } from "@/components/patterns/page-header";
import { EmptyState } from "@/components/patterns/empty-state";

// Page-level role guard. RLS is the security backstop (it returns no data to a
// role that shouldn't see it), but restricted roles reaching a privileged route
// directly should get a clean message rather than an empty UI shell. Render this
// in place of the page body when the role isn't allowed.
export default function RoleGate({ title }: { title: string }) {
  return (
    <div className="space-y-6">
      <PageHeader title={title} />
      <EmptyState
        icon={<Lock />}
        title="Not available for your role"
        description="Use the navigation menu to reach the areas you have access to."
      />
    </div>
  );
}

export function roleAllowed(
  role: string | undefined,
  allowed: string[]
): boolean {
  return allowed.includes(role ?? "");
}
