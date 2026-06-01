import * as THREE from "three";
import { DRACOLoader } from "three/addons/loaders/DRACOLoader.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import {
  scene, camera, controls, renderer,
  sphere, sphereGroup, sphereMat, starPoints,
  texLoader, ktx2Loader,
} from "./scene.js";
import { state } from "./state.js";
import { resetWireframe } from "./wireframe.js";
import { applyLightMode } from "./lighting.js";

export function showLoading(on, msg = "Loading") {
  const overlay = document.getElementById("loading-overlay");
  overlay.querySelector(".loading-text").textContent = msg;
  overlay.classList.toggle("visible", on);
}

export function setMode(m) {
  state.appMode = m;
  document.body.classList.remove("mode-texture", "mode-glb");
  document.body.classList.add("mode-" + m);
}

export function disposeObject3D(obj) {
  if (!obj) return;
  obj.traverse((child) => {
    child.geometry?.dispose();
    const mats = [
      ...(Array.isArray(child.material) ? child.material : child.material ? [child.material] : []),
      ...(child.userData.originalMaterial
        ? Array.isArray(child.userData.originalMaterial)
          ? child.userData.originalMaterial
          : [child.userData.originalMaterial]
        : []),
    ];
    mats.forEach((m) => {
      if (!m) return;
      Object.values(m).forEach((v) => { if (v?.isTexture) v.dispose(); });
      m.dispose();
    });
  });
  scene.remove(obj);
}

export function resetCameraForTexture() {
  controls.target.set(0, 0, 0);
  controls.minDistance = 12;
  controls.maxDistance = 80;
  camera.position.set(0, 0, 26);
  camera.near = 0.1;
  camera.far  = 5000;
  camera.updateProjectionMatrix();
  controls.update();
}

export function resetCameraForGLB() {
  controls.target.copy(state.glbInitCenter);
  camera.position.set(
    state.glbInitCenter.x,
    state.glbInitCenter.y + state.glbInitMaxDim * 0.5,
    state.glbInitCenter.z + state.glbInitMaxDim * 1.6
  );
  camera.near          = state.glbInitMaxDim * 0.001;
  camera.far           = state.glbInitMaxDim * 100;
  controls.minDistance = state.glbInitMaxDim * 0.3;
  controls.maxDistance = state.glbInitMaxDim * 12;
  camera.updateProjectionMatrix();
  controls.update();
}

function markZoneLoaded(zone, dropText, file) {
  const mb = (file.size / (1024 * 1024)).toFixed(2);
  zone.classList.add("loaded", "compact");
  dropText.innerHTML =
    `<span class="loaded-name">${file.name}</span>` +
    `<span class="loaded-meta">${mb} MB</span>`;
}

export function loadTexture(file, isNormal = false) {
  if (!file) return;
  const url = URL.createObjectURL(file);
  const ext = file.name.split(".").pop().toLowerCase();
  const mb  = (file.size / (1024 * 1024)).toFixed(2);

  const zone      = document.getElementById(isNormal ? "normalZone"     : "primaryZone");
  const dropText  = document.getElementById(isNormal ? "normalDropText" : "primaryDropText");
  const fileStats = document.getElementById("fileStats");

  if (!isNormal) {
    showLoading(true, "Loading Surface");
    document.getElementById("subject-name").textContent = file.name;
    if (state.appMode === "glb") {
      resetWireframe();
      disposeObject3D(state.currentModel);
      state.currentModel  = null;
      sphereGroup.visible = true;
      starPoints.visible  = true;
      resetCameraForTexture();
      setMode("texture");
    }
    fileStats.className   = "";
    fileStats.textContent = "Loading…";
  }

  const onLoaded = (tex) => {
    if (isNormal) {
      if (state.currentNorm) state.currentNorm.dispose();
      tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
      sphereMat.normalMap   = tex;
      sphereMat.normalScale = new THREE.Vector2(
        parseFloat(document.getElementById("normalScale").value),
        parseFloat(document.getElementById("normalScale").value)
      );
      state.currentNorm = tex;
    } else {
      if (state.currentTex) state.currentTex.dispose();
      tex.colorSpace  = THREE.SRGBColorSpace;
      tex.anisotropy  = renderer.capabilities.getMaxAnisotropy();
      if (ext !== "ktx2") {
        tex.minFilter       = THREE.LinearMipmapLinearFilter;
        tex.generateMipmaps = true;
      }
      sphereMat.map = tex;
      sphereMat.color.setHex(0xffffff);
      state.currentTex    = tex;
      fileStats.className = "";
      fileStats.innerHTML =
        `<span class="stat-val">${file.name}</span><br>` +
        `<span class="stat-key">size &nbsp;</span><span class="stat-val">${mb} MB</span>` +
        `&ensp;<span class="stat-key">fmt &nbsp;</span><span class="stat-val">${ext.toUpperCase()}</span>`;
      showLoading(false);
    }
    sphereMat.needsUpdate = true;
    markZoneLoaded(zone, dropText, file);
    document.getElementById("viewportEmpty")?.classList.add("hide");
    if (typeof window.__labOnSubjectLoaded === "function") window.__labOnSubjectLoaded("texture");
  };

  const onError = (err) => {
    console.error("Texture error:", err);
    if (!isNormal) {
      fileStats.className   = "error";
      fileStats.textContent = "Error loading texture.";
      showLoading(false);
    }
  };

  ext === "ktx2" && !isNormal
    ? ktx2Loader.load(url, onLoaded, undefined, onError)
    : texLoader.load(url, onLoaded, undefined, onError);
}

export function loadGLB(file) {
  showLoading(true, "Parsing Model");
  document.getElementById("subject-name").textContent = file.name;
  const fileStats     = document.getElementById("fileStats");
  fileStats.className   = "";
  fileStats.textContent = "Parsing…";

  const mb  = (file.size / (1024 * 1024)).toFixed(2);
  const ext = file.name.split(".").pop().toLowerCase();

  const reader = new FileReader();
  reader.onload = (e) => {
    state.glbOriginalBuffer = e.target.result;
    state.glbOriginalName = file.name;

    const dracoLoader = new DRACOLoader();
    dracoLoader.setDecoderPath("https://unpkg.com/three@0.160.0/examples/jsm/libs/draco/");
    const loader = new GLTFLoader();
    loader.setDRACOLoader(dracoLoader);

    loader.parse(
      e.target.result,
      "",
      (gltf) => {
        resetWireframe();
        disposeObject3D(state.currentModel);
        state.currentModel  = gltf.scene;
        sphereGroup.visible = false;
        starPoints.visible  = false;
        setMode("glb");
        scene.add(state.currentModel);

        const box    = new THREE.Box3().setFromObject(state.currentModel);
        const center = box.getCenter(new THREE.Vector3());
        const size   = box.getSize(new THREE.Vector3());
        const maxDim = Math.max(size.x, size.y, size.z) || 1;

        // Auto-recenter if model is far from origin (more than 1% of its size)
        let recentered = false;
        if (center.length() > maxDim * 0.01) {
          state.currentModel.position.sub(center);
          center.set(0, 0, 0);
          recentered = true;
        }

        state.glbInitCenter.copy(center);
        state.glbInitMaxDim = maxDim;

        controls.target.copy(center);
        camera.position.set(center.x, center.y + maxDim * 0.5, center.z + maxDim * 1.6);
        camera.near          = maxDim * 0.001;
        camera.far           = maxDim * 100;
        controls.minDistance = maxDim * 0.3;
        controls.maxDistance = maxDim * 12;
        camera.updateProjectionMatrix();
        controls.update();

        applyLightMode(state.lightMode);

        fileStats.className = "";
        fileStats.innerHTML =
          `<span class="stat-val">${file.name}</span><br>` +
          `<span class="stat-key">size &nbsp;</span><span class="stat-val">${mb} MB</span>` +
          `&ensp;<span class="stat-key">fmt &nbsp;</span><span class="stat-val">${ext.toUpperCase()}</span>`;

        markZoneLoaded(
          document.getElementById("primaryZone"),
          document.getElementById("primaryDropText"),
          file
        );
        document.getElementById("viewportEmpty")?.classList.add("hide");
        if (typeof window.__labOnSubjectLoaded === "function") {
          window.__labOnSubjectLoaded("glb", { recentered });
        }
        showLoading(false);
      },
      (err) => {
        fileStats.className   = "error";
        fileStats.textContent = "Loader error: " + (err.message || "failed to parse.");
        showLoading(false);
      }
    );
  };
  reader.readAsArrayBuffer(file);
}
