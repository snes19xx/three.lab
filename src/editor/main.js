import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { GLTFExporter } from "three/addons/exporters/GLTFExporter.js";
import { DRACOLoader } from "three/addons/loaders/DRACOLoader.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { payloadToFile, putHandoff, takeHandoff } from "../shared/handoff.js";
import { initialThemeIsDark, storeTheme, watchSystemTheme } from "../shared/theme.js";
import { compressGLB } from "./optimize.js";
import { simplifyGeometry } from "./simplify.js";
import { initTabs } from "./tabs.js";

//  STATE

let scene, camera, renderer, controls;
let currentModel = null;
let originalArrayBuffer = null;
let currentFileName = "";
let cutPlaneMesh = null;
let planeFrame = null;
let gridHelper = null;
let modelBoundingBox = new THREE.Box3();
let modelSize = 1;
let modelCenter = new THREE.Vector3();
let history = [];
let wireframe = false;
let keepSide = "front"; // 'front' | 'back'

// Part selection (multi-select)
let selection = []; // selected meshes, in click order
let isolateOn = false;
let selectionBoxes = []; // one BoxHelper per selected mesh
let savedEmissive = []; // [{ mat, hex, intensity }] restored on deselect
let partList = []; // [{ mesh, name, tris, row, checkbox, eye }]
const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
const SELECT_COLOR = 0xff7847;

// Maximize-button glyphs (arrows out = expand, arrows in = restore)
const PARTS_ICON_EXPAND =
  '<svg width="13" height="13" viewBox="0 0 16 16" fill="none"><path d="M6 2H2v4M10 2h4v4M6 14H2v-4M10 14h4v-4" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const PARTS_ICON_RESTORE =
  '<svg width="13" height="13" viewBox="0 0 16 16" fill="none"><path d="M2 6h4V2M14 6h-4V2M2 10h4v4M14 10h-4v4" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';

//  DOM
const $ = (id) => document.getElementById(id);
const fileInput = $("fileInput");
const dropzone = $("dropzone");
const dropOverlay = $("dropOverlay");
const emptyState = $("emptyState");
const fileMeta = $("fileMeta");
const loader = $("loader");
const loaderText = $("loaderText");
const toastWrap = $("toastWrap");
const statsPill = $("statsPill");

const segSide = $("segSide");
const btnFlip = $("btnFlip");
const btnReload = $("btnReload");
const btnExport = $("btnExport");
const btnCrop = $("btnCrop");
const btnSimplify = $("btnSimplify");
const btnUndo = $("btnUndo");
const btnOpenInLab = $("btnOpenInLab");
const btnTheme = $("btnTheme");

const btnPosReset = $("btnPosReset");
const btnRotReset = $("btnRotReset");
const alignX = $("alignX");
const alignY = $("alignY");
const alignZ = $("alignZ");

const tglPlane = $("tglPlane");
const tglGrid = $("tglGrid");
const tglWire = $("tglWire");
const btnFit = $("btnFit");

const simplifySlider = $("simplifySlider");
const simplifyNum = $("simplifyNum");

// Outliner / selection
const outliner = $("outliner");
const btnMaxParts = $("btnMaxParts");
const selActions = $("selActions");
const selName = $("selName");
const selMeta = $("selMeta");
const btnIsolate = $("btnIsolate");
const btnFrameSel = $("btnFrameSel");
const btnSimplifySel = $("btnSimplifySel");
const btnExportSel = $("btnExportSel");
const btnSelToLab = $("btnSelToLab");
const btnDeleteSel = $("btnDeleteSel");

// Export tab
const btnMeasureSize = $("btnMeasureSize");
const sizeCurrent = $("sizeCurrent");
const textureList = $("textureList");
const maxTexSize = $("maxTexSize");
const segComp = $("compMode");
const btnExportOptimized = $("btnExportOptimized");
let compMode = "none"; // 'none' | 'draco' | 'meshopt'

const axes = ["X", "Y", "Z"];
const posSliders = axes.map((a) => $(`pos${a}Slider`));
const posNums = axes.map((a) => $(`pos${a}Num`));
const rotSliders = axes.map((a) => $(`rot${a}Slider`));
const rotNums = axes.map((a) => $(`rot${a}Num`));

const allInputs = [...posSliders, ...posNums, ...rotSliders, ...rotNums];

//  INIT
// Apply the theme BEFORE init() builds the scene, so background reads correctly
document.body.classList.toggle("dark", initialThemeIsDark());

init();
animate();

function init() {
  const container = $("canvas-container");
  const w = container.clientWidth || window.innerWidth - 320;
  const h = container.clientHeight || window.innerHeight - 52;

  scene = new THREE.Scene();
  applySceneTheme();

  camera = new THREE.PerspectiveCamera(40, w / h, 0.1, 5000);
  camera.position.set(60, 50, 80);

  renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setSize(w, h);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  container.appendChild(renderer.domElement);

  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.target.set(0, 0, 0);

  // Lights
  const hemi = new THREE.HemisphereLight(0xffffff, 0xe6e2d6, 0.9);
  scene.add(hemi);
  const key = new THREE.DirectionalLight(0xffffff, 1.2);
  key.position.set(40, 60, 50);
  scene.add(key);
  const fill = new THREE.DirectionalLight(0xffffff, 0.45);
  fill.position.set(-40, 30, -30);
  scene.add(fill);

  // Grid
  gridHelper = new THREE.GridHelper(200, 40);
  gridHelper.material.opacity = 0.85;
  gridHelper.material.transparent = true;
  scene.add(gridHelper);
  applyGridTheme();

  // Build the cut plane
  buildCutPlane(60);

  window.addEventListener("resize", onWindowResize);

  bindUI();
  bindDragDrop();
  bindKeys();
  bindPicking();
  initTabs();
}

function buildCutPlane(size) {
  if (cutPlaneMesh) {
    scene.remove(cutPlaneMesh);
    cutPlaneMesh.geometry?.dispose?.();
  }

  const group = new THREE.Group();

  // Translucent fill
  const fillGeo = new THREE.PlaneGeometry(size, size);
  const fillMat = new THREE.MeshBasicMaterial({
    color: 0x627343,
    transparent: true,
    opacity: 0.12,
    side: THREE.DoubleSide,
    depthWrite: false,
  });
  const fill = new THREE.Mesh(fillGeo, fillMat);
  group.add(fill);

  // Border lines
  const h = size / 2;
  const borderPoints = [
    new THREE.Vector3(-h, -h, 0),
    new THREE.Vector3(h, -h, 0),
    new THREE.Vector3(h, h, 0),
    new THREE.Vector3(-h, h, 0),
    new THREE.Vector3(-h, -h, 0),
  ];
  const borderGeo = new THREE.BufferGeometry().setFromPoints(borderPoints);
  const borderMat = new THREE.LineBasicMaterial({ color: 0x627343 });
  const border = new THREE.Line(borderGeo, borderMat);
  group.add(border);

  // Cross hairs through center for orientation
  const crossPts = [
    new THREE.Vector3(-h * 0.95, 0, 0),
    new THREE.Vector3(h * 0.95, 0, 0),
    new THREE.Vector3(0, -h * 0.95, 0),
    new THREE.Vector3(0, h * 0.95, 0),
  ];
  const crossGeo = new THREE.BufferGeometry().setFromPoints(crossPts);
  const crossMat = new THREE.LineDashedMaterial({
    color: 0x627343,
    dashSize: size * 0.04,
    gapSize: size * 0.025,
    opacity: 0.5,
    transparent: true,
  });
  const cross = new THREE.LineSegments(crossGeo, crossMat);
  cross.computeLineDistances();
  group.add(cross);

  // Normal arrow
  const arrow = new THREE.ArrowHelper(
    new THREE.Vector3(0, 0, 1),
    new THREE.Vector3(0, 0, 0),
    size * 0.25,
    0x627343,
    size * 0.06,
    size * 0.04,
  );
  arrow.name = "normalArrow";
  group.add(arrow);

  group.visible = false;
  cutPlaneMesh = group;
  scene.add(group);
}

//  UI BINDING

function bindUI() {
  // dropzone click -->to--> file picker
  dropzone.addEventListener("click", (e) => {
    if (e.target === fileInput) return;
    fileInput.click();
  });
  fileInput.addEventListener("change", (e) => {
    const file = e.target.files[0];
    if (file) loadFile(file);
  });

  // segmented side
  segSide.querySelectorAll(".seg-opt").forEach((b) => {
    b.addEventListener("click", () => {
      segSide
        .querySelectorAll(".seg-opt")
        .forEach((x) => x.classList.remove("active"));
      b.classList.add("active");
      keepSide = b.dataset.side;
      flashNormalArrow();
    });
  });
  btnFlip.addEventListener("click", () => {
    keepSide = keepSide === "front" ? "back" : "front";
    segSide
      .querySelectorAll(".seg-opt")
      .forEach((x) =>
        x.classList.toggle("active", x.dataset.side === keepSide),
      );
    flashNormalArrow();
  });

  // Sliders
  for (let i = 0; i < 3; i++) {
    const s = posSliders[i],
      n = posNums[i];
    s.addEventListener("input", () => {
      n.value = (+s.value).toFixed(1);
      updatePlaneTransform();
    });
    n.addEventListener("input", () => {
      s.value = n.value;
      updatePlaneTransform();
    });
  }
  for (let i = 0; i < 3; i++) {
    const s = rotSliders[i],
      n = rotNums[i];
    s.addEventListener("input", () => {
      n.value = s.value;
      updatePlaneTransform();
    });
    n.addEventListener("input", () => {
      s.value = n.value;
      updatePlaneTransform();
    });
  }

  btnPosReset.addEventListener("click", () => {
    posSliders.forEach((s) => (s.value = 0));
    posNums.forEach((n) => (n.value = 0));
    updatePlaneTransform();
  });
  btnRotReset.addEventListener("click", () => {
    rotSliders.forEach((s) => (s.value = 0));
    rotNums.forEach((n) => (n.value = 0));
    updatePlaneTransform();
  });

  // Align plane normal to X / Y / Z axis
  alignX.addEventListener("click", () => setRotation(0, 90, 0));
  alignY.addEventListener("click", () => setRotation(90, 0, 0));
  alignZ.addEventListener("click", () => setRotation(0, 0, 0));

  // Crop / Undo / Reload / Export
  btnCrop.addEventListener("click", applyCrop);
  btnSimplify.addEventListener("click", simplifyModel);
  btnUndo.addEventListener("click", undoCrop);
  btnReload.addEventListener("click", reloadOriginal);
  btnExport.addEventListener("click", exportGLB);
  btnOpenInLab.addEventListener("click", openInLab);
  btnTheme.addEventListener("click", toggleTheme);

  // Simplify slider
  simplifySlider.addEventListener("input", () => {
    simplifyNum.value = simplifySlider.value;
  });
  simplifyNum.addEventListener("input", () => {
    simplifySlider.value = simplifyNum.value;
  });

  // Viewport toolbar
  tglPlane.addEventListener("click", () => {
    const on = cutPlaneMesh.visible;
    cutPlaneMesh.visible = !on;
    tglPlane.classList.toggle("active", !on);
  });
  tglGrid.addEventListener("click", () => {
    const on = gridHelper.visible;
    gridHelper.visible = !on;
    tglGrid.classList.toggle("active", !on);
  });
  tglWire.addEventListener("click", () => {
    wireframe = !wireframe;
    tglWire.classList.toggle("active", wireframe);
    applyWireframe();
  });
  btnFit.addEventListener("click", fitToModel);

  // ViewCube buttons
  document.querySelectorAll(".viewcube button[data-view]").forEach((b) => {
    if (!b.dataset.view) return;
    b.addEventListener("click", () => setView(b.dataset.view));
  });

  // Outliner / selection
  btnMaxParts.addEventListener("click", toggleMaximizeParts);
  btnIsolate.addEventListener("click", toggleIsolate);
  btnFrameSel.addEventListener("click", frameSelected);
  btnSimplifySel.addEventListener("click", simplifySelected);
  btnExportSel.addEventListener("click", exportSelected);
  btnSelToLab.addEventListener("click", sendSelectionToLab);
  btnDeleteSel.addEventListener("click", deleteSelected);

  // Export tab
  btnMeasureSize.addEventListener("click", measureSize);
  btnExportOptimized.addEventListener("click", exportOptimized);
  segComp.querySelectorAll(".seg-opt").forEach((b) => {
    b.addEventListener("click", () => {
      segComp
        .querySelectorAll(".seg-opt")
        .forEach((x) => x.classList.remove("active"));
      b.classList.add("active");
      compMode = b.dataset.comp;
    });
  });
}

function setRotation(x, y, z) {
  rotSliders[0].value = x;
  rotNums[0].value = x;
  rotSliders[1].value = y;
  rotNums[1].value = y;
  rotSliders[2].value = z;
  rotNums[2].value = z;
  updatePlaneTransform();
}

function updatePlaneTransform() {
  if (!cutPlaneMesh) return;
  // slider values are offsets from the model center so the plane lives on the model, not at world origin
  cutPlaneMesh.position.set(
    modelCenter.x + +posSliders[0].value,
    modelCenter.y + +posSliders[1].value,
    modelCenter.z + +posSliders[2].value,
  );
  cutPlaneMesh.rotation.set(
    THREE.MathUtils.degToRad(+rotSliders[0].value),
    THREE.MathUtils.degToRad(+rotSliders[1].value),
    THREE.MathUtils.degToRad(+rotSliders[2].value),
  );
}

function flashNormalArrow() {
  const arrow = cutPlaneMesh?.getObjectByName("normalArrow");
  if (!arrow) return;
  // visually flip the arrow when "back" is chosen
  arrow.setDirection(new THREE.Vector3(0, 0, keepSide === "front" ? 1 : -1));
}

//  DRAG / DROP across the whole viewport

function bindDragDrop() {
  const dragTargets = [document.querySelector(".viewport"), document.body];

  let depth = 0;
  document.addEventListener("dragenter", (e) => {
    if (!e.dataTransfer?.types?.includes("Files")) return;
    depth++;
    dropOverlay.classList.add("on");
  });
  document.addEventListener("dragover", (e) => {
    if (e.dataTransfer?.types?.includes("Files")) e.preventDefault();
  });
  document.addEventListener("dragleave", () => {
    depth--;
    if (depth <= 0) {
      depth = 0;
      dropOverlay.classList.remove("on");
    }
  });
  document.addEventListener("drop", (e) => {
    if (!e.dataTransfer?.files?.length) return;
    e.preventDefault();
    depth = 0;
    dropOverlay.classList.remove("on");
    const file = e.dataTransfer.files[0];
    if (file && /\.(glb|gltf)$/i.test(file.name)) {
      loadFile(file);
    } else {
      toast("Drop a .glb or .gltf file", "warn");
    }
  });
}

//  KEYBOARD

function bindKeys() {
  window.addEventListener("keydown", (e) => {
    const tag = (e.target.tagName || "").toLowerCase();
    if (tag === "input" || tag === "textarea") return;

    const meta = e.metaKey || e.ctrlKey;
    if (meta && e.key.toLowerCase() === "z") {
      e.preventDefault();
      if (!btnUndo.disabled) undoCrop();
      return;
    }
    if (meta && e.key.toLowerCase() === "e") {
      e.preventDefault();
      if (!btnExport.disabled) exportGLB();
      return;
    }
    if (e.key === "Escape") {
      if (document.body.classList.contains("parts-max")) toggleMaximizeParts();
      else if (selection.length) clearSelection();
      return;
    }
    if (e.key === "Enter") {
      if (!btnCrop.disabled) applyCrop();
      return;
    }
    switch (e.key.toLowerCase()) {
      case "p":
        tglPlane.click();
        break;
      case "g":
        tglGrid.click();
        break;
      case "w":
        tglWire.click();
        break;
      case "f":
        fitToModel();
        break;
    }
  });
}

//  FILE LOADING

function loadFile(file, opts = {}) {
  showLoader("Loading " + file.name + "…");
  currentFileName = file.name;
  const reader = new FileReader();
  reader.onload = (e) => {
    originalArrayBuffer = e.target.result;
    parseGLB(originalArrayBuffer, file.name, file.size, opts);
  };
  reader.readAsArrayBuffer(file);
}

function parseGLB(buffer, name, size, opts = {}) {
  const draco = new DRACOLoader();
  draco.setDecoderPath(
    "https://unpkg.com/three@0.160.0/examples/jsm/libs/draco/",
  );
  const loader = new GLTFLoader();
  loader.setDRACOLoader(draco); // without this, draco-compressed models hang forever at loading
  loader.parse(
    buffer,
    "",
    (gltf) => {
      if (currentModel) {
        clearSelection();
        disposeObject(currentModel);
        scene.remove(currentModel);
      }
      currentModel = gltf.scene;
      const wrap = new THREE.Group();
      wrap.name = "ModelRoot";
      wrap.add(currentModel);
      currentModel = wrap;
      scene.add(currentModel);

      history = [];
      btnUndo.disabled = true;

      computeModelBounds();

      // Auto-recenter if model is far from origin (more than 1% of its size)
      const center = new THREE.Vector3();
      modelBoundingBox.getCenter(center);
      if (center.length() > modelSize * 0.01) {
        currentModel.position.sub(center);
        // Re-compute bounds after translation
        computeModelBounds();
      }

      configureUIForModel(name, size);
      buildOutliner();
      fitToModel();
      cutPlaneMesh.visible = true;
      tglPlane.classList.add("active");
      emptyState.classList.add("hide");
      hideLoader();
      if (!opts.silent) toast("Loaded " + name, "accent");
      maybeWarnAboutGeometry();
    },
    (err) => {
      console.error(err);
      hideLoader();
      toast("Failed to parse file. Is it a valid GLB?", "warn");
    },
  );
}

function computeModelBounds() {
  modelBoundingBox.setFromObject(currentModel);
  const sz = new THREE.Vector3();
  modelBoundingBox.getSize(sz);
  modelSize = Math.max(sz.x, sz.y, sz.z) || 10;
}

function maybeWarnAboutGeometry() {
  // flag glbs that may crop unexpectedly so the user knows what's going on
  if (!currentModel) return;
  const reasons = [];
  const sz = modelBoundingBox.getSize(new THREE.Vector3());

  const dims = [sz.x, sz.y, sz.z].filter((d) => d > 0).sort((a, b) => a - b);
  const aspect = dims.length === 3 ? dims[2] / dims[0] : 1;
  if (aspect > 6) reasons.push("extreme aspect ratio");

  // count meshes whose bounding boxes don't touch any other mesh those are truly separate parts
  const meshBoxes = [];
  currentModel.traverse((c) => {
    if (c.isMesh && c.geometry)
      meshBoxes.push(new THREE.Box3().setFromObject(c));
  });
  let isolated = 0;
  for (let i = 0; i < meshBoxes.length; i++) {
    let touches = false;
    for (let j = 0; j < meshBoxes.length; j++) {
      if (i !== j && meshBoxes[i].intersectsBox(meshBoxes[j])) {
        touches = true;
        break;
      }
    }
    if (!touches) isolated++;
  }
  const isolatedRatio = meshBoxes.length ? isolated / meshBoxes.length : 0;
  if (meshBoxes.length >= 2 && isolatedRatio >= 0.5)
    reasons.push("scattered parts");

  console.log("[cropper] geometry check", {
    size: sz,
    aspect: +aspect.toFixed(2),
    meshes: meshBoxes.length,
    isolated,
    isolatedRatio: +isolatedRatio.toFixed(2),
    reasons,
  });

  if (reasons.length > 0) {
    setTimeout(
      () =>
        toast(
          `Heads up: ${reasons.join(" + ")}. Cropping may behave unexpectedly.`,
          "warn",
        ),
      1100,
    );
  }
}

function configureUIForModel(name, fileSize) {
  // Rebuild plane sized to model so it always spans across
  buildCutPlane(modelSize * 2.2);
  cutPlaneMesh.visible = true;

  // anchor the cut plane to wherever the model actually lives in world space
  modelBoundingBox.getCenter(modelCenter);

  // Resize grid and fog
  const newGridSize = Math.max(200, modelSize * 3);
  if (gridHelper) {
    scene.remove(gridHelper);
    gridHelper.geometry.dispose();
    gridHelper.material.dispose();
  }
  gridHelper = new THREE.GridHelper(newGridSize, 40);
  gridHelper.material.opacity = 0.85;
  gridHelper.material.transparent = true;
  scene.add(gridHelper);
  applyGridTheme();
  tglGrid.classList.toggle("active", gridHelper.visible);

  if (scene.fog) {
    scene.fog.near = Math.max(200, modelSize * 2.5);
    scene.fog.far = Math.max(1200, modelSize * 8);
  }

  // Slider ranges based on model size
  const range = modelSize * 1.2;
  posSliders.forEach((s) => {
    s.min = -range;
    s.max = range;
    s.step = range / 400;
    s.value = 0;
  });
  posNums.forEach((n) => {
    n.value = 0;
    n.step = range / 400;
  });
  rotSliders.forEach((s) => (s.value = 0));
  rotNums.forEach((n) => (n.value = 0));
  updatePlaneTransform();
  flashNormalArrow();

  allInputs.forEach((el) => (el.disabled = false));
  [
    btnCrop,
    btnExport,
    btnReload,
    btnFlip,
    btnOpenInLab,
    alignX,
    alignY,
    alignZ,
    btnPosReset,
    btnRotReset,
    btnSimplify,
    btnMeasureSize,
    btnExportOptimized,
    maxTexSize,
  ].forEach((b) => (b.disabled = false));

  simplifySlider.disabled = false;
  simplifyNum.disabled = false;

  buildTextureList();
  updateMeta(name, fileSize);
  updateStats();
  statsPill.style.display = "block";
}

function updateMeta(name, fileSize) {
  const kb = fileSize ? (fileSize / 1024).toFixed(0) + " KB" : "";
  fileMeta.innerHTML = `
    <strong>${escapeHtml(name)}</strong>
    ${kb ? '<span class="sep">·</span><span>' + kb + "</span>" : ""}
    <span class="sep">·</span>
    <span id="metaDims"></span>
  `;
  const sz = new THREE.Vector3();
  modelBoundingBox.getSize(sz);
  const fmt = (n) => n.toFixed(1);
  document.getElementById("metaDims").textContent =
    fmt(sz.x) + " × " + fmt(sz.y) + " × " + fmt(sz.z);
}

function updateStats() {
  let tris = 0,
    verts = 0,
    meshes = 0;
  currentModel.traverse((c) => {
    if (c.isMesh && c.geometry) {
      meshes++;
      const pos = c.geometry.attributes.position;
      if (pos) verts += pos.count;
      if (c.geometry.index) tris += c.geometry.index.count / 3;
      else if (pos) tris += pos.count / 3;
    }
  });
  $("statTris").textContent = formatNum(Math.round(tris));
  $("statVerts").textContent = formatNum(verts);
  $("statMeshes").textContent = meshes;
}

function formatNum(n) {
  return n.toLocaleString();
}
function escapeHtml(s) {
  return s.replace(
    /[&<>"']/g,
    (c) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[c],
  );
}

function disposeObject(obj) {
  obj.traverse((c) => {
    if (c.geometry) c.geometry.dispose?.();
    if (c.material) {
      const m = Array.isArray(c.material) ? c.material : [c.material];
      m.forEach((mm) => mm.dispose?.());
    }
  });
}

//  CAMERA / VIEW

function setView(which) {
  const center = new THREE.Vector3();
  modelBoundingBox.getCenter(center);
  const dist = modelSize * 2.4 || 100;

  const dirs = {
    front: [0, 0, 1],
    back: [0, 0, -1],
    left: [-1, 0, 0],
    right: [1, 0, 0],
    top: [0, 1, 0],
    bottom: [0, -1, 0],
    iso: [1, 0.75, 1],
  };
  const d = dirs[which] || dirs.iso;
  const target = center.clone();
  const pos = new THREE.Vector3(d[0], d[1], d[2])
    .normalize()
    .multiplyScalar(dist)
    .add(target);

  animateCamera(pos, target);
}

function recalibrateCamera() {
  // scale near/far to the model so big rockets and tiny props both get usable z-precision
  if (!modelSize || modelSize <= 0) return;
  camera.near = Math.max(modelSize * 0.001, 0.01);
  camera.far = Math.max(modelSize * 100, 1000);
  camera.updateProjectionMatrix();

  if (scene.fog) {
    scene.fog.near = Math.max(200, modelSize * 2.5);
    scene.fog.far = Math.max(1200, modelSize * 8);
  }
}

function fitToModel() {
  if (!currentModel) return;
  computeModelBounds();
  recalibrateCamera();
  const center = new THREE.Vector3();
  modelBoundingBox.getCenter(center);
  const dist = modelSize * 2.2;
  // Keep current direction from target
  const dir = camera.position.clone().sub(controls.target).normalize();
  const pos = dir.multiplyScalar(dist).add(center);
  animateCamera(pos, center);
}

function animateCamera(toPos, toTarget) {
  const fromPos = camera.position.clone();
  const fromTarget = controls.target.clone();
  const start = performance.now();
  const dur = 380;

  function step(now) {
    const t = Math.min(1, (now - start) / dur);
    const e = t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t; // easeInOutQuad
    camera.position.lerpVectors(fromPos, toPos, e);
    controls.target.lerpVectors(fromTarget, toTarget, e);
    controls.update();
    if (t < 1) requestAnimationFrame(step);
  }
  requestAnimationFrame(step);
}

//  WIREFRAME

function applyWireframe() {
  if (!currentModel) return;
  currentModel.traverse((c) => {
    if (c.isMesh && c.material) {
      const arr = Array.isArray(c.material) ? c.material : [c.material];
      arr.forEach((m) => {
        if ("wireframe" in m) m.wireframe = wireframe;
      });
    }
  });
}

//  PART SELECTION / OUTLINER

function bindPicking() {
  const el = renderer.domElement;
  let downX = 0,
    downY = 0;
  el.addEventListener("pointerdown", (e) => {
    downX = e.clientX;
    downY = e.clientY;
  });
  el.addEventListener("pointerup", (e) => {
    // Ignore orbit/pan drags; only treat near-stationary releases as a click
    if (Math.hypot(e.clientX - downX, e.clientY - downY) > 5) return;
    if (!currentModel) return;
    const rect = el.getBoundingClientRect();
    pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(pointer, camera);
    const hits = raycaster
      .intersectObject(currentModel, true)
      .filter((h) => h.object.isMesh && h.object.visible);
    const additive = e.ctrlKey || e.metaKey || e.shiftKey; // hold to add/remove
    if (hits.length) {
      if (additive) toggleSelection(hits[0].object);
      else setSelection([hits[0].object]);
    } else if (!additive) {
      clearSelection();
    }
  });
}

function meshTriCount(mesh) {
  const g = mesh.geometry;
  if (!g) return 0;
  if (g.index) return g.index.count / 3;
  const p = g.attributes.position;
  return p ? p.count / 3 : 0;
}

function collectMeshes() {
  const out = [];
  if (!currentModel) return out;
  currentModel.traverse((c) => {
    if (c.isMesh && c.geometry) out.push(c);
  });
  return out;
}

function eyeSVG(open) {
  return open
    ? '<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M1 8s2.6-4.5 7-4.5S15 8 15 8s-2.6 4.5-7 4.5S1 8 1 8Z" stroke="currentColor" stroke-width="1.2"/><circle cx="8" cy="8" r="1.9" fill="currentColor"/></svg>'
    : '<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M2.5 4.5C1.6 5.4 1 8 1 8s2.6 4.5 7 4.5c1 0 1.9-.2 2.7-.6M6.2 3.7C6.8 3.6 7.4 3.5 8 3.5c4.4 0 7 4.5 7 4.5s-.7 1.2-1.9 2.4M2 2l12 12" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>';
}

function buildOutliner() {
  // any geometry change invalidates the last measured export size
  if (sizeCurrent) sizeCurrent.textContent = "—";
  const meshes = collectMeshes();
  partList = meshes.map((mesh, i) => ({
    mesh,
    name: mesh.name && mesh.name.trim() ? mesh.name : `Mesh ${i + 1}`,
    tris: Math.round(meshTriCount(mesh)),
  }));

  outliner.innerHTML = "";
  if (partList.length === 0) {
    const e = document.createElement("div");
    e.className = "outliner-empty";
    e.textContent = "No model loaded";
    outliner.appendChild(e);
    hideSelActions();
    return;
  }

  partList.forEach((p, i) => {
    const row = document.createElement("div");
    row.className = "part-row";
    row.dataset.idx = i;

    // Checklist checkbox — multi-select without holding a modifier
    const check = document.createElement("input");
    check.type = "checkbox";
    check.className = "part-check";
    check.title = "Add to selection";
    check.addEventListener("click", (ev) => {
      ev.stopPropagation();
      toggleSelection(p.mesh);
    });

    const eye = document.createElement("button");
    eye.className = "part-eye" + (p.mesh.visible ? "" : " off");
    eye.innerHTML = eyeSVG(p.mesh.visible);
    eye.title = "Toggle visibility";
    eye.addEventListener("click", (ev) => {
      ev.stopPropagation();
      p.mesh.visible = !p.mesh.visible;
      eye.className = "part-eye" + (p.mesh.visible ? "" : " off");
      eye.innerHTML = eyeSVG(p.mesh.visible);
      row.classList.toggle("hidden-part", !p.mesh.visible);
    });

    const name = document.createElement("div");
    name.className = "part-name";
    name.textContent = p.name;
    name.title = p.name;

    const tris = document.createElement("div");
    tris.className = "part-tris";
    tris.textContent = formatNum(p.tris);

    row.appendChild(check);
    row.appendChild(eye);
    row.appendChild(name);
    row.appendChild(tris);
    row.classList.toggle("hidden-part", !p.mesh.visible);
    // Plain click = single-select; ctrl/cmd/shift+click = add/remove
    row.addEventListener("click", (ev) => {
      if (ev.ctrlKey || ev.metaKey || ev.shiftKey) toggleSelection(p.mesh);
      else setSelection([p.mesh], { frame: true });
    });
    p.row = row;
    p.checkbox = check;
    p.eye = eye;
    outliner.appendChild(row);
  });

  // Drop any selected meshes that didn't survive a rebuild, then repaint
  selection = selection.filter((m) => partList.some((p) => p.mesh === m));
  renderHighlights();
  updateSelectionUI();
}

function isSelected(mesh) {
  return selection.includes(mesh);
}

// Replace the whole selection with the given meshes
function setSelection(meshes, opts = {}) {
  clearHighlights();
  selection = meshes.slice();
  renderHighlights();
  applyIsolationVisibility();
  updateSelectionUI();
  if (opts.frame) frameSelected();
}

// Add or remove a single mesh from the current selection
function toggleSelection(mesh) {
  clearHighlights();
  if (isSelected(mesh)) selection = selection.filter((m) => m !== mesh);
  else selection.push(mesh);
  renderHighlights();
  applyIsolationVisibility();
  updateSelectionUI();
}

function clearSelection() {
  clearHighlights();
  selection = [];
  // Don't leave the viewport blank if everything was isolated
  if (isolateOn) showAllParts();
  updateSelectionUI();
}

// While isolated, keep only the selected meshes visible as the selection changes
function applyIsolationVisibility() {
  if (!isolateOn) return;
  partList.forEach((p) => (p.mesh.visible = isSelected(p.mesh)));
  syncEyes();
  updateSelectionBoxes();
}

// Expand the Parts panel to a wide, tall layout (hides the edit-tool sections)
function toggleMaximizeParts() {
  const max = !document.body.classList.contains("parts-max");
  document.body.classList.toggle("parts-max", max);
  btnMaxParts.innerHTML = max ? PARTS_ICON_RESTORE : PARTS_ICON_EXPAND;
  btnMaxParts.dataset.tip = max ? "Restore panel" : "Expand panel";
  // The viewport column changes width — resync the renderer after layout settles
  requestAnimationFrame(onWindowResize);
}

// Paint emissive + outline box for every mesh in the selection
function renderHighlights() {
  savedEmissive = [];
  selectionBoxes = [];
  selection.forEach((mesh) => {
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    mats.forEach((m) => {
      if (m && m.emissive) {
        savedEmissive.push({
          mat: m,
          hex: m.emissive.getHex(),
          intensity: m.emissiveIntensity,
        });
        m.emissive.setHex(SELECT_COLOR);
        m.emissiveIntensity = 0.45;
      }
    });
    const box = new THREE.BoxHelper(mesh, SELECT_COLOR);
    box.material.depthTest = false;
    box.material.transparent = true;
    scene.add(box);
    selectionBoxes.push(box);
  });
}

function clearHighlights() {
  savedEmissive.forEach(({ mat, hex, intensity }) => {
    if (mat && mat.emissive) {
      mat.emissive.setHex(hex);
      mat.emissiveIntensity = intensity;
    }
  });
  savedEmissive = [];
  selectionBoxes.forEach((box) => {
    scene.remove(box);
    box.geometry?.dispose?.();
    box.material?.dispose?.();
  });
  selectionBoxes = [];
}

function updateSelectionBoxes() {
  selectionBoxes.forEach((box) => box.update());
}

// Sync row highlight, checkboxes, and the action panel to the selection
function updateSelectionUI() {
  partList.forEach((p) => {
    const on = isSelected(p.mesh);
    p.row?.classList.toggle("active", on);
    if (p.checkbox) p.checkbox.checked = on;
  });

  const n = selection.length;
  if (n === 0) {
    hideSelActions();
    return;
  }
  selActions.style.display = "block";

  let tris = 0;
  const box = new THREE.Box3();
  selection.forEach((mesh) => {
    tris += meshTriCount(mesh);
    box.expandByObject(mesh);
  });
  const sz = box.getSize(new THREE.Vector3());
  const fmt = (v) => v.toFixed(1);

  if (n === 1) {
    const entry = partList.find((p) => p.mesh === selection[0]);
    selName.textContent = entry ? entry.name : "Mesh";
  } else {
    selName.textContent = `${n} parts selected`;
  }
  selMeta.textContent = `${formatNum(Math.round(tris))} tris · ${fmt(sz.x)}×${fmt(
    sz.y,
  )}×${fmt(sz.z)}`;

  btnExportSel.textContent = n > 1 ? `Export ${n} parts` : "Export part";
  btnDeleteSel.textContent = n > 1 ? `Delete ${n} parts` : "Delete part";
}

function hideSelActions() {
  selActions.style.display = "none";
}

function frameSelected() {
  if (selection.length === 0) return;
  const box = new THREE.Box3();
  selection.forEach((mesh) => box.expandByObject(mesh));
  if (box.isEmpty()) return;
  const center = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());
  const radius = Math.max(size.x, size.y, size.z) || modelSize;
  const dir = camera.position.clone().sub(controls.target).normalize();
  animateCamera(dir.multiplyScalar(radius * 2.6).add(center), center);
}

function toggleIsolate() {
  if (selection.length === 0) return;
  isolateOn = !isolateOn;
  partList.forEach((p) => {
    p.mesh.visible = isolateOn ? isSelected(p.mesh) : true;
  });
  syncEyes();
  btnIsolate.classList.toggle("active", isolateOn);
  btnIsolate.textContent = isolateOn ? "Un-isolate" : "Isolate";
  updateSelectionBoxes();
}

function showAllParts() {
  isolateOn = false;
  partList.forEach((p) => (p.mesh.visible = true));
  syncEyes();
  btnIsolate.classList.remove("active");
  btnIsolate.textContent = "Isolate";
}

function syncEyes() {
  partList.forEach((p) => {
    if (p.eye) {
      p.eye.className = "part-eye" + (p.mesh.visible ? "" : " off");
      p.eye.innerHTML = eyeSVG(p.mesh.visible);
    }
    p.row?.classList.toggle("hidden-part", !p.mesh.visible);
  });
}

function deleteSelected() {
  if (selection.length === 0) return;
  const meshes = selection.slice();
  // Restore clean materials before snapshotting so undo doesn't keep the highlight
  clearSelection();
  pushHistory();
  meshes.forEach((mesh) => {
    mesh.parent?.remove(mesh);
    mesh.geometry?.dispose?.();
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    mats.forEach((m) => m?.dispose?.());
  });
  btnUndo.disabled = false;
  computeModelBounds();
  buildOutliner();
  updateStats();
  toast(
    meshes.length > 1 ? `Deleted ${meshes.length} parts` : "Deleted part",
    "accent",
  );
}

// Clone the given meshes with world transforms baked in, recentered to origin.
function buildSelectionRoot(meshes) {
  const root = new THREE.Group();
  meshes.forEach((mesh) => {
    mesh.updateWorldMatrix(true, false);
    const clone = new THREE.Mesh(
      mesh.geometry.clone(),
      Array.isArray(mesh.material)
        ? mesh.material.map((m) => m.clone())
        : mesh.material.clone(),
    );
    clone.applyMatrix4(mesh.matrixWorld);
    clone.name = mesh.name;
    root.add(clone);
  });
  root.updateMatrixWorld(true);
  const c = new THREE.Box3().setFromObject(root).getCenter(new THREE.Vector3());
  root.children.forEach((clone) => clone.position.sub(c));
  return root;
}

// Filename-safe label for the current selection ("wheel", "3parts").
function selectionLabel(meshes) {
  if (meshes.length === 1) {
    const entry = partList.find((p) => p.mesh === meshes[0]);
    return (
      (entry ? entry.name : "part")
        .replace(/[^a-z0-9_-]+/gi, "_")
        .replace(/^_+|_+$/g, "")
        .slice(0, 40) || "part"
    );
  }
  return `${meshes.length}parts`;
}

function exportSelected() {
  if (selection.length === 0) return;
  const meshes = selection.slice();
  // Strip the highlight so it isn't baked into the cloned materials
  clearHighlights();
  showLoader("Exporting…");

  const root = buildSelectionRoot(meshes);
  const base = currentFileName.replace(/\.(glb|gltf)$/i, "") || "model";
  const label = selectionLabel(meshes);

  const exporter = new GLTFExporter();
  exporter.parse(
    root,
    (glb) => {
      const blob = new Blob([glb], { type: "application/octet-stream" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${base}.${label}.glb`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      renderHighlights();
      hideLoader();
      toast("Exported " + a.download, "accent");
    },
    (err) => {
      renderHighlights();
      hideLoader();
      console.error(err);
      toast("Export failed", "warn");
    },
    { binary: true },
  );
}

// Hand the current selection straight to the Lab, where it can be turned
// into an SVG or an R3F component.
function sendSelectionToLab() {
  if (selection.length === 0) return;
  const meshes = selection.slice();
  clearHighlights();
  showLoader("Sending to Lab…");

  const root = buildSelectionRoot(meshes);
  const base = currentFileName.replace(/\.(glb|gltf)$/i, "") || "model";
  const label = selectionLabel(meshes);

  const exporter = new GLTFExporter();
  exporter.parse(
    root,
    async (glb) => {
      try {
        // wireframe: true asks the Lab to show the harvested part as a wireframe
        await putHandoff(
          "toLab",
          { name: `${base}.${label}.glb`, buffer: glb },
          { wireframe: true },
        );
        location.href = "lab.html";
      } catch (err) {
        renderHighlights();
        hideLoader();
        console.error(err);
        toast("Hand-off failed", "warn");
      }
    },
    (err) => {
      renderHighlights();
      hideLoader();
      console.error(err);
      toast("Send failed", "warn");
    },
    { binary: true },
  );
}

// SIMPLIFY

let simplifyRunning = false;

function totalTris(meshes) {
  return meshes.reduce((sum, m) => sum + meshTriCount(m), 0);
}

// Simplify each mesh in turn, yielding between them so the progress bar paints.
async function simplifyMeshes(meshes, ratio, onProgress) {
  let done = 0;
  let skipped = 0;
  for (let i = 0; i < meshes.length; i++) {
    const mesh = meshes[i];
    try {
      const simplified = await simplifyGeometry(mesh.geometry, ratio);
      if (simplified) {
        mesh.geometry.dispose();
        mesh.geometry = simplified;
        done++;
      } else {
        skipped++;
      }
    } catch (err) {
      console.error("Simplify error:", mesh.name, err);
      skipped++;
    }
    onProgress?.((i + 1) / meshes.length);
    await new Promise((r) => requestAnimationFrame(r));
  }
  return { done, skipped };
}

// Enable undo (or roll back a no-op snapshot) and report the real reduction.
function finishSimplify(done, skipped, before, after, noun) {
  if (done === 0) {
    history.pop();
    btnUndo.disabled = history.length === 0;
    toast("Couldn't simplify any further", "warn");
    return;
  }
  btnUndo.disabled = false;
  const plural = done > 1 ? (noun === "mesh" ? "es" : "s") : "";
  const pct = before > 0 ? Math.round((1 - after / before) * 100) : 0;
  let msg = `Reduced ${done} ${noun}${plural} — ${pct}% fewer triangles`;
  if (skipped > 0) msg += ` (${skipped} skipped)`;
  toast(msg, skipped > 0 ? "warn" : "accent");
}

async function simplifySelected() {
  if (selection.length === 0 || simplifyRunning) return;
  const ratio = parseFloat(simplifySlider.value) / 100;
  if (ratio <= 0) {
    toast("Set a reduction above 0%", "warn");
    return;
  }
  const meshes = selection.slice();
  simplifyRunning = true;
  // Restore clean materials before snapshotting; buildOutliner re-highlights after
  clearHighlights();
  pushHistory();
  showLoader("Simplifying…", { showProgress: true });

  const before = totalTris(meshes);
  const { done, skipped } = await simplifyMeshes(meshes, ratio, (p) => {
    updateLoaderProgress(p * 100);
    loaderText.textContent = `Simplifying… ${Math.round(p * 100)}%`;
  });
  const after = totalTris(meshes);

  computeModelBounds();
  buildOutliner();
  updateStats();
  hideLoader();
  simplifyRunning = false;
  finishSimplify(done, skipped, before, after, "part");
}

async function simplifyModel() {
  if (!currentModel || simplifyRunning) return;
  const ratio = parseFloat(simplifySlider.value) / 100;
  if (ratio <= 0) {
    toast("Set a reduction above 0%", "warn");
    return;
  }
  const meshes = [];
  currentModel.traverse((c) => {
    if (c.isMesh && c.geometry) meshes.push(c);
  });
  if (meshes.length === 0) {
    toast("Nothing to simplify", "warn");
    return;
  }

  simplifyRunning = true;
  // Selection highlight mutates materials — drop it before snapshotting
  clearSelection();
  pushHistory();
  showLoader("Simplifying…", { showProgress: true });

  const before = totalTris(meshes);
  const { done, skipped } = await simplifyMeshes(meshes, ratio, (p) => {
    updateLoaderProgress(p * 100);
    loaderText.textContent = `Simplifying… ${Math.round(p * 100)}%`;
  });
  const after = totalTris(meshes);

  computeModelBounds();
  updateStats();
  buildOutliner();
  hideLoader();
  simplifyRunning = false;
  finishSimplify(done, skipped, before, after, "mesh");
}

//  CROP
function applyCrop() {
  if (!currentModel) return;
  const isFront = keepSide === "front";

  // Drop selection highlight before snapshotting so undo restores clean materials
  clearSelection();

  // Snapshot current geometry for undo
  pushHistory();

  showLoader("Cropping…");

  // Defer to next frame so the loader paints
  requestAnimationFrame(() => {
    let croppedCount = 0;
    const newRoot = new THREE.Group();
    newRoot.name = "CroppedModel";

    currentModel.updateMatrixWorld(true);
    cutPlaneMesh.updateMatrixWorld(true);
    const inversePlaneMatrix = cutPlaneMesh.matrixWorld.clone().invert();

    currentModel.traverse((child) => {
      if (!(child.isMesh && child.geometry)) return;
      const geom = child.geometry;
      const posAttr = geom.attributes.position;
      const uvAttr = geom.attributes.uv;
      const normAttr = geom.attributes.normal;
      if (!posAttr) return;

      const newPositions = [];
      const newUvs = [];
      const newNormals = [];

      const wA = new THREE.Vector3(),
        wB = new THREE.Vector3(),
        wC = new THREE.Vector3();
      const vA = new THREE.Vector3(),
        vB = new THREE.Vector3(),
        vC = new THREE.Vector3();
      const uA = new THREE.Vector2(),
        uB = new THREE.Vector2(),
        uC = new THREE.Vector2();
      const nA = new THREE.Vector3(),
        nB = new THREE.Vector3(),
        nC = new THREE.Vector3();
      const matrix = child.matrixWorld;
      const normalMatrix = new THREE.Matrix3().getNormalMatrix(matrix);

      const processTriangle = (a, b, c) => {
        wA.fromBufferAttribute(posAttr, a).applyMatrix4(matrix);
        wB.fromBufferAttribute(posAttr, b).applyMatrix4(matrix);
        wC.fromBufferAttribute(posAttr, c).applyMatrix4(matrix);

        vA.copy(wA).applyMatrix4(inversePlaneMatrix);
        vB.copy(wB).applyMatrix4(inversePlaneMatrix);
        vC.copy(wC).applyMatrix4(inversePlaneMatrix);

        const keep = isFront
          ? vA.z > 0 && vB.z > 0 && vC.z > 0
          : vA.z < 0 && vB.z < 0 && vC.z < 0;

        if (!keep) return;
        newPositions.push(wA.x, wA.y, wA.z, wB.x, wB.y, wB.z, wC.x, wC.y, wC.z);
        if (uvAttr) {
          uA.fromBufferAttribute(uvAttr, a);
          uB.fromBufferAttribute(uvAttr, b);
          uC.fromBufferAttribute(uvAttr, c);
          newUvs.push(uA.x, uA.y, uB.x, uB.y, uC.x, uC.y);
        }
        if (normAttr) {
          nA.fromBufferAttribute(normAttr, a).applyMatrix3(normalMatrix);
          nB.fromBufferAttribute(normAttr, b).applyMatrix3(normalMatrix);
          nC.fromBufferAttribute(normAttr, c).applyMatrix3(normalMatrix);
          newNormals.push(nA.x, nA.y, nA.z, nB.x, nB.y, nB.z, nC.x, nC.y, nC.z);
        }
      };

      if (geom.index) {
        const idx = geom.index;
        for (let i = 0; i < idx.count; i += 3) {
          processTriangle(idx.getX(i), idx.getX(i + 1), idx.getX(i + 2));
        }
      } else {
        for (let i = 0; i < posAttr.count; i += 3) {
          processTriangle(i, i + 1, i + 2);
        }
      }

      if (newPositions.length > 0) {
        const newGeom = new THREE.BufferGeometry();
        newGeom.setAttribute(
          "position",
          new THREE.Float32BufferAttribute(newPositions, 3),
        );
        if (uvAttr) {
          newGeom.setAttribute(
            "uv",
            new THREE.Float32BufferAttribute(newUvs, 2),
          );
        }
        if (newNormals.length) {
          newGeom.setAttribute(
            "normal",
            new THREE.Float32BufferAttribute(newNormals, 3),
          );
        } else {
          newGeom.computeVertexNormals();
        }

        const newMat = child.material
          ? Array.isArray(child.material)
            ? child.material[0].clone()
            : child.material.clone()
          : new THREE.MeshStandardMaterial({ color: 0xcccccc });
        newMat.side = THREE.DoubleSide;
        if (wireframe && "wireframe" in newMat) newMat.wireframe = true;

        const newMesh = new THREE.Mesh(newGeom, newMat);
        newMesh.name = child.name; // keep part identity across crops
        newRoot.add(newMesh);
        croppedCount++;
      }
    });

    if (croppedCount === 0) {
      // pop the history
      history.pop();
      btnUndo.disabled = history.length === 0;
      hideLoader();
      toast("Crop removed everything. Adjust and try again.", "warn");
      return;
    }

    // Replace model
    scene.remove(currentModel);
    disposeObject(currentModel);
    const wrap = new THREE.Group();
    wrap.name = "ModelRoot";
    wrap.add(newRoot);
    currentModel = wrap;
    scene.add(currentModel);

    btnUndo.disabled = false;
    isolateOn = false;
    computeModelBounds();
    updateMeta(currentFileName, null);
    updateStats();
    buildOutliner();
    hideLoader();
    toast(
      `Cropped · ${croppedCount} mesh${croppedCount > 1 ? "es" : ""} kept`,
      "accent",
    );
  });
}

function pushHistory() {
  // Detach children and store reference for restore
  const snapshot = new THREE.Group();
  while (currentModel.children.length) {
    snapshot.add(currentModel.children[0]);
  }
  // Put them back into current model so rendering continues
  while (snapshot.children.length) {
    currentModel.add(snapshot.children[0]);
  }
  // Now actually clone for true undo
  const clone = currentModel.clone(true);
  history.push(clone);
  if (history.length > 12) history.shift();
}

function undoCrop() {
  if (history.length === 0) return;
  clearSelection();
  isolateOn = false;
  const prev = history.pop();
  scene.remove(currentModel);
  disposeObject(currentModel);
  currentModel = prev;
  scene.add(currentModel);
  btnUndo.disabled = history.length === 0;
  computeModelBounds();
  updateMeta(currentFileName, null);
  updateStats();
  applyWireframe();
  buildOutliner();
  toast("Undid last crop");
}

function reloadOriginal() {
  if (!originalArrayBuffer) return;
  history = [];
  btnUndo.disabled = true;
  parseGLB(originalArrayBuffer, currentFileName, null, { silent: true });
  toast("Reloaded original");
}

//  EXPORT
function exportGLB() {
  if (!currentModel) return;
  showLoader("Exporting GLB…");
  const exporter = new GLTFExporter();
  const wasVisible = cutPlaneMesh.visible;
  cutPlaneMesh.visible = false;
  clearHighlights();

  exporter.parse(
    currentModel,
    (glb) => {
      cutPlaneMesh.visible = wasVisible;
      renderHighlights();
      const blob = new Blob([glb], { type: "application/octet-stream" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      const base = currentFileName.replace(/\.(glb|gltf)$/i, "") || "model";
      a.download = `${base}.cropped.glb`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      hideLoader();
      toast("Exported " + a.download, "accent");
    },
    (err) => {
      cutPlaneMesh.visible = wasVisible;
      renderHighlights();
      hideLoader();
      console.error(err);
      toast("Export failed", "warn");
    },
    { binary: true },
  );
}

// OPTIMIZE / EXPORT TAB

function formatBytes(n) {
  if (n < 1024) return n + " B";
  if (n < 1024 * 1024) return (n / 1024).toFixed(0) + " KB";
  return (n / (1024 * 1024)).toFixed(2) + " MB";
}

// Serialize an object to a binary GLB ArrayBuffer.
function exportToGLB(obj, opts) {
  return new Promise((resolve, reject) => {
    new GLTFExporter().parse(obj, resolve, reject, { binary: true, ...opts });
  });
}

function downloadBuffer(buffer, filename) {
  const blob = new Blob([buffer], { type: "application/octet-stream" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

const TEX_SLOTS = [
  "map",
  "normalMap",
  "roughnessMap",
  "metalnessMap",
  "emissiveMap",
  "aoMap",
  "alphaMap",
  "bumpMap",
  "displacementMap",
  "clearcoatMap",
  "sheenColorMap",
  "specularMap",
];

function collectTextures() {
  const seen = new Set();
  const list = [];
  if (!currentModel) return list;
  currentModel.traverse((c) => {
    if (!c.isMesh || !c.material) return;
    const mats = Array.isArray(c.material) ? c.material : [c.material];
    mats.forEach((m) => {
      if (!m) return;
      TEX_SLOTS.forEach((slot) => {
        const t = m[slot];
        if (!t || !t.image || seen.has(t)) return;
        seen.add(t);
        const img = t.image;
        list.push({
          slot,
          w: img.width || img.naturalWidth || 0,
          h: img.height || img.naturalHeight || 0,
        });
      });
    });
  });
  return list;
}

function buildTextureList() {
  const list = collectTextures();
  textureList.innerHTML = "";
  if (list.length === 0) {
    const e = document.createElement("div");
    e.className = "texture-empty";
    e.textContent = currentModel ? "No textures" : "No model loaded";
    textureList.appendChild(e);
    return;
  }
  list.forEach((t) => {
    const row = document.createElement("div");
    row.className = "texture-row";
    const name = document.createElement("span");
    name.className = "t-name";
    name.textContent = t.slot;
    const dim = document.createElement("span");
    dim.className = "t-dim";
    dim.textContent = t.w && t.h ? `${t.w}×${t.h}` : "—";
    row.appendChild(name);
    row.appendChild(dim);
    textureList.appendChild(row);
  });
}

async function measureSize() {
  if (!currentModel) return;
  showLoader("Measuring…");
  clearHighlights();
  const wasPlane = cutPlaneMesh.visible;
  cutPlaneMesh.visible = false;
  try {
    const glb = await exportToGLB(currentModel);
    sizeCurrent.textContent = formatBytes(glb.byteLength);
  } catch (err) {
    console.error(err);
    toast("Couldn't measure size", "warn");
  } finally {
    cutPlaneMesh.visible = wasPlane;
    renderHighlights();
    hideLoader();
  }
}

async function exportOptimized() {
  if (!currentModel) return;
  const maxTex = parseInt(maxTexSize.value, 10) || 0;
  if (maxTex === 0 && compMode === "none") {
    toast("Pick a texture size or compression first", "warn");
    return;
  }

  showLoader("Optimizing…");
  clearHighlights();
  const wasPlane = cutPlaneMesh.visible;
  cutPlaneMesh.visible = false;
  try {
    let glb = await exportToGLB(
      currentModel,
      maxTex > 0 ? { maxTextureSize: maxTex } : {},
    );

    if (compMode !== "none") {
      try {
        glb = await compressGLB(glb, compMode);
      } catch (err) {
        console.error("compression failed:", err);
        toast("Compression failed: " + (err?.message || err), "warn");
      }
    }

    const base = currentFileName.replace(/\.(glb|gltf)$/i, "") || "model";
    downloadBuffer(glb, `${base}.web.glb`);

    // Compare against the original file the user loaded — the comparison they
    // actually care about ("did I end up smaller than I started?").
    const before = originalArrayBuffer ? originalArrayBuffer.byteLength : glb.byteLength;
    const after = glb.byteLength;
    sizeCurrent.textContent = formatBytes(after);
    const pct = before > 0 ? Math.round((1 - after / before) * 100) : 0;
    const tag = pct >= 0 ? `${pct}% smaller` : `${-pct}% larger`;
    toast(
      `${formatBytes(before)} → ${formatBytes(after)} · ${tag}`,
      pct >= 0 ? "accent" : "warn",
    );
  } catch (err) {
    console.error(err);
    toast("Export failed", "warn");
  } finally {
    cutPlaneMesh.visible = wasPlane;
    renderHighlights();
    hideLoader();
  }
}

//  TOAST / LOADER
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

function showLoader(text, opts = {}) {
  loaderText.textContent = text || "Working…";
  loader.classList.add("on");
  if (opts.showProgress) {
    $("loaderProgressWrap").style.display = "block";
    updateLoaderProgress(0);
  } else {
    $("loaderProgressWrap").style.display = "none";
  }
}
function hideLoader() {
  loader.classList.remove("on");
}
function updateLoaderProgress(pct) {
  $("loaderProgressBar").style.width = pct + "%";
}

//  LOOP / RESIZE
function onWindowResize() {
  const container = $("canvas-container");
  const w = container.clientWidth;
  const h = container.clientHeight;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h);
}

function animate() {
  requestAnimationFrame(animate);
  controls.update();
  renderer.render(scene, camera);
}

//  THEME (shared with the City and Lab; OS preference unless toggled)
//  must run BEFORE init() so scene background reads the right theme
document.body.classList.toggle("dark", initialThemeIsDark());

// Until the user picks a side, follow the OS live.
watchSystemTheme((dark) => {
  document.body.classList.toggle("dark", dark);
  applySceneTheme();
  applyGridTheme();
});

function isDark() {
  return document.body.classList.contains("dark");
}

function applySceneTheme() {
  const bg = isDark() ? 0x15140f : 0xfaf9f5;
  scene.background = new THREE.Color(bg);
  const near = scene.fog ? scene.fog.near : 200;
  const far = scene.fog ? scene.fog.far : 1200;
  scene.fog = new THREE.Fog(bg, near, far);
}

function applyGridTheme() {
  if (!gridHelper) return;
  const center = isDark() ? 0x3a3830 : 0xc8c2b0;
  const grid = isDark() ? 0x2a2820 : 0xe6e2d6;
  gridHelper.material.color.setHex(grid);
  if (Array.isArray(gridHelper.material)) {
    gridHelper.material[0].color.setHex(center);
    gridHelper.material[1].color.setHex(grid);
  }
}

function toggleTheme() {
  const dark = !isDark();
  document.body.classList.toggle("dark", dark);
  storeTheme(dark); // only an explicit toggle pins the theme
  applySceneTheme();
  applyGridTheme();
}

//  HANDOFF —-> Cropper to & from Lab

async function openInLab() {
  if (!currentModel) {
    toast("Load a model first", "warn");
    return;
  }
  showLoader("Preparing for Lab…");
  const exporter = new GLTFExporter();
  const wasVisible = cutPlaneMesh.visible;
  cutPlaneMesh.visible = false;
  clearHighlights();
  exporter.parse(
    currentModel,
    async (glb) => {
      cutPlaneMesh.visible = wasVisible;
      renderHighlights();
      try {
        const base = currentFileName.replace(/\.(glb|gltf)$/i, "") || "model";
        await putHandoff("toLab", { name: `${base}.glb`, buffer: glb });
        location.href = "lab.html";
      } catch (err) {
        console.error(err);
        hideLoader();
        toast("Hand-off failed", "warn");
      }
    },
    (err) => {
      cutPlaneMesh.visible = wasVisible;
      renderHighlights();
      console.error(err);
      hideLoader();
      toast("Export failed", "warn");
    },
    { binary: true },
  );
}

// On load, check for an incoming model from Lab
(async function checkIncoming() {
  try {
    const payload = await takeHandoff("toEditor");
    if (payload) {
      const file = payloadToFile(payload);
      toast(`Loaded ${file.name} from Lab`, "accent");
      loadFile(file, { silent: true });
    }
  } catch (err) {
    console.warn("handoff check failed", err);
  }
})();
