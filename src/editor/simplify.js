// Mesh simplification backed by meshoptimizer's quadric simplifier.
// It collapses edges on the index buffer while leaving vertex attributes
// (UVs, normals) intact on the survivors, so textures hold up far better than
// three's SimplifyModifier — and it's wasm-fast on large meshes.

import * as THREE from "three";
import * as BufferGeometryUtils from "three/addons/utils/BufferGeometryUtils.js";

const MESHOPT_URL =
  "https://unpkg.com/meshoptimizer@0.22.0/meshopt_simplifier.module.js";

let simplifierPromise = null;

function getSimplifier() {
  if (!simplifierPromise) {
    simplifierPromise = import(MESHOPT_URL).then(async (m) => {
      await m.MeshoptSimplifier.ready;
      return m.MeshoptSimplifier;
    });
  }
  return simplifierPromise;
}

// Keep only the vertices the new index buffer still references, carrying every
// attribute along, then reindex. Keeps vertex counts and file size honest.
function compact(geom, dstIndices) {
  const remap = new Map();
  const order = [];
  for (let i = 0; i < dstIndices.length; i++) {
    const o = dstIndices[i];
    if (!remap.has(o)) {
      remap.set(o, order.length);
      order.push(o);
    }
  }

  const out = new THREE.BufferGeometry();
  for (const name of Object.keys(geom.attributes)) {
    const src = geom.attributes[name];
    const size = src.itemSize;
    const Arr = src.array.constructor;
    const dst = new Arr(order.length * size);
    for (let n = 0; n < order.length; n++) {
      const o = order[n];
      for (let c = 0; c < size; c++) dst[n * size + c] = src.array[o * size + c];
    }
    out.setAttribute(name, new THREE.BufferAttribute(dst, size, src.normalized));
  }

  const index = new Uint32Array(dstIndices.length);
  for (let i = 0; i < dstIndices.length; i++) {
    index[i] = remap.get(dstIndices[i]);
  }
  out.setIndex(new THREE.BufferAttribute(index, 1));
  return out;
}

// Reduce a geometry's triangle count. `ratio` is the fraction of triangles to
// remove (0..1). Returns a new indexed BufferGeometry, or null if no
// meaningful reduction was possible.
export async function simplifyGeometry(geometry, ratio) {
  if (!geometry?.attributes?.position) return null;
  const simplifier = await getSimplifier();

  // Weld first: an indexed, non-interleaved, de-duplicated mesh. mergeVertices
  // hashes all attributes, so it won't fuse across UV/normal seams.
  const geom = BufferGeometryUtils.mergeVertices(geometry);
  if (!geom.index) return null;

  const indexCount = geom.index.count;
  if (indexCount < 6) return null;

  const idx = geom.index.array;
  const indices = idx instanceof Uint32Array ? idx : new Uint32Array(idx);
  const posArr = geom.attributes.position.array;
  const positions =
    posArr instanceof Float32Array ? posArr : new Float32Array(posArr);

  let target = Math.floor(indexCount * (1 - ratio));
  target -= target % 3;
  target = Math.max(3, target);
  if (target >= indexCount) return null;

  // A high error budget lets the requested ratio drive the result instead of
  // an error threshold, so the "Reduction %" slider stays honest.
  const [dstIndices] = simplifier.simplify(indices, positions, 3, target, 1.0, []);
  if (!dstIndices || dstIndices.length >= indexCount) return null;

  return compact(geom, dstIndices);
}
