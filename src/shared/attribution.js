///////////////////////////////////////////////////////
// Attribution stamped onto everything the tools export.
///////////////////////////////////////////////////////

export const SITE_URL = "https://snes19xx.github.io/three.lab/";
export const CREDIT = `Generated from ${SITE_URL}`;
export const CREDIT_SHORT = SITE_URL.replace(/^https?:\/\//, "").replace(
  /\/$/,
  "",
);

const FONT_FRACTION = 0.016;
const MIN_FONT_PX = 9;
const MARGIN_FRACTION = 0.6; // of the font size
const CHAR_WIDTH_EM = 0.52;
const USABLE_WIDTH = 0.88;

function fitCredit(width, height, text) {
  const fromShortEdge = Math.max(
    MIN_FONT_PX,
    Math.round(Math.min(width, height) * FONT_FRACTION),
  );
  const sizeFor = (t) =>
    Math.floor((width * USABLE_WIDTH) / (t.length * CHAR_WIDTH_EM));

  if (sizeFor(text) >= MIN_FONT_PX) {
    return { text, size: Math.min(fromShortEdge, sizeFor(text)) };
  }
  if (text !== CREDIT_SHORT && sizeFor(CREDIT_SHORT) >= MIN_FONT_PX) {
    return {
      text: CREDIT_SHORT,
      size: Math.min(fromShortEdge, sizeFor(CREDIT_SHORT)),
    };
  }
  // Smaller than a favicon, but at least legible in a corner of a print.
  return { text: CREDIT_SHORT, size: Math.max(1, sizeFor(CREDIT_SHORT)) };
}

// Screenshots
export function drawCreditOnCanvas(ctx, width, height, options = {}) {
  const { text, size } = fitCredit(width, height, options.text ?? CREDIT);
  const margin = Math.round(size * MARGIN_FRACTION * 2);
  const x = width - margin;
  const y = height - margin;

  const estimatedWidth = text.length * size * CHAR_WIDTH_EM;
  const colour =
    options.colour ??
    contrastInk(
      sampleLuma(ctx, x - estimatedWidth, y - size, estimatedWidth, size * 1.4),
    );

  ctx.save();
  ctx.font = `${size}px "Helvetica Neue", Helvetica, Arial, sans-serif`;
  ctx.textAlign = "right";
  ctx.textBaseline = "alphabetic";
  ctx.shadowColor = colour.startsWith("rgba(255")
    ? "rgba(0,0,0,0.5)"
    : "rgba(255,255,255,0.5)";
  ctx.shadowBlur = Math.max(2, Math.round(size * 0.35));
  ctx.fillStyle = colour;
  ctx.fillText(text, x, y);
  ctx.restore();
}

function sampleLuma(ctx, x, y, w, h) {
  const left = Math.max(0, Math.floor(x));
  const top = Math.max(0, Math.floor(y));
  const width = Math.max(1, Math.floor(w));
  const height = Math.max(1, Math.floor(h));
  let data;
  try {
    data = ctx.getImageData(left, top, width, height).data;
  } catch {
    return null; // cross-origin texture on the canvas
  }
  if (!data.length) return null;

  let total = 0;
  let count = 0;
  for (let i = 0; i < data.length; i += 4 * 16) {
    total +=
      (0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]) / 255;
    count++;
  }
  return count ? total / count : null;
}

function contrastInk(luma) {
  if (luma == null) return "rgba(255,255,255,0.62)";
  return luma > 0.5 ? "rgba(0,0,0,0.55)" : "rgba(255,255,255,0.62)";
}

// Picks a credit colour that reads against the image it is sitting on.
export function creditColourFor(backgroundStyle) {
  const rgb = parseRGB(backgroundStyle);
  if (!rgb) return "rgba(255,255,255,0.62)";
  // Rec. 709 luma.
  const luma = (0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]) / 255;
  return contrastInk(luma);
}

function parseRGB(style) {
  if (typeof style !== "string") return null;
  const fn = style.match(/rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/i);
  if (fn) return [+fn[1], +fn[2], +fn[3]];
  const hex = style.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (!hex) return null;
  let h = hex[1];
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  return [
    parseInt(h.slice(0, 2), 16),
    parseInt(h.slice(2, 4), 16),
    parseInt(h.slice(4, 6), 16),
  ];
}

// Vector output
export function creditSVGMarkup(width, height, options = {}) {
  const { fill = "#666666", opacity = 0.85 } = options;
  const { text, size } = fitCredit(width, height, options.text ?? CREDIT);
  const margin = Math.round(size * MARGIN_FRACTION * 2);
  return (
    `<text x="${round(width - margin)}" y="${round(height - margin)}" ` +
    `text-anchor="end" ` +
    `font-family="Helvetica Neue, Helvetica, Arial, sans-serif" ` +
    `font-size="${size}" fill="${fill}" fill-opacity="${opacity}">` +
    `${escapeXml(text)}</text>`
  );
}

// Generated source
export function creditComment(text = CREDIT) {
  return `// ${text}`;
}

function round(n) {
  return Math.round(n * 100) / 100;
}

function escapeXml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
