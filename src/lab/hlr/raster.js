// Rasterises the line art to a print-resolution PNG.

import { CREDIT, SITE_URL } from "../../shared/attribution.js";
import { toSVG } from "./output.js";

export const PRINT_DPI = 600;
const DEFAULT_LONG_EDGE_MM = 297;
const MM_PER_INCH = 25.4;
const MAX_CANVAS_PIXELS = 100_000_000;

export function printSize(
  lineArt,
  { dpi = PRINT_DPI, longEdgeMM = DEFAULT_LONG_EDGE_MM } = {},
) {
  const aspect = lineArt.width / lineArt.height;
  const longEdgeInches = longEdgeMM / MM_PER_INCH;

  let widthMM;
  let heightMM;
  if (aspect >= 1) {
    widthMM = longEdgeMM;
    heightMM = longEdgeMM / aspect;
  } else {
    heightMM = longEdgeMM;
    widthMM = longEdgeMM * aspect;
  }

  let effectiveDpi = dpi;
  let pixelWidth = Math.round((widthMM / MM_PER_INCH) * effectiveDpi);
  let pixelHeight = Math.round((heightMM / MM_PER_INCH) * effectiveDpi);

  // Back off proportionally if the canvas would be refused.
  if (pixelWidth * pixelHeight > MAX_CANVAS_PIXELS) {
    const factor = Math.sqrt(MAX_CANVAS_PIXELS / (pixelWidth * pixelHeight));
    effectiveDpi = Math.floor(effectiveDpi * factor);
    pixelWidth = Math.round((widthMM / MM_PER_INCH) * effectiveDpi);
    pixelHeight = Math.round((heightMM / MM_PER_INCH) * effectiveDpi);
  }

  return {
    pixelWidth,
    pixelHeight,
    widthMM,
    heightMM,
    dpi: effectiveDpi,
    requestedDpi: dpi,
    reduced: effectiveDpi !== dpi,
    longEdgeInches,
  };
}

export async function renderPNG(lineArt, options = {}) {
  const {
    dpi = PRINT_DPI,
    longEdgeMM = DEFAULT_LONG_EDGE_MM,
    stroke = "#111111",
    strokeWidth = 0.8,
    background = "#ffffff",
  } = options;

  const size = printSize(lineArt, { dpi, longEdgeMM });

  const svg = toSVG(lineArt, {
    stroke,
    strokeWidth,
    background,
    pixelWidth: size.pixelWidth,
    pixelHeight: size.pixelHeight,
  });

  const image = await loadSVGImage(svg);

  const canvas = document.createElement("canvas");
  canvas.width = size.pixelWidth;
  canvas.height = size.pixelHeight;
  if (canvas.width !== size.pixelWidth || canvas.height !== size.pixelHeight) {
    throw new Error("Browser refused a canvas that large");
  }

  const context = canvas.getContext("2d");
  if (!context) throw new Error("Could not get a 2D context");
  if (background) {
    context.fillStyle = background;
    context.fillRect(0, 0, canvas.width, canvas.height);
  }
  context.drawImage(image, 0, 0, canvas.width, canvas.height);

  const blob = await canvasToBlob(canvas);
  if (!blob) throw new Error("Browser could not encode a PNG that large");

  const buffer = await blob.arrayBuffer();
  const withDensity = setPngDensity(new Uint8Array(buffer), size.dpi);

  return { blob: new Blob([withDensity], { type: "image/png" }), ...size };
}

function loadSVGImage(svg) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(
      new Blob([svg], { type: "image/svg+xml;charset=utf-8" }),
    );
    const image = new Image();
    image.onload = () => {
      URL.revokeObjectURL(url);
      resolve(image);
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("Could not rasterise the SVG"));
    };
    image.src = url;
  });
}

function canvasToBlob(canvas) {
  return new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
}

//  PNG pHYs INJECTION

const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

let crcLookup = null;
function crc32(bytes) {
  if (!crcLookup) {
    crcLookup = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcLookup[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    crc = crcLookup[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function writeUint32(view, offset, value) {
  view[offset] = (value >>> 24) & 0xff;
  view[offset + 1] = (value >>> 16) & 0xff;
  view[offset + 2] = (value >>> 8) & 0xff;
  view[offset + 3] = value & 0xff;
}

function readUint32(bytes, offset) {
  return (
    ((bytes[offset] << 24) |
      (bytes[offset + 1] << 16) |
      (bytes[offset + 2] << 8) |
      bytes[offset + 3]) >>>
    0
  );
}

// Builds a pHYs chunk declaring the given DPI, in pixels per metre.
function buildPhysChunk(dpi) {
  const pixelsPerMetre = Math.round(dpi / 0.0254);
  const chunk = new Uint8Array(21); // 4 length + 4 type + 9 data + 4 crc
  writeUint32(chunk, 0, 9);
  chunk[4] = 0x70; // p
  chunk[5] = 0x48; // H
  chunk[6] = 0x59; // Y
  chunk[7] = 0x73; // s
  writeUint32(chunk, 8, pixelsPerMetre);
  writeUint32(chunk, 12, pixelsPerMetre);
  chunk[16] = 1; // unit: metres
  writeUint32(chunk, 17, crc32(chunk.subarray(4, 17)));
  return chunk;
}

// Builds a Latin-1 tEXt chunk. PNG keywords are 1-79 bytes and the keyword and
// text are separated by a single NUL.
function buildTextChunk(keyword, text) {
  const latin1 = (str) =>
    Array.from(String(str), (ch) => {
      const code = ch.codePointAt(0);
      return code < 256 ? code : 63; // "?" :tEXt cannot carry anything wider
    });
  const data = [...latin1(keyword.slice(0, 79)), 0, ...latin1(text)];
  const chunk = new Uint8Array(12 + data.length);
  writeUint32(chunk, 0, data.length);
  chunk[4] = 0x74; // t
  chunk[5] = 0x45; // E
  chunk[6] = 0x58; // X
  chunk[7] = 0x74; // t
  chunk.set(data, 8);
  writeUint32(
    chunk,
    8 + data.length,
    crc32(chunk.subarray(4, 8 + data.length)),
  );
  return chunk;
}

// Rewrites a PNG with the given physical density and the attribution,
// replacing any pHYs or matching tEXt already present. Returns the original
// bytes untouched if it does not look like a PNG.
export function setPngDensity(bytes, dpi) {
  for (let i = 0; i < PNG_SIGNATURE.length; i++) {
    if (bytes[i] !== PNG_SIGNATURE[i]) return bytes;
  }

  const phys = buildPhysChunk(dpi);
  // Machine-readable attribution, so the credit survives a crop of the image.
  const credits = [
    buildTextChunk("Software", "three.lab"),
    buildTextChunk("Source", SITE_URL),
    buildTextChunk("Comment", CREDIT),
  ];
  const before = [];
  const after = [];
  let target = before;

  let offset = 8;
  while (offset + 8 <= bytes.length) {
    const length = readUint32(bytes, offset);
    const type = String.fromCharCode(
      bytes[offset + 4],
      bytes[offset + 5],
      bytes[offset + 6],
      bytes[offset + 7],
    );
    const total = 12 + length;
    const chunk = bytes.subarray(offset, offset + total);

    if (type === "pHYs" || type === "tEXt") {
      // Dropped: the new ones replace them.
    } else {
      target.push(chunk);
      // pHYs must precede the image data, so everything from IDAT on follows.
      if (type === "IHDR") target = after;
    }

    offset += total;
    if (type === "IEND") break;
  }

  const parts = [...before, phys, ...credits, ...after];
  const size = parts.reduce((n, part) => n + part.length, 0);
  const out = new Uint8Array(8 + size);
  out.set(PNG_SIGNATURE, 0);
  let cursor = 8;
  for (const part of parts) {
    out.set(part, cursor);
    cursor += part.length;
  }
  return out;
}
