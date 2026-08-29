import { Download } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

const TYPES: { type: string; label: string }[] = [
  { type: "staff", label: "Staff" },
  { type: "tenant", label: "Tenants" },
  { type: "vendor", label: "Vendors" },
  { type: "landlord", label: "Landlords / owners" },
];

/**
 * Bulk CSV export, one button per record type. Gated by the caller
 * (`records.export`, 0223) before this ever renders — plain links, not a
 * fetch, so the browser's own download handling carries a large roster on a
 * weak connection the way `/api/training`'s link already does.
 */
export default function RecordDownloads() {
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Download records</CardTitle>
        <CardDescription>
          A CSV roster of this organisation's own records. Nothing here
          crosses an organisation boundary.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-wrap gap-2">
        {TYPES.map((t) => (
          <Button key={t.type} asChild variant="outline" size="sm">
            <a href={`/api/records/export?type=${t.type}`} download>
              <Download className="size-4" /> {t.label}
            </a>
          </Button>
        ))}
      </CardContent>
    </Card>
  );
}
