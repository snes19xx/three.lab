// City page wiring: pick an extent on the map, pull it from Overpass, extrude
// it, and hand the resulting GLB to the Lab or the Editor.

import { GLTFExporter } from "three/addons/exporters/GLTFExporter.js";
import { putHandoff } from "../shared/handoff.js";
import {
  initialThemeIsDark,
  storeTheme,
  watchSystemTheme,
} from "../shared/theme.js";
import { buildCity } from "./build.js";
import { bboxAreaKm2, bboxSpanMetres, EARTH_R } from "./geo.js";
import {
  countElements,
  fetchArea,
  geocode,
  LAYERS,
  tileBbox,
} from "./overpass.js";

const $ = (id) => document.getElementById(id);
const toastWrap = $("toastWrap");
const AREA_WARN_KM2 = 4;

const state = {
  sizeMetres: 800,
  heightScale: 1,
  minArea: 0,
  includeGround: true,
  layers: new Set(["buildings", "roads", "water", "green"]),
  placeName: "",
  glb: null, // { name, buffer }
  busy: false,
  abort: null,
};

//  THEME (shared with the Lab and Editor; OS preference unless toggled)
function applyTheme(isDark) {
  document.body.classList.toggle("dark", isDark);
  $("themeLabel").textContent = isDark ? "Light mode" : "Dark mode";
}

applyTheme(initialThemeIsDark());

$("btnLightMode").addEventListener("click", () => {
  const next = !document.body.classList.contains("dark");
  applyTheme(next);
  storeTheme(next); // only an explicit toggle pins the theme
});

// Until the user picks a side, follow the OS live.
watchSystemTheme(applyTheme);

//  MAP
const map = L.map("map", {
  center: [40.7128, -74.006],
  zoom: 15,
  zoomControl: true,
  attributionControl: true,
});

L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19,
  attribution: "© OpenStreetMap",
}).addTo(map);

const extentRect = L.rectangle(
  [
    [0, 0],
    [0, 0],
  ],
  { className: "extent-rect", interactive: false },
).addTo(map);

// The extent is always a square of `sizeMetres` centred on the map centre
// aim it by panning, which keeps the interaction to one slider and a drag.
function currentBbox() {
  const c = map.getCenter();
  const half = state.sizeMetres / 2;
  const dLat = half / (EARTH_R * (Math.PI / 180));
  const dLon = dLat / Math.max(0.01, Math.cos(c.lat * (Math.PI / 180)));
  return {
    south: c.lat - dLat,
    north: c.lat + dLat,
    west: c.lng - dLon,
    east: c.lng + dLon,
  };
}

function updateExtent() {
  const bbox = currentBbox();
  extentRect.setBounds([
    [bbox.south, bbox.west],
    [bbox.north, bbox.east],
  ]);

  const area = bboxAreaKm2(bbox);
  const span = bboxSpanMetres(bbox);
  const tiles = tileBbox(bbox).length;
  const readout = $("extentReadout");
  readout.textContent =
    `${area.toFixed(3)} km² · ${Math.round(span.width)}×${Math.round(span.depth)} m` +
    (tiles > 1 ? ` · ${tiles} tiles` : " · 1 request") +
    `\n${bbox.south.toFixed(4)}, ${bbox.west.toFixed(4)}`;
  readout.classList.toggle("warn", area > AREA_WARN_KM2);

  const c = map.getCenter();
  $("subject-name").textContent =
    state.placeName || `${c.lat.toFixed(4)}, ${c.lng.toFixed(4)}`;
  $("subject-name").classList.remove("placeholder");
}

map.on("move zoom", updateExtent);
map.on("mousemove", (e) => {
  const el = $("cursor-coords");
  const { lat, lng } = e.latlng;
  el.textContent =
    `${Math.abs(lat).toFixed(4)}° ${lat >= 0 ? "N" : "S"}  ` +
    `${Math.abs(lng).toFixed(4)}° ${lng >= 0 ? "E" : "W"}`;
  el.classList.add("active");
});
map.on("mouseout", () => {
  $("cursor-coords").textContent = "— lat   — lon";
  $("cursor-coords").classList.remove("active");
});

// Leaflet needs a nudge once the panel has settled its layout.
requestAnimationFrame(() => {
  map.invalidateSize();
  updateExtent();
});

//  SLIDERS
$("extentSize").addEventListener("input", (e) => {
  state.sizeMetres = parseInt(e.target.value, 10);
  $("valExtentSize").textContent =
    state.sizeMetres >= 1000
      ? (state.sizeMetres / 1000).toFixed(2) + "km"
      : state.sizeMetres + "m";
  updateExtent();
});

$("heightScale").addEventListener("input", (e) => {
  state.heightScale = parseFloat(e.target.value);
  $("valHeightScale").textContent = state.heightScale.toFixed(2);
});

$("minArea").addEventListener("input", (e) => {
  state.minArea = parseInt(e.target.value, 10);
  $("valMinArea").textContent =
    state.minArea === 0 ? "off" : state.minArea + "m²";
});

$("optGround").addEventListener("change", (e) => {
  state.includeGround = e.target.checked;
});

//  LAYERS
const layerList = $("layerList");
for (const [key, def] of Object.entries(LAYERS)) {
  const label = document.createElement("label");
  label.className = "check-row";
  label.innerHTML =
    `<input type="checkbox" value="${key}" ${state.layers.has(key) ? "checked" : ""} />` +
    `<span>${def.label}</span>`;
  label.querySelector("input").addEventListener("change", (e) => {
    if (e.target.checked) state.layers.add(key);
    else state.layers.delete(key);
  });
  layerList.appendChild(label);
}

//  SEARCH
let searchAbort = null;

async function runSearch() {
  const text = $("searchInput").value.trim();
  if (!text) return;

  searchAbort?.abort();
  searchAbort = new AbortController();
  const results = $("searchResults");
  results.innerHTML = "<li>Searching…</li>";

  try {
    const rows = await geocode(text, { signal: searchAbort.signal });
    results.innerHTML = "";
    if (!rows.length) {
      results.innerHTML = "<li>No matches</li>";
      return;
    }
    for (const row of rows) {
      const li = document.createElement("li");
      li.textContent = row.name;
      li.addEventListener("click", () => {
        state.placeName = row.name.split(",")[0];
        map.setView([row.lat, row.lon], 16);
        results.innerHTML = "";
        $("searchInput").value = "";
        updateExtent();
      });
      results.appendChild(li);
    }
  } catch (err) {
    if (err.name === "AbortError") return;
    results.innerHTML = "";
    toast("Search failed: " + err.message, "warn");
  }
}

$("btnSearch").addEventListener("click", runSearch);
$("searchInput").addEventListener("keydown", (e) => {
  if (e.key === "Enter") runSearch();
});

//  PROGRESS
// Progress is shown in two places at once: a bar docked to the panel footer
// (always on screen, never scrolled away) and a card over the map (impossible
// to miss). Overpass can legitimately take a bit
let phaseText = "";
let detailText = "";
let startedAt = 0;
let tickTimer = null;

function paintElapsed() {
  const secs = Math.round((Date.now() - startedAt) / 1000);
  const elapsed =
    secs < 60 ? `${secs}s` : `${Math.floor(secs / 60)}m ${secs % 60}s`;
  $("workElapsed").textContent = elapsed;
  $("progressLabel").textContent = `${phaseText} · ${elapsed}`;
}

// `fraction` of null means "no meaningful percentage"
function setProgress(fraction, phase, detail = "") {
  phaseText = phase;
  detailText = detail;

  $("progressWrap").classList.add("visible");
  $("workPhase").textContent = phase;
  $("workDetail").textContent = detail;

  const indeterminate = fraction == null;
  $("workBarWrap").classList.toggle("indeterminate", indeterminate);
  if (!indeterminate) {
    const pct = Math.round(Math.min(1, Math.max(0, fraction)) * 100) + "%";
    $("progressFill").style.width = pct;
    $("workFill").style.width = pct;
  }
  paintElapsed();
}

function clearProgress() {
  $("progressWrap").classList.remove("visible");
  $("progressFill").style.width = "0";
  $("workFill").style.width = "0";
}

function setBusy(busy) {
  state.busy = busy;
  $("btnEstimate").disabled = busy;
  $("btnBuild").hidden = busy;
  $("btnCancel").hidden = !busy;
  $("workOverlay").hidden = !busy;

  clearInterval(tickTimer);
  if (busy) {
    startedAt = Date.now();
    tickTimer = setInterval(paintElapsed, 1000);
    state.abort = new AbortController();
  } else {
    state.abort = null;
  }
}

function cancelWork() {
  state.abort?.abort();
  setProgress(null, "Cancelling…", "");
}
$("btnCancel").addEventListener("click", cancelWork);
$("btnCancelOverlay").addEventListener("click", cancelWork);

// Esc is the reflex for "make this stop".
window.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && state.busy) cancelWork();
});

// True when a caught error is just the user hitting cancel.
const isCancel = (err) => err?.name === "AbortError";

// Lets the progress bar actually paint between synchronous build phases.
const yieldToPaint = () =>
  new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));

//  ESTIMATE
$("btnEstimate").addEventListener("click", async () => {
  if (state.busy) return;
  const layers = [...state.layers];
  if (!layers.length) return toast("Pick at least one layer", "warn");

  const bbox = currentBbox();
  setBusy(true);
  setProgress(null, "Counting elements", "");
  try {
    const counts = await countElements(bbox, layers, {
      signal: state.abort.signal,
      onProgress: (f, msg) => setProgress(f, "Counting elements", msg),
    });
    const prefix = counts.approximate ? "≈" : "";
    showStats([
      ["Area", bboxAreaKm2(bbox).toFixed(3) + " km²"],
      ["Requests", String(counts.tiles)],
      ["Elements", prefix + counts.total.toLocaleString()],
      ["Ways", prefix + counts.ways.toLocaleString()],
      ["Relations", prefix + counts.relations.toLocaleString()],
    ]);
    toast(
      `${prefix}${counts.total.toLocaleString()} elements in extent`,
      "accent",
    );
  } catch (err) {
    if (!isCancel(err)) showError(err.message);
  } finally {
    clearProgress();
    setBusy(false);
  }
});

//  BUILD
$("btnBuild").addEventListener("click", async () => {
  if (state.busy) return;
  const layers = [...state.layers];
  if (!layers.length) return toast("Pick at least one layer", "warn");

  const bbox = currentBbox();
  setBusy(true);
  $("resultCard").hidden = true;
  state.glb = null;

  try {
    // The network fetch dominates wall-clock time, so it owns most of the bar.
    setProgress(null, "Querying OpenStreetMap", "contacting server…");
    const elements = await fetchArea(bbox, layers, {
      signal: state.abort.signal,
      onProgress: (f, msg) =>
        setProgress(0.02 + f * 0.68, "Querying OpenStreetMap", msg),
    });

    if (!elements.length) {
      showError("Nothing mapped in this extent — try somewhere denser");
      return;
    }

    setProgress(
      0.72,
      "Building geometry",
      `${elements.length.toLocaleString()} elements`,
    );
    await yieldToPaint();

    const group = buildCity(
      elements,
      bbox,
      {
        includeGround: state.includeGround,
        heightScale: state.heightScale,
        minBuildingArea: state.minArea,
      },
      (fraction, label) =>
        setProgress(0.72 + fraction * 0.16, "Building geometry", label),
    );

    const info = group.userData.city;
    if (!info.triangles) {
      showError("Extract produced no geometry");
      return;
    }

    setProgress(
      0.9,
      "Encoding GLB",
      `${Math.round(info.triangles).toLocaleString()} triangles`,
    );
    await yieldToPaint();
    const buffer = await exportGLB(group);
    disposeGroup(group);

    state.glb = { name: fileNameFor(bbox), buffer };
    setProgress(1, "Done", "");

    const rows = [
      ["Buildings", info.buildings.toLocaleString()],
      ["Roads", info.roads.toLocaleString()],
      ["Water / green", `${info.water} / ${info.green}`],
      ["Triangles", Math.round(info.triangles).toLocaleString()],
      ["GLB size", formatBytes(buffer.byteLength)],
    ];
    showStats(rows);
    showResult(rows);
    toast(`${info.buildings.toLocaleString()} buildings extruded`, "accent");
  } catch (err) {
    if (isCancel(err)) {
      toast("Build cancelled");
    } else {
      console.error(err);
      showError(err.message || String(err));
    }
  } finally {
    setBusy(false);
    setTimeout(clearProgress, 900);
  }
});

//  RESULT CARD
function showResult(rows) {
  $("resultTitle").textContent = state.placeName || "City built";
  $("resultGrid").innerHTML = rows
    .map(
      ([k, v]) => `<div class="row"><span>${k}</span><span>${v}</span></div>`,
    )
    .join("");
  $("resultCard").hidden = false;
}

$("btnResultClose").addEventListener("click", () => {
  $("resultCard").hidden = true;
});

function exportGLB(object) {
  return new Promise((resolve, reject) => {
    new GLTFExporter().parse(
      object,
      (result) => resolve(result),
      (err) =>
        reject(err instanceof Error ? err : new Error("GLB export failed")),
      { binary: true },
    );
  });
}

function disposeGroup(group) {
  group.traverse((child) => {
    child.geometry?.dispose();
    child.material?.dispose();
  });
}

function fileNameFor(bbox) {
  const slug = (state.placeName || "city")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);
  const c = {
    lat: (bbox.north + bbox.south) / 2,
    lon: (bbox.east + bbox.west) / 2,
  };
  return `${slug || "city"}_${c.lat.toFixed(4)}_${c.lon.toFixed(4)}_${state.sizeMetres}m.glb`;
}

//  RESULT ACTIONS
async function handOff(slot, destination) {
  if (!state.glb) return;
  try {
    await putHandoff(slot, {
      name: state.glb.name,
      buffer: state.glb.buffer.slice(0),
    });
    location.href = destination;
  } catch (err) {
    console.error(err);
    toast("Hand-off failed", "warn");
  }
}

$("btnToLab").addEventListener("click", () => handOff("toLab", "lab.html"));
$("btnToEditor").addEventListener("click", () =>
  handOff("toEditor", "editor.html"),
);

$("btnDownload").addEventListener("click", () => {
  if (!state.glb) return;
  const blob = new Blob([state.glb.buffer], { type: "model/gltf-binary" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = state.glb.name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});

//  STATS / ERRORS
function showStats(rows) {
  const el = $("buildStats");
  el.classList.remove("empty", "error");
  el.innerHTML = rows
    .map(
      ([k, v]) => `<div class="row"><span>${k}</span><span>${v}</span></div>`,
    )
    .join("");
}

function showError(message) {
  const el = $("buildStats");
  el.classList.remove("empty");
  el.classList.add("error");
  el.textContent = message;
  toast(message, "warn");
}

function formatBytes(n) {
  if (n < 1024) return n + " B";
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
  return (n / (1024 * 1024)).toFixed(2) + " MB";
}

//  TOAST
function toast(msg, kind = "") {
  const el = document.createElement("div");
  el.className = "toast " + kind;
  el.textContent = msg;
  toastWrap.appendChild(el);
  requestAnimationFrame(() => el.classList.add("show"));
  setTimeout(() => {
    el.classList.remove("show");
    setTimeout(() => el.remove(), 200);
  }, 3000);
}
