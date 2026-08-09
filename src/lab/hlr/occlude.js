// True hidden-line removal.
//
// Projects each edge into screen space, finds the portions occluded by solid
// geometry, and emits only the visible parts. Edges are parameterized by
// screen-space u in [0,1], with occluders producing hidden intervals that are
// subtracted from the edge.
//
// Depth is compared using triangle-plane tests rather than a depth buffer.
// Under perspective, screen position is not linear in the 3D edge parameter,
// so `tFromU` handles the conversion.
//
// Geometry is clipped against the OpenGL near plane, z + w = 0. Clipping
// against w > 0 would place new vertices at the eye and send them to infinity
// after the perspective divide. Only edges crossing the near plane are affected.

const CLIP_W_EPSILON = 1e-6;
const nearDistance = (z, w) => z + w;

export function removeHiddenLines(
  topology,
  edges,
  view,
  options = {},
  onProgress,
) {
  const {
    viewProjection, // Float64Array(16), column-major (Three.js order)
    cameraPosition,
    width,
    height,
    orthographic = false,
    viewDirection = null,
  } = view;

  const {
    cullBackFaces = true,
    gridCells = 0, // 0 = choose from triangle count
    planeEpsilon: planeEpsilonOption,
    chunkTriangles = 20000,
  } = options;

  const { verts, vertexCount, triangles, triangleCount, normals } = topology;

  // Coplanar tolerance.
  const planeEpsilon = planeEpsilonOption ?? estimateScale(verts) * 1e-5;

  //  1. PROJECT EVERY VERTEX ONCE
  const clip = new Float64Array(vertexCount * 4);
  const screen = new Float64Array(vertexCount * 2);
  projectVertices(
    verts,
    vertexCount,
    viewProjection,
    width,
    height,
    clip,
    screen,
  );

  //  2. BUILD OCCLUDERS
  const occluders = buildOccluders({
    verts,
    triangles,
    triangleCount,
    normals,
    clip,
    screen,
    width,
    height,
    cameraPosition,
    orthographic,
    viewDirection,
    cullBackFaces,
  });

  onProgress?.(0.35, `${occluders.count.toLocaleString()} occluders`);

  //  3. SPATIAL INDEX
  const grid = buildGrid(occluders, width, height, gridCells);
  onProgress?.(0.45, `${grid.cols}×${grid.rows} grid`);

  //  4. CLIP EACH EDGE
  const polylines = [];
  const stamp = new Int32Array(occluders.count).fill(-1);
  const hidden = [];
  let processed = 0;

  for (let e = 0; e < edges.length; e++) {
    const edge = edges[e];
    const nearClipped = clipEdgeToNearPlane(
      edge,
      verts,
      clip,
      screen,
      width,
      height,
    );
    if (!nearClipped) continue;
    const segment = clipSegmentToViewport(nearClipped, width, height);
    if (!segment) continue;

    hidden.length = 0;
    accumulateHiddenIntervals(
      segment,
      edge,
      occluders,
      grid,
      stamp,
      e,
      cameraPosition,
      orthographic,
      viewDirection,
      planeEpsilon,
      hidden,
    );

    emitVisible(segment, hidden, edge, polylines);

    if ((++processed & 1023) === 0) {
      onProgress?.(
        0.45 + 0.5 * (e / edges.length),
        `${e.toLocaleString()} / ${edges.length.toLocaleString()} edges`,
      );
    }
  }

  onProgress?.(1, "Done");
  return { polylines, occluderCount: occluders.count, edgeCount: edges.length };
}

//  PROJECTION

function estimateScale(verts) {
  let minX = Infinity,
    minY = Infinity,
    minZ = Infinity;
  let maxX = -Infinity,
    maxY = -Infinity,
    maxZ = -Infinity;
  for (let i = 0; i < verts.length; i += 3) {
    if (verts[i] < minX) minX = verts[i];
    if (verts[i] > maxX) maxX = verts[i];
    if (verts[i + 1] < minY) minY = verts[i + 1];
    if (verts[i + 1] > maxY) maxY = verts[i + 1];
    if (verts[i + 2] < minZ) minZ = verts[i + 2];
    if (verts[i + 2] > maxZ) maxZ = verts[i + 2];
  }
  return Math.hypot(maxX - minX, maxY - minY, maxZ - minZ) || 1;
}

function projectVertices(verts, vertexCount, m, width, height, clip, screen) {
  for (let i = 0; i < vertexCount; i++) {
    const x = verts[i * 3];
    const y = verts[i * 3 + 1];
    const z = verts[i * 3 + 2];

    const cx = m[0] * x + m[4] * y + m[8] * z + m[12];
    const cy = m[1] * x + m[5] * y + m[9] * z + m[13];
    const cz = m[2] * x + m[6] * y + m[10] * z + m[14];
    const cw = m[3] * x + m[7] * y + m[11] * z + m[15];

    clip[i * 4] = cx;
    clip[i * 4 + 1] = cy;
    clip[i * 4 + 2] = cz;
    clip[i * 4 + 3] = cw;

    if (cw > CLIP_W_EPSILON) {
      screen[i * 2] = ((cx / cw) * 0.5 + 0.5) * width;
      screen[i * 2 + 1] = ((-cy / cw) * 0.5 + 0.5) * height;
    } else {
      screen[i * 2] = NaN;
      screen[i * 2 + 1] = NaN;
    }
  }
}

//  OCCLUDERS
//
// Each occluder is a convex screen-space polygon (the triangle, near-clipped,
// so 3 or 4 corners) plus the plane of the original 3D triangle. Clipping
// never moves the plane, so it gwets correct depth tests for triangles that
// straddle the near plane without ever building new 3D vertices.

function buildOccluders(input) {
  const {
    verts,
    triangles,
    triangleCount,
    normals,
    clip,
    screen,
    width,
    height,
    cameraPosition,
    orthographic,
    viewDirection,
    cullBackFaces,
  } = input;

  const maxCorners = triangleCount * 4;
  const polyX = new Float64Array(maxCorners);
  const polyY = new Float64Array(maxCorners);
  const polyStart = new Int32Array(triangleCount);
  const polyLength = new Int32Array(triangleCount);
  const planeNX = new Float64Array(triangleCount);
  const planeNY = new Float64Array(triangleCount);
  const planeNZ = new Float64Array(triangleCount);
  const planeD = new Float64Array(triangleCount);
  const minX = new Float64Array(triangleCount);
  const minY = new Float64Array(triangleCount);
  const maxX = new Float64Array(triangleCount);
  const maxY = new Float64Array(triangleCount);
  const sourceTri = new Int32Array(triangleCount);
  const windingSign = new Int8Array(triangleCount);

  // Scratch for near-plane clipping in homogeneous space.
  const inX = new Float64Array(8),
    inY = new Float64Array(8);
  const inZ = new Float64Array(8),
    inW = new Float64Array(8);
  const outX = new Float64Array(8),
    outY = new Float64Array(8);
  const outZ = new Float64Array(8),
    outW = new Float64Array(8);

  let count = 0;
  let cursor = 0;

  for (let t = 0; t < triangleCount; t++) {
    const nx = normals[t * 3];
    const ny = normals[t * 3 + 1];
    const nz = normals[t * 3 + 2];

    const a = triangles[t * 3];
    const ax = verts[a * 3],
      ay = verts[a * 3 + 1],
      az = verts[a * 3 + 2];
    const d = nx * ax + ny * ay + nz * az;

    if (cullBackFaces) {
      // A back face of a closed solid is always behind one of its own front
      // faces, so it can never be the thing that hides an edge.
      const facing = orthographic
        ? -(
            nx * viewDirection[0] +
            ny * viewDirection[1] +
            nz * viewDirection[2]
          )
        : nx * (cameraPosition[0] - ax) +
          ny * (cameraPosition[1] - ay) +
          nz * (cameraPosition[2] - az);
      if (facing <= 0) continue;
    }

    for (let k = 0; k < 3; k++) {
      const v = triangles[t * 3 + k];
      inX[k] = clip[v * 4];
      inY[k] = clip[v * 4 + 1];
      inZ[k] = clip[v * 4 + 2];
      inW[k] = clip[v * 4 + 3];
    }

    const corners = clipPolygonToNearPlane(
      inX,
      inY,
      inZ,
      inW,
      3,
      outX,
      outY,
      outZ,
      outW,
    );
    if (corners < 3) continue;

    let bx0 = Infinity,
      by0 = Infinity,
      bx1 = -Infinity,
      by1 = -Infinity;
    const start = cursor;
    for (let k = 0; k < corners; k++) {
      const w = outW[k];
      const sx = ((outX[k] / w) * 0.5 + 0.5) * width;
      const sy = ((-outY[k] / w) * 0.5 + 0.5) * height;
      polyX[cursor] = sx;
      polyY[cursor] = sy;
      cursor++;
      if (sx < bx0) bx0 = sx;
      if (sx > bx1) bx1 = sx;
      if (sy < by0) by0 = sy;
      if (sy > by1) by1 = sy;
    }

    // Entirely off-screen occluders can never hide an on-screen edge.
    if (bx1 < 0 || by1 < 0 || bx0 > width || by0 > height) {
      cursor = start;
      continue;
    }

    // Winding decides which way the inward edge normals point; computing it
    // once here keeps it out of the edge-vs-triangle inner loop.
    let area = 0;
    for (let k = 0; k < corners; k++) {
      const i0 = start + k;
      const i1 = start + ((k + 1) % corners);
      area += polyX[i0] * polyY[i1] - polyX[i1] * polyY[i0];
    }
    if (area === 0) {
      cursor = start;
      continue;
    }
    windingSign[count] = area > 0 ? 1 : -1;

    polyStart[count] = start;
    polyLength[count] = corners;
    planeNX[count] = nx;
    planeNY[count] = ny;
    planeNZ[count] = nz;
    planeD[count] = d;
    minX[count] = bx0;
    minY[count] = by0;
    maxX[count] = bx1;
    maxY[count] = by1;
    sourceTri[count] = t;
    count++;
  }

  return {
    count,
    polyX,
    polyY,
    polyStart,
    polyLength,
    windingSign,
    planeNX,
    planeNY,
    planeNZ,
    planeD,
    minX,
    minY,
    maxX,
    maxY,
    sourceTri,
  };
}

// Sutherland-Hodgman against w >= epsilon, in homogeneous clip space.
function clipPolygonToNearPlane(inX, inY, inZ, inW, n, outX, outY, outZ, outW) {
  let out = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const di = nearDistance(inZ[i], inW[i]);
    const dj = nearDistance(inZ[j], inW[j]);
    const insideI = di > 0;
    const insideJ = dj > 0;

    if (insideI) {
      outX[out] = inX[i];
      outY[out] = inY[i];
      outZ[out] = inZ[i];
      outW[out] = inW[i];
      out++;
    }
    if (insideI !== insideJ) {
      const s = di / (di - dj);
      outX[out] = inX[i] + s * (inX[j] - inX[i]);
      outY[out] = inY[i] + s * (inY[j] - inY[i]);
      outZ[out] = inZ[i] + s * (inZ[j] - inZ[i]);
      outW[out] = inW[i] + s * (inW[j] - inW[i]);
      out++;
    }
  }
  return out;
}

//  EDGE PREPARATION

// Returns the visible-side portion of an edge, or null if it is entirely
// behind the camera. Screen endpoints are the projections of the clipped 3D
// endpoints, so u in [0,1] spans exactly the drawable part.
function clipEdgeToNearPlane(edge, verts, clip, screen, width, height) {
  const a = edge.v0,
    b = edge.v1;
  let wA = clip[a * 4 + 3];
  let wB = clip[b * 4 + 3];
  const dA = nearDistance(clip[a * 4 + 2], wA);
  const dB = nearDistance(clip[b * 4 + 2], wB);
  const inA = dA > 0;
  const inB = dB > 0;
  if (!inA && !inB) return null;

  let ax = verts[a * 3],
    ay = verts[a * 3 + 1],
    az = verts[a * 3 + 2];
  let bx = verts[b * 3],
    by = verts[b * 3 + 1],
    bz = verts[b * 3 + 2];
  let sax, say, sbx, sby;

  if (inA && inB) {
    sax = screen[a * 2];
    say = screen[a * 2 + 1];
    sbx = screen[b * 2];
    sby = screen[b * 2 + 1];
  } else {
    // Split at the near plane and keep the half in front of it.
    const s = dA / (dA - dB);
    const cx = clip[a * 4] + s * (clip[b * 4] - clip[a * 4]);
    const cy = clip[a * 4 + 1] + s * (clip[b * 4 + 1] - clip[a * 4 + 1]);
    const cw = wA + s * (wB - wA);
    if (!(Math.abs(cw) > CLIP_W_EPSILON)) return null;

    const px = ax + s * (bx - ax);
    const py = ay + s * (by - ay);
    const pz = az + s * (bz - az);
    const sx = ((cx / cw) * 0.5 + 0.5) * width;
    const sy = ((-cy / cw) * 0.5 + 0.5) * height;

    if (inA) {
      sax = screen[a * 2];
      say = screen[a * 2 + 1];
      sbx = sx;
      sby = sy;
      bx = px;
      by = py;
      bz = pz;
      wB = cw;
    } else {
      sax = sx;
      say = sy;
      sbx = screen[b * 2];
      sby = screen[b * 2 + 1];
      ax = px;
      ay = py;
      az = pz;
      wA = cw;
    }
  }

  if (!Number.isFinite(sax) || !Number.isFinite(sbx)) return null;

  return { ax, ay, az, bx, by, bz, wA, wB, sax, say, sbx, sby };
}

// Restricts a segment to the part that lands on the canvas, re-parametrising

function clipSegmentToViewport(seg, width, height) {
  const x0 = seg.sax;
  const y0 = seg.say;
  const dx = seg.sbx - x0;
  const dy = seg.sby - y0;

  let lo = 0;
  let hi = 1;
  const bounds = [
    [-dx, x0],
    [dx, width - x0],
    [-dy, y0],
    [dy, height - y0],
  ];

  for (const [p, q] of bounds) {
    if (p === 0) {
      if (q < 0) return null; // parallel to this edge, outside it
      continue;
    }
    const r = q / p;
    if (p < 0) {
      if (r > hi) return null;
      if (r > lo) lo = r;
    } else {
      if (r < lo) return null;
      if (r < hi) hi = r;
    }
  }
  if (!(lo < hi)) return null;
  if (lo === 0 && hi === 1) return seg;

  // Screen parameters map back through perspective to 3D parameters.
  const tLo = tFromU(lo, seg.wA, seg.wB);
  const tHi = tFromU(hi, seg.wA, seg.wB);
  const at = (t, a, b) => a + t * (b - a);

  return {
    ax: at(tLo, seg.ax, seg.bx),
    ay: at(tLo, seg.ay, seg.by),
    az: at(tLo, seg.az, seg.bz),
    bx: at(tHi, seg.ax, seg.bx),
    by: at(tHi, seg.ay, seg.by),
    bz: at(tHi, seg.az, seg.bz),
    // w is linear in the 3D parameter.
    wA: at(tLo, seg.wA, seg.wB),
    wB: at(tHi, seg.wA, seg.wB),
    sax: x0 + lo * dx,
    say: y0 + lo * dy,
    sbx: x0 + hi * dx,
    sby: y0 + hi * dy,
  };
}

// Screen parameter u -> 3D parameter t. Perspective makes this non-linear;
// getting it wrong puts depth comparisons in the wrong place along the edge.
function tFromU(u, wA, wB) {
  const denom = wB + u * (wA - wB);
  if (Math.abs(denom) < 1e-12) return u;
  return (u * wA) / denom;
}

//  HIDDEN INTERVAL ACCUMULATION

function accumulateHiddenIntervals(
  seg,
  edge,
  occ,
  grid,
  stamp,
  stampValue,
  cameraPosition,
  orthographic,
  viewDirection,
  planeEpsilon,
  out,
) {
  const faces = edge.faces;
  const f0 = faces[0],
    f1 = faces.length > 1 ? faces[1] : -1;

  const dx = seg.sbx - seg.sax;
  const dy = seg.sby - seg.say;

  forEachCandidate(grid, seg.sax, seg.say, seg.sbx, seg.sby, (o) => {
    if (stamp[o] === stampValue) return;
    stamp[o] = stampValue;

    // An edge is never hidden by a face it belongs to.
    const src = occ.sourceTri[o];
    if (src === f0 || src === f1) return;

    // Cheap screen-space rejection before any real work.
    if (occ.maxX[o] < Math.min(seg.sax, seg.sbx)) return;
    if (occ.minX[o] > Math.max(seg.sax, seg.sbx)) return;
    if (occ.maxY[o] < Math.min(seg.say, seg.sby)) return;
    if (occ.minY[o] > Math.max(seg.say, seg.sby)) return;

    const nx = occ.planeNX[o],
      ny = occ.planeNY[o],
      nz = occ.planeNZ[o];
    const d = occ.planeD[o];

    const fA = nx * seg.ax + ny * seg.ay + nz * seg.az - d;
    const fB = nx * seg.bx + ny * seg.by + nz * seg.bz - d;

    // The edge lies in this triangle's own plane: coplanar geometry must not
    // occlude
    if (Math.abs(fA) < planeEpsilon && Math.abs(fB) < planeEpsilon) return;

    // Which side is the camera on? Anything on that side is in front.
    const fCam = orthographic
      ? -(nx * viewDirection[0] + ny * viewDirection[1] + nz * viewDirection[2])
      : nx * cameraPosition[0] +
        ny * cameraPosition[1] +
        nz * cameraPosition[2] -
        d;
    if (fCam === 0) return;
    const cameraSide = fCam > 0 ? 1 : -1;

    // Split the edge where it pierces the plane
    let splits = 0;
    let uSplit = 0;
    if (fA > 0 !== fB > 0) {
      const t = fA / (fA - fB);
      if (t > 0 && t < 1) {
        // 3D parameter -> screen parameter.
        const denom = seg.wA + t * (seg.wB - seg.wA);
        uSplit = Math.abs(denom) < 1e-12 ? t : (t * seg.wB) / denom;
        if (uSplit > 1e-9 && uSplit < 1 - 1e-9) splits = 1;
      }
    }

    const ranges = splits
      ? [
          [0, uSplit],
          [uSplit, 1],
        ]
      : [[0, 1]];

    for (const [r0, r1] of ranges) {
      const mid = (r0 + r1) * 0.5;
      const tMid = tFromU(mid, seg.wA, seg.wB);
      const px = seg.ax + tMid * (seg.bx - seg.ax);
      const py = seg.ay + tMid * (seg.by - seg.ay);
      const pz = seg.az + tMid * (seg.bz - seg.az);
      const fMid = nx * px + ny * py + nz * pz - d;

      // In front of the occluder's plane, or too close to call: keep it.
      if (Math.abs(fMid) < planeEpsilon) continue;
      if ((fMid > 0 ? 1 : -1) === cameraSide) continue;

      // Behind the plane — hidden wherever it also overlaps the triangle.
      const clipped = clipSegmentToPolygon(
        occ,
        o,
        seg.sax,
        seg.say,
        dx,
        dy,
        r0,
        r1,
      );
      if (clipped) out.push(clipped);
    }
  });
}

// Parametric clip of the 2D segment against a convex polygon, restricted to
// [lo, hi]. Returns [lo', hi'] or null.
function clipSegmentToPolygon(occ, o, ax, ay, dx, dy, lo, hi) {
  const start = occ.polyStart[o];
  const n = occ.polyLength[o];
  const px = occ.polyX,
    py = occ.polyY;
  const sign = occ.windingSign[o];

  for (let i = 0; i < n; i++) {
    const k = start + i;
    const j = start + ((i + 1) % n);
    const ex = px[j] - px[k];
    const ey = py[j] - py[k];
    // Inward normal for this winding.
    const nx = -ey * sign;
    const ny = ex * sign;

    const num = (ax - px[k]) * nx + (ay - py[k]) * ny;
    const den = dx * nx + dy * ny;

    if (Math.abs(den) < 1e-12) {
      if (num < 0) return null; // parallel and outside
      continue;
    }
    const u = -num / den;
    if (den > 0) {
      if (u > lo) lo = u;
    } else {
      if (u < hi) hi = u;
    }
    if (lo >= hi) return null;
  }

  return lo < hi ? [lo, hi] : null;
}

//  VISIBLE OUTPUT

function emitVisible(seg, hidden, edge, out) {
  const ax = seg.sax,
    ay = seg.say;
  const dx = seg.sbx - ax,
    dy = seg.sby - ay;

  const push = (u0, u1) => {
    if (u1 - u0 < 1e-6) return;
    out.push({
      kind: edge.kind,
      points: [ax + u0 * dx, ay + u0 * dy, ax + u1 * dx, ay + u1 * dy],
    });
  };

  if (hidden.length === 0) {
    push(0, 1);
    return;
  }

  // Sweep the sorted hidden intervals and emit the gaps between them.
  hidden.sort((p, q) => p[0] - q[0]);
  let cursor = 0;
  for (let i = 0; i < hidden.length; i++) {
    const lo = hidden[i][0];
    const hi = hidden[i][1];
    if (lo > cursor) push(cursor, lo < 1 ? lo : 1);
    if (hi > cursor) cursor = hi;
    if (cursor >= 1) return;
  }
  if (cursor < 1) push(cursor, 1);
}

//  UNIFORM GRID

function buildGrid(occ, width, height, requestedCells) {
  const cells =
    requestedCells > 0
      ? requestedCells
      : Math.max(8, Math.min(256, Math.round(Math.sqrt(occ.count / 2)) || 8));
  const cols = cells;
  const rows = cells;
  const cellW = width / cols;
  const cellH = height / rows;

  const counts = new Int32Array(cols * rows + 1);
  const clampCol = (v) => (v < 0 ? 0 : v >= cols ? cols - 1 : v);
  const clampRow = (v) => (v < 0 ? 0 : v >= rows ? rows - 1 : v);

  for (let o = 0; o < occ.count; o++) {
    const c0 = clampCol(Math.floor(occ.minX[o] / cellW));
    const c1 = clampCol(Math.floor(occ.maxX[o] / cellW));
    const r0 = clampRow(Math.floor(occ.minY[o] / cellH));
    const r1 = clampRow(Math.floor(occ.maxY[o] / cellH));
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) counts[r * cols + c + 1]++;
    }
  }
  for (let i = 0; i < cols * rows; i++) counts[i + 1] += counts[i];

  const items = new Int32Array(counts[cols * rows]);
  const fill = counts.slice(0, cols * rows);
  for (let o = 0; o < occ.count; o++) {
    const c0 = clampCol(Math.floor(occ.minX[o] / cellW));
    const c1 = clampCol(Math.floor(occ.maxX[o] / cellW));
    const r0 = clampRow(Math.floor(occ.minY[o] / cellH));
    const r1 = clampRow(Math.floor(occ.maxY[o] / cellH));
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) items[fill[r * cols + c]++] = o;
    }
  }

  return { cols, rows, cellW, cellH, offsets: counts, items };
}

function forEachCandidate(grid, x0, y0, x1, y1, visit) {
  const { cols, rows, cellW, cellH, offsets, items } = grid;

  const clampCol = (v) => (v < 0 ? 0 : v >= cols ? cols - 1 : v);
  const clampRow = (v) => (v < 0 ? 0 : v >= rows ? rows - 1 : v);

  let c = clampCol(Math.floor(x0 / cellW));
  let r = clampRow(Math.floor(y0 / cellH));
  const cEnd = clampCol(Math.floor(x1 / cellW));
  const rEnd = clampRow(Math.floor(y1 / cellH));

  const emit = (cc, rr) => {
    const cell = rr * cols + cc;
    for (let i = offsets[cell]; i < offsets[cell + 1]; i++) visit(items[i]);
  };

  if (c === cEnd && r === rEnd) {
    emit(c, r);
    return;
  }

  const dx = x1 - x0;
  const dy = y1 - y0;
  const stepC = dx > 0 ? 1 : -1;
  const stepR = dy > 0 ? 1 : -1;

  const tDeltaX = dx !== 0 ? Math.abs(cellW / dx) : Infinity;
  const tDeltaY = dy !== 0 ? Math.abs(cellH / dy) : Infinity;

  const nextBoundaryX = (c + (stepC > 0 ? 1 : 0)) * cellW;
  const nextBoundaryY = (r + (stepR > 0 ? 1 : 0)) * cellH;
  let tMaxX = dx !== 0 ? (nextBoundaryX - x0) / dx : Infinity;
  let tMaxY = dy !== 0 ? (nextBoundaryY - y0) / dy : Infinity;

  emit(c, r);

  // Bounded so a degenerate case can never spin forever.
  const limit = cols + rows + 4;
  for (let guard = 0; guard < limit; guard++) {
    if (c === cEnd && r === rEnd) break;
    if (tMaxX < tMaxY) {
      if (c === cEnd) {
        tMaxX = Infinity;
        continue;
      }
      c += stepC;
      tMaxX += tDeltaX;
    } else {
      if (r === rEnd) {
        tMaxY = Infinity;
        continue;
      }
      r += stepR;
      tMaxY += tDeltaY;
    }
    if (c < 0 || c >= cols || r < 0 || r >= rows) break;
    emit(c, r);
  }
}
