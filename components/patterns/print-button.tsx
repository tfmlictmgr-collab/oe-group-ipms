"use client";

import { Printer } from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * Prints the current page through the browser's own dialogue.
 *
 * Deliberately `window.print()` rather than a server-rendered PDF: what a
 * finance reader needs from these screens is the figures they are already
 * looking at, on paper, with the period and the filters they chose — and a
 * separate PDF renderer is a second copy of the report that can disagree with
 * the first. Receipts and the analytics pack stay on @react-pdf because they
 * are documents SENT to someone; this one is a screen a person prints.
 *
 * Carries no access check of its own, and must not grow one: it prints the DOM
 * the server already decided this reader may see. The gate is the page.
 */
export function PrintButton({
  label = "Print",
  className,
}: {
  label?: string;
  className?: string;
}) {
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      onClick={() => window.print()}
      className={className}
    >
      <Printer className="size-4" />
      {label}
    </Button>
  );
}
