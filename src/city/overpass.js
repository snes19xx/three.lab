// Overpass API client.
//
// Ask for `out geom`, which inlines every node's lat/lon on the way itself.
// That costs a little bandwidth but means it never has to resolve node ids by
// hand, and multipolygon relations arrive with their member rings attached.
//
// Each request has a client-side deadline so a stalled Overpass connection
// cannot leave the UI hanging indefinitely.
//
// Large areas are split into smaller tiles and fetched one at a time.
// This makes requests more reliable and lets us report progress as tiles finish.

const ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
];

// Per-request deadline. The server-side [timeout:] is set slightly lower so a
// well-behaved server gives up before the client does.
const REQUEST_TIMEOUT_MS = 60_000;
const SERVER_TIMEOUT_S = 50;

// Above this, the extent is fetched as a grid of tiles
const MAX_TILE_KM2 = 1.0;

const LAST_GOOD_KEY = "three-lab-overpass-endpoint";

export const LAYERS = {
  buildings: {
    label: "Buildings",
    query: (bb) => `
      way["building"](${bb});
      relation["building"]["type"="multipolygon"](${bb});
      way["building:part"](${bb});`,
  },
  roads: {
    label: "Roads",
    query: (bb) => `
      way["highway"](${bb});`,
  },
  water: {
    label: "Water",
    query: (bb) => `
      way["natural"="water"](${bb});
      way["waterway"="riverbank"](${bb});
      relation["natural"="water"]["type"="multipolygon"](${bb});`,
  },
  green: {
    label: "Parks & green",
    query: (bb) => `
      way["leisure"~"park|garden|pitch|golf_course"](${bb});
      way["landuse"~"grass|forest|meadow|village_green|cemetery"](${bb});
      way["natural"~"wood|scrub|grassland"](${bb});`,
  },
  rail: {
    label: "Rail",
    query: (bb) => `
      way["railway"~"rail|light_rail|subway|tram"](${bb});`,
  },
};

function bboxString(bbox) {
  // Overpass south,west,north,east.
  return `${bbox.south},${bbox.west},${bbox.north},${bbox.east}`;
}

function layerStatements(bbox, layers) {
  const bb = bboxString(bbox);
  return layers
    .filter((key) => LAYERS[key])
    .map((key) => LAYERS[key].query(bb))
    .join("\n");
}

export function buildQuery(bbox, layers, timeout = SERVER_TIMEOUT_S) {
  return `[out:json][timeout:${timeout}];\n(${layerStatements(bbox, layers)}\n);\nout geom;`;
}

// Counts elements without downloading geometry
export function buildCountQuery(bbox, layers, timeout = 30) {
  return `[out:json][timeout:${timeout}];\n(${layerStatements(bbox, layers)}\n);\nout count;`;
}

//  TILING

// Splits a bbox into a grid of tiles no larger than `maxKm2` each.
export function tileBbox(bbox, maxKm2 = MAX_TILE_KM2) {
  const kmPerDegLat = 111.32;

  // A degree of longitude is widest nearest the equator, and each tile's area
  // gets measured at its own mid-latitude. Size the grid against the widest
  // latitude the bbox touches, or the southern tiles come out over the cap.
  const spansEquator = bbox.south <= 0 && bbox.north >= 0;
  const widestLat = spansEquator
    ? 0
    : Math.min(Math.abs(bbox.south), Math.abs(bbox.north));
  const kmPerDegLon = kmPerDegLat * Math.cos(widestLat * (Math.PI / 180));

  const widthKm = Math.abs(bbox.east - bbox.west) * kmPerDegLon;
  const depthKm = Math.abs(bbox.north - bbox.south) * kmPerDegLat;
  if (widthKm * depthKm <= maxKm2) return [bbox];

  // Divide each axis independently against a square tile side. .
  const tileSideKm = Math.sqrt(maxKm2);
  const cols = Math.max(1, Math.ceil(widthKm / tileSideKm));
  const rows = Math.max(1, Math.ceil(depthKm / tileSideKm));

  const dLon = (bbox.east - bbox.west) / cols;
  const dLat = (bbox.north - bbox.south) / rows;

  const tiles = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      tiles.push({
        west: bbox.west + c * dLon,
        east: bbox.west + (c + 1) * dLon,
        south: bbox.south + r * dLat,
        north: bbox.south + (r + 1) * dLat,
      });
    }
  }
  return tiles;
}

//  REQUESTS

class OverpassError extends Error {
  constructor(message, kind) {
    super(message);
    this.name = "OverpassError";
    this.kind = kind; // "rate-limit" | "timeout" | "server" | "network"
  }
}

// Orders endpoints so whichever one worked last time is tried first.
function orderedEndpoints() {
  let last = null;
  try {
    last = sessionStorage.getItem(LAST_GOOD_KEY);
  } catch {
    /* private mode; not worth caring about */
  }
  if (!last || !ENDPOINTS.includes(last)) return ENDPOINTS;
  return [last, ...ENDPOINTS.filter((e) => e !== last)];
}

function rememberEndpoint(endpoint) {
  try {
    sessionStorage.setItem(LAST_GOOD_KEY, endpoint);
  } catch {
    /* ignore */
  }
}

export async function runQuery(
  query,
  { signal, onStatus, timeoutMs = REQUEST_TIMEOUT_MS } = {},
) {
  const endpoints = orderedEndpoints();
  let lastError = null;

  for (let i = 0; i < endpoints.length; i++) {
    // Checked before each attempt as well as in the catch: a cancel that lands
    // between two mirror attempts must not start another request.
    if (signal?.aborted) throw new DOMException("Cancelled", "AbortError");

    const endpoint = endpoints[i];
    const host = new URL(endpoint).host;

    // A per-attempt deadline, combined with the caller's cancel signal.
    const deadline = AbortSignal.timeout(timeoutMs);
    const combined = signal ? AbortSignal.any([signal, deadline]) : deadline;

    try {
      onStatus?.(i === 0 ? `Querying ${host}…` : `Retrying via ${host}…`);
      const res = await fetch(endpoint, {
        method: "POST",
        body: "data=" + encodeURIComponent(query),
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        signal: combined,
      });

      if (res.status === 429) {
        lastError = new OverpassError(
          `${host} is rate-limiting this IP — wait a minute, or shrink the extent`,
          "rate-limit",
        );
        continue;
      }
      if (res.status === 504) {
        lastError = new OverpassError(
          `${host} timed out building the extract — try a smaller extent`,
          "timeout",
        );
        continue;
      }
      if (!res.ok) {
        lastError = new OverpassError(
          `${host} returned HTTP ${res.status}`,
          "server",
        );
        continue;
      }

      const json = await res.json();

      // Overpass reports query timeouts in-band, with HTTP 200.
      if (json.remark && /timed out|runtime error/i.test(json.remark)) {
        lastError = new OverpassError(
          /timed out/i.test(json.remark)
            ? `${host} timed out building the extract — try a smaller extent`
            : json.remark,
          "timeout",
        );
        continue;
      }

      rememberEndpoint(endpoint);
      return json;
    } catch (err) {
      // The caller cancelled: propagate immediately, do not try other mirrors.
      if (signal?.aborted) throw new DOMException("Cancelled", "AbortError");

      if (err.name === "TimeoutError") {
        lastError = new OverpassError(
          `${host} did not respond within ${Math.round(timeoutMs / 1000)}s`,
          "timeout",
        );
      } else if (err.name === "AbortError") {
        throw err;
      } else {
        lastError = new OverpassError(
          `${host} unreachable (${err.message})`,
          "network",
        );
      }
    }
  }

  throw (
    lastError ||
    new OverpassError("Could not reach any Overpass endpoint", "network")
  );
}

//  PUBLIC API

export async function countElements(bbox, layers, { signal, onProgress } = {}) {
  const tiles = tileBbox(bbox);
  let total = 0;
  let ways = 0;
  let relations = 0;

  for (let i = 0; i < tiles.length; i++) {
    onProgress?.(
      i / tiles.length,
      `Counting tile ${i + 1} of ${tiles.length}…`,
    );
    const json = await runQuery(buildCountQuery(tiles[i], layers), {
      signal,
      timeoutMs: 45_000,
      onStatus: (msg) =>
        onProgress?.(
          i / tiles.length,
          tiles.length > 1 ? `${msg} (tile ${i + 1}/${tiles.length})` : msg,
        ),
    });
    const tags = json.elements?.[0]?.tags || {};
    total += Number(tags.total || 0);
    ways += Number(tags.ways || 0);
    relations += Number(tags.relations || 0);
  }

  onProgress?.(1, "Counted");
  // Ways straddling a tile edge are counted once per tile, so this is an
  // estimate rather than a total whenever we tiled.
  return {
    total,
    ways,
    relations,
    tiles: tiles.length,
    approximate: tiles.length > 1,
  };
}

export async function fetchArea(bbox, layers, { signal, onProgress } = {}) {
  const tiles = tileBbox(bbox);
  // Ways crossing a tile boundary come back from every tile they touch, and
  // `out geom` gives the complete geometry each time, so keying by id both
  // de-duplicates and keeps buildings whole across the seams.
  const byId = new Map();

  for (let i = 0; i < tiles.length; i++) {
    const base = i / tiles.length;
    const label = tiles.length > 1 ? ` (tile ${i + 1}/${tiles.length})` : "";
    onProgress?.(base, `Fetching${label}…`);

    const json = await runQuery(buildQuery(tiles[i], layers), {
      signal,
      onStatus: (msg) => onProgress?.(base, msg + label),
    });

    for (const el of json.elements || []) {
      byId.set(`${el.type}/${el.id}`, el);
    }
    onProgress?.(
      (i + 1) / tiles.length,
      `${byId.size.toLocaleString()} elements${label}`,
    );
  }

  return [...byId.values()];
}

// Nominatim place search, so you can type "Vancopuver"
export async function geocode(text, { signal } = {}) {
  const url =
    "https://nominatim.openstreetmap.org/search?format=json&limit=5&q=" +
    encodeURIComponent(text);
  const deadline = AbortSignal.timeout(15_000);
  const combined = signal ? AbortSignal.any([signal, deadline]) : deadline;

  const res = await fetch(url, {
    headers: { Accept: "application/json" },
    signal: combined,
  });
  if (!res.ok) throw new Error(`Nominatim returned HTTP ${res.status}`);
  const rows = await res.json();
  return rows.map((r) => ({
    name: r.display_name,
    lat: Number(r.lat),
    lon: Number(r.lon),
    // Nominatim boundingbox is [south, north, west, east] as strings.
    bbox: r.boundingbox && {
      south: Number(r.boundingbox[0]),
      north: Number(r.boundingbox[1]),
      west: Number(r.boundingbox[2]),
      east: Number(r.boundingbox[3]),
    },
  }));
}
