// Brand tokens per CLAUDE.md B2. The org's `delivery_brand` selects the base
// theme; per-org overrides (set by an org admin in Settings) then win, so a
// client can tune its own colours and monogram without a code change.
export type DeliveryBrand = "TFML" | "OEA" | "direct";

export type BrandTheme = {
  name: string;
  primary: string;
  primaryForeground: string;
  accent: string;
  surface: string;
  logoText: string | null;
};

const BASE_THEMES: Record<DeliveryBrand, BrandTheme> = {
  TFML: {
    name: "Total Facilities Management",
    primary: "#003366", // navy
    primaryForeground: "#ffffff",
    accent: "#2E7D32", // green
    surface: "#f4f7fa",
    logoText: "TF",
  },
  OEA: {
    name: "Ora Egbunike & Associates",
    primary: "#D92323", // red
    primaryForeground: "#ffffff",
    accent: "#1A1A2E", // charcoal
    surface: "#faf6f0", // cream
    logoText: "OE",
  },
  direct: {
    name: "OE Group",
    primary: "#8B1D1D", // dark red — OE Group house colour
    primaryForeground: "#ffffff",
    accent: "#C9A227", // gold
    surface: "#faf7f6",
    logoText: "OE",
  },
};

// Admin-set overrides stored on the org row (all optional).
export type BrandOverrides = {
  name?: string | null;
  theme_primary?: string | null;
  theme_accent?: string | null;
  theme_logo_text?: string | null;
};

function normalizeBrand(brand: string | null | undefined): DeliveryBrand {
  return brand === "TFML" || brand === "OEA" || brand === "direct" ? brand : "direct";
}

// Accepts a hex colour or returns the fallback. Guards the CSS var against junk.
function safeHex(value: string | null | undefined, fallback: string): string {
  if (value && /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(value.trim())) return value.trim();
  return fallback;
}

export function getBrandTheme(
  brand: string | null | undefined,
  overrides?: BrandOverrides | null
): BrandTheme {
  const base = BASE_THEMES[normalizeBrand(brand)];
  if (!overrides) return base;
  return {
    ...base,
    name: overrides.name?.trim() || base.name,
    primary: safeHex(overrides.theme_primary, base.primary),
    accent: safeHex(overrides.theme_accent, base.accent),
    logoText: overrides.theme_logo_text?.trim()?.slice(0, 2) || base.logoText,
  };
}

// Base palette used by the Settings preview to show "reset to brand default".
export function getBaseTheme(brand: string | null | undefined): BrandTheme {
  return BASE_THEMES[normalizeBrand(brand)];
}

// Kept for backwards compatibility with any existing import.
export const BRAND_THEMES = BASE_THEMES;
