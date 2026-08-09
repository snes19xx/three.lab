// Joins the surviving segments into continuous polylines.
//
// The occlusion pass emits one short segment per visible piece of an edge, so
// a building outline comes out as dozens of disconnected sticks. Chaining them
// back together matters for three reasons: the SVG gets far smaller, the
// strokes join cleanly instead of showing a seam at every vertex, and a pen
// plotter lifts its pen once per outline rather than once per segment.

// Endpoints are quantised before matching, because two segments that meet at a
// shared vertex will have computed that vertex through different arithmetic.
const DEFAULT_TOLERANCE = 0.05; // screen pixels

export function chainSegments(
  segments,
  { tolerance = DEFAULT_TOLERANCE, byKind = true } = {},
) {
  const groups = new Map();
  for (const segment of segments) {
    const key = byKind ? segment.kind : 0;
    let group = groups.get(key);
    if (!group) groups.set(key, (group = []));
    group.push(segment);
  }

  const out = [];
  for (const [kind, group] of groups) {
    for (const points of chainGroup(group, tolerance)) {
      out.push({ kind, points });
    }
  }
  return out;
}

function chainGroup(segments, tolerance) {
  const inverse = 1 / tolerance;
  const keyOf = (x, y) =>
    `${Math.round(x * inverse)},${Math.round(y * inverse)}`;

  // node key -> list of { segment index, which end }
  const nodes = new Map();
  const addNode = (key, entry) => {
    let list = nodes.get(key);
    if (!list) nodes.set(key, (list = []));
    list.push(entry);
  };

  const count = segments.length;
  const startKey = new Array(count);
  const endKey = new Array(count);
  const used = new Uint8Array(count);

  for (let i = 0; i < count; i++) {
    const p = segments[i].points;
    startKey[i] = keyOf(p[0], p[1]);
    endKey[i] = keyOf(p[2], p[3]);
    addNode(startKey[i], { segment: i, end: 0 });
    addNode(endKey[i], { segment: i, end: 1 });
  }

  // Finds an unused segment continuing from `key`, if there is exactly one
  // sensible continuation. Junctions with three or more branches end the
  // chain: guessing which way to turn produces worse drawings than stopping.
  const nextFrom = (key) => {
    const list = nodes.get(key);
    if (!list) return null;
    let found = null;
    let available = 0;
    for (const entry of list) {
      if (used[entry.segment]) continue;
      available++;
      if (available > 1) return null;
      found = entry;
    }
    return found;
  };

  const polylines = [];

  for (let i = 0; i < count; i++) {
    if (used[i]) continue;
    used[i] = 1;

    const p = segments[i].points;
    const points = [p[0], p[1], p[2], p[3]];
    let headKey = startKey[i];
    let tailKey = endKey[i];

    // Extend forward.
    for (;;) {
      const next = nextFrom(tailKey);
      if (!next) break;
      used[next.segment] = 1;
      const q = segments[next.segment].points;
      if (next.end === 0) {
        points.push(q[2], q[3]);
        tailKey = endKey[next.segment];
      } else {
        points.push(q[0], q[1]);
        tailKey = startKey[next.segment];
      }
      if (tailKey === headKey) break; // closed loop
    }

    // Extend backward.
    for (;;) {
      const previous = nextFrom(headKey);
      if (!previous) break;
      used[previous.segment] = 1;
      const q = segments[previous.segment].points;
      if (previous.end === 1) {
        points.unshift(q[0], q[1]);
        headKey = startKey[previous.segment];
      } else {
        points.unshift(q[2], q[3]);
        headKey = endKey[previous.segment];
      }
      if (tailKey === headKey) break;
    }

    polylines.push(points);
  }

  return polylines;
}

// Drops interior points that lie on the straight line between their
// neighbours. A city wall chained from twenty collinear fragments becomes two
// points
export function simplifyCollinear(polylines, tolerance = 0.08) {
  const out = [];
  for (const line of polylines) {
    const p = line.points;
    if (p.length <= 4) {
      out.push(line);
      continue;
    }
    const kept = [p[0], p[1]];
    for (let i = 2; i < p.length - 2; i += 2) {
      const ax = kept[kept.length - 2],
        ay = kept[kept.length - 1];
      const bx = p[i],
        by = p[i + 1];
      const cx = p[i + 2],
        cy = p[i + 3];
      // Perpendicular distance of b from the line a->c.
      const vx = cx - ax,
        vy = cy - ay;
      const length = Math.hypot(vx, vy);
      const distance =
        length < 1e-9
          ? Math.hypot(bx - ax, by - ay)
          : Math.abs(vx * (ay - by) - (ax - bx) * vy) / length;
      if (distance > tolerance) kept.push(bx, by);
    }
    kept.push(p[p.length - 2], p[p.length - 1]);
    out.push({ ...line, points: kept });
  }
  return out;
}
