// Brand tokens per CLAUDE.md B2. The org's `delivery_brand` selects the theme
// so one portal renders under either brand (or a neutral OE Group default).
export type DeliveryBrand = "TFML" | "OEA" | "direct";

export type BrandTheme = {
  name: string;
  primary: string;
  primaryForeground: string;
  accent: string;
  surface: string;
};

export const BRAND_THEMES: Record<DeliveryBrand, BrandTheme> = {
  TFML: {
    name: "Total Facilities Management",
    primary: "#003366", // navy
    primaryForeground: "#ffffff",
    accent: "#2E7D32", // green
    surface: "#f4f7fa",
  },
  OEA: {
    name: "Ora Egbunike & Associates",
    primary: "#D92323", // red
    primaryForeground: "#ffffff",
    accent: "#1A1A2E", // charcoal
    surface: "#faf6f0", // cream
  },
  direct: {
    name: "OE Group",
    primary: "#1A1A2E", // charcoal
    primaryForeground: "#ffffff",
    accent: "#C9A227", // gold-ish neutral
    surface: "#f5f5f7",
  },
};

export function getBrandTheme(brand: string | null | undefined): BrandTheme {
  if (brand === "TFML" || brand === "OEA" || brand === "direct") {
    return BRAND_THEMES[brand];
  }
  return BRAND_THEMES.direct;
}
