import * as THREE from "three";
import { LineMaterial } from "three/addons/lines/LineMaterial.js";
import { LineSegments2 } from "three/addons/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/addons/lines/LineSegmentsGeometry.js";
import { lineResolution, sphere } from "./scene.js";
import { state } from "./state.js";

// Invisible mesh so raycasting still works when wireframe is on
const TRANSPARENT_MAT = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false });

function buildWireframeLines(meshGeo, color, linewidth) {
  const edgesGeo = new THREE.EdgesGeometry(meshGeo, 10);
  const lsgeo = new LineSegmentsGeometry();
  lsgeo.setPositions(edgesGeo.attributes.position.array);
  edgesGeo.dispose();
  const mat = new LineMaterial({ color, linewidth, resolution: lineResolution.clone(), worldUnits: false });
  const ls2 = new LineSegments2(lsgeo, mat);
  ls2.name = "__wf__";
  return ls2;
}

function enableWireframeOnMesh(child, color, linewidth) {
  if (child.userData.originalMaterial) return;
  child.userData.originalMaterial = child.material;
  child.material = TRANSPARENT_MAT;
  const ls2 = buildWireframeLines(child.geometry, color, linewidth);
  child.add(ls2);
  child.userData.wireframeLines = ls2;
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
  document.getElementById("btnWireframe").classList.remove("active");
  document.getElementById("wireframeColor").disabled = true;
  document.getElementById("linewidth").disabled      = true;

  const teardown = (target) => {
    if (!target) return;
    target.traverse((child) => { if (child.isMesh) disableWireframeOnMesh(child); });
  };
  teardown(sphere);
  teardown(state.currentModel);
}
