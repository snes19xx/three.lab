// Turning OSM's free-form tagging into numbers to extrude
//
// OSM heights are a mess: metres, feet with a prime, "5;6" from a bad merge,
// or missing entirely. Everything here degrades to a plausible default rather
// than throwing, because one weird building should never fail a whole extract.

const METRES_PER_LEVEL = 3.2;

// Fallbacks when a building carries no height or level information at all.
const DEFAULT_HEIGHT_BY_TYPE = {
  house: 6,
  detached: 6,
  semidetached_house: 6,
  bungalow: 4,
  terrace: 8,
  hut: 3,
  shed: 3,
  garage: 3,
  garages: 3,
  carport: 3,
  roof: 3,
  kiosk: 3,
  greenhouse: 4,
  chapel: 9,
  church: 20,
  cathedral: 30,
  mosque: 18,
  temple: 16,
  synagogue: 16,
  apartments: 15,
  residential: 12,
  dormitory: 15,
  hotel: 20,
  commercial: 12,
  retail: 9,
  supermarket: 9,
  office: 18,
  industrial: 10,
  warehouse: 10,
  hangar: 12,
  train_station: 12,
  hospital: 18,
  school: 9,
  university: 15,
  civic: 12,
  public: 12,
  stadium: 25,
  tower: 40,
  skyscraper: 80,
};

const DEFAULT_HEIGHT = 9;

// "25", "25 m", "25m", "82'", "82 ft", "5;6" -> metres, or null.
export function parseLength(raw) {
  if (raw == null) return null;
  const text = String(raw).trim().split(";")[0].trim();
  if (!text) return null;

  const feetInches = text.match(/^(-?[\d.]+)\s*'\s*(?:([\d.]+)\s*")?$/);
  if (feetInches) {
    const feet = parseFloat(feetInches[1]);
    const inches = feetInches[2] ? parseFloat(feetInches[2]) : 0;
    if (!Number.isFinite(feet)) return null;
    return (feet + inches / 12) * 0.3048;
  }

  const match = text.match(/^(-?[\d.]+)\s*([a-z']*)$/i);
  if (!match) return null;
  const value = parseFloat(match[1]);
  if (!Number.isFinite(value)) return null;

  switch (match[2].toLowerCase()) {
    case "ft":
    case "feet":
    case "'":
      return value * 0.3048;
    case "km":
      return value * 1000;
    case "cm":
      return value / 100;
    default:
      return value; // bare numbers and "m" are metres
  }
}

function parseLevels(raw) {
  const n = parseLength(raw); // same lenient numeric handling, no units
  return n != null && n > 0 ? n : null;
}

// Returns { base, top } in metres above ground. `base` is non-zero only for
// building:part pieces that float partway up a tower.
export function buildingHeight(tags = {}) {
  let top =
    parseLength(tags.height) ??
    parseLength(tags["building:height"]) ??
    parseLength(tags.est_height);

  if (top == null) {
    const levels =
      parseLevels(tags["building:levels"]) ?? parseLevels(tags.levels);
    if (levels != null) {
      const roof = parseLength(tags["roof:height"]) ?? 0;
      top = levels * METRES_PER_LEVEL + roof;
    }
  }

  if (top == null) {
    const kind = tags.building || tags["building:part"];
    top = DEFAULT_HEIGHT_BY_TYPE[kind] ?? DEFAULT_HEIGHT;
  }

  let base =
    parseLength(tags.min_height) ?? parseLength(tags["building:min_height"]);
  if (base == null) {
    const minLevel =
      parseLevels(tags["building:min_level"]) ?? parseLevels(tags.min_level);
    base = minLevel != null ? minLevel * METRES_PER_LEVEL : 0;
  }

  // Guard against tagging that would give us an inverted or zero-thickness box.
  if (!(top > base)) {
    base = 0;
    top = Math.max(top || 0, 2);
  }
  return { base, top };
}

// Road half-widths are driven by class, then nudged by an explicit lane count.
const ROAD_WIDTH = {
  motorway: 16,
  motorway_link: 8,
  trunk: 14,
  trunk_link: 7,
  primary: 12,
  primary_link: 6,
  secondary: 10,
  secondary_link: 5,
  tertiary: 8,
  tertiary_link: 4,
  unclassified: 6,
  residential: 6,
  living_street: 5,
  pedestrian: 5,
  service: 3.5,
  track: 3,
  cycleway: 2,
  footway: 1.8,
  path: 1.5,
  steps: 1.5,
};

const MAJOR_ROADS = new Set([
  "motorway",
  "motorway_link",
  "trunk",
  "trunk_link",
  "primary",
  "primary_link",
  "secondary",
  "secondary_link",
]);

export function roadWidth(tags = {}) {
  const explicit = parseLength(tags.width);
  if (explicit != null && explicit > 0.5) return explicit;

  let width = ROAD_WIDTH[tags.highway] ?? 4;
  const lanes = parseLevels(tags.lanes);
  if (lanes != null && ROAD_WIDTH[tags.highway] != null) {
    // Default class widths already assume ~2 lanes.
    width *= Math.max(0.5, lanes / 2);
  }
  return width;
}

export function isMajorRoad(tags = {}) {
  return MAJOR_ROADS.has(tags.highway);
}

export function railWidth(tags = {}) {
  return tags.railway === "tram" ? 3 : 4.5;
}

// Buildings are split into height bands so the Lab renders a legible gradient
// and the Editor's outliner gives you something meaningful to isolate.
export const HEIGHT_BANDS = [
  { max: 8, name: "0–8m", color: 0x8f8b7d },
  { max: 16, name: "8–16m", color: 0x9c977f },
  { max: 30, name: "16–30m", color: 0xa8a075 },
  { max: 60, name: "30–60m", color: 0xb5a86a },
  { max: Infinity, name: "60m+", color: 0xc4b25c },
];

export function heightBand(top) {
  for (let i = 0; i < HEIGHT_BANDS.length; i++) {
    if (top <= HEIGHT_BANDS[i].max) return i;
  }
  return HEIGHT_BANDS.length - 1;
}
