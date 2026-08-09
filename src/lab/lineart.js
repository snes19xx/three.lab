// Line art panel: runs the hidden-line engine on the current view, previews
// the result, and exports it as SVG or as plotter instructions.

import { chainSegments, simplifyCollinear } from "./hlr/chain.js";
import { computeLineArt } from "./hlr/index.js";
import { estimatePlotLength, toGCode, toHPGL, toSVG } from "./hlr/output.js";
import { PRINT_DPI, printSize, renderPNG } from "./hlr/raster.js";
import { camera, renderer } from "./scene.js";
import { state } from "./state.js";

const $ = (id) => document.getElementById(id);

// Preview resolution.
const EXPORT_WIDTH = 1920;

let current = null; // last computed { polylines, width, height, ... }
let computing = false;

const options = {
  includeSilhouette: true,
  includeCrease: true,
  includeBoundary: true,
  includeMaterial: true,
  creaseAngleDeg: 25,
  strokeWidth: 0.8,
};

export function initLineArt({ onToast }) {
  const toast = onToast || (() => {});

  const open = () => {
    if (!state.currentModel) {
      toast("Load a model first", "warn");
      return;
    }
    $("lineArtOverlay").hidden = false;
    compute(toast);
  };

  const close = () => {
    $("lineArtOverlay").hidden = true;
  };

  $("btnLineArt")?.addEventListener("click", open);
  $("btnLineArtClose")?.addEventListener("click", close);
  $("lineArtOverlay")?.addEventListener("click", (e) => {
    if (e.target.id === "lineArtOverlay") close();
  });
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !$("lineArtOverlay").hidden) close();
  });

  $("btnLineArtRecompute")?.addEventListener("click", () => compute(toast));

  // Toggling which edges are drawn is cheap enough to recompute immediately.
  const bind = (id, key) =>
    $(id)?.addEventListener("change", (e) => {
      options[key] = e.target.checked;
      compute(toast);
    });
  bind("laSilhouette", "includeSilhouette");
  bind("laCrease", "includeCrease");
  bind("laBoundary", "includeBoundary");
  bind("laMaterial", "includeMaterial");

  $("laCreaseAngle")?.addEventListener("input", (e) => {
    options.creaseAngleDeg = parseInt(e.target.value, 10);
    $("valLaCreaseAngle").textContent = options.creaseAngleDeg + "°";
  });
  $("laCreaseAngle")?.addEventListener("change", () => compute(toast));

  // Line weight is a pure restyle: no need to redo the geometry.
  $("laWeight")?.addEventListener("input", (e) => {
    options.strokeWidth = parseFloat(e.target.value);
    $("valLaWeight").textContent = options.strokeWidth.toFixed(1);
    if (current) paintPreview();
  });

  $("btnLineArtSVG")?.addEventListener("click", () => {
    if (!current) return;
    download(
      toSVG(current, { stroke: "#111111", strokeWidth: options.strokeWidth }),
      "image/svg+xml;charset=utf-8",
      "lineart.svg",
    );
    toast("SVG saved", "accent");
  });

  $("btnLineArtPNG")?.addEventListener("click", async () => {
    if (!current) return;
    const button = $("btnLineArtPNG");
    const label = button.textContent;
    button.disabled = true;
    button.textContent = "Rendering…";
    try {
      const result = await renderPNG(current, {
        dpi: PRINT_DPI,
        strokeWidth: options.strokeWidth,
      });
      downloadBlob(result.blob, "lineart-600dpi.png");
      toast(
        result.reduced
          ? `PNG saved at ${result.dpi} dpi — ${PRINT_DPI} exceeded this browser's canvas limit`
          : `PNG saved · ${result.pixelWidth}×${result.pixelHeight} at ${result.dpi} dpi`,
        result.reduced ? "warn" : "accent",
      );
    } catch (err) {
      console.error("PNG export failed:", err);
      toast("PNG export failed: " + err.message, "warn");
    } finally {
      button.disabled = false;
      button.textContent = label;
    }
  });

  $("btnLineArtHPGL")?.addEventListener("click", () => {
    if (!current) return;
    download(toHPGL(current), "text/plain;charset=utf-8", "lineart.hpgl");
    toast("HPGL saved", "accent");
  });

  $("btnLineArtGCode")?.addEventListener("click", () => {
    if (!current) return;
    download(toGCode(current), "text/plain;charset=utf-8", "lineart.gcode");
    toast("G-code saved", "accent");
  });
}

function compute(toast) {
  if (computing || !state.currentModel) return;
  computing = true;

  const placeholder = $("lineArtPlaceholder");
  if (placeholder) {
    placeholder.hidden = false;
    placeholder.textContent = "Computing…";
  }

  // Match the viewport's aspect so the drawing frames like what you see.
  const canvas = renderer.domElement;
  const aspect =
    camera.aspect || (canvas.height ? canvas.width / canvas.height : 16 / 9);
  const width = EXPORT_WIDTH;
  const height = Math.round(EXPORT_WIDTH / aspect);

  // Yield first so the panel paints before we block the main thread.
  requestAnimationFrame(() => {
    setTimeout(() => {
      const started = performance.now();
      try {
        const raw = computeLineArt({
          root: state.currentModel,
          camera,
          width,
          height,
          options,
        });

        if (!raw || !raw.polylines.length) {
          current = null;
          if (placeholder)
            placeholder.textContent = "Nothing visible from here";
          showStats(null);
          return;
        }

        const chained = simplifyCollinear(chainSegments(raw.polylines));
        current = { ...raw, polylines: chained };

        paintPreview();
        showStats({
          ...raw,
          chained: chained.length,
          ms: performance.now() - started,
        });
        if (placeholder) placeholder.hidden = true;
      } catch (err) {
        console.error("Line art failed:", err);
        current = null;
        if (placeholder) placeholder.textContent = "Failed — see console";
        toast("Line art failed: " + err.message, "warn");
      } finally {
        computing = false;
      }
    }, 0);
  });
}

function paintPreview() {
  const host = $("lineArtPreview");
  const placeholder = $("lineArtPlaceholder");
  if (!host || !current) return;

  const svg = toSVG(current, {
    stroke: "currentColor",
    strokeWidth: options.strokeWidth,
  });

  host.innerHTML = "";
  if (placeholder) {
    placeholder.hidden = true;
    host.appendChild(placeholder);
  }
  const wrap = document.createElement("div");
  wrap.className = "lineart-svg";
  wrap.innerHTML = svg;
  host.appendChild(wrap);
}

function showStats(info) {
  const el = $("lineArtStats");
  if (!el) return;
  if (!info) {
    el.innerHTML = "";
    return;
  }

  const plotMetres = estimatePlotLength(current) / 1000;
  const print = printSize(current);
  const rows = [
    ["Triangles", info.triangleCount.toLocaleString()],
    ["Candidate edges", info.candidateEdges.toLocaleString()],
    ["Visible pieces", info.polylines.length.toLocaleString()],
    ["Chained paths", info.chained.toLocaleString()],
    ["Pen path (A4)", plotMetres.toFixed(1) + " m"],
    ["PNG @ 600dpi", `${print.pixelWidth}×${print.pixelHeight}`],
    ["Computed in", Math.round(info.ms) + " ms"],
  ];
  el.innerHTML = rows
    .map(
      ([k, v]) => `<div class="row"><span>${k}</span><span>${v}</span></div>`,
    )
    .join("");
}

function download(text, mime, filename) {
  downloadBlob(new Blob([text], { type: mime }), filename);
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
