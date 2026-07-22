const { JSDOM } = require("jsdom");
const fs = require("fs");
const assert = require("assert");

const dom = new JSDOM("<!DOCTYPE html><body></body>");
global.document = dom.window.document;
global.window = dom.window;

const html = fs.readFileSync("./area_map_export.html", "utf8");
const script = html.match(/<script>([\s\S]*?)<\/script>/g)[0]
  .replace(/^<script>/, "")
  .replace(/<\/script>$/, "");

const cutoff = script.indexOf("// ---------------------------------------------------------------\n// UI wiring");
eval(script.slice(0, cutoff));

const fake = {
  elements: [
    {
      type: "way", id: 10, tags: { highway: "residential" },
      geometry: [{ lat: 41.60, lon: -86.30 }, { lat: 41.60, lon: -86.29 }],
    },
    {
      type: "way", id: 11, tags: { building: "yes" },
      geometry: [
        { lat: 41.60, lon: -86.30 }, { lat: 41.60, lon: -86.29 },
        { lat: 41.61, lon: -86.29 }, { lat: 41.61, lon: -86.30 },
        { lat: 41.60, lon: -86.30 },
      ],
    },
    {
      type: "way", id: 12, tags: { natural: "coastline" },
      geometry: [{ lat: 41.611, lon: -86.31 }, { lat: 41.605, lon: -86.295 }, { lat: 41.599, lon: -86.28 }],
    },
    { type: "node", id: 20, lat: 41.605, lon: -86.295, tags: { amenity: "hospital" } },
    { type: "node", id: 21, lat: 41.602, lon: -86.298, tags: { shop: "supermarket" } },
  ],
};
const bbox = { north: 41.61, south: 41.6, east: -86.29, west: -86.3 };
const layers = parseOverpassResponse(fake);

const enabled = ["streets", "buildings", "coastline", "hospitals", "food"];
const svg = buildSVG(layers, bbox, enabled);

assert.strictEqual(svg.tagName.toLowerCase(), "svg");
const paths = svg.querySelectorAll("path");
// streets(1) + buildings(1) + coastline(1)
assert.strictEqual(paths.length, 3, "streets + buildings + coastline paths, got " + paths.length);

const coastlinePath = Array.from(paths).find((p) => p.getAttribute("stroke") === "#3f766d");
assert(coastlinePath, "coastline path uses its distinct stroke color");
assert.strictEqual(coastlinePath.getAttribute("fill"), "none", "coastline is never filled");

const circles = svg.querySelectorAll("circle");
assert.strictEqual(circles.length, 2, "hospital + food points rendered as circles");

// disabling coastline should drop it even though it's in the parsed data
const svgNoCoast = buildSVG(layers, bbox, ["streets", "buildings"]);
assert.strictEqual(svgNoCoast.querySelectorAll("path").length, 2, "coastline omitted when not enabled");

// buildOverpassQuery uses out geom(bbox); coastline has no relation
// clause (coastlines aren't multipolygons), buildings does (large
// complexes commonly are)
const q = buildOverpassQuery(bbox, ["coastline", "buildings"], "all");
assert(q.includes('natural"="coastline"'));
assert(q.includes('relation["building"]'), "buildings still gets its relation clause");
assert(q.includes("out geom("));

console.log("paths:", paths.length, "circles:", circles.length);
console.log("buildSVG (coastline + out-geom) test OK");
