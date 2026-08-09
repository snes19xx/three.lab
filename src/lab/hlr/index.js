// Three.js adapter for the hidden-line engine.

import * as THREE from "three";
import { classifyEdges } from "./classify.js";
import { removeHiddenLines } from "./occlude.js";
import { buildTopology } from "./topology.js";

export {
  EDGE_BOUNDARY,
  EDGE_CREASE,
  EDGE_MATERIAL,
  EDGE_SILHOUETTE,
} from "./classify.js";

// Flattens a subtree into world-space triangles, plus a material id per
// triangle so the classifier can outline colour changes.
export function collectTriangleSoup(root, { includeInvisible = false } = {}) {
  const meshes = [];
  root.updateMatrixWorld(true);
  root.traverse((child) => {
    if (!child.isMesh || !child.geometry) return;
    if (!includeInvisible && !child.visible) return;
    // The Lab's wireframe overlay is a display artefact, NOT geometry.
    if (child.name === "__wf__") return;
    meshes.push(child);
  });

  let triCount = 0;
  for (const mesh of meshes) {
    const position = mesh.geometry.attributes.position;
    if (!position) continue;
    triCount += Math.floor(
      (mesh.geometry.index ? mesh.geometry.index.count : position.count) / 3,
    );
  }

  const positions = new Float64Array(triCount * 9);
  const triMaterial = new Int32Array(triCount);
  const materialIds = new Map();
  const vector = new THREE.Vector3();

  let out = 0;
  for (const mesh of meshes) {
    const geometry = mesh.geometry;
    const position = geometry.attributes.position;
    if (!position) continue;
    const index = geometry.index;
    const matrix = mesh.matrixWorld;
    const count = index ? index.count : position.count;

    // Multi-material meshes carry one group per material range.
    const groups =
      Array.isArray(mesh.material) && geometry.groups?.length
        ? geometry.groups
        : [{ start: 0, count, materialIndex: 0 }];

    for (const group of groups) {
      const material = Array.isArray(mesh.material)
        ? mesh.material[group.materialIndex] || mesh.material[0]
        : mesh.material;

      const key = material?.uuid ?? "none";
      let materialId = materialIds.get(key);
      if (materialId === undefined) {
        materialId = materialIds.size;
        materialIds.set(key, materialId);
      }

      const end = Math.min(group.start + group.count, count);
      for (let i = group.start; i + 2 < end; i += 3) {
        for (let k = 0; k < 3; k++) {
          const v = index ? index.getX(i + k) : i + k;
          vector.fromBufferAttribute(position, v).applyMatrix4(matrix);
          positions[out * 9 + k * 3] = vector.x;
          positions[out * 9 + k * 3 + 1] = vector.y;
          positions[out * 9 + k * 3 + 2] = vector.z;
        }
        triMaterial[out] = materialId;
        out++;
      }
    }
  }

  return {
    positions: positions.subarray(0, out * 9),
    triCount: out,
    triMaterial: triMaterial.subarray(0, out),
    materialCount: materialIds.size,
  };
}

export function computeLineArt({
  root,
  camera,
  width,
  height,
  options = {},
  onProgress,
}) {
  onProgress?.(0.02, "Collecting geometry");
  const soup = collectTriangleSoup(root);
  if (soup.triCount === 0) return null;

  onProgress?.(0.1, `Welding ${soup.triCount.toLocaleString()} triangles`);
  const topology = buildTopology(soup, { weldEpsilon: options.weldEpsilon });

  camera.updateMatrixWorld(true);
  camera.updateProjectionMatrix();

  const viewProjection = new THREE.Matrix4().multiplyMatrices(
    camera.projectionMatrix,
    camera.matrixWorldInverse,
  );
  const cameraPosition = new THREE.Vector3().setFromMatrixPosition(
    camera.matrixWorld,
  );
  const viewDirection = new THREE.Vector3(0, 0, -1).applyQuaternion(
    camera.quaternion,
  );
  const orthographic = !!camera.isOrthographicCamera;

  const cameraArray = [cameraPosition.x, cameraPosition.y, cameraPosition.z];
  const viewArray = [viewDirection.x, viewDirection.y, viewDirection.z];

  onProgress?.(0.2, "Classifying edges");
  const edges = classifyEdges(topology, cameraArray, {
    creaseAngleDeg: options.creaseAngleDeg,
    includeBoundary: options.includeBoundary,
    includeCrease: options.includeCrease,
    includeSilhouette: options.includeSilhouette,
    includeMaterial: options.includeMaterial,
    orthographic,
    viewDirection: viewArray,
  });

  const result = removeHiddenLines(
    topology,
    edges,
    {
      viewProjection: new Float64Array(viewProjection.elements),
      cameraPosition: cameraArray,
      width,
      height,
      orthographic,
      viewDirection: viewArray,
    },
    options,
    onProgress,
  );

  return {
    ...result,
    width,
    height,
    triangleCount: topology.triangleCount,
    vertexCount: topology.vertexCount,
    candidateEdges: edges.length,
  };
}
