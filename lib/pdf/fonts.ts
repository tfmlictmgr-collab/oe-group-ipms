import path from "node:path";
import { Font } from "@react-pdf/renderer";

// ⚠️ The built-in PDF fonts (Helvetica, Courier) have no ₦ glyph, and react-pdf
// also drops £ and €: a receipt for ₦250,000 printed "�250,000.00" (measured
// 9 Oct 2026 by extracting the text of a rendered page; only "$" survived).
//
// DejaVu Sans covers every currency symbol this build issues. It is used as a
// FALLBACK family, not a replacement: `fontFamily: PDF_FONT` keeps Helvetica for
// every glyph Helvetica has and takes only the missing ones from DejaVu, so the
// documents look exactly as before apart from the symbol now being there.
//
// The files ship under lib/pdf/fonts (licence alongside) and are listed in
// next.config's `outputFileTracingIncludes`: the path is assembled at runtime,
// which the serverless file tracer does not follow (the 5 Aug incident).
const DIR = path.join(process.cwd(), "lib", "pdf", "fonts");

let registered = false;
export function registerPdfFonts(): void {
  if (registered) return;
  Font.register({
    family: "DejaVuSans",
    fonts: [
      { src: path.join(DIR, "DejaVuSans.ttf") },
      { src: path.join(DIR, "DejaVuSans-Bold.ttf"), fontWeight: 700 },
    ],
  });
  registered = true;
}

/** Helvetica first, DejaVu Sans for the glyphs Helvetica lacks (₦, £, €). */
export const PDF_FONT = ["Helvetica", "DejaVuSans"];
