import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs font-medium transition-colors",
  {
    variants: {
      variant: {
        default: "border-transparent bg-secondary text-secondary-foreground",
        brand: "border-transparent bg-[var(--brand)] text-[var(--brand-fg)]",
        outline: "border-border text-foreground",
        // Tinted chips read their text from `-onTint`, not from the fill hue —
        // the fill is far too light to be legible on its own 12% wash.
        success: "border-transparent bg-success/12 text-success-onTint",
        warning: "border-transparent bg-warning/15 text-warning-onTint",
        info: "border-transparent bg-info/12 text-info-onTint",
        destructive: "border-transparent bg-destructive/12 text-destructive-onTint",
        muted: "border-transparent bg-muted text-foreground/75",
      },
    },
    defaultVariants: { variant: "default" },
  }
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}

export { Badge, badgeVariants };
