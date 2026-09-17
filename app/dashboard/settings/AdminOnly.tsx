import { ShieldAlert } from "lucide-react";
import { EmptyState } from "@/components/patterns/empty-state";

// Shown when a non-admin reaches an organisation-configuration tab directly.
// The nav hides these tabs, but the check is repeated on the server so the URL
// is not a way around it.
export default function AdminOnly({ what }: { what: string }) {
  return (
    <EmptyState
      icon={<ShieldAlert />}
      title="Administrator access required"
      description={`Only administrators can change ${what}. Your own preferences are under "My Notifications".`}
    />
  );
}
