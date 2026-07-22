// Core logic for the area-to-SVG export tool.
// Kept dependency-free so it can be tested under plain node,
// then pasted into the HTML tool's <script> tag.

const DEG_PER_METER_LAT = 1 / 111320;

function bboxFromCenter(lat, lon, radiusMeters) {
  const dLat = radiusMeters * DEG_PER_METER_LAT;
  const dLon = (radiusMeters * DEG_PER_METER_LAT) / Math.cos((lat * Math.PI) / 180);
  return {
    north: lat + dLat,
    south: lat - dLat,
    east: lon + dLon,
    west: lon - dLon,
  };
}

// km spans and area for a bbox — shared by the UI's size warning and
// the tiling logic below, so both agree on what "big" means.
function bboxSpanKm(bbox) {
  const latKm = (bbox.north - bbox.south) * 111.32;
  const midLatRad = ((bbox.north + bbox.south) / 2) * (Math.PI / 180);
  const lonKm = (bbox.east - bbox.west) * 111.32 * Math.cos(midLatRad);
  return { latKm, lonKm, areaKm2: latKm * lonKm };
}

// Splits a bbox into a grid of tiles, each roughly maxTileKm on a
// side (never larger). Public Overpass instances are shared, rate
// limited, and cap both query time and memory per request — a single
// request covering a whole town, however the tag filters are split,
// can still fail outright (timeout, or an internal "out of memory"
// error) even for layers that are individually light. Fetching many
// small tiles instead of one big area is slower in aggregate (more
// requests) but each individual request is far more likely to
// actually succeed, and a failure only costs one tile instead of the
// whole map.
function tileBBox(bbox, maxTileKm) {
  const { latKm, lonKm } = bboxSpanKm(bbox);
  const rows = Math.max(1, Math.ceil(latKm / maxTileKm));
  const cols = Math.max(1, Math.ceil(lonKm / maxTileKm));
  const latStep = (bbox.north - bbox.south) / rows;
  const lonStep = (bbox.east - bbox.west) / cols;

  const tiles = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      tiles.push({
        row: r,
        col: c,
        south: bbox.south + r * latStep,
        north: bbox.south + (r + 1) * latStep,
        west: bbox.west + c * lonStep,
        east: bbox.west + (c + 1) * lonStep,
      });
    }
  }
  return tiles;
}

// Each layer is either "area" (rendered as filled/unfilled polygons or
// lines from ways/relations) or "point" (rendered as small markers,
// from nodes and the centroid of any matching ways). `query` returns
// the Overpass QL lines for that layer; `roadDetail` lets the streets
// layer narrow to major roads only for large/zoomed-out areas.
//
// Large water bodies (bays, lagoons), parks, and building complexes
// are frequently mapped as `relation` multipolygons rather than plain
// ways once they get big or complex — a single way in OSM is capped
// around 2000 nodes. Those layers include a `relation[...]` clause;
// coastline and streets don't, since a coastline is a chain of ways,
// not a multipolygon, and a road relation (route relations) isn't the
// same thing as the physical way we want to draw.
const LAYER_DEFS = {
  streets: {
    kind: "area",
    query: (b, roadDetail) => {
      const filter = roadDetail === "major"
        ? `~"^(motorway|trunk|primary|secondary|tertiary)(_link)?$"`
        : "";
      return [`way["highway"${filter}](${b});`];
    },
  },
  buildings: {
    kind: "area",
    query: (b) => [`way["building"](${b});`, `relation["building"](${b});`],
  },
  water: {
    kind: "area",
    query: (b) => [
      `way["natural"="water"](${b});`,
      `way["waterway"](${b});`,
      `relation["natural"="water"](${b});`,
    ],
  },
  coastline: {
    kind: "area",
    query: (b) => [`way["natural"="coastline"](${b});`],
  },
  green: {
    kind: "area",
    query: (b) => [
      `way["leisure"="park"](${b});`,
      `way["landuse"~"^(forest|grass|meadow|recreation_ground)$"](${b});`,
      `way["natural"="wood"](${b});`,
      `relation["leisure"="park"](${b});`,
      `relation["landuse"~"^(forest|grass|meadow|recreation_ground)$"](${b});`,
    ],
  },
  farmland: {
    kind: "area",
    query: (b) => [`way["landuse"="farmland"](${b});`, `relation["landuse"="farmland"](${b});`],
  },
  wetland: {
    kind: "area",
    query: (b) => [`way["natural"="wetland"](${b});`, `relation["natural"="wetland"](${b});`],
  },
  hospitals: {
    kind: "point",
    query: (b) => [
      `node["amenity"~"^(hospital|clinic)$"](${b});`,
      `way["amenity"~"^(hospital|clinic)$"](${b});`,
    ],
  },
  schools: {
    kind: "point",
    query: (b) => [`node["amenity"="school"](${b});`, `way["amenity"="school"](${b});`],
  },
  transit: {
    kind: "point",
    query: (b) => [
      `node["highway"="bus_stop"](${b});`,
      `node["railway"="station"](${b});`,
      `node["public_transport"="stop_position"](${b});`,
      `way["amenity"="bus_station"](${b});`,
    ],
  },
  food: {
    kind: "point",
    query: (b) => [
      `node["shop"~"^(supermarket|convenience)$"](${b});`,
      `way["shop"~"^(supermarket|convenience)$"](${b});`,
      `node["social_facility"="food_bank"](${b});`,
    ],
  },
};

// Builds a query for one or more layers. `timeoutSeconds` should match
// (or sit under) whatever the caller sets as its own request timeout —
// mismatched timeouts mean the client can give up before Overpass
// itself would have. Uses `out geom(bbox)` so way/relation-member
// geometry is clipped to the bbox server-side instead of dragging back
// a feature's entire remaining length when it only clips the corner
// of the requested area (rivers, coastlines, long roads).
function buildOverpassQuery(bbox, enabledLayers, roadDetail, timeoutSeconds) {
  const b = `${bbox.south},${bbox.west},${bbox.north},${bbox.east}`;
  const timeout = timeoutSeconds || 25;
  const lines = [];
  for (const name of enabledLayers) {
    const def = LAYER_DEFS[name];
    if (!def) continue;
    lines.push(...def.query(b, roadDetail));
  }
  return `[out:json][timeout:${timeout}];
(
${lines.map((l) => "  " + l).join("\n")}
);
out geom(${b});`;
}

// Classifies a tag set into one of the LAYER_DEFS names, or null.
function classifyTags(tags) {
  if (!tags) return null;
  if (tags.building) return "buildings";
  if (tags.natural === "coastline") return "coastline";
  if (tags.natural === "water" || tags.waterway) return "water";
  if (
    tags.leisure === "park" ||
    tags.natural === "wood" ||
    ["forest", "grass", "meadow", "recreation_ground"].includes(tags.landuse)
  ) return "green";
  if (tags.landuse === "farmland") return "farmland";
  if (tags.natural === "wetland") return "wetland";
  if (["hospital", "clinic"].includes(tags.amenity)) return "hospitals";
  if (tags.amenity === "school") return "schools";
  if (
    tags.highway === "bus_stop" ||
    tags.railway === "station" ||
    tags.public_transport === "stop_position" ||
    tags.amenity === "bus_station"
  ) return "transit";
  if (
    ["supermarket", "convenience"].includes(tags.shop) ||
    tags.social_facility === "food_bank"
  ) return "food";
  if (tags.highway) return "streets";
  return null;
}

function centroid(coords) {
  let sLat = 0, sLon = 0;
  for (const [lat, lon] of coords) { sLat += lat; sLon += lon; }
  return [sLat / coords.length, sLon / coords.length];
}

function geometryToCoords(geometry) {
  return (geometry || []).filter(Boolean).map((p) => [p.lat, p.lon]);
}

// Turns raw Overpass JSON (elements = nodes/ways/relations, geometry
// embedded via `out geom`) into per-layer arrays. Area/line layers get
// arrays of [lat,lon] coordinate rings, already clipped to the bbox by
// Overpass. Point layers get arrays of single [lat,lon] points — nodes
// are used directly, ways/relations are reduced to their centroid.
//
// Relations (multipolygons) are approximated by taking each "outer"
// member's ring as its own shape and ignoring "inner" members (holes).
// That means an island inside a lake, or a courtyard inside a building
// complex, may get drawn as solid rather than cut out — a known
// simplification, not a bug, and worth it for how common multipolygons
// are for exactly the large water/park/building features this layer
// needs to handle at town/city scale.
function parseOverpassResponse(json) {
  const layers = {};
  for (const name of Object.keys(LAYER_DEFS)) layers[name] = [];

  for (const el of json.elements) {
    if (el.type === "node") {
      const layer = classifyTags(el.tags);
      if (layer && LAYER_DEFS[layer].kind === "point") layers[layer].push([el.lat, el.lon]);
      continue;
    }

    if (el.type === "way") {
      const layer = classifyTags(el.tags);
      if (!layer) continue;
      const coords = geometryToCoords(el.geometry);
      if (coords.length < 2) continue;
      if (LAYER_DEFS[layer].kind === "point") layers[layer].push(centroid(coords));
      else layers[layer].push(coords);
      continue;
    }

    if (el.type === "relation") {
      const layer = classifyTags(el.tags);
      if (!layer) continue;
      const outerCoordSets = [];
      for (const member of el.members || []) {
        if (member.type !== "way") continue;
        if (member.role && member.role !== "outer") continue; // skip holes
        const coords = geometryToCoords(member.geometry);
        if (coords.length >= 2) outerCoordSets.push(coords);
      }
      if (outerCoordSets.length === 0) continue;
      if (LAYER_DEFS[layer].kind === "point") {
        layers[layer].push(centroid(outerCoordSets.flat()));
      } else {
        for (const coords of outerCoordSets) layers[layer].push(coords);
      }
    }
  }

  return layers;
}

// Projects [lat,lon] coordinate arrays into SVG x/y given a bbox and
// target width. Uses a simple equirectangular projection corrected by
// cos(centerLat) so shapes aren't east-west stretched.
function makeProjector(bbox, svgWidth, margin) {
  const centerLatRad = ((bbox.north + bbox.south) / 2) * (Math.PI / 180);
  const cosLat = Math.cos(centerLatRad);
  const lonSpan = bbox.east - bbox.west;
  const latSpan = bbox.north - bbox.south;
  const innerWidth = svgWidth - margin * 2;
  const scale = innerWidth / (lonSpan * cosLat);
  const svgHeight = latSpan * scale + margin * 2;

  function project([lat, lon]) {
    const x = margin + (lon - bbox.west) * cosLat * scale;
    const y = margin + (bbox.north - lat) * scale;
    return [x, y];
  }

  return { project, svgHeight, scale, cosLat };
}

if (typeof module !== "undefined") {
  module.exports = {
    LAYER_DEFS,
    bboxFromCenter,
    bboxSpanKm,
    tileBBox,
    buildOverpassQuery,
    classifyTags,
    parseOverpassResponse,
    makeProjector,
  };
}
