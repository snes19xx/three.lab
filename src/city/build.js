// OSM elements -> Three.js geometry.
//
// Output is a Group of a handful of named meshes (building height bands, major
// and minor roads, water, green, rail, ground).

import * as THREE from "three";
import {
  bboxSpanMetres,
  cleanRing,
  createProjector,
  signedArea,
} from "./geo.js";
import {
  HEIGHT_BANDS,
  buildingHeight,
  heightBand,
  isMajorRoad,
  railWidth,
  roadWidth,
} from "./tags.js";

// Vertical stacking order for the flat layers, in metres. Small gaps keep the
// depth buffer from tearing between coincident ground planes.
const Y_GROUND = 0;
const Y_GREEN = 0.08;
const Y_WATER = 0.14;
const Y_ROAD_MINOR = 0.2;
const Y_ROAD_MAJOR = 0.26;
const Y_RAIL = 0.32;

// Accumulates triangles into flat arrays, one per output mesh.
class Accumulator {
  constructor(name, color, opts = {}) {
    this.name = name;
    this.color = color;
    this.opts = opts;
    this.positions = [];
    this.normals = [];
    this.count = 0;
  }

  // Winding is normalised here rather than at every call site: push the
  // triangle, then flip it if its normal points away from `expectedUp`.
  addTriangle(ax, ay, az, bx, by, bz, cx, cy, cz, expectedUp) {
    const e1x = bx - ax,
      e1y = by - ay,
      e1z = bz - az;
    const e2x = cx - ax,
      e2y = cy - ay,
      e2z = cz - az;
    let nx = e1y * e2z - e1z * e2y;
    let ny = e1z * e2x - e1x * e2z;
    let nz = e1x * e2y - e1y * e2x;

    const len = Math.hypot(nx, ny, nz);
    if (len < 1e-12) return; // degenerate sliver, skip
    nx /= len;
    ny /= len;
    nz /= len;

    let flip = false;
    if (expectedUp === 1 && ny < 0) flip = true;
    else if (expectedUp === -1 && ny > 0) flip = true;

    if (flip) {
      nx = -nx;
      ny = -ny;
      nz = -nz;
      this.positions.push(ax, ay, az, cx, cy, cz, bx, by, bz);
    } else {
      this.positions.push(ax, ay, az, bx, by, bz, cx, cy, cz);
    }
    this.normals.push(nx, ny, nz, nx, ny, nz, nx, ny, nz);
    this.count++;
  }

  toMesh() {
    if (this.count === 0) return null;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute(
      "position",
      new THREE.BufferAttribute(new Float32Array(this.positions), 3),
    );
    geometry.setAttribute(
      "normal",
      new THREE.BufferAttribute(new Float32Array(this.normals), 3),
    );
    geometry.computeBoundingSphere();

    const material = new THREE.MeshStandardMaterial({
      color: this.color,
      roughness: this.opts.roughness ?? 0.85,
      metalness: this.opts.metalness ?? 0,
      side: this.opts.side ?? THREE.FrontSide,
      flatShading: true,
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = this.name;
    return mesh;
  }
}

//  POLYGONS

// Triangulates a ring (with optional holes) and emits it as a horizontal cap.
function addCap(accum, outer, holes, y, facing) {
  const contour = outer.map((p) => new THREE.Vector2(p.x, p.z));
  const holeContours = holes.map((h) =>
    h.map((p) => new THREE.Vector2(p.x, p.z)),
  );

  let faces;
  try {
    faces = THREE.ShapeUtils.triangulateShape(contour, holeContours);
  } catch {
    return 0; // self-intersecting footprint; drop it isntead of crashing the build
  }

  const verts = contour.concat(...holeContours);
  for (const [i, j, k] of faces) {
    const a = verts[i],
      b = verts[j],
      c = verts[k];
    if (!a || !b || !c) continue;
    accum.addTriangle(a.x, y, a.y, b.x, y, b.y, c.x, y, c.y, facing);
  }
  return faces.length;
}

// Outward-facing wall quads for one ring.
function addWalls(accum, ring, baseY, topY) {
  for (let i = 0, n = ring.length; i < n; i++) {
    const p0 = ring[i];
    const p1 = ring[(i + 1) % n];
    const dx = p1.x - p0.x;
    const dz = p1.z - p0.z;
    if (Math.abs(dx) < 1e-6 && Math.abs(dz) < 1e-6) continue;

    // Both triangles of the quad, wound so their normal matches (-dz, dx).
    accum.addTriangle(
      p0.x,
      baseY,
      p0.z,
      p1.x,
      baseY,
      p1.z,
      p1.x,
      topY,
      p1.z,
      0,
    );
    accum.addTriangle(p0.x, baseY, p0.z, p1.x, topY, p1.z, p0.x, topY, p0.z, 0);
  }
}

// Normalises a ring so that its cap faces up when triangulated (see geo.js).
function orientRing(ring, wantNegative) {
  const area = signedArea(ring);
  if (Math.abs(area) < 1e-6) return null;
  const isNegative = area < 0;
  return isNegative === wantNegative ? ring : ring.slice().reverse();
}

function extrudePolygon(accum, outer, holes, baseY, topY) {
  const shell = orientRing(outer, true);
  if (!shell || shell.length < 3) return;
  const voids = holes
    .map((h) => orientRing(h, false))
    .filter((h) => h && h.length >= 3);

  addCap(accum, shell, voids, topY, 1);
  addWalls(accum, shell, baseY, topY);
  for (const hole of voids) addWalls(accum, hole, baseY, topY);
}

function addFlatPolygon(accum, outer, holes, y) {
  const shell = orientRing(outer, true);
  if (!shell || shell.length < 3) return;
  const voids = holes
    .map((h) => orientRing(h, false))
    .filter((h) => h && h.length >= 3);
  addCap(accum, shell, voids, y, 1);
}

//  EXTENT CLIPPING
//
// Overpass returns each way's complete geometry, not just the part inside the
// query box, so a road that merely passes through the extent arrives with
// kilometres of tail attached. (XXX NEEDS MORE WORK XXX)

// Liang-Barsky clip of one segment to an axis-aligned rectangle.
// Returns [t0, t1] of the visible portion, or null.
function clipSegmentToRect(x0, z0, x1, z1, minX, minZ, maxX, maxZ) {
  let t0 = 0;
  let t1 = 1;
  const dx = x1 - x0;
  const dz = z1 - z0;

  const edges = [
    [-dx, x0 - minX],
    [dx, maxX - x0],
    [-dz, z0 - minZ],
    [dz, maxZ - z0],
  ];

  for (const [p, q] of edges) {
    if (p === 0) {
      if (q < 0) return null; // parallel to this edge and outside it
      continue;
    }
    const r = q / p;
    if (p < 0) {
      if (r > t1) return null;
      if (r > t0) t0 = r;
    } else {
      if (r < t0) return null;
      if (r < t1) t1 = r;
    }
  }
  return t0 < t1 ? [t0, t1] : null;
}

// Clips a polyline to the extent, returning the pieces that survive.
function clipPolylineToRect(points, minX, minZ, maxX, maxZ) {
  const pieces = [];
  let current = null;

  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i];
    const b = points[i + 1];
    const range = clipSegmentToRect(a.x, a.z, b.x, b.z, minX, minZ, maxX, maxZ);
    if (!range) {
      current = null;
      continue;
    }
    const [t0, t1] = range;
    const p0 = { x: a.x + t0 * (b.x - a.x), z: a.z + t0 * (b.z - a.z) };
    const p1 = { x: a.x + t1 * (b.x - a.x), z: a.z + t1 * (b.z - a.z) };

    // Continue the run when this segment starts where the last one ended.
    if (
      current &&
      t0 === 0 &&
      Math.abs(current[current.length - 1].x - p0.x) < 1e-6 &&
      Math.abs(current[current.length - 1].z - p0.z) < 1e-6
    ) {
      current.push(p1);
    } else {
      current = [p0, p1];
      pieces.push(current);
    }
    // Leaving the box ends the run.
    if (t1 < 1) current = null;
  }

  return pieces.filter((p) => p.length >= 2);
}

//  RIBBONS (roads, rail)

// Mitred offset ribbon. Falls back to a plain perpendicular offset when the
// mitre would spike out at a hairpin bend.
const MITRE_LIMIT = 4;

function addRibbon(accum, points, width, y) {
  const pts = cleanRing(points, 1e-3);
  if (pts.length < 2) return;

  const half = width / 2;
  const left = [];
  const right = [];

  for (let i = 0; i < pts.length; i++) {
    const prev = pts[i - 1];
    const curr = pts[i];
    const next = pts[i + 1];

    // Unit normals of the incoming and outgoing segments.
    let nx = 0,
      nz = 0;
    const seg = (a, b) => {
      const dx = b.x - a.x;
      const dz = b.z - a.z;
      const len = Math.hypot(dx, dz) || 1;
      return { x: -dz / len, z: dx / len };
    };

    if (!prev) {
      const n = seg(curr, next);
      nx = n.x;
      nz = n.z;
    } else if (!next) {
      const n = seg(prev, curr);
      nx = n.x;
      nz = n.z;
    } else {
      const a = seg(prev, curr);
      const b = seg(curr, next);
      nx = a.x + b.x;
      nz = a.z + b.z;
      const len = Math.hypot(nx, nz);
      if (len < 1e-6) {
        nx = a.x;
        nz = a.z; // doubled-back segment
      } else {
        nx /= len;
        nz /= len;
        // Mitre scale: 1 / cos(theta/2), where the dot gives cos(theta/2).
        const scale = 1 / Math.max(1e-3, nx * a.x + nz * a.z);
        if (scale <= MITRE_LIMIT) {
          nx *= scale;
          nz *= scale;
        }
      }
    }

    left.push({ x: curr.x + nx * half, z: curr.z + nz * half });
    right.push({ x: curr.x - nx * half, z: curr.z - nz * half });
  }

  for (let i = 0; i < pts.length - 1; i++) {
    const l0 = left[i],
      l1 = left[i + 1];
    const r0 = right[i],
      r1 = right[i + 1];
    accum.addTriangle(l0.x, y, l0.z, r0.x, y, r0.z, r1.x, y, r1.z, 1);
    accum.addTriangle(l0.x, y, l0.z, r1.x, y, r1.z, l1.x, y, l1.z, 1);
  }
}

//  ELEMENT NORMALISATION

// Stitches relation members into closed rings.
function assembleRings(segments) {
  const rings = [];
  const open = [];

  for (const seg of segments) {
    if (seg.length < 2) continue;
    const first = seg[0];
    const last = seg[seg.length - 1];
    if (
      Math.abs(first.x - last.x) < 1e-4 &&
      Math.abs(first.z - last.z) < 1e-4
    ) {
      rings.push(seg);
    } else {
      open.push(seg.slice());
    }
  }

  const near = (a, b) => Math.abs(a.x - b.x) < 0.5 && Math.abs(a.z - b.z) < 0.5;

  while (open.length) {
    let chain = open.pop();
    let joined = true;

    while (joined) {
      joined = false;
      const head = chain[0];
      const tail = chain[chain.length - 1];
      if (near(head, tail)) break;

      for (let i = 0; i < open.length; i++) {
        const other = open[i];
        const oHead = other[0];
        const oTail = other[other.length - 1];

        if (near(tail, oHead)) chain = chain.concat(other.slice(1));
        else if (near(tail, oTail))
          chain = chain.concat(other.slice(0, -1).reverse());
        else if (near(head, oTail)) chain = other.slice(0, -1).concat(chain);
        else if (near(head, oHead))
          chain = other.slice(1).reverse().concat(chain);
        else continue;

        open.splice(i, 1);
        joined = true;
        break;
      }
    }

    if (chain.length >= 3) rings.push(chain);
  }

  return rings;
}

// Flattens Overpass elements into { tags, outer, holes } / { tags, line }.
function normaliseElements(elements, project) {
  const toLocal = (nodes) =>
    cleanRing((nodes || []).map((n) => project(n.lat, n.lon)));

  const areas = [];
  const lines = [];
  const consumedWays = new Set();

  // Relations first
  for (const el of elements) {
    if (el.type !== "relation") continue;
    const outerSegs = [];
    const innerSegs = [];
    for (const m of el.members || []) {
      if (!m.geometry) continue;
      consumedWays.add(m.ref);
      const ring = toLocal(m.geometry);
      if (ring.length < 2) continue;
      (m.role === "inner" ? innerSegs : outerSegs).push(ring);
    }
    const outers = assembleRings(outerSegs);
    const holes = assembleRings(innerSegs);
    // Every outer ring gets the full hole set; holes outside a given shell are
    // rejected by the triangulator anyway, and this avoids a containment test.
    for (const outer of outers) {
      if (outer.length >= 3) areas.push({ tags: el.tags || {}, outer, holes });
    }
  }

  for (const el of elements) {
    if (el.type !== "way" || !el.geometry) continue;
    const tags = el.tags || {};
    const pts = toLocal(el.geometry);
    if (pts.length < 2) continue;

    const isClosed =
      el.geometry.length > 3 &&
      el.geometry[0].lat === el.geometry[el.geometry.length - 1].lat &&
      el.geometry[0].lon === el.geometry[el.geometry.length - 1].lon;

    if (tags.highway || tags.railway) {
      lines.push({ tags, line: pts });
    } else if (isClosed && pts.length >= 3) {
      if (consumedWays.has(el.id) && !tags.building) continue;
      areas.push({ tags, outer: pts, holes: [] });
    }
  }

  return { areas, lines };
}

//  MAIN ENTRY

const CATEGORY_COLORS = {
  water: 0x4a6b82,
  green: 0x6e7f57,
  roadMajor: 0x55524a,
  roadMinor: 0x615d54,
  rail: 0x4a4740,
  ground: 0x2e2c26,
};

function isWater(tags) {
  return (
    tags.natural === "water" ||
    tags.waterway === "riverbank" ||
    tags.water != null
  );
}

function isGreen(tags) {
  return (
    tags.leisure != null ||
    ["grass", "forest", "meadow", "village_green", "cemetery"].includes(
      tags.landuse,
    ) ||
    ["wood", "scrub", "grassland"].includes(tags.natural)
  );
}

export function buildCity(elements, bbox, options = {}, onProgress = () => {}) {
  const {
    includeGround = true,
    heightScale = 1,
    minBuildingArea = 0,
    clipToExtent = true,
  } = options;

  const centreLat = (bbox.north + bbox.south) / 2;
  const centreLon = (bbox.east + bbox.west) / 2;
  const project = createProjector(centreLat, centreLon);

  onProgress(0.05, "Projecting coordinates…");
  const { areas, lines } = normaliseElements(elements, project);

  const bands = HEIGHT_BANDS.map(
    (b) =>
      new Accumulator(`Buildings · ${b.name}`, b.color, { roughness: 0.9 }),
  );
  const water = new Accumulator("Water", CATEGORY_COLORS.water, {
    roughness: 0.35,
  });
  const green = new Accumulator("Green", CATEGORY_COLORS.green);
  const roadMajor = new Accumulator("Roads · major", CATEGORY_COLORS.roadMajor);
  const roadMinor = new Accumulator("Roads · minor", CATEGORY_COLORS.roadMinor);
  const rail = new Accumulator("Rail", CATEGORY_COLORS.rail);
  const ground = new Accumulator("Ground", CATEGORY_COLORS.ground);

  const stats = {
    buildings: 0,
    roads: 0,
    water: 0,
    green: 0,
    rail: 0,
    skipped: 0,
  };

  onProgress(0.15, "Extruding buildings…");
  for (let i = 0; i < areas.length; i++) {
    const { tags, outer, holes } = areas[i];

    if (tags.building || tags["building:part"]) {
      if (
        minBuildingArea > 0 &&
        Math.abs(signedArea(outer)) < minBuildingArea
      ) {
        stats.skipped++;
        continue;
      }
      const { base, top } = buildingHeight(tags);
      // Band on the *scaled* height: the bands drive colour and the outliner
      // groups, so they have to describe the geometry you actually get.
      const scaledBase = base * heightScale;
      const scaledTop = top * heightScale;
      const band = bands[heightBand(scaledTop)];
      extrudePolygon(band, outer, holes, scaledBase, scaledTop);
      stats.buildings++;
    } else if (isWater(tags)) {
      addFlatPolygon(water, outer, holes, Y_WATER);
      stats.water++;
    } else if (isGreen(tags)) {
      addFlatPolygon(green, outer, holes, Y_GREEN);
      stats.green++;
    }

    if ((i & 255) === 0) {
      onProgress(0.15 + 0.6 * (i / areas.length), "Extruding buildings…");
    }
  }

  onProgress(0.78, "Laying roads…");
  const extent = bboxSpanMetres(bbox);
  const halfW = extent.width / 2;
  const halfD = extent.depth / 2;

  for (const { tags, line } of lines) {
    const pieces = clipToExtent
      ? clipPolylineToRect(line, -halfW, -halfD, halfW, halfD)
      : [line];
    if (!pieces.length) continue;

    if (tags.railway) {
      for (const piece of pieces)
        addRibbon(rail, piece, railWidth(tags), Y_RAIL);
      stats.rail++;
    } else if (tags.highway) {
      const major = isMajorRoad(tags);
      for (const piece of pieces) {
        addRibbon(
          major ? roadMajor : roadMinor,
          piece,
          roadWidth(tags),
          major ? Y_ROAD_MAJOR : Y_ROAD_MINOR,
        );
      }
      stats.roads++;
    }
  }

  if (includeGround) {
    const { width, depth } = bboxSpanMetres(bbox);
    const hw = width / 2;
    const hd = depth / 2;
    addFlatPolygon(
      ground,
      [
        { x: -hw, z: -hd },
        { x: hw, z: -hd },
        { x: hw, z: hd },
        { x: -hw, z: hd },
      ],
      [],
      Y_GROUND,
    );
  }

  onProgress(0.92, "Assembling meshes…");
  const group = new THREE.Group();
  group.name = "OSM City";

  for (const accum of [
    ground,
    green,
    water,
    roadMinor,
    roadMajor,
    rail,
    ...bands,
  ]) {
    const mesh = accum.toMesh();
    if (mesh) group.add(mesh);
  }

  let triangles = 0;
  group.traverse((c) => {
    if (c.isMesh) triangles += c.geometry.attributes.position.count / 3;
  });

  const span = bboxSpanMetres(bbox);
  group.userData.city = {
    ...stats,
    triangles,
    bbox,
    centre: { lat: centreLat, lon: centreLon },
    spanMetres: span,
  };

  onProgress(1, "Done");
  return group;
}
