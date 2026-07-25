"use client";

import { useTransition } from "react";
import { toast } from "sonner";
import { FileOutput } from "lucide-react";
import { Button } from "@/components/ui/button";
import { generateInvoices } from "./actions";

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
        await generateInvoices(budgetId);
        toast.success("Invoices generated", {
          description: "Each occupant's statement has been updated.",
        });
      } catch (e) {
        toast.error("Could not generate invoices", {
          description: e instanceof Error ? e.message : "Unexpected error.",
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
