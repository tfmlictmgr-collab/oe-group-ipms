// Shared style for the OEA UAT decks.
//
// Palette is OEA's own — the audience is OEA staff signing into oeaportal.com,
// so the deck wears their brand rather than the platform's navy/amber.
const React = require("react");
const ReactDOMServer = require("react-dom/server");
const sharp = require("sharp");

const CHARCOAL = "1A1A2E";
const CHARCOAL_DEEP = "121220";
const RED = "D92323";
const RED_DEEP = "A81A1A";
const RED_SOFT = "FBE9E9";
const PAPER = "FFFFFF";
const CREAM = "FBF7F2";
const INK = "1F2229";
const INK_SOFT = "5C616E";
const LINE = "E8E2DA";
const OK = "1E7B4D";
const OK_SOFT = "E6F3EB";
const MIST = "EFEFF4";

const TITLE_FONT = "Cambria";
const BODY_FONT = "Calibri";

const W = 13.333;
const H = 7.5;

async function iconPng(IconComp, color, size = 256) {
  const svg = ReactDOMServer.renderToStaticMarkup(
    React.createElement(IconComp, { color: `#${color}`, size })
  );
  const buf = await sharp(Buffer.from(svg)).resize(size, size).png().toBuffer();
  return "image/png;base64," + buf.toString("base64");
}

function helpers(pres) {
  const api = {
    darkBg(s) { s.background = { color: CHARCOAL_DEEP }; },
    lightBg(s) { s.background = { color: PAPER }; },
    creamBg(s) { s.background = { color: CREAM }; },

    pageNum(s, n) {
      s.addText(String(n).padStart(2, "0"), {
        x: W - 0.95, y: H - 0.55, w: 0.6, h: 0.35,
        fontFace: BODY_FONT, fontSize: 10, color: INK_SOFT, align: "right", margin: 0,
      });
    },

    kicker(s, text, opts = {}) {
      s.addText(String(text).toUpperCase(), {
        x: opts.x ?? 0.7, y: opts.y ?? 0.5, w: opts.w ?? 11.5, h: 0.32,
        fontFace: BODY_FONT, fontSize: 11.5, bold: true,
        color: opts.color ?? RED_DEEP, charSpacing: 2, margin: 0,
      });
    },

    title(s, text, opts = {}) {
      s.addText(text, {
        x: opts.x ?? 0.7, y: opts.y ?? 0.88, w: opts.w ?? 11.9, h: opts.h ?? 0.8,
        fontFace: TITLE_FONT, fontSize: opts.size ?? 32, bold: true,
        color: opts.color ?? INK, align: "left", margin: 0,
      });
    },

    lede(s, text, opts = {}) {
      s.addText(text, {
        x: opts.x ?? 0.7, y: opts.y ?? 1.68, w: opts.w ?? 11.3, h: opts.h ?? 0.5,
        fontFace: BODY_FONT, fontSize: opts.size ?? 14.5, color: opts.color ?? INK_SOFT,
        margin: 0,
      });
    },

    /** A soft card. Never an edge stripe. */
    card(s, x, y, w, h, opts = {}) {
      s.addShape("roundRect", {
        x, y, w, h, rectRadius: 0.08,
        fill: { color: opts.fill ?? CREAM },
        line: { color: opts.line ?? LINE, width: 1 },
      });
    },

    /** Numbered step disc. */
    disc(s, x, y, n, opts = {}) {
      const d = opts.d ?? 0.46;
      s.addShape("ellipse", {
        x, y, w: d, h: d,
        fill: { color: opts.fill ?? RED }, line: { type: "none" },
      });
      s.addText(String(n), {
        x, y, w: d, h: d, fontFace: BODY_FONT, fontSize: opts.size ?? 14, bold: true,
        color: opts.color ?? PAPER, align: "center", valign: "middle", margin: 0,
      });
    },

    /** Small pill label. */
    pill(s, x, y, text, opts = {}) {
      const w = opts.w ?? (0.36 + String(text).length * 0.088);
      s.addShape("roundRect", {
        x, y, w, h: opts.h ?? 0.32, rectRadius: 0.16,
        fill: { color: opts.fill ?? RED_SOFT }, line: { type: "none" },
      });
      s.addText(text, {
        x, y, w, h: opts.h ?? 0.32, fontFace: BODY_FONT, fontSize: opts.size ?? 10,
        bold: true, color: opts.color ?? RED_DEEP, align: "center", valign: "middle", margin: 0,
      });
      return w;
    },

    /** Day divider slide. */
    dayDivider(s, dayNo, heading, sub, bullets) {
      api.darkBg(s);
      s.addShape("ellipse", {
        x: 9.9, y: -2.4, w: 6.6, h: 6.6,
        fill: { color: CHARCOAL, transparency: 30 }, line: { type: "none" },
      });
      s.addShape("ellipse", {
        x: 11.4, y: 4.9, w: 4.2, h: 4.2,
        fill: { color: RED, transparency: 84 }, line: { type: "none" },
      });
      s.addText(`DAY ${dayNo}`, {
        x: 0.9, y: 1.75, w: 6, h: 0.45, fontFace: BODY_FONT, fontSize: 13.5, bold: true,
        color: RED, charSpacing: 3, margin: 0,
      });
      s.addText(heading, {
        x: 0.85, y: 2.25, w: 10.5, h: 1.25, fontFace: TITLE_FONT, fontSize: 46, bold: true,
        color: PAPER, margin: 0,
      });
      s.addText(sub, {
        x: 0.9, y: 3.6, w: 9.5, h: 0.55, fontFace: BODY_FONT, fontSize: 17,
        color: "C9CBD8", italic: true, margin: 0,
      });
      let by = 4.55;
      bullets.forEach((b) => {
        s.addShape("ellipse", { x: 0.95, y: by + 0.12, w: 0.12, h: 0.12, fill: { color: RED }, line: { type: "none" } });
        s.addText(b, {
          x: 1.28, y: by, w: 10, h: 0.38, fontFace: BODY_FONT, fontSize: 13.5,
          color: "E4E5EC", margin: 0, valign: "middle",
        });
        by += 0.46;
      });
    },
  };
  return api;
}

module.exports = {
  CHARCOAL, CHARCOAL_DEEP, RED, RED_DEEP, RED_SOFT, PAPER, CREAM,
  INK, INK_SOFT, LINE, OK, OK_SOFT, MIST,
  TITLE_FONT, BODY_FONT, W, H, iconPng, helpers,
};
