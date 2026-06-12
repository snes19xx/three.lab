import * as THREE from "three";
import { exportR3F, exportSVG, takeScreenshot } from "./export.js";
import { payloadToFile, putHandoff, takeHandoff } from "../shared/handoff.js";
import { applyLightMode } from "./lighting.js";
import {
  loadGLB,
  loadTexture,
  resetCameraForGLB,
  resetCameraForTexture,
} from "./loaders.js";
import {
  atmosMat,
  atmosSphere,
  BG_DARK,
  BG_LIGHT,
  camera,
  controls,
  graticule,
  northPole,
  renderer,
  scene,
  southPole,
  sphere,
  sphereGroup,
  sphereMat,
} from "./scene.js";
import { state } from "./state.js";
import {
  applyWireframe,
  resetWireframe,
  updateAllWireframeColors,
  updateAllWireframeLinewidths,
} from "./wireframe.js";

const $ = (id) => document.getElementById(id);
const toastWrap = $("toastWrap");

//  THEME (dark / light)
const THEME_KEY = "mt-theme";

function wireframeDefaultColor(isDark) {
  return isDark ? "#ffffff" : "#000000";
}

function setWireframeColor(hex) {
  const inp = $("wireframeColor");
  if (!inp) return;
  inp.value = hex;
  $("wireframeColorHex").textContent = hex;
  if (state.wireframeActive) updateAllWireframeColors();
}

function applyTheme(isDark) {
  state.lightModeActive = !isDark;
  document.body.classList.toggle("dark", isDark);
  scene.background = isDark ? BG_DARK : BG_LIGHT;

  // recolour the default sphere to match theme (only if no texture is loaded)
  if (!sphereMat.map) {
    sphereMat.color.setHex(isDark ? 0x3a3a3a : 0xcfcfcf);
  }

  // Auto-flip wireframe default only when user hasn't picked a custom color
  const currentHex = $("wireframeColor")?.value?.toLowerCase();
  if (currentHex === "#000000" || currentHex === "#ffffff") {
    setWireframeColor(wireframeDefaultColor(isDark));
  }
  const lbl = $("themeLabel");
  if (lbl) lbl.textContent = isDark ? "Light mode" : "Dark mode";
  localStorage.setItem(THEME_KEY, isDark ? "dark" : "light");
}
const savedTheme = localStorage.getItem(THEME_KEY);
applyTheme(savedTheme ? savedTheme === "dark" : true); // default = dark

$("btnLightMode").addEventListener("click", () => {
  applyTheme(!document.body.classList.contains("dark"));
});

//  FILE ROUTING
function routeFile(file) {
  if (!file) return;
  const ext = file.name.split(".").pop().toLowerCase();
  if (ext === "glb" || ext === "gltf") loadGLB(file);
  else loadTexture(file, false);
}

$("primaryInput").addEventListener("change", (e) =>
  routeFile(e.target.files[0]),
);
$("normalInput").addEventListener("change", (e) => {
  if (e.target.files[0]) loadTexture(e.target.files[0], true);
});

const primaryZone = $("primaryZone");
primaryZone.addEventListener("dragover", (e) => {
  e.preventDefault();
  primaryZone.classList.add("drag-over");
});
primaryZone.addEventListener("dragleave", () =>
  primaryZone.classList.remove("drag-over"),
);
primaryZone.addEventListener("drop", (e) => {
  e.preventDefault();
  primaryZone.classList.remove("drag-over");
  routeFile(e.dataTransfer.files[0]);
});

// Document-wide drop too (anywhere)
const canvasEl = $("canvas-container");
canvasEl.addEventListener("dragover", (e) => {
  if (e.dataTransfer?.types?.includes("Files")) e.preventDefault();
});
canvasEl.addEventListener("drop", (e) => {
  if (e.dataTransfer?.files?.length) {
    e.preventDefault();
    routeFile(e.dataTransfer.files[0]);
  }
});

//  WIREFRAME UI
$("btnWireframe").addEventListener("click", () => {
  state.wireframeActive = !state.wireframeActive;
  $("btnWireframe").classList.toggle("active", state.wireframeActive);
  $("wireframeColor").disabled = !state.wireframeActive;
  $("linewidth").disabled = !state.wireframeActive;
  applyWireframe();
});

$("wireframeColor").addEventListener("input", (e) => {
  $("wireframeColorHex").textContent = e.target.value;
  if (state.wireframeActive) updateAllWireframeColors();
});

$("linewidth").addEventListener("input", (e) => {
  state.currentLinewidth = parseFloat(e.target.value);
  $("valLinewidth").textContent = state.currentLinewidth.toFixed(1) + "px";
  if (state.wireframeActive) updateAllWireframeLinewidths();
});

//  LIGHTING
$("lightDirect").addEventListener("click", () => applyLightMode("direct"));
$("lightAmbient").addEventListener("click", () => applyLightMode("ambient"));
$("lightCustom").addEventListener("click", () => applyLightMode("custom"));

[
  ["lightAzimuth", "valLightAzimuth", (v) => v + "°"],
  ["lightElevation", "valLightElevation", (v) => v + "°"],
  ["lightIntensity", "valLightIntensity", (v) => parseFloat(v).toFixed(1)],
].forEach(([id, valId, fmt]) => {
  $(id).addEventListener("input", (e) => {
    $(valId).textContent = fmt(e.target.value);
    applyLightMode("custom");
  });
});

//  ROTATION
$("btnAutoRotate").addEventListener("click", () => {
  state.autoRotate = !state.autoRotate;
  $("btnAutoRotate").classList.toggle("active", state.autoRotate);
});

$("rotSpeed").addEventListener("input", (e) => {
  state.rotSpeed = parseFloat(e.target.value);
  $("valRotSpeed").textContent = state.rotSpeed.toFixed(1) + "×";
});

$("axialTilt").addEventListener("input", (e) => {
  const rad = parseFloat(e.target.value) * (Math.PI / 180);
  sphereGroup.rotation.z = rad;
  if (state.currentModel) state.currentModel.rotation.z = rad;
  $("valAxialTilt").textContent = e.target.value + "°";
});

//  MATERIAL (texture mode)
$("roughness").addEventListener("input", (e) => {
  sphereMat.roughness = parseFloat(e.target.value);
  $("valRoughness").textContent = parseFloat(e.target.value).toFixed(2);
});
$("metalness").addEventListener("input", (e) => {
  sphereMat.metalness = parseFloat(e.target.value);
  $("valMetalness").textContent = parseFloat(e.target.value).toFixed(2);
});
$("normalScale").addEventListener("input", (e) => {
  const v = parseFloat(e.target.value);
  $("valNormalScale").textContent = v.toFixed(2);
  if (sphereMat.normalMap) {
    sphereMat.normalScale.set(v, v);
    sphereMat.needsUpdate = true;
  }
});

//  ATMOSPHERE
$("btnAtmosphere").addEventListener("click", () => {
  atmosSphere.visible = !atmosSphere.visible;
  $("btnAtmosphere").classList.toggle("active", atmosSphere.visible);
});
$("atmosphereColor").addEventListener("input", (e) => {
  atmosMat.uniforms.glowColor.value.setStyle(e.target.value);
  $("atmosphereColorHex").textContent = e.target.value;
});
$("atmosphereIntensity").addEventListener("input", (e) => {
  const v = parseFloat(e.target.value);
  atmosMat.uniforms.intensity.value = v;
  $("valAtmosIntensity").textContent = v.toFixed(2);
});
$("btnGraticule").addEventListener("click", () => {
  graticule.visible = !graticule.visible;
  $("btnGraticule").classList.toggle("active", graticule.visible);
});
$("btnPoles").addEventListener("click", () => {
  const v = !northPole.visible;
  northPole.visible = v;
  southPole.visible = v;
  $("btnPoles").classList.toggle("active", v);
});

//  RESET
function setSlider(id, valId, value, fmt) {
  $(id).value = value;
  $(valId).textContent = fmt(value);
}

$("btnReset").addEventListener("click", () => {
  state.autoRotate = false;
  $("btnAutoRotate").classList.remove("active");

  state.rotSpeed = 1.0;
  setSlider(
    "rotSpeed",
    "valRotSpeed",
    1.0,
    (v) => parseFloat(v).toFixed(1) + "×",
  );
  setSlider("axialTilt", "valAxialTilt", 0, (v) => v + "°");
  sphereGroup.rotation.z = 0;
  if (state.currentModel) state.currentModel.rotation.z = 0;

  if (state.wireframeActive) resetWireframe();
  const wfDefault = wireframeDefaultColor(
    document.body.classList.contains("dark"),
  );
  $("wireframeColor").value = wfDefault;
  $("wireframeColorHex").textContent = wfDefault;
  state.currentLinewidth = 1.0;
  $("linewidth").value = 1.0;
  $("valLinewidth").textContent = "1.0px";

  setSlider("lightAzimuth", "valLightAzimuth", 45, (v) => v + "°");
  setSlider("lightElevation", "valLightElevation", 45, (v) => v + "°");
  setSlider("lightIntensity", "valLightIntensity", 2.5, (v) =>
    parseFloat(v).toFixed(1),
  );
  applyLightMode("direct");

  if (state.appMode === "texture") {
    sphereMat.roughness = 0.8;
    sphereMat.metalness = 0.0;
    setSlider("roughness", "valRoughness", 0.8, (v) =>
      parseFloat(v).toFixed(2),
    );
    setSlider("metalness", "valMetalness", 0.0, (v) =>
      parseFloat(v).toFixed(2),
    );
    setSlider("normalScale", "valNormalScale", 1.0, (v) =>
      parseFloat(v).toFixed(2),
    );
    if (sphereMat.normalMap) {
      sphereMat.normalScale.set(1, 1);
      sphereMat.needsUpdate = true;
    }
    atmosSphere.visible = false;
    $("btnAtmosphere").classList.remove("active");
    graticule.visible = false;
    $("btnGraticule").classList.remove("active");
    northPole.visible = false;
    southPole.visible = false;
    $("btnPoles").classList.remove("active");
    resetCameraForTexture();
  }
  if (state.appMode === "glb" && state.currentModel) {
    resetCameraForGLB();
  }
  toast("Settings reset");
});

//  EXPORTS
$("btnScreenshot").addEventListener("click", () => {
  takeScreenshot();
  toast("Screenshot saved", "accent");
});
$("btnExportSVG").addEventListener("click", exportSVG);
$("btnExportJSX").addEventListener("click", () => exportR3F("jsx"));
$("btnExportTSX").addEventListener("click", () => exportR3F("tsx"));

//
//  HANDOFF: Lab to and from Cropper
//
const btnOpenInEditor = $("btnOpenInEditor");
btnOpenInEditor.addEventListener("click", async (e) => {
  e.preventDefault();
  if (!state.glbOriginalBuffer) {
    toast("Load a GLB to send to Editor", "warn");
    return;
  }
  try {
    await putHandoff("toEditor", {
      name: state.glbOriginalName,
      buffer: state.glbOriginalBuffer.slice(0),
    });
    location.href = "editor.html";
  } catch (err) {
    console.error(err);
    toast("Hand-off failed", "warn");
  }
});

// Set when an incoming model asked to be shown as a wireframe; consumed once
// the model finishes loading (see __labOnSubjectLoaded).
let pendingWireframe = false;

function enableWireframeDefaults() {
  state.wireframeActive = true;
  $("btnWireframe").classList.add("active");
  $("wireframeColor").disabled = false;
  $("linewidth").disabled = false;

  const def = wireframeDefaultColor(document.body.classList.contains("dark"));
  $("wireframeColor").value = def;
  $("wireframeColorHex").textContent = def;

  state.currentLinewidth = 1.0;
  $("linewidth").value = 1.0;
  $("valLinewidth").textContent = "1.0px";

  applyWireframe();
}

// On startup: if something was sent from the Editor, load it
(async function checkIncoming() {
  try {
    const payload = await takeHandoff("toLab");
    if (payload) {
      pendingWireframe = !!payload.wireframe;
      const file = payloadToFile(payload);
      toast(`Loaded ${file.name} from Editor`, "accent");
      loadGLB(file);
    }
  } catch (err) {
    console.warn("handoff check failed", err);
  }
})();

//  LAT/LON CURSOR (texture mode)
const raycaster = new THREE.Raycaster();
const mouse = new THREE.Vector2();
const coordEl = $("cursor-coords");

renderer.domElement.addEventListener("mousemove", (e) => {
  if (state.appMode !== "texture") return;
  const rect = renderer.domElement.getBoundingClientRect();
  mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
  mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
  raycaster.setFromCamera(mouse, camera);
  const hits = raycaster.intersectObject(sphere, false);
  if (hits.length > 0) {
    const local = sphere.worldToLocal(hits[0].point.clone()).normalize();
    const lat = Math.asin(Math.max(-1, Math.min(1, local.y))) * (180 / Math.PI);
    const lon = Math.atan2(local.z, local.x) * (180 / Math.PI);
    coordEl.textContent = `${Math.abs(lat).toFixed(1)}° ${lat >= 0 ? "N" : "S"}  ${Math.abs(lon).toFixed(1)}° ${lon >= 0 ? "E" : "W"}`;
    coordEl.classList.add("active");
  } else {
    coordEl.textContent = "— lat   — lon";
    coordEl.classList.remove("active");
  }
});
renderer.domElement.addEventListener("mouseleave", () => {
  coordEl.textContent = "— lat   — lon";
  coordEl.classList.remove("active");
});

//  STATS / EMPTY STATE: invoked from loaders.js
function updateSubjectName(name) {
  const el = $("subject-name");
  el.textContent = name;
  el.classList.toggle("placeholder", !name || name === "No subject loaded");
}

function updateStats() {
  if (state.appMode !== "glb" || !state.currentModel) {
    $("statsPill").classList.remove("visible");
    return;
  }
  let tris = 0,
    verts = 0,
    meshes = 0;
  state.currentModel.traverse((c) => {
    if (c.isMesh && c.geometry) {
      meshes++;
      const pos = c.geometry.attributes.position;
      if (pos) verts += pos.count;
      if (c.geometry.index) tris += c.geometry.index.count / 3;
      else if (pos) tris += pos.count / 3;
    }
  });
  $("statTris").textContent = Math.round(tris).toLocaleString();
  $("statVerts").textContent = verts.toLocaleString();
  $("statMeshes").textContent = meshes;
  $("statsPill").classList.add("visible");
}

window.__labOnSubjectLoaded = (kind, info) => {
  const subj = $("subject-name");
  updateSubjectName(subj.textContent);
  updateStats();
  // file stats container
  $("fileStats")?.classList.remove("empty");

  if (info?.recentered) {
    toast("Model was far from origin, auto-recentered", "accent");
  }

  // Parts harvested from the Editor arrive flagged to show as a wireframe
  if (kind === "glb" && pendingWireframe) {
    pendingWireframe = false;
    enableWireframeDefaults();
  }
};

// Show viewport empty state on first load
$("viewportEmpty").classList.remove("hide");

//  TRY-IT OUTS
async function loadSampleAsset(url, filename, mime) {
  try {
    toast(`Fetching ${filename}…`);
    const res = await fetch(url);
    if (!res.ok) throw new Error("HTTP " + res.status);
    const blob = await res.blob();
    const file = new File([blob], filename, { type: mime });
    routeFile(file);
  } catch (err) {
    console.error(err);
    toast("Could not load sample. Is it deployed alongside the page?", "warn");
  }
}
$("tryTexture")?.addEventListener("click", () =>
  loadSampleAsset("assets/jupiter.jpg", "jupiter.jpg", "image/jpeg"),
);
$("tryGLB")?.addEventListener("click", () =>
  loadSampleAsset("assets/nyc.glb", "nyc.glb", "model/gltf-binary"),
);

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
  }, 2200);
}

//  RENDER LOOP
const clock = new THREE.Clock();
function animate() {
  requestAnimationFrame(animate);
  const dt = clock.getDelta();
  if (state.autoRotate) {
    const subject = state.appMode === "glb" ? state.currentModel : sphere;
    if (subject) subject.rotation.y += dt * state.rotSpeed * 0.18;
  }
  controls.update();
  renderer.render(scene, camera);
}
animate();
