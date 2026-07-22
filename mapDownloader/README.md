# Area Map Export (web tool)

A single self-contained HTML file. No build step, no backend, no install
beyond a browser. Open `area_map_export.html` directly, or drop it on
GitHub Pages / Netlify / any static host to put it online.

## What it does

1. Shows a Leaflet map. Draw a box (click "Draw box on map" then
   click-drag), use the current map view, or type exact north/south/
   east/west bounds, or give a center point + radius in meters.
2. On "Generate map", it queries OSM's public Overpass API directly
   from your browser for whichever layers are checked.
3. Renders a line-map SVG with the real bounding-box coordinates
   labeled at the four corners (no arbitrary grid — the north/south/
   east/west values are the actual numbers for that box).
4. "Download SVG" saves the result.

## Data layers

**Core layers** (area/line features): streets, buildings, water,
green space (parks/forest/grass). Streets has a "road detail" toggle:
"All roads" pulls every tagged road; "Major roads only" restricts to
motorway/trunk/primary/secondary/tertiary, which is faster and lighter
for a large or zoomed-out area. Turning this down is the practical
answer to different zoom levels here — Overpass has no separate concept
of tile zoom, and the OSM data itself doesn't change, so the lever
that matters is which data you ask for at what area size, not a
map-tile zoom integer. The span readout suggests switching to "major
roads only" and trimming layers once an area gets over ~4 km².

**Additional data** (off by default, since they add separate Overpass
queries): hospitals & clinics, schools, transit stops/stations, food
access (supermarkets, convenience stores, food banks), farmland,
wetland. These map to actual OSM tags (`amenity=hospital`, `shop=
supermarket`, `landuse=farmland`, etc.) — a few things from the
original d4emergency reference (elderly/non-native-speaking
populations, "hills") aren't taggable point data in OSM, so those
aren't included; happy to add other tag-backed categories on request
(schools by type, places of worship, floodplain proxies, etc.).

**Coastline** (`natural=coastline`, off by default) is in Core layers
next to Water. It's drawn as a stroked line, never filled, since a
coastline segment inside a small bbox essentially never forms a
closed ring the way a lake or park does.

Point layers render as small colored circles with a one-letter glyph
(H/S/T/F) and a legend line appears under the output once generated.
Only the layers you check get queried and drawn — unchecked ones cost
nothing.

## Speed and scale (town/city-size areas)

The Jayuya and San Juan examples are a different scale than what the
tool was originally tuned for — whole towns and city districts (several
km across, tens of thousands of buildings), not a few blocks. Two
separate problems showed up there, both fixed now:

**1. Long/large features dragging in far more geometry than needed.**
Coastlines are the sharpest case — a single OSM way can represent
hundreds of km of shoreline — but long rivers and highways have the
same issue. The original query pattern (`out body; >; out skel qt;`)
fetches the *entire* node list for any way that touches the box at
all. Fixed by switching to `out geom(bbox)`, which has Overpass clip
each way's (and relation member's) coordinates to the bbox
server-side, embedding the clipped geometry directly on the element.
You get the piece inside your box, not the piece plus everything else
the feature happens to run through.

**2. One giant combined query, all-or-nothing — and even splitting by
layer wasn't enough.** The first fix here was fetching one layer per
request instead of bundling everything together, so one heavy layer
timing out wouldn't take the others down with it. That helped, but at
true town/city scale (the Jayuya and San Juan examples), even
individual layers — including normally-light ones like green space —
kept timing out. That's a sign the problem isn't really about *which*
tags are in the query, it's the *area* itself: a shared public
Overpass instance enforces per-request time and memory limits
regardless of how the query is organized, and a query spanning a
whole town can hit those limits no matter how it's split by layer.

The actual fix is **automatic tiling**: the bbox now gets split into a
grid of small cells (a "Max tile size (km)" field controls this, 2 km
by default), and each (tile, layer) pair is fetched as its own small
request. A live readout under the field shows how many tiles and total
requests that works out to for the current bounds. Up to 3 requests
run concurrently to cut wall-clock time without hammering the shared
server. If a handful of tiles fail, only those tiles are missing —
the rest of the map still renders, and the summary reports exact
tile counts per layer (e.g. "buildings: 4200 (18/20 tiles)") so you
know which layer is incomplete and can shrink the tile size or area
if it matters. Regenerating reuses every tile+layer response already
fetched (the cache key is the exact query text, and each tile/layer
pair is its own query), so growing an area or adding a layer doesn't
refetch what you already have.

This trades more total requests (and somewhat more total wall-clock
time) for each individual request being small enough to actually
succeed on a shared public server — the right trade once "a few
blocks" became "a whole town."

Also fixed a real bug along the way: the client-side abort was set to
20s while the query itself declared a 25s server timeout — the tool
was cutting the connection *before Overpass's own timeout even
fired*. Both are now 40s (server) / 45s (client) per request, so the
client always gives Overpass the time it asked for.

**3. Large water bodies, parks, and building complexes are often
`relation` multipolygons, not plain ways** — a single OSM way is
capped around 2000 nodes, so big or complex shapes (a bay, a lagoon, a
hospital campus) get split into a relation with multiple member ways
once they outgrow that. The water/green/wetland/farmland/buildings
layers now query relations as well as ways and take each outer-ring
member as its own shape. Known simplification: inner members (holes —
an island in a lake, a courtyard in a building complex) are skipped
rather than cut out, so those may render solid. Given how common
multipolygons are for exactly the large water/park/building features
this needs to handle, that trade felt worth it over not drawing them
at all.

None of this changes Overpass's own compute cost for a given area — a
genuinely large query is still a genuinely large query on a shared
public server — but between geometry clipping, tiling, and per-tile
isolation, the tool should now actually finish (possibly with a few
incomplete layers it tells you about) instead of failing outright the
way it did on the Jayuya/San Juan areas.

## Why no grid this time

The lettered/numbered grid from the first version is gone. The
border now just carries the literal bbox coordinates (N/S/E/W to 5
decimal places), since that's what you asked for.

## Why not R/Shiny

Shiny would buy you `sf`/`osmdata`/`ggplot2` for styling, at the cost
of needing a live R process somewhere (shinyapps.io free tier sleeps
and has monthly hour caps, or self-host). This tool has no backend at
all — Overpass gets called from the visitor's browser — so hosting is
just dropping the file on GitHub Pages/Netlify. That's the better fit
for "live online" with no ongoing cost. If you want R's cartographic
styling specifically, extend the earlier Python/osmnx script instead
of moving this to Shiny.

## Network dependencies

Everything runs client-side in the browser, so it needs normal
internet access (this is different from the earlier Python/osmnx
version, which needed to run from a machine with internet — this one
only needs the *user's* browser to have it, which is what makes it
work as a hosted page):
- `cdnjs.cloudflare.com` for Leaflet's JS/CSS
- `tile.openstreetmap.org` for the basemap tiles shown while selecting
- `overpass-api.de`, falling back to `overpass.kumi.systems`, for the
  actual OSM data query

If Overpass is slow or rejects requests (shared public server, rate
limited), the status line reports it per layer with tile counts (e.g.
"buildings: 18/20 tiles") — other tiles and layers still render.
Lower "Max tile size (km)" for a still-more-reliable (but slower)
fetch on very dense or very large areas.

## Files

- `area_map_export.html` — the tool itself, this is the one to host/open.
- `core-logic.js` / `test-core-logic.js` — the projection, tiling,
  Overpass query-building, and response-parsing logic as plain
  functions with node-runnable tests, kept outside the HTML so it's
  testable without a browser. The same logic is inlined in the HTML
  file's `<script>`.
- `test-svg-build.js` — a jsdom-based test that exercises the actual
  SVG-building function pulled out of the HTML file.
- `test-tiling-merge.js` — exercises the tile x layer fetch/merge flow
  with a mocked Overpass response (no real network), including a
  partial-tile-failure case.

Run tests with:
```bash
node test-core-logic.js
node test-svg-build.js      # needs `npm install jsdom` first
node test-tiling-merge.js
```

## Putting it online

Simplest options:
- **GitHub Pages**: push this file to a repo, enable Pages, done.
- **Netlify/Vercel drop**: drag the single HTML file into their web
  upload UI.
- No server-side code needed anywhere — it's a static file that talks
  to Overpass directly from the visitor's browser.
