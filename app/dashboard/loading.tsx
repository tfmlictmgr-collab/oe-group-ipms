import { Skeleton } from "@/components/ui/skeleton";
import { Card, CardContent } from "@/components/ui/card";

// One loading state for the whole dashboard section. Next's Suspense
// boundary at this layout level covers every route under /dashboard that
// doesn't define its own — which, before this file, was all 44 of them:
// a navigation showed either a blank flash or the PREVIOUS page's content
// hanging on screen until the new one's data arrived. The sidebar/top bar
// (rendered by the layout, not this file) stay put; only the content area
// swaps to this while the next page's server component does its fetching.
//
// Deliberately generic rather than one skeleton per route shape — this
// codebase's pages overwhelmingly follow the same PageHeader + Card list
// pattern, and a close-enough placeholder that appears instantly beats an
// exact one that would need 44 bespoke files to stay in sync with 44 pages.
export default function DashboardLoading() {
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-2">
          <Skeleton className="h-7 w-48" />
          <Skeleton className="h-4 w-64" />
        </div>
        <Skeleton className="h-10 w-32" />
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Card key={i}>
            <CardContent className="space-y-2 p-4">
              <Skeleton className="h-3 w-20" />
              <Skeleton className="h-7 w-16" />
            </CardContent>
          </Card>
        ))}
      </div>

      <div className="space-y-3">
        {Array.from({ length: 5 }).map((_, i) => (
          <Card key={i}>
            <CardContent className="flex items-center justify-between gap-4 p-4">
              <div className="min-w-0 flex-1 space-y-2">
                <Skeleton className="h-4 w-1/3" />
                <Skeleton className="h-3 w-1/2" />
              </div>
              <Skeleton className="h-6 w-20 flex-shrink-0" />
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
