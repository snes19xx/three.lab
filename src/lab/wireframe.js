import * as THREE from "three";
import { LineMaterial } from "three/addons/lines/LineMaterial.js";
import { LineSegments2 } from "three/addons/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/addons/lines/LineSegmentsGeometry.js";
import { lineResolution, sphere } from "./scene.js";
import { state } from "./state.js";

// Invisible mesh so raycasting still works when wireframe is on
const TRANSPARENT_MAT = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false });

const CLAY_MAT = new THREE.MeshStandardMaterial({
  color: 0xe0e0e0,
  roughness: 0.8,
  metalness: 0.1
});

function buildWireframeLines(meshGeo, color, linewidth) {
  const edgesGeo = new THREE.EdgesGeometry(meshGeo, 10);
  const lsgeo = new LineSegmentsGeometry();
  lsgeo.setPositions(edgesGeo.attributes.position.array);
  edgesGeo.dispose();
  const mat = new LineMaterial({ 
    color, 
    linewidth, 
    resolution: lineResolution.clone(), 
    worldUnits: false,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -1
  });
  const ls2 = new LineSegments2(lsgeo, mat);
  ls2.name = "__wf__";
  return ls2;
}

function enableWireframeOnMesh(child, color, linewidth) {
  if (!child.userData.originalMaterial) {
    child.userData.originalMaterial = child.material;
  }
  child.material = state.wireframeStyle === "transparent" ? TRANSPARENT_MAT : CLAY_MAT;
  if (!child.userData.wireframeLines) {
    const ls2 = buildWireframeLines(child.geometry, color, linewidth);
    child.add(ls2);
    child.userData.wireframeLines = ls2;
  }
}

function disableWireframeOnMesh(child) {
  if (!child.userData.originalMaterial) return;
  const ls2 = child.userData.wireframeLines;
  if (ls2) {
    ls2.geometry.dispose();
    ls2.material.dispose();
    child.remove(ls2);
    delete child.userData.wireframeLines;
  }
  child.material = child.userData.originalMaterial;
  delete child.userData.originalMaterial;
}

function updateWireframeColor(child, color) {
  if (child.userData.wireframeLines) child.userData.wireframeLines.material.color.set(color);
}

function updateWireframeLinewidth(child, linewidth) {
  if (child.userData.wireframeLines) child.userData.wireframeLines.material.linewidth = linewidth;
}

export function applyWireframeToTarget(target, color, linewidth, enable) {
  if (!target) return;
  target.traverse((child) => {
    if (!child.isMesh || child.name === "__wf__") return;
    if (enable) enableWireframeOnMesh(child, color, linewidth);
    else disableWireframeOnMesh(child);
  });
}

function getTarget() {
  return state.appMode === "texture" ? sphere : state.currentModel;
}

export function applyWireframe() {
  const color = document.getElementById("wireframeColor").value;
  applyWireframeToTarget(getTarget(), color, state.currentLinewidth, state.wireframeActive);
}

export function updateBodyColor(color) {
  CLAY_MAT.color.set(color);
}

export function updateAllWireframeColors() {
  const color  = document.getElementById("wireframeColor").value;
  const target = getTarget();
  if (!target) return;
  target.traverse((child) => { if (child.isMesh) updateWireframeColor(child, color); });
}

export function updateAllWireframeLinewidths() {
  const target = getTarget();
  if (!target) return;
  target.traverse((child) => { if (child.isMesh) updateWireframeLinewidth(child, state.currentLinewidth); });
}

export function resetWireframe() {
  state.wireframeActive = false;
  state.wireframeStyle = "transparent";
  document.getElementById("btnWireframe").classList.remove("active");
  const btnTech = document.getElementById("btnTechnical");
  if (btnTech) btnTech.classList.remove("active");
  document.getElementById("wireframeColor").disabled = true;
  document.getElementById("linewidth").disabled      = true;
  
  const bodyColorRow = document.getElementById("bodyColorRow");
  if (bodyColorRow) bodyColorRow.style.display = "none";
  const lblColor = document.getElementById("lblWireframeColor");
  if (lblColor) lblColor.textContent = "Color";
  
  CLAY_MAT.color.setHex(0xe0e0e0);
  const bodyColorInp = document.getElementById("bodyColor");
  if (bodyColorInp) {
    bodyColorInp.value = "#e0e0e0";
    document.getElementById("bodyColorHex").textContent = "#e0e0e0";
  }

  const teardown = (target) => {
    if (!target) return;
    target.traverse((child) => { if (child.isMesh) disableWireframeOnMesh(child); });
  };
  teardown(sphere);
  teardown(state.currentModel);
}
