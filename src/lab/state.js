import * as THREE from "three";

export const state = {
  appMode: "texture",
  currentModel: null,
  currentTex: null,
  currentNorm: null,
  autoRotate: false,
  rotSpeed: 1.0,
  lightMode: "direct",
  wireframeActive: false,
  wireframeStyle: "transparent",
  currentLinewidth: 1.0,
  lightModeActive: false,
  glbInitCenter: new THREE.Vector3(),
  glbInitMaxDim: 1,
  // Stored at GLB load time so it can hand off to other apps without re-parsing
  glbOriginalBuffer: null,
  glbOriginalName: "",
};
