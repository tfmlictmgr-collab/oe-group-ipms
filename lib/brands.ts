import { normalizeWhatsAppNumber } from "@/lib/whatsapp-link";
import { normalizeTelegramUsername } from "@/lib/telegram-link";

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
  // No-code branding (0015): all optional, all admin-editable.
  logoUrl: string | null;
  portalName: string;
  tagline: string | null;
  supportEmail: string | null;
  supportPhone: string | null;
  // E.164 without '+', for building wa.me links. Distinct from supportPhone:
  // that is a number to call, this one is only ever tapped (0146).
  whatsappNumber: string | null;
  // Bot username without '@', for building t.me links (0147). The public half
  // of the bot's identity — the token stays in channel_routes.
  telegramBotUsername: string | null;
  loginHeadline: string;
};

export const DEFAULT_PORTAL_NAME = "FM / PM Portal";
export const DEFAULT_LOGIN_HEADLINE =
  "Facilities and property management, unified.";

// The hard-coded brand palettes. The no-code fields (logo, copy) are not part
// of a brand default — they are filled in by withDefaults() below.
type BaseBrand = Omit<
  BrandTheme,
  | "logoUrl"
  | "portalName"
  | "tagline"
  | "supportEmail"
  | "supportPhone"
  | "whatsappNumber"
  | "telegramBotUsername"
  | "loginHeadline"
>;

const BASE_THEMES: Record<DeliveryBrand, BaseBrand> = {
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
  logo_url?: string | null;
  portal_name?: string | null;
  tagline?: string | null;
  support_email?: string | null;
  support_phone?: string | null;
  whatsapp_number?: string | null;
  telegram_bot_username?: string | null;
  login_headline?: string | null;
};

function normalizeBrand(brand: string | null | undefined): DeliveryBrand {
  return brand === "TFML" || brand === "OEA" || brand === "direct" ? brand : "direct";
}

// Fills the no-code branding fields with their product defaults.
function withDefaults(base: BaseBrand): BrandTheme {
  return {
    ...base,
    logoUrl: null,
    portalName: DEFAULT_PORTAL_NAME,
    tagline: null,
    supportEmail: null,
    supportPhone: null,
    whatsappNumber: null,
    telegramBotUsername: null,
    loginHeadline: DEFAULT_LOGIN_HEADLINE,
  };
}

// Accepts a hex colour or returns the fallback. Guards the CSS var against junk.
function safeHex(value: string | null | undefined, fallback: string): string {
  if (value && /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(value.trim())) return value.trim();
  return fallback;
}

// Only ever render a logo we host. Blocks a stored value pointing at an
// arbitrary third-party (or javascript:) URL from being injected into <img src>.
function safeLogoUrl(value: string | null | undefined): string | null {
  const v = value?.trim();
  if (!v) return null;
  const base = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (base && v.startsWith(`${base}/storage/v1/object/public/org-logos/`)) return v;
  return null;
}

export function getBrandTheme(
  brand: string | null | undefined,
  overrides?: BrandOverrides | null
): BrandTheme {
  const base = withDefaults(BASE_THEMES[normalizeBrand(brand)]);
  if (!overrides) return base;
  return {
    ...base,
    name: overrides.name?.trim() || base.name,
    primary: safeHex(overrides.theme_primary, base.primary),
    accent: safeHex(overrides.theme_accent, base.accent),
    logoText: overrides.theme_logo_text?.trim()?.slice(0, 2) || base.logoText,
    logoUrl: safeLogoUrl(overrides.logo_url),
    portalName: overrides.portal_name?.trim() || base.portalName,
    tagline: overrides.tagline?.trim() || null,
    supportEmail: overrides.support_email?.trim() || null,
    supportPhone: overrides.support_phone?.trim() || null,
    // Normalised on the way out as well as the way in. The DB constraint (0146)
    // already guarantees the shape, but this value gets interpolated into a URL
    // handed to a user, and re-checking at the boundary costs nothing — same
    // reason safeLogoUrl exists above rather than trusting the stored string.
    whatsappNumber: normalizeWhatsAppNumber(overrides.whatsapp_number),
    telegramBotUsername: normalizeTelegramUsername(overrides.telegram_bot_username),
    loginHeadline: overrides.login_headline?.trim() || base.loginHeadline,
  };
}

// Base palette used by the Settings preview to show "reset to brand default".
export function getBaseTheme(brand: string | null | undefined): BrandTheme {
  return withDefaults(BASE_THEMES[normalizeBrand(brand)]);
}

// Kept for backwards compatibility with any existing import.
export const BRAND_THEMES = BASE_THEMES;
