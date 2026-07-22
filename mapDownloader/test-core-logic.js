const assert = require("assert");
const {
  bboxFromCenter,
  bboxSpanKm,
  tileBBox,
  buildOverpassQuery,
  classifyTags,
  parseOverpassResponse,
  makeProjector,
  LAYER_DEFS,
} = require("./core-logic.js");

// bboxFromCenter
{
  const bbox = bboxFromCenter(0, 0, 1000);
  assert(Math.abs(bbox.north - 0.00898) < 0.001, "north offset roughly correct");
  assert(Math.abs(bbox.south + 0.00898) < 0.001, "south offset roughly correct");
  assert(bbox.east > 0 && bbox.west < 0, "east/west straddle center");
  console.log("bboxFromCenter OK");
}

// bboxSpanKm: rough sanity check against known ~111.32 km/degree latitude
{
  const bbox = { north: 1, south: 0, east: 1, west: 0 }; // near equator, 1 deg square
  const { latKm, lonKm, areaKm2 } = bboxSpanKm(bbox);
  assert(Math.abs(latKm - 111.32) < 0.5, "1 degree of latitude is ~111.32 km");
  assert(Math.abs(lonKm - 111.32) < 1, "1 degree of longitude near the equator is ~111.32 km");
  assert(Math.abs(areaKm2 - 111.32 * 111.32) < 200, "area is roughly latKm * lonKm");
  console.log("bboxSpanKm OK");
}

// tileBBox: a small bbox under the tile size should come back as a
// single tile; a larger one should be split into a grid that fully
// covers the original bbox edge to edge with no gaps or overlaps
{
  const small = { north: 18.401, south: 18.400, east: -66.10, west: -66.101 };
  const single = tileBBox(small, 1);
  assert.strictEqual(single.length, 1, "area smaller than tile size stays one tile");
  assert.strictEqual(single[0].north, small.north);
  assert.strictEqual(single[0].south, small.south);
  assert.strictEqual(single[0].east, small.east);
  assert.strictEqual(single[0].west, small.west);

  const big = { north: 18.45, south: 18.40, east: -66.00, west: -66.10 }; // ~5.5km x ~10.5km
  const tiles = tileBBox(big, 1.2);
  assert(tiles.length > 1, "large area is split into multiple tiles");

  // edges of the tile grid should exactly match the original bbox
  const norths = tiles.map((t) => t.north), souths = tiles.map((t) => t.south);
  const easts = tiles.map((t) => t.east), wests = tiles.map((t) => t.west);
  assert(Math.abs(Math.max(...norths) - big.north) < 1e-9, "grid reaches the original north edge");
  assert(Math.abs(Math.min(...souths) - big.south) < 1e-9, "grid reaches the original south edge");
  assert(Math.abs(Math.max(...easts) - big.east) < 1e-9, "grid reaches the original east edge");
  assert(Math.abs(Math.min(...wests) - big.west) < 1e-9, "grid reaches the original west edge");

  // no gaps/overlaps: each row's tiles should tile the full lon span with matching seams
  const rows = new Set(tiles.map((t) => t.row));
  for (const r of rows) {
    const rowTiles = tiles.filter((t) => t.row === r).sort((a, b) => a.west - b.west);
    for (let i = 1; i < rowTiles.length; i++) {
      assert(Math.abs(rowTiles[i].west - rowTiles[i - 1].east) < 1e-9, "adjacent tiles share a seam, no gap/overlap");
    }
  }
  console.log("tileBBox OK,", tiles.length, "tiles for a ~5.5x10.5km area at 1.2km tiles");
}


// buildOverpassQuery: per-layer calls, relation clauses on the layers
// that need them, configurable/matched timeout
{
  const bbox = { north: 41.7, south: 41.6, east: -86.2, west: -86.3 };
  const b = "41.6,-86.3,41.7,-86.2";

  const q1 = buildOverpassQuery(bbox, ["streets"], "all", 40);
  assert(q1.includes(`way["highway"](${b});`), "unfiltered highway query");
  assert(q1.includes("[timeout:40]"), "custom timeout applied");
  assert(!q1.includes("relation"), "streets has no relation clause");

  const qDefault = buildOverpassQuery(bbox, ["streets"], "all");
  assert(qDefault.includes("[timeout:25]"), "defaults to 25s when unspecified");

  const q2 = buildOverpassQuery(bbox, ["water"], "all", 40);
  assert(q2.includes('relation["natural"="water"]'), "water includes a relation clause for bays/lagoons");

  const q3 = buildOverpassQuery(bbox, ["buildings"], "all", 40);
  assert(q3.includes('relation["building"]'), "buildings includes a relation clause for complexes");

  console.log("buildOverpassQuery OK");
}

// classifyTags (unchanged set, quick smoke check)
{
  assert.strictEqual(classifyTags({ natural: "water" }), "water");
  assert.strictEqual(classifyTags({ natural: "coastline" }), "coastline");
  assert.strictEqual(classifyTags({ building: "yes" }), "buildings");
  console.log("classifyTags OK");
}

// parseOverpassResponse: relation (multipolygon) support — outer rings
// captured, inner rings (holes) skipped, per the documented simplification
{
  const fakeLagoon = {
    elements: [
      {
        type: "relation", id: 99, tags: { natural: "water" },
        members: [
          {
            type: "way", role: "outer",
            geometry: [
              { lat: 18.40, lon: -66.05 }, { lat: 18.42, lon: -66.05 },
              { lat: 18.42, lon: -66.02 }, { lat: 18.40, lon: -66.02 },
              { lat: 18.40, lon: -66.05 },
            ],
          },
          {
            type: "way", role: "inner", // an island — should be skipped, not drawn
            geometry: [
              { lat: 18.408, lon: -66.04 }, { lat: 18.409, lon: -66.04 },
              { lat: 18.409, lon: -66.035 }, { lat: 18.408, lon: -66.04 },
            ],
          },
        ],
      },
      // an ordinary way-based building for comparison, in the same response
      {
        type: "way", id: 1, tags: { building: "yes" },
        geometry: [{ lat: 18.41, lon: -66.03 }, { lat: 18.411, lon: -66.03 }, { lat: 18.411, lon: -66.029 }],
      },
    ],
  };
  const layers = parseOverpassResponse(fakeLagoon);
  assert.strictEqual(layers.water.length, 1, "one outer ring captured from the relation");
  assert.strictEqual(layers.water[0].length, 5, "outer ring geometry preserved");
  assert.strictEqual(layers.buildings.length, 1, "ordinary way still parses alongside relations");
  console.log("relation (multipolygon) parsing OK");
}

// a relation classified as a point-type layer (e.g. a hospital mapped
// as a building relation) should reduce to a centroid, same as a way would
{
  const fakeHospitalRelation = {
    elements: [
      {
        type: "relation", id: 50, tags: { amenity: "hospital" },
        members: [
          {
            type: "way", role: "outer",
            geometry: [
              { lat: 18.40, lon: -66.05 }, { lat: 18.40, lon: -66.04 },
              { lat: 18.41, lon: -66.04 }, { lat: 18.41, lon: -66.05 },
            ],
          },
        ],
      },
    ],
  };
  const layers = parseOverpassResponse(fakeHospitalRelation);
  assert.strictEqual(layers.hospitals.length, 1);
  assert.strictEqual(layers.hospitals[0].length, 2, "hospital relation reduced to a single [lat,lon] centroid");
  console.log("point-layer relation centroid OK");
}

// makeProjector (unchanged behavior)
{
  const bbox = { north: 41.61, south: 41.6, east: -86.29, west: -86.3 };
  const { project, svgHeight } = makeProjector(bbox, 1000, 40);
  const [xNW, yNW] = project([bbox.north, bbox.west]);
  const [xSE, ySE] = project([bbox.south, bbox.east]);
  assert(Math.abs(xNW - 40) < 1, "west edge maps near left margin");
  assert(Math.abs(yNW - 40) < 1, "north edge maps near top margin");
  assert(xSE > xNW && ySE > yNW, "SE is right and below NW");
  assert(svgHeight > 0, "positive svg height");
  console.log("makeProjector OK");
}

console.log("All core-logic tests passed. Layer names:", Object.keys(LAYER_DEFS).join(", "));
