export function formatNaira(n: number | string | null | undefined): string {
  if (n == null) return "—";
  return (
    "₦" +
    Number(n).toLocaleString("en-NG", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })
  );
}
