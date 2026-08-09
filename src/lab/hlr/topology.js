// Welds a soup of world-space triangles into a shared vertex/edge topology.

const MAX_VERTS = 1 << 22;

export function buildTopology(triangleSoup, { weldEpsilon } = {}) {
  const { positions, triCount, triMaterial } = triangleSoup;

  // Weld tolerance scales with the model, so a 2 km city and a 2 cm bolt both
  // behave. Callers can override when they know better.
  let epsilon = weldEpsilon;
  if (epsilon == null) {
    let minX = Infinity,
      minY = Infinity,
      minZ = Infinity;
    let maxX = -Infinity,
      maxY = -Infinity,
      maxZ = -Infinity;
    for (let i = 0; i < positions.length; i += 3) {
      if (positions[i] < minX) minX = positions[i];
      if (positions[i] > maxX) maxX = positions[i];
      if (positions[i + 1] < minY) minY = positions[i + 1];
      if (positions[i + 1] > maxY) maxY = positions[i + 1];
      if (positions[i + 2] < minZ) minZ = positions[i + 2];
      if (positions[i + 2] > maxZ) maxZ = positions[i + 2];
    }
    const diagonal = Math.hypot(maxX - minX, maxY - minY, maxZ - minZ) || 1;
    epsilon = diagonal * 1e-6;
  }
  const inverseEpsilon = 1 / epsilon;

  const lookup = new Map();
  const vertX = [];
  const vertY = [];
  const vertZ = [];
  const cornerToVert = new Int32Array(triCount * 3);

  for (let corner = 0; corner < triCount * 3; corner++) {
    const x = positions[corner * 3];
    const y = positions[corner * 3 + 1];
    const z = positions[corner * 3 + 2];
    const key =
      Math.round(x * inverseEpsilon) +
      "|" +
      Math.round(y * inverseEpsilon) +
      "|" +
      Math.round(z * inverseEpsilon);

    let index = lookup.get(key);
    if (index === undefined) {
      index = vertX.length;
      if (index >= MAX_VERTS) {
        throw new Error("Model has too many distinct vertices to vectorise");
      }
      lookup.set(key, index);
      vertX.push(x);
      vertY.push(y);
      vertZ.push(z);
    }
    cornerToVert[corner] = index;
  }

  const vertexCount = vertX.length;
  const verts = new Float64Array(vertexCount * 3);
  for (let i = 0; i < vertexCount; i++) {
    verts[i * 3] = vertX[i];
    verts[i * 3 + 1] = vertY[i];
    verts[i * 3 + 2] = vertZ[i];
  }

  // Drop triangles that collapsed to a line or point during welding; they have
  // no meaningful normal and would poison the crease test.
  const tris = new Int32Array(triCount * 3);
  const triMat = new Int32Array(triCount);
  let kept = 0;
  for (let t = 0; t < triCount; t++) {
    const a = cornerToVert[t * 3];
    const b = cornerToVert[t * 3 + 1];
    const c = cornerToVert[t * 3 + 2];
    if (a === b || b === c || a === c) continue;
    tris[kept * 3] = a;
    tris[kept * 3 + 1] = b;
    tris[kept * 3 + 2] = c;
    triMat[kept] = triMaterial ? triMaterial[t] : 0;
    kept++;
  }

  const triangles = tris.subarray(0, kept * 3);
  const triangleMaterial = triMat.subarray(0, kept);
  const normals = computeFaceNormals(verts, triangles, kept);
  const edges = buildEdgeMap(triangles, kept);

  return {
    verts,
    vertexCount,
    triangles,
    triangleCount: kept,
    triangleMaterial,
    normals,
    edges,
    weldEpsilon: epsilon,
  };
}

function computeFaceNormals(verts, triangles, triangleCount) {
  const normals = new Float64Array(triangleCount * 3);
  for (let t = 0; t < triangleCount; t++) {
    const a = triangles[t * 3] * 3;
    const b = triangles[t * 3 + 1] * 3;
    const c = triangles[t * 3 + 2] * 3;

    const e1x = verts[b] - verts[a];
    const e1y = verts[b + 1] - verts[a + 1];
    const e1z = verts[b + 2] - verts[a + 2];
    const e2x = verts[c] - verts[a];
    const e2y = verts[c + 1] - verts[a + 1];
    const e2z = verts[c + 2] - verts[a + 2];

    let nx = e1y * e2z - e1z * e2y;
    let ny = e1z * e2x - e1x * e2z;
    let nz = e1x * e2y - e1y * e2x;
    const length = Math.hypot(nx, ny, nz) || 1;

    normals[t * 3] = nx / length;
    normals[t * 3 + 1] = ny / length;
    normals[t * 3 + 2] = nz / length;
  }
  return normals;
}

// edgeKey -> { v0, v1, faces[] }. Non-manifold edges (three or more faces)
// are kept as-is; the classifier treats anything that is not exactly two
// faces as a boundary, which is the visually correct fallback.
function buildEdgeMap(triangles, triangleCount) {
  const map = new Map();

  const add = (v0, v1, face) => {
    const lo = v0 < v1 ? v0 : v1;
    const hi = v0 < v1 ? v1 : v0;
    const key = lo * MAX_VERTS + hi;
    const existing = map.get(key);
    if (existing) existing.faces.push(face);
    else map.set(key, { v0: lo, v1: hi, faces: [face] });
  };

  for (let t = 0; t < triangleCount; t++) {
    const a = triangles[t * 3];
    const b = triangles[t * 3 + 1];
    const c = triangles[t * 3 + 2];
    add(a, b, t);
    add(b, c, t);
    add(c, a, t);
  }

  return [...map.values()];
}
