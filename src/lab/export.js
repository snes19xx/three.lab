import * as THREE from "three";
import {
  creditColourFor,
  creditComment,
  creditSVGMarkup,
  drawCreditOnCanvas,
} from "../shared/attribution.js";
import { showLoading } from "./loaders.js";
import {
  ambientLight,
  camera,
  dirLight,
  lineResolution,
  renderer,
  scene,
  sphere,
} from "./scene.js";
import { state } from "./state.js";

export function takeScreenshot() {
  const originalPixelRatio = renderer.getPixelRatio();
  const originalSize = new THREE.Vector2();
  renderer.getSize(originalSize);
  const originalAspect = camera.aspect;

  renderer.setPixelRatio(1);
  renderer.setSize(3840, 2160, false);
  camera.aspect = 3840 / 2160;
  camera.updateProjectionMatrix();

  lineResolution.set(3840, 2160);
  scene.traverse((obj) => {
    if (obj.isLineSegments2 && obj.material?.isLineMaterial) {
      obj.material.resolution.copy(lineResolution);
    }
  });

  renderer.render(scene, camera);

  // The WebGL canvas cannot be drawn on, so the frame is copied into a 2D
  // canvas and the credit goes on top of that.
  const composed = document.createElement("canvas");
  composed.width = 3840;
  composed.height = 2160;
  const ctx = composed.getContext("2d");
  ctx.drawImage(renderer.domElement, 0, 0, composed.width, composed.height);
  drawCreditOnCanvas(ctx, composed.width, composed.height);

  const a = document.createElement("a");
  a.download = `models-lab_${state.appMode === "glb" ? "model" : "surface"}.png`;
  a.href = composed.toDataURL("image/png");
  a.click();

  renderer.setPixelRatio(originalPixelRatio);
  renderer.setSize(originalSize.x, originalSize.y, false);
  camera.aspect = originalAspect;
  camera.updateProjectionMatrix();

  lineResolution.set(originalSize.x, originalSize.y);
  scene.traverse((obj) => {
    if (obj.isLineSegments2 && obj.material?.isLineMaterial) {
      obj.material.resolution.copy(lineResolution);
    }
  });

  renderer.render(scene, camera);
}

function svgClamp01(x) {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

function svgAces(x) {
  const a = 2.51,
    b = 0.03,
    c = 2.43,
    d = 0.59,
    e = 0.14;
  return svgClamp01((x * (a * x + b)) / (x * (c * x + d) + e));
}

function svgLinearToSRGB(c) {
  c = svgClamp01(c);
  return c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
}

function svgShadeColor(albedo, shade) {
  const r = Math.round(svgLinearToSRGB(svgAces(albedo.r * shade)) * 255);
  const g = Math.round(svgLinearToSRGB(svgAces(albedo.g * shade)) * 255);
  const b = Math.round(svgLinearToSRGB(svgAces(albedo.b * shade)) * 255);
  return `rgb(${r},${g},${b})`;
}

function buildSVGMarkup() {
  const target = state.appMode === "texture" ? sphere : state.currentModel;
  if (!target) return null;

  const size = new THREE.Vector2();
  renderer.getSize(size);
  const width = size.x;
  const height = size.y;
  if (!width || !height) return null;

  scene.updateMatrixWorld(true);
  camera.updateMatrixWorld(true);
  camera.updateProjectionMatrix();

  const vpMatrix = new THREE.Matrix4().multiplyMatrices(
    camera.projectionMatrix,
    camera.matrixWorldInverse,
  );
  const vpe = vpMatrix.elements;
  const ve = camera.matrixWorldInverse.elements;
  const cameraPos = new THREE.Vector3().setFromMatrixPosition(
    camera.matrixWorld,
  );
  const lightDir = new THREE.Vector3().copy(dirLight.position).normalize();
  const ambientI = ambientLight.intensity;
  const dirI = dirLight.intensity;

  const mode = state.wireframeActive
    ? state.wireframeStyle === "technical"
      ? "technical"
      : "wireframe"
    : "solid";
  const drawFills = mode !== "wireframe";
  const drawEdges = mode !== "solid";

  const f = (n) => Math.round(n * 100) / 100;
  const project = (x, y, z) => {
    const w = vpe[3] * x + vpe[7] * y + vpe[11] * z + vpe[15];
    if (w <= 1e-6) return null;
    const cx = vpe[0] * x + vpe[4] * y + vpe[8] * z + vpe[12];
    const cy = vpe[1] * x + vpe[5] * y + vpe[9] * z + vpe[13];
    return {
      x: ((cx / w) * 0.5 + 0.5) * width,
      y: ((-cy / w) * 0.5 + 0.5) * height,
    };
  };

  const meshes = [];
  target.traverse((c) => {
    if (c.isMesh && c.visible && c.name !== "__wf__" && c.geometry)
      meshes.push(c);
  });

  const v1 = new THREE.Vector3();
  const v2 = new THREE.Vector3();
  const v3 = new THREE.Vector3();
  const e1 = new THREE.Vector3();
  const e2 = new THREE.Vector3();
  const normal = new THREE.Vector3();
  const centroid = new THREE.Vector3();
  const viewDir = new THREE.Vector3();
  const whiteColor = new THREE.Color(1, 1, 1);

  const faces = [];

  if (drawFills) {
    for (const mesh of meshes) {
      const geometry = mesh.geometry;
      const posAttr = geometry.attributes.position;
      if (!posAttr) continue;
      const index = geometry.index;
      const wm = mesh.matrixWorld;
      const matIsArray = Array.isArray(mesh.material);
      const ranges =
        matIsArray && geometry.groups && geometry.groups.length
          ? geometry.groups
          : [
              {
                start: 0,
                count: index ? index.count : posAttr.count,
                materialIndex: 0,
              },
            ];

      for (const range of ranges) {
        const mat = matIsArray
          ? mesh.material[range.materialIndex] || mesh.material[0]
          : mesh.material;
        if (!mat || mat.visible === false) continue;
        const albedo = mat.color || whiteColor;
        const opacity =
          mat.transparent && mat.opacity != null ? mat.opacity : 1;
        if (opacity <= 0) continue;
        const end = range.start + range.count;

        for (let i = range.start; i < end; i += 3) {
          const a = index ? index.getX(i) : i;
          const b = index ? index.getX(i + 1) : i + 1;
          const c = index ? index.getX(i + 2) : i + 2;

          v1.fromBufferAttribute(posAttr, a).applyMatrix4(wm);
          v2.fromBufferAttribute(posAttr, b).applyMatrix4(wm);
          v3.fromBufferAttribute(posAttr, c).applyMatrix4(wm);

          const p1 = project(v1.x, v1.y, v1.z);
          const p2 = project(v2.x, v2.y, v2.z);
          const p3 = project(v3.x, v3.y, v3.z);
          if (!p1 || !p2 || !p3) continue;

          centroid.copy(v1).add(v2).add(v3).divideScalar(3);
          const z =
            ve[2] * centroid.x +
            ve[6] * centroid.y +
            ve[10] * centroid.z +
            ve[14];

          e1.subVectors(v2, v1);
          e2.subVectors(v3, v1);
          normal.crossVectors(e1, e2);
          if (normal.lengthSq() === 0) continue;
          normal.normalize();
          viewDir.subVectors(cameraPos, centroid).normalize();
          if (normal.dot(viewDir) < 0) normal.negate();

          const ndl = Math.max(0, normal.dot(lightDir));
          const shade = ambientI + ndl * dirI;
          faces.push({
            z,
            d: `M${f(p1.x)},${f(p1.y)}L${f(p2.x)},${f(p2.y)}L${f(p3.x)},${f(p3.y)}z`,
            fill: svgShadeColor(albedo, shade),
            op: opacity,
          });
        }
      }
    }
    faces.sort((p, q) => p.z - q.z);
  }

  let fillMarkup = "";
  let curFill = null,
    curOp = null,
    curD = "";
  for (const fc of faces) {
    if (fc.fill === curFill && fc.op === curOp) {
      curD += fc.d;
    } else {
      if (curD)
        fillMarkup += `<path d="${curD}" style="fill:${curFill};fill-opacity:${curOp}"></path>`;
      curFill = fc.fill;
      curOp = fc.op;
      curD = fc.d;
    }
  }
  if (curD)
    fillMarkup += `<path d="${curD}" style="fill:${curFill};fill-opacity:${curOp}"></path>`;

  let edgeMarkup = "";
  if (drawEdges) {
    const edgeColor =
      document.getElementById("wireframeColor").value || "#000000";
    const linewidth = state.currentLinewidth || 1;
    const ea = new THREE.Vector3();
    const eb = new THREE.Vector3();
    const segs = [];
    for (const mesh of meshes) {
      let eg;
      try {
        eg = new THREE.EdgesGeometry(mesh.geometry, 10);
      } catch (err) {
        continue;
      }
      const pos = eg.attributes.position;
      const wm = mesh.matrixWorld;
      for (let i = 0; i < pos.count; i += 2) {
        ea.fromBufferAttribute(pos, i).applyMatrix4(wm);
        eb.fromBufferAttribute(pos, i + 1).applyMatrix4(wm);
        const pa = project(ea.x, ea.y, ea.z);
        const pb = project(eb.x, eb.y, eb.z);
        if (!pa || !pb) continue;
        segs.push(`M${f(pa.x)},${f(pa.y)}L${f(pb.x)},${f(pb.y)}`);
      }
      eg.dispose();
    }
    if (segs.length) {
      edgeMarkup = `<path d="${segs.join("")}" style="fill:none;stroke:${edgeColor};stroke-opacity:1;stroke-width:${linewidth};stroke-linecap:round;stroke-linejoin:round"></path>`;
    }
  }

  const bg =
    scene.background && scene.background.getStyle
      ? scene.background.getStyle()
      : "rgb(10,10,10)";

  const credit = creditSVGMarkup(width, height, {
    fill: creditColourFor(bg) === "rgba(0,0,0,0.55)" ? "#333333" : "#dddddd",
  });

  return `<svg viewBox="0 0 ${f(width)} ${f(height)}" width="${f(width)}" height="${f(height)}" style="background-color: ${bg};" xmlns="http://www.w3.org/2000/svg" version="1.1">${fillMarkup}${edgeMarkup}${credit}</svg>`;
}

export function exportSVG() {
  showLoading(true, "Vectorizing");
  setTimeout(() => {
    try {
      const svgXML = buildSVGMarkup();
      if (!svgXML) {
        showLoading(false);
        return;
      }

      const suffix = state.wireframeActive ? "_wireframe" : "_solid";
      const blob = new Blob([svgXML], { type: "image/svg+xml;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `model_export${suffix}.svg`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      showLoading(false);
    } catch (err) {
      console.error("SVG export error:", err);
      showLoading(false);
    }
  }, 120);
}

// Converts any string to a valid JS identifier
function toId(str) {
  if (!str) return "";
  return str.replace(/[^a-zA-Z0-9_]/g, "_").replace(/^[0-9]/, "_$&");
}

// Traverses the loaded GLTF scene and generates a React Three Fiber component.
// This perfectly mirrors what gltfjsx does on the CLI but runs entirely in the browser.
function buildR3FCode(gltfScene, modelFilename, format) {
  const isTsx = format === "tsx";
  const compName = toId(modelFilename.replace(/\.[^.]+$/, "")) || "Model";

  const meshNodes = new Map(); // uuid -> sanitized node name
  const matNames = new Map(); // uuid -> sanitized material name
  const usedNames = new Set();
  let matIdx = 0;

  // Collect unique names for all meshes and materials
  gltfScene.traverse((obj) => {
    if (!obj.isMesh) return;

    let base = toId(obj.name) || "Mesh";
    let name = base,
      n = 0;
    while (usedNames.has(name)) name = `${base}_${++n}`;
    usedNames.add(name);
    meshNodes.set(obj.uuid, name);

    const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
    mats.forEach((m) => {
      if (m && !matNames.has(m.uuid))
        matNames.set(m.uuid, toId(m.name) || `Material${matIdx++}`);
    });
  });

  function nodeJSX(obj, depth) {
    const pad = "  ".repeat(depth);

    if (obj.isMesh) {
      const n = meshNodes.get(obj.uuid);
      const matName =
        !Array.isArray(obj.material) && obj.material
          ? matNames.get(obj.material.uuid)
          : null;
      const matProp = matName ? ` material={materials.${matName}}` : "";
      return `${pad}<mesh geometry={nodes.${n}.geometry}${matProp} />\n`;
    }

    if (obj.children?.length) {
      const body = obj.children.map((c) => nodeJSX(c, depth + 1)).join("");
      if (!body.trim()) return "";
      return `${pad}<group>\n${body}${pad}</group>\n`;
    }

    return "";
  }

  const inner = gltfScene.children.map((c) => nodeJSX(c, 3)).join("");
  const nodeList = [...meshNodes.values()];
  const matList = [...matNames.values()];

  const credit = creditComment();

  if (isTsx) {
    return `${credit}
import * as THREE from 'three'
import { useRef } from 'react'
import { useGLTF } from '@react-three/drei'
import { GLTF } from 'three-stdlib'

type GLTFResult = GLTF & {
  nodes: {
${nodeList.map((n) => `    ${n}: THREE.Mesh`).join("\n")}
  }
  materials: {
${matList.map((m) => `    ${m}: THREE.MeshStandardMaterial`).join("\n")}
  }
}

// Update '/model.glb' to match your file path in /public
export function ${compName}(props: JSX.IntrinsicElements['group']) {
  const { nodes, materials } = useGLTF('/model.glb') as GLTFResult
  return (
    <group {...props} dispose={null}>
${inner}    </group>
  )
}

useGLTF.preload('/model.glb')
`;
  }

  return `${credit}
import { useRef } from 'react'
import { useGLTF } from '@react-three/drei'

// Update '/model.glb' to match your file path in /public
export function ${compName}(props) {
  const { nodes, materials } = useGLTF('/model.glb')
  return (
    <group {...props} dispose={null}>
${inner}    </group>
  )
}

useGLTF.preload('/model.glb')
`;
}

export function exportR3F(format) {
  if (!state.currentModel) return;
  const filename =
    document.getElementById("subject-name").textContent || "Model";
  const code = buildR3FCode(state.currentModel, filename, format);
  const ext = format === "tsx" ? "tsx" : "jsx";
  const stem = toId(filename.replace(/\.[^.]+$/, "")) || "Model";
  const blob = new Blob([code], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${stem}.${ext}`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
