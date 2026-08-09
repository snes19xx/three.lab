// Serialisers for the finished line art.
//
// SVG is for looking at and for sending to a laser or vinyl cutter; HPGL and
// G-code are for driving a pen plotter directly. All three consume the same
// chained polylines, in screen pixels with y pointing down.

import { creditSVGMarkup } from "../../shared/attribution.js";
import {
  EDGE_BOUNDARY,
  EDGE_CREASE,
  EDGE_MATERIAL,
  EDGE_SILHOUETTE,
} from "./classify.js";

const round = (n, places = 2) => {
  const factor = 10 ** places;
  return Math.round(n * factor) / factor;
};

//  SVG

export function toSVG(lineArt, options = {}) {
  const {
    stroke = "#000000",
    strokeWidth = 1,
    background = null,
    byKind = false,
    kindStyles = {},
    title = "three.lab line art",
    // Rasterisers need the SVG to declare its target pixel size, or they
    // render it at its intrinsic size and scale the bitmap up.
    pixelWidth = null,
    pixelHeight = null,
    // The credit is markup
    credit = true,
  } = options;

  const { polylines, width, height } = lineArt;

  const pathData = (points) => {
    let d = `M${round(points[0])},${round(points[1])}`;
    for (let i = 2; i < points.length; i += 2) {
      d += `L${round(points[i])},${round(points[i + 1])}`;
    }
    return d;
  };

  let body = "";
  if (byKind) {
    // Silhouettes carry the drawing; creases are the detail inside it.
    const buckets = new Map();
    for (const line of polylines) {
      let bucket = buckets.get(line.kind);
      if (!bucket) buckets.set(line.kind, (bucket = []));
      bucket.push(pathData(line.points));
    }
    for (const [kind, paths] of [...buckets].sort((a, b) => a[0] - b[0])) {
      const style = kindStyles[kind] || {};
      const w = style.strokeWidth ?? strokeWidth;
      const c = style.stroke ?? stroke;
      body +=
        `<g class="${kindClassName(kind)}" ` +
        `style="fill:none;stroke:${c};stroke-width:${w};stroke-linecap:round;stroke-linejoin:round">` +
        `<path d="${paths.join("")}"/></g>`;
    }
  } else {
    const paths = polylines.map((line) => pathData(line.points)).join("");
    body =
      `<path d="${paths}" style="fill:none;stroke:${stroke};stroke-width:${strokeWidth};` +
      `stroke-linecap:round;stroke-linejoin:round"/>`;
  }

  const backgroundRect = background
    ? `<rect width="${round(width)}" height="${round(height)}" fill="${background}"/>`
    : "";

  const creditMarkup = credit ? creditSVGMarkup(width, height) : "";

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" version="1.1" ` +
    `width="${round(pixelWidth ?? width)}" height="${round(pixelHeight ?? height)}" ` +
    `viewBox="0 0 ${round(width)} ${round(height)}">` +
    `<title>${escapeXml(title)}</title>` +
    backgroundRect +
    body +
    creditMarkup +
    `</svg>`
  );
}

function kindClassName(kind) {
  const parts = [];
  if (kind & EDGE_SILHOUETTE) parts.push("silhouette");
  if (kind & EDGE_BOUNDARY) parts.push("boundary");
  if (kind & EDGE_CREASE) parts.push("crease");
  if (kind & EDGE_MATERIAL) parts.push("material");
  return parts.join(" ") || "edge";
}

function escapeXml(s) {
  return String(s).replace(
    /[<>&"']/g,
    (c) =>
      ({
        "<": "&lt;",
        ">": "&gt;",
        "&": "&amp;",
        '"': "&quot;",
        "'": "&apos;",
      })[c],
  );
}

//  PLOTTER GEOMETRY

function planePlacement(lineArt, { pageWidthMM, pageHeightMM, marginMM }) {
  const usableW = Math.max(1, pageWidthMM - marginMM * 2);
  const usableH = Math.max(1, pageHeightMM - marginMM * 2);
  const scale = Math.min(usableW / lineArt.width, usableH / lineArt.height);
  const drawnW = lineArt.width * scale;
  const drawnH = lineArt.height * scale;
  const offsetX = marginMM + (usableW - drawnW) / 2;
  const offsetY = marginMM + (usableH - drawnH) / 2;

  return (x, y) => [
    offsetX + x * scale,
    // Flip: screen y grows downward, the page grows upward.
    offsetY + (lineArt.height - y) * scale,
  ];
}

export function orderForPlotter(polylines) {
  if (polylines.length < 2) return polylines.slice();

  const remaining = polylines.slice();
  const ordered = [];
  let x = 0;
  let y = 0;

  while (remaining.length) {
    let best = 0;
    let bestDistance = Infinity;
    let bestReversed = false;

    for (let i = 0; i < remaining.length; i++) {
      const p = remaining[i].points;
      const dStart = (p[0] - x) ** 2 + (p[1] - y) ** 2;
      if (dStart < bestDistance) {
        bestDistance = dStart;
        best = i;
        bestReversed = false;
      }
      const dEnd = (p[p.length - 2] - x) ** 2 + (p[p.length - 1] - y) ** 2;
      if (dEnd < bestDistance) {
        bestDistance = dEnd;
        best = i;
        bestReversed = true;
      }
    }

    const [chosen] = remaining.splice(best, 1);
    const points = bestReversed ? reversePoints(chosen.points) : chosen.points;
    ordered.push({ ...chosen, points });
    x = points[points.length - 2];
    y = points[points.length - 1];
  }

  return ordered;
}

function reversePoints(points) {
  const out = new Array(points.length);
  for (let i = 0, j = points.length - 2; i < points.length; i += 2, j -= 2) {
    out[i] = points[j];
    out[i + 1] = points[j + 1];
  }
  return out;
}

//  HPGL (AxiDraw, Roland, HP pen plotters)

export function toHPGL(lineArt, options = {}) {
  const {
    pageWidthMM = 297, // A4 landscape
    pageHeightMM = 210,
    marginMM = 10,
    pen = 1,
    optimise = true,
  } = options;

  // HPGL plotter units are 1/40 mm.
  const UNITS_PER_MM = 40;
  const place = planePlacement(lineArt, {
    pageWidthMM,
    pageHeightMM,
    marginMM,
  });
  const lines = optimise
    ? orderForPlotter(lineArt.polylines)
    : lineArt.polylines;

  const out = ["IN;", `SP${pen};`];
  for (const line of lines) {
    const p = line.points;
    const [x0, y0] = place(p[0], p[1]);
    out.push(
      `PU${Math.round(x0 * UNITS_PER_MM)},${Math.round(y0 * UNITS_PER_MM)};`,
    );
    const coords = [];
    for (let i = 2; i < p.length; i += 2) {
      const [x, y] = place(p[i], p[i + 1]);
      coords.push(
        `${Math.round(x * UNITS_PER_MM)},${Math.round(y * UNITS_PER_MM)}`,
      );
    }
    if (coords.length) out.push(`PD${coords.join(",")};`);
  }
  out.push("PU;", "SP0;");
  return out.join("\n") + "\n";
}

//  G-CODE (pen holder on a 3-axis machine)

export function toGCode(lineArt, options = {}) {
  const {
    pageWidthMM = 297,
    pageHeightMM = 210,
    marginMM = 10,
    penUpZ = 5,
    penDownZ = 0,
    travelFeed = 3000,
    drawFeed = 1500,
    optimise = true,
  } = options;

  const place = planePlacement(lineArt, {
    pageWidthMM,
    pageHeightMM,
    marginMM,
  });
  const lines = optimise
    ? orderForPlotter(lineArt.polylines)
    : lineArt.polylines;
  const f = (n) => round(n, 3);

  const out = [
    "; three.lab hidden-line export",
    `; ${lines.length} paths`,
    "G21 ; millimetres",
    "G90 ; absolute positioning",
    `G0 Z${f(penUpZ)}`,
    `G0 X0 Y0 F${travelFeed}`,
  ];

  for (const line of lines) {
    const p = line.points;
    const [x0, y0] = place(p[0], p[1]);
    out.push(`G0 Z${f(penUpZ)}`);
    out.push(`G0 X${f(x0)} Y${f(y0)} F${travelFeed}`);
    out.push(`G1 Z${f(penDownZ)} F${drawFeed}`);
    for (let i = 2; i < p.length; i += 2) {
      const [x, y] = place(p[i], p[i + 1]);
      out.push(`G1 X${f(x)} Y${f(y)} F${drawFeed}`);
    }
  }

  out.push(`G0 Z${f(penUpZ)}`, "G0 X0 Y0", "M2");
  return out.join("\n") + "\n";
}

// Total pen-down distance in millimetres
export function estimatePlotLength(lineArt, options = {}) {
  const { pageWidthMM = 297, pageHeightMM = 210, marginMM = 10 } = options;
  const place = planePlacement(lineArt, {
    pageWidthMM,
    pageHeightMM,
    marginMM,
  });

  let drawn = 0;
  for (const line of lineArt.polylines) {
    const p = line.points;
    for (let i = 2; i < p.length; i += 2) {
      const [x0, y0] = place(p[i - 2], p[i - 1]);
      const [x1, y1] = place(p[i], p[i + 1]);
      drawn += Math.hypot(x1 - x0, y1 - y0);
    }
  }
  return drawn;
}
