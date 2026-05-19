import { SVGRenderer } from "three/addons/renderers/SVGRenderer.js";
import { showLoading } from "./loaders.js";
import { camera, renderer, scene } from "./scene.js";
import { state } from "./state.js";

export function takeScreenshot() {
  renderer.render(scene, camera);
  const a = document.createElement("a");
  a.download = `models-lab_${state.appMode === "glb" ? "model" : "surface"}.png`;
  a.href = renderer.domElement.toDataURL("image/png");
  a.click();
}

export function exportSVG() {
  showLoading(true, "Vectorising");
  setTimeout(() => {
    try {
      const svgRenderer = new SVGRenderer();
      svgRenderer.setSize(window.innerWidth, window.innerHeight);
      svgRenderer.setClearColor(state.lightModeActive ? 0xfdfbf7 : 0x0a0a0a, 1);
      svgRenderer.render(scene, camera);

      const svgEl = svgRenderer.domElement;
      svgEl.setAttribute("xmlns", "http://www.w3.org/2000/svg");
      svgEl.setAttribute("version", "1.1");
      let svgXML = svgEl.outerHTML;
      if (!svgXML.includes("xmlns="))
        svgXML = svgXML.replace(
          "<svg",
          '<svg xmlns="http://www.w3.org/2000/svg" version="1.1"',
        );

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

  if (isTsx) {
    return `import * as THREE from 'three'
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

  return `import { useRef } from 'react'
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
