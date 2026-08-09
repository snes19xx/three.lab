// Geographic helpers: WGS84 <-> a local metre grid centred on the selected area.
//
// Over a few square kilometres the tangent-plane error is well under a metre,
// which is far below the precision of OSM footprints anyway.

export const EARTH_R = 6378137;
const DEG = Math.PI / 180;

export function createProjector(centreLat, centreLon) {
  const cosLat = Math.cos(centreLat * DEG);
  const mPerDegLat = EARTH_R * DEG;
  const mPerDegLon = mPerDegLat * cosLat;

  const project = (lat, lon) => ({
    x: (lon - centreLon) * mPerDegLon,
    z: -(lat - centreLat) * mPerDegLat,
  });

  project.inverse = (x, z) => ({
    lat: centreLat - z / mPerDegLat,
    lon: centreLon + x / mPerDegLon,
  });
  project.centre = { lat: centreLat, lon: centreLon };
  project.mPerDegLat = mPerDegLat;
  project.mPerDegLon = mPerDegLon;

  return project;
}

// Ground size of a lat/lon bbox, in metres.
export function bboxSpanMetres(bbox) {
  const { south, west, north, east } = bbox;
  const midLat = (south + north) / 2;
  return {
    width: Math.abs(east - west) * EARTH_R * DEG * Math.cos(midLat * DEG),
    depth: Math.abs(north - south) * EARTH_R * DEG,
  };
}

export function bboxAreaKm2(bbox) {
  const { width, depth } = bboxSpanMetres(bbox);
  return (width * depth) / 1e6;
}

// Shoelace area of a ring of {x, z} points. Negative == the ring faces up
// once triangulated in our Y-up frame (see build.js for the derivation).
export function signedArea(ring) {
  let a = 0;
  for (let i = 0, n = ring.length; i < n; i++) {
    const p = ring[i];
    const q = ring[(i + 1) % n];
    a += p.x * q.z - q.x * p.z;
  }
  return a / 2;
}

// Drops the duplicated closing vertex OSM ways carry, plus any zero-length
// segments that would produce degenerate triangles.
export function cleanRing(ring, epsilon = 1e-4) {
  const out = [];
  for (const p of ring) {
    const last = out[out.length - 1];
    if (
      last &&
      Math.abs(last.x - p.x) < epsilon &&
      Math.abs(last.z - p.z) < epsilon
    )
      continue;
    out.push(p);
  }
  while (out.length > 1) {
    const first = out[0];
    const last = out[out.length - 1];
    if (
      Math.abs(first.x - last.x) < epsilon &&
      Math.abs(first.z - last.z) < epsilon
    )
      out.pop();
    else break;
  }
  return out;
}
