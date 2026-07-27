"use client";

import { useTransition } from "react";
import { toast } from "sonner";
import { FileOutput } from "lucide-react";
import { Button } from "@/components/ui/button";
import { generateInvoices } from "./actions";
import { runAction, describeError } from "@/lib/run-action";

export default function GenerateButton({
  budgetId,
  alreadyInvoiced,
}: {
  budgetId: string;
  alreadyInvoiced: boolean;
}) {
  const [pending, startTransition] = useTransition();

  function handleClick() {
    startTransition(async () => {
      try {
        await runAction(generateInvoices(budgetId));
        toast.success("Invoices generated", {
          description: "Each occupant's statement has been updated.",
        });
      } catch (e) {
        toast.error("Could not generate invoices", {
          description: describeError(e),
        });
      }
    });
  }

  return (
    <Button onClick={handleClick} disabled={pending} variant="brand" size="sm">
      <FileOutput />
      {pending
        ? "Generating…"
        : alreadyInvoiced
          ? "Regenerate invoices"
          : "Generate invoices"}
    </Button>
  );
}
