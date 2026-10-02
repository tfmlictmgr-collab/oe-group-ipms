import Link from "next/link";
import { ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * Shown to a member with no second factor while their organisation's
 * enforcement date is still ahead (0308). Not dismissable: it is a deadline,
 * and after it the dashboard is replaced by the setup page anyway.
 */
export default function MfaDueBanner({ enforcedFrom }: { enforcedFrom: string }) {
  const when = new Date(enforcedFrom).toLocaleString("en-NG", {
    timeZone: "Africa/Lagos",
    day: "numeric",
    month: "long",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
  return (
    <div
      role="status"
      className="mb-4 flex flex-col gap-3 rounded-lg border border-warning/40 bg-warning/10 px-4 py-3 text-sm sm:flex-row sm:items-center sm:justify-between"
    >
      <p className="flex items-start gap-2">
        <ShieldAlert className="mt-0.5 size-4 flex-shrink-0 text-warning" />
        <span>
          <span className="font-medium">Set up two-factor sign-in by {when}.</span>{" "}
          After that, you will be asked to set it up before you can continue. It takes about a minute
          with an authenticator app on your phone.
        </span>
      </p>
      <Button asChild variant="brand" size="sm" className="shrink-0">
        <Link href="/mfa?next=/dashboard">Set it up now</Link>
      </Button>
    </div>
  );
}
