import * as React from "react";
import { cn } from "@/lib/utils";

// ⚠️ `text-base md:text-sm`, not `text-sm`.
//
// Mobile Safari zooms the page whenever a focused input's font-size is below
// 16px, and every field here was 14px — so on an iPhone each tap into a field
// jerked the layout, and the applicant had to pinch back out before finding the
// next one. On a fourteen-section tenancy form that is not a blemish, it is the
// reason someone gives up halfway. 16px on small screens removes the trigger;
// desktop keeps the tighter 14px where no zoom behaviour exists.
const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  ({ className, type, ...props }, ref) => (
    <input
      type={type}
      ref={ref}
      className={cn(
        "flex h-10 w-full rounded-md border border-input bg-card px-3 py-2 text-base shadow-sm transition-colors md:text-sm",
        "placeholder:text-muted-foreground",
        "focus-visible:border-[var(--brand)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)]/25",
        "disabled:cursor-not-allowed disabled:opacity-50",
        "file:border-0 file:bg-transparent file:text-sm file:font-medium",
        className
      )}
      {...props}
    />
  )
);
Input.displayName = "Input";

const Textarea = React.forwardRef<
  HTMLTextAreaElement,
  React.TextareaHTMLAttributes<HTMLTextAreaElement>
>(({ className, ...props }, ref) => (
  <textarea
    ref={ref}
    className={cn(
      "flex min-h-[90px] w-full rounded-md border border-input bg-card px-3 py-2 text-base shadow-sm transition-colors md:text-sm",
      "placeholder:text-muted-foreground",
      "focus-visible:border-[var(--brand)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)]/25",
      "disabled:cursor-not-allowed disabled:opacity-50",
      className
    )}
    {...props}
  />
));
Textarea.displayName = "Textarea";

const Select = React.forwardRef<
  HTMLSelectElement,
  React.SelectHTMLAttributes<HTMLSelectElement>
>(({ className, ...props }, ref) => (
  <select
    ref={ref}
    className={cn(
      "flex h-10 w-full rounded-md border border-input bg-card px-3 py-2 text-base shadow-sm transition-colors md:text-sm",
      "focus-visible:border-[var(--brand)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)]/25",
      "disabled:cursor-not-allowed disabled:opacity-50",
      className
    )}
    {...props}
  />
));
Select.displayName = "Select";

export { Input, Textarea, Select };
