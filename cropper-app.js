import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { GLTFExporter } from "three/addons/exporters/GLTFExporter.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { DRACOLoader } from "three/addons/loaders/DRACOLoader.js";
import { payloadToFile, putHandoff, takeHandoff } from "./handoff.js";

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
let history = [];
let wireframe = false;
let keepSide = "front"; // 'front' | 'back'

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

const axes = ["X", "Y", "Z"];
const posSliders = axes.map((a) => $(`pos${a}Slider`));
const posNums = axes.map((a) => $(`pos${a}Num`));
const rotSliders = axes.map((a) => $(`rot${a}Slider`));
const rotNums = axes.map((a) => $(`rot${a}Num`));

const allInputs = [...posSliders, ...posNums, ...rotSliders, ...rotNums];

//  INIT
// Apply saved theme BEFORE init() builds the scene, so background reads correctly
document.body.classList.toggle(
  "dark",
  localStorage.getItem("mt-theme") === "dark",
);

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
  btnUndo.addEventListener("click", undoCrop);
  btnReload.addEventListener("click", reloadOriginal);
  btnExport.addEventListener("click", exportGLB);
  btnOpenInLab.addEventListener("click", openInLab);
  btnTheme.addEventListener("click", toggleTheme);

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
  cutPlaneMesh.position.set(
    +posSliders[0].value,
    +posSliders[1].value,
    +posSliders[2].value,
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
  draco.setDecoderPath("https://unpkg.com/three@0.160.0/examples/jsm/libs/draco/");
  const loader = new GLTFLoader();
  loader.setDRACOLoader(draco); // without this, draco-compressed models hang forever at loading
  loader.parse(
    buffer,
    "",
    (gltf) => {
      if (currentModel) {
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
      configureUIForModel(name, size);
      fitToModel();
      cutPlaneMesh.visible = true;
      tglPlane.classList.add("active");
      emptyState.classList.add("hide");
      hideLoader();
      if (!opts.silent) toast("Loaded " + name, "accent");
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

function configureUIForModel(name, fileSize) {
  // Rebuild plane sized to model so it always spans across
  buildCutPlane(modelSize * 2.2);
  cutPlaneMesh.visible = true;

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
  ].forEach((b) => (b.disabled = false));

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

function fitToModel() {
  if (!currentModel) return;
  computeModelBounds();
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

//  CROP
function applyCrop() {
  if (!currentModel) return;
  const isFront = keepSide === "front";

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
        newRoot.add(newMesh);
        croppedCount++;
      }
    });

    if (croppedCount === 0) {
      // pop the history we just pushed (no-op crop)
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
    computeModelBounds();
    updateMeta(currentFileName, null);
    updateStats();
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

  exporter.parse(
    currentModel,
    (glb) => {
      cutPlaneMesh.visible = wasVisible;
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
      hideLoader();
      console.error(err);
      toast("Export failed", "warn");
    },
    { binary: true },
  );
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

function showLoader(text) {
  loaderText.textContent = text || "Working…";
  loader.classList.add("on");
}
function hideLoader() {
  loader.classList.remove("on");
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

//  THEME (dark / light)
//  must run BEFORE init() so scene background reads the right theme
const THEME_KEY = "mt-theme";
(function loadTheme() {
  const saved = localStorage.getItem(THEME_KEY);
  document.body.classList.toggle("dark", saved === "dark");
})();

function isDark() {
  return document.body.classList.contains("dark");
}

function applySceneTheme() {
  const bg = isDark() ? 0x15140f : 0xfaf9f5;
  scene.background = new THREE.Color(bg);
  scene.fog = new THREE.Fog(bg, 200, 1200);
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
  localStorage.setItem(THEME_KEY, dark ? "dark" : "light");
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
  exporter.parse(
    currentModel,
    async (glb) => {
      cutPlaneMesh.visible = wasVisible;
      try {
        const base = currentFileName.replace(/\.(glb|gltf)$/i, "") || "model";
        await putHandoff("toLab", { name: `${base}.glb`, buffer: glb });
        location.href = "Lab.html";
      } catch (err) {
        console.error(err);
        hideLoader();
        toast("Hand-off failed", "warn");
      }
    },
    (err) => {
      cutPlaneMesh.visible = wasVisible;
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
    const payload = await takeHandoff("toCropper");
    if (payload) {
      const file = payloadToFile(payload);
      toast(`Loaded ${file.name} from Lab`, "accent");
      loadFile(file, { silent: true });
    }
  } catch (err) {
    console.warn("handoff check failed", err);
  }
})();
