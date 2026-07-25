import { cn } from "@/lib/utils";

// Logo lockup: a brand-coloured monogram + the org/brand name. `logoText` lets
// an admin override the two-letter monogram (per-org theming).
export function BrandMark({
  name,
  logoText,
  subtitle,
  className,
  onDark = true,
}: {
  name: string;
  logoText?: string | null;
  subtitle?: string;
  className?: string;
  onDark?: boolean;
}) {
  const mono = (logoText || name).slice(0, 2).toUpperCase();
  return (
    <div className={cn("flex min-w-0 items-center gap-2.5", className)}>
      <span
        className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg text-sm font-bold shadow-sm"
        style={{ background: "var(--brand)", color: "var(--brand-fg)" }}
      >
        {mono}
      </span>
      <span className="min-w-0 leading-tight">
        <span
          className={cn(
            "block truncate text-sm font-semibold",
            onDark ? "text-white" : "text-foreground"
          )}
        >
          {name}
        </span>
        {subtitle && (
          <span className={cn("block truncate text-xs", onDark ? "text-sidebar-muted" : "text-muted-foreground")}>
            {subtitle}
          </span>
        )}
      </span>
    </div>
  );
}
