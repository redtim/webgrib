# gribwebview

A browser-native GRIB2 decoder and weather data visualization tool. Decodes HRRR (High-Resolution Rapid Refresh) meteorological forecasts and SFBOFS ocean current data directly in the browser and renders them on an interactive map with WebGL2 scalar overlays, Canvas 2D wind particle animations, and real-time lightning strike visualization.

No server-side processing is required. All GRIB2 decoding, projection math, and rendering happens client-side using Web Workers, WebGL2 shaders, and Canvas 2D.

**Tech stack:** TypeScript, Vite, MapLibre GL JS, WebGL2 (GLSL ES 3.0), Canvas 2D, Web Workers

---

## Architecture

```
                          ┌──────────────────────────────────────────┐
                          │              User Interface              │
                          │  Panel · Timeline · LevelSlider · Legend │
                          └─────────────────┬────────────────────────┘
                                            │ variable + forecast hour + level
                                            ▼
                          ┌──────────────────────────────────────────┐
                          │            main.ts  (orchestrator)       │
                          │  Wires UI ↔ data pipeline ↔ renderers   │
                          └───┬─────────────────┬───────────────┬───┘
                              │                 │               │
                 ┌────────────▼──────┐   ┌──────▼──────┐  ┌────▼─────────────┐
                 │   HRRR Pipeline   │   │ OFS Pipeline│  │  Lightning Layer  │
                 │  (GRIB2 / Worker) │   │  (OPeNDAP)  │  │   (WebSocket)    │
                 └────────┬──────────┘   └──────┬──────┘  └────┬─────────────┘
                          │                     │              │
         ┌────────────────▼──────────────┐      │              │
         │        Web Worker             │      │              │
         │  idx fetch → Range request    │      │              │
         │  → GRIB2 parse → DRS decode   │      │              │
         │  → Float32Array (transferable)│      │              │
         └────────────────┬──────────────┘      │              │
                          │                     │              │
              ┌───────────▼─────────┐  ┌────────▼────────┐     │
              │   ScalarFieldLayer  │  │    WindyLayer    │     │
              │   (WebGL2 shader)   │  │  (Canvas 2D)    │     │
              │                     │  │                  │     │
              │ Mercator → lon/lat  │  │ resampleLccTo   │     │
              │ → LCC/LatLon grid   │  │ LatLon → windy  │     │
              │ → field texture     │  │ .js particles   │     │
              │ → colormap LUT      │  │                  │     │
              └─────────────────────┘  └──────────────────┘     │
                          │                     │               │
                          ▼                     ▼               ▼
              ┌──────────────────────────────────────────────────────┐
              │                  MapLibre GL JS                      │
              │       OpenFreeMap dark basemap + overlays            │
              └──────────────────────────────────────────────────────┘
```

### Data flow (HRRR)

1. User selects a variable (e.g. "Temperature 850 hPa") and forecast hour
2. `main.ts` builds a regex query from the catalog (`parameter`, `level`, `forecast`)
3. `DecodeClient` posts the query to the Web Worker
4. Worker fetches the `.idx` sidecar file, finds the matching record's byte range
5. Worker issues an HTTP Range request to fetch just that GRIB2 message (~200-800 KB, not the full ~300 MB file)
6. Worker parses the GRIB2 message sections (0-8), dispatches to the appropriate DRS template decoder
7. Decoded `Float32Array` is posted back to the main thread via transferable (zero-copy)
8. For scalar variables: `ScalarFieldLayer` uploads the data as an R32F texture; the fragment shader forward-projects each pixel through LCC to sample the field, then maps the value through a colormap LUT
9. For wind variables: `WindyLayer` resamples the LCC u/v components onto a regular lat/lon grid with grid-convergence rotation, then feeds them to the vendored `windy.js` particle engine

### Data flow (OFS / Ocean Currents)

1. `sfbofs.ts` builds an OPeNDAP constraint expression requesting only surface-level u/v + coordinate arrays (~1.5 MB vs 68 MB full)
2. `dap2.ts` parses the DAP2 binary response (DDS text header + XDR float payload)
3. Data is passed to `ScalarFieldLayer.setDataLatLon()` (simpler lat/lon shader) and `WindyLayer.setWindLatLon()` (no LCC resampling needed)

---

## Project Structure

```
gribwebview/
├── index.html                          Single-page app entry point
├── vite.config.ts                      Vite config: base path, dev proxy, path aliases
├── tsconfig.json                       TypeScript config (ES2022, strict, WebWorker lib)
├── package.json                        Dependencies and scripts
│
├── src/
│   ├── grib2/                          ── GRIB2 binary format parser ──
│   │   ├── index.ts                    Public API re-exports
│   │   ├── reader.ts                   BinaryReader (big-endian cursor) + BitReader (sub-byte)
│   │   ├── message.ts                  Top-level message walker (sections 0-8)
│   │   ├── types.ts                    TypeScript interfaces for all GRIB2 sections
│   │   ├── idx.ts                      .idx sidecar parser + HTTP Range fetch + HRRR URL builder
│   │   ├── unpack.ts                   DRS template dispatcher → decoded Float32Array
│   │   ├── resample.ts                 LCC → lat/lon resampling with grid-convergence rotation
│   │   ├── sections/                   Section-specific parsers
│   │   │   ├── section1.ts             §1: Reference time, originating center
│   │   │   ├── section3.ts             §3: Grid definition (template 0 lat/lon, template 30 LCC)
│   │   │   ├── section4.ts             §4: Product definition (parameter, level, forecast)
│   │   │   ├── section5.ts             §5: Data representation template number
│   │   │   └── section6.ts             §6: Bitmap indicator + bitmap data
│   │   └── templates/drs/              Data Representation Section decoders
│   │       ├── common.ts               Shared: IEEE float parse, dequantize formula, bitmap apply
│   │       ├── simple.ts               Template 5.0: simple bit-packing
│   │       ├── complex.ts              Template 5.2/5.3: complex packing + spatial differencing
│   │       ├── jpeg2000.ts             Template 5.40: JPEG 2000 wavelet compression
│   │       ├── jpxBootstrap.ts         Lazy JPEG 2000 decoder loader (jpx.js / OpenJPEG WASM)
│   │       └── png.ts                  Template 5.41: PNG lossless compression
│   │
│   ├── ofs/                            ── Ocean Forecast System data access ──
│   │   ├── dap2.ts                     DAP2 binary (.dods) parser
│   │   └── sfbofs.ts                   SFBOFS fetcher: OPeNDAP subsetting, cycle timing
│   │
│   ├── renderer/                       ── Visualization layers ──
│   │   ├── index.ts                    Public exports
│   │   ├── catalog.ts                  Declarative variable catalog (queries, colormaps, ranges)
│   │   ├── colormaps.ts                14 named 256-entry RGBA LUT colormaps
│   │   ├── layers/
│   │   │   ├── scalarField.ts          WebGL2 CustomLayerInterface: field texture + shader
│   │   │   ├── windyLayer.ts           Canvas overlay: vendored windy.js particle animation
│   │   │   ├── lightning.ts            Canvas overlay: real-time Blitzortung lightning strikes
│   │   │   └── vendor/
│   │   │       ├── windy.js            Vendored leaflet-velocity particle engine
│   │   │       └── LICENSE-windy.txt   CSIRO BSD/MIT + MIT license
│   │   ├── gl/
│   │   │   ├── program.ts             WebGL2 shader compilation + linking
│   │   │   └── texture.ts             R32F scalar texture + colormap LUT texture creation
│   │   └── projections/
│   │       ├── lcc.ts                  Lambert Conformal Conic: CPU + GLSL implementations
│   │       └── latlon.ts              Regular lat/lon: CPU + GLSL implementations
│   │
│   ├── worker/                         ── Web Worker for off-thread decoding ──
│   │   ├── decodeWorker.ts             Worker entry: fetch + parse + decode, post transferable
│   │   └── client.ts                   Main-thread coordinator: job dispatch + LRU cache
│   │
│   └── demo/                           ── Application UI ──
│       ├── main.ts                     App orchestrator: map init, data loading, click-inspect
│       ├── panel.ts                    Variable picker (grouped, collapsible)
│       ├── timeline.ts                 Cycle selector + forecast hour ticks
│       ├── levelSlider.ts              Atmospheric level picker
│       ├── legend.ts                   Colormap bar with unit-aware tick labels
│       └── units.ts                    Unit conversion system + localStorage persistence
│
├── test/
│   ├── smoke.test.ts                   E2E decode tests against live NOAA data
│   └── lcc.test.ts                     LCC projection math tests
│
└── worker/                             Vite output directory for worker bundles
```

---

## Component Deep Dives

### GRIB2 Parser (`src/grib2/`)

#### What is GRIB2?

GRIB2 (General Regularly-distributed Information in Binary form, Edition 2) is a WMO standard binary format for encoding gridded meteorological data. It is the primary distribution format for operational numerical weather prediction models worldwide, including NOAA's HRRR, GFS, RAP, and NAM.

A GRIB2 file contains one or more **messages**, each encoding a single 2D field (e.g., "temperature at 850 hPa, forecast hour 6"). Each message is divided into 8 numbered **sections**:

| Section | Name | Content |
|---------|------|---------|
| 0 | Indicator | Magic bytes `GRIB`, discipline code, edition, total message length |
| 1 | Identification | Reference time, originating center/subcenter, production status |
| 2 | Local Use | Optional agency-specific extensions (skipped by this parser) |
| 3 | Grid Definition | Grid template (lat/lon, Lambert Conformal, etc.), dimensions, projection parameters |
| 4 | Product Definition | Parameter category/number, level type, forecast time |
| 5 | Data Representation | Packing template number, scaling factors, bits per value |
| 6 | Bitmap | Which grid points have data vs. are missing |
| 7 | Data | The packed/compressed data bytes |
| 8 | End | `7777` marker |

Sections 4-7 can repeat within a single message to encode multiple products on the same grid, though in practice HRRR uses one product per message.

#### Parser architecture

```
.idx sidecar (text)          GRIB2 file (binary)
        │                           │
  parseIdx()                   HTTP Range
  findRecord()                 request
        │                           │
        └──── byte offset ──────────┘
                    │
              fetchMessageBytes()
                    │
              walkMessages()  ← generator yielding GribMessage records
                    │
         ┌──── per section ─────────────────────────┐
         │  §1 parseSection1()  → reference time     │
         │  §3 parseSection3()  → grid definition     │
         │     ├─ template 0: regular lat/lon        │
         │     └─ template 30: Lambert Conformal     │
         │  §4 parseSection4()  → product definition  │
         │  §5 parseSection5()  → DRS template number │
         │  §6 parseSection6()  → bitmap              │
         └───────────────────────────────────────────┘
                    │
              decodeMessage()  ← DRS template dispatch
                    │
         ┌──── per template ─────────────────────────┐
         │  5.0:  unpackSimple()       (bit-packing) │
         │  5.2:  unpackComplex()      (grouped)     │
         │  5.3:  unpackComplexSpatial() (+spatial Δ)│
         │  5.40: unpackJpeg2000()     (wavelet)     │
         │  5.41: unpackPng()          (lossless)    │
         └───────────────────────────────────────────┘
                    │
              DecodedField { values: Float32Array, nx, ny, min, max }
```

#### Binary reader (`reader.ts`)

All GRIB2 data is big-endian. The `BinaryReader` class provides a cursor-based reader over a `DataView` with methods for common integer widths (`uint8`, `uint16`, `uint32`, `uint64`, `int8`, `int16`, `int32`), ASCII strings, raw byte slices, and GRIB2's unusual **sign-magnitude integers** (where the high bit encodes sign separately from the magnitude, unlike two's complement).

The `BitReader` class handles sub-byte reading for the DRS templates' packed data streams. It reads N bits at a time, MSB-first within each byte, crossing byte boundaries freely. This is the hot path for simple/complex packing decompression.

#### Message walker (`message.ts`)

`walkMessages()` is a generator that iterates over concatenated GRIB2 messages in a buffer. For each message it:

1. Validates the `GRIB` magic and edition number (must be 2)
2. Reads the 16-byte Section 0 indicator (discipline, total length)
3. Parses Section 1 (reference time, center ID)
4. Iterates remaining sections by reading each section's 4-byte length + 1-byte section number
5. Dispatches to the appropriate section parser
6. Yields a `GribMessage` when Section 7 (data) is encountered
7. Validates the `7777` end marker

It handles repeating Section 4-7 groups (multiple products per grid) and has a tolerant mode for corrupt boundaries.

#### Index parser and HTTP Range fetch (`idx.ts`)

NOAA publishes a `.idx` sidecar file alongside every GRIB2 file. Each line maps a parameter/level/forecast to a byte offset:

```
1:0:d=2026041112:REFC:entire atmosphere:anl:
2:63912:d=2026041112:RETOP:cloud top:anl:
3:91024:d=2026041112:VIS:surface:anl:
```

`parseIdx()` parses this text format. `findRecord()` matches a query (parameter regex, level regex, forecast regex) to a specific byte range. `fetchMessageBytes()` then issues an HTTP Range request for just that slice — typically 200-800 KB instead of the full ~300 MB GRIB2 file. This is what makes client-side decoding practical.

`hrrrUrls()` builds NOAA S3 bucket URLs for HRRR data. `forecastQuery()` and `accForecastQuery()` build forecast-time regexes for standard and accumulated fields.

#### Data Representation Templates (`templates/drs/`)

GRIB2 supports multiple compression schemes, identified by the template number in Section 5. This parser implements four:

**Template 5.0 — Simple packing** (`simple.ts`): The most straightforward scheme. Each grid point value is quantized to an unsigned integer of `bitsPerValue` bits, packed contiguously MSB-first. Reconstruction applies the formula:

```
value = (R + X * 2^E) * 10^(-D)
```

where R is the reference value (IEEE 754 float), E is the binary scale factor, D is the decimal scale factor, and X is the packed unsigned integer. Special case: `bitsPerValue === 0` means every value equals R exactly.

**Template 5.2 / 5.3 — Complex packing with spatial differencing** (`complex.ts`): A two-level encoding scheme designed for spatially smooth fields (temperatures, pressures, geopotential heights). Template 5.2 uses group-based packing where the field is divided into groups, each with its own reference value and bit width. Template 5.3 adds first- or second-order spatial differencing before packing, which reduces entropy for smooth fields and achieves much better compression ratios.

**Template 5.40 — JPEG 2000** (`jpeg2000.ts`): Uses JPEG 2000 wavelet compression for the data section. Achieves excellent compression for complex fields but requires a JPEG 2000 decoder. The parser lazy-loads a decoder (jpx.js from PDF.js or OpenJPEG WASM) via `templates/drs/jpxBootstrap.ts` only when a template 5.40 message is encountered.

**Template 5.41 — PNG** (`png.ts`): Lossless PNG compression of the packed integer values. Decodes the PNG to extract pixel sample values, then applies the standard dequantization formula.

All templates share common utilities in `common.ts`: the `parseSimplePackingHeader()` function reads the 11-byte packing header (reference value, binary/decimal scale, bits per value), `simpleDequantize()` applies the reconstruction formula, and `applyBitmap()` expands sparse data using the Section 6 bitmap (MSB-first, setting unset grid points to NaN).

#### LCC resampling (`resample.ts`)

HRRR data is on a Lambert Conformal Conic grid with grid-relative u/v wind components. The vendored `windy.js` particle renderer only accepts regular lat/lon grids with true-north-referenced vectors. `resampleLccToLatLon()` bridges this gap:

1. Walks the LCC grid perimeter to compute a lat/lon bounding box
2. Creates a target regular grid (default 600x300, ~0.12° resolution)
3. For each target cell, forward-projects lat/lon into LCC grid space
4. Bilinearly interpolates u/v from the source grid
5. Rotates from grid-relative to true-north using the grid convergence angle `gamma = n * (lambda - lambda_0)`
6. Emits a windy.js-compatible `[U, V]` component pair

Out-of-grid cells are filled with (0, 0) — "no wind" — because windy.js would crash on NaN values propagating through its draw-bucket math.

---

### OPeNDAP / DAP2 Parser (`src/ofs/`)

#### What is OPeNDAP?

OPeNDAP (Open-source Project for a Network Data Access Protocol) is a remote data access protocol widely used in earth science for subsetting and retrieving portions of large datasets without downloading entire files. The protocol allows clients to request specific variables and array slices via URL constraint expressions.

#### What is DAP2 binary format?

DAP2 `.dods` responses contain two parts separated by a `\nData:\n` marker:

1. **DDS header** (text): Declares variable names, types (`Float32`, `Float64`, `Int32`, `Int16`), and dimension shapes (e.g., `Float32 u_eastward[time = 1][s_rho = 1][eta_rho = 329][xi_rho = 553]`)
2. **Binary payload** (XDR-encoded): For each variable in DDS declaration order, two big-endian `uint32` length fields (the array length, repeated twice as a consistency check), followed by the raw data. Float32 values are big-endian IEEE 754; Float64 are 8-byte IEEE 754; Int16 values are padded to 4 bytes per XDR convention.

#### Why a custom parser?

The DAP2 binary format is simple enough to parse in ~130 lines of TypeScript. Using a full NetCDF library (e.g., netcdf-js) would add significant bundle weight and complexity for what amounts to reading a text header and iterating over big-endian floats. The custom parser (`dap2.ts`) handles the four data types SFBOFS uses and fits naturally into the browser's `ArrayBuffer` API.

#### SFBOFS data access (`sfbofs.ts`)

The San Francisco Bay Operational Forecast System (SFBOFS) is an FVCOM-based ocean current model run by NOAA CO-OPS. It produces regulargrid output interpolated to a 329x553 lat/lon grid.

- **Cycles**: 03Z, 09Z, 15Z, 21Z (4 per day)
- **Availability**: ~4-5 hours after nominal cycle time
- **Forecast range**: 48 hours
- **Subsetting**: The OPeNDAP constraint expression requests only surface-level (depth index 0) u/v current components plus coordinate arrays, reducing the download from ~68 MB to ~1.5 MB

In development, requests go through Vite's proxy (`/ofs-proxy → opendap.co-ops.nos.noaa.gov`) to bypass CORS. In production, a Cloudflare Worker CORS proxy is used (configured via `VITE_OFS_PROXY_URL`).

---

### Web Worker Pipeline (`src/worker/`)

GRIB2 decompression — especially JPEG 2000 decoding — is CPU-intensive and would block the main thread, causing jank during data loads. The decode pipeline runs entirely in a Web Worker.

**`decodeWorker.ts`** listens for two message types:
- `decode`: Single field (scalar variables). Fetches the idx, range-fetches the GRIB2 message, parses, decodes, and posts the resulting `Float32Array` back via **transferable** (zero-copy ownership transfer — no serialization cost).
- `decode-pair`: Two fields in parallel (wind u/v components). Fetches both in parallel with `Promise.all`, posts both arrays back.

**`client.ts`** (`DecodeClient`) is the main-thread coordinator. It:
- Spawns the worker and tracks pending jobs via `Map<jobId, {resolve, reject}>`
- Maintains an **LRU cache** (20 entries for scalars, 10 for wind pairs) keyed by idx URL + query regex source strings, avoiding redundant fetches when the user navigates back to a previously-viewed field
- Provides `decode()` and `decodePair()` async methods that return cached results or dispatch to the worker

---

### Rendering Layers (`src/renderer/`)

#### ScalarFieldLayer (`layers/scalarField.ts`)

A MapLibre GL `CustomLayerInterface` that renders decoded GRIB2 fields using WebGL2.

**Pipeline:**
1. `setData(field, grid)` uploads the `Float32Array` as an `R32F` texture and computes LCC projection uniforms + a Mercator bounding rectangle
2. `render()` draws a tessellated quad (in MapLibre Mercator unit-square coordinates) transformed by the map's camera matrix
3. The **fragment shader** receives perspective-correct Mercator coordinates, unprojects to lon/lat, forward-projects through LCC (or a simple affine for lat/lon grids), samples the field texture, and maps the value through a 256-entry colormap LUT texture

Two shader programs are compiled: one with embedded LCC projection GLSL, one with lat/lon projection GLSL. The active program is selected based on the data source.

The layer retains the field data on the CPU (~8 MB for HRRR CONUS at 1799x1059) to support `sampleAt()` — bilinear interpolation at a geographic point for click-to-inspect popups without GPU readback.

#### WindyLayer (`layers/windyLayer.ts`)

A DOM canvas overlay that renders wind-particle streamlines using the vendored leaflet-velocity `windy.js` particle engine.

**Why canvas instead of WebGL?** The project originally used a custom WebGL2 ping-pong particle advection renderer. It was replaced with the vendored leaflet-velocity approach because:
- It produces the characteristic nullschool-style soft trailing-line visual that the user specifically wanted (matching a companion Swift+Metal port)
- The WebGL2 renderer produced suboptimal visuals: tiny 1.6px points with abrupt respawn pop-in and no inter-frame interpolation

**How it works:**
1. Creates a `<canvas>` element positioned absolutely over the MapLibre canvas, with `pointer-events: none`
2. Hands the canvas to `windy.js`, which runs its own `requestAnimationFrame` loop at 15 fps
3. On map pan/zoom start: stops the simulation and clears the canvas (particles would be geographically stale)
4. On map pan/zoom end: restarts with new viewport bounds after a 150ms debounce

**Trade-offs:**
- *Pro:* Visual fidelity matches leaflet-velocity / earth.nullschool.net
- *Con:* Canvas sits above all MapLibre layers (roads/labels end up underneath wind trails)
- *Con:* Canvas clears during pan/zoom — particles pop back in after the camera settles

**LCC handling:** `setWind()` runs source data through `resampleLccToLatLon()` before passing to windy.js. The raw LCC data is retained on the instance so `sampleAt()` reads from unresampled values for pixel-accurate click-to-inspect.

**Lat/lon handling:** `setWindLatLon()` skips resampling, flips rows from S-to-N to N-to-S (windy.js expects scanMode 0), and replaces NaN with 0.

#### LightningLayer (`layers/lightning.ts`)

A Canvas 2D overlay that visualizes real-time lightning strikes from the Blitzortung network.

- Connects via WebSocket to `wss://ws1.blitzortung.org/`
- Decodes LZW-compressed JSON messages containing strike lat/lon/time/polarity
- Renders bolt-shaped markers with an age-based color gradient (white → yellow → orange → red → grey) and a radial glow effect for fresh strikes (< 5 seconds old)
- Prunes strikes older than the configurable max age (default 10 minutes)
- Supports `hitTest()` for click-to-inspect proximity detection

---

### Projection Math (`src/renderer/projections/`)

#### Lambert Conformal Conic (`lcc.ts`)

HRRR data is distributed on a Lambert Conformal Conic grid (GRIB2 template 3.30). Every pixel in the scalar field shader needs a forward projection from lon/lat to grid coordinates. The LCC math is implemented in two places:

**CPU (TypeScript):**
- `computeLccUniforms()`: Precomputes projection constants (n, F, rho0, lambda0, origin, scan direction) from GRIB2 grid parameters
- `lonLatToGridUV()`: Forward LCC — lon/lat degrees to normalized [0,1] grid coordinates (used for click-to-inspect, resampling)
- `gridUVToLonLat()`: Inverse LCC — grid coordinates to lon/lat (used for bounding box computation)
- `gridLonLatBounds()`: Walks the grid perimeter at N sample points to compute a tight lon/lat bounding box (the grid's rectangular outline in LCC space becomes a curved quad in lon/lat)
- `lonLatToMercator()`: Forward Web Mercator for positioning the rendering quad

**GPU (GLSL):**
- `lccToGrid()`: Inlined into the fragment shader via the `LCC_GLSL` template string. Performs the same forward projection per-pixel in parallel. Takes `(lon, lat)` in radians, returns normalized `(u, v)` grid coordinates.

The projection handles GRIB2 scan mode flags (bit 1 for east/west scan direction, bit 2 for north/south) and normalizes longitudes to [-pi, pi] to avoid antimeridian wrapping issues.

**Forward LCC formulas** (spherical approximation, which is adequate for visualization):

```
n  = ln(cos phi_1 / cos phi_2) / ln(tan(pi/4 + phi_2/2) / tan(pi/4 + phi_1/2))
F  = cos(phi_1) * tan^n(pi/4 + phi_1/2) / n
rho  = R * F / tan^n(pi/4 + phi/2)
rho_0 = R * F / tan^n(pi/4 + phi_0/2)
x  = rho * sin(n * (lambda - lambda_0))
y  = rho_0 - rho * cos(n * (lambda - lambda_0))
```

#### Regular Lat/Lon (`latlon.ts`)

OFS data is on a regular lat/lon grid, so the projection is a simple affine transform: `grid_i = (lon - lon_min) / (lon_max - lon_min)`. Both CPU and GLSL implementations are provided, matching the same interface pattern as LCC.

---

### Data Catalog and Units (`src/renderer/catalog.ts`, `src/demo/units.ts`)

#### Catalog-driven design

All weather variables are defined declaratively in `CATALOG` — an array of `CatalogVariable` objects, each specifying:
- `id`, `group`, `label` for UI display
- `kind`: `'scalar'` or `'wind'`
- `levels[]`: atmospheric levels with regex queries for .idx matching
- `colormap`: named colormap from the 14 available palettes
- `range`: fixed value range in native units
- `dimension`: physical dimension (temperature, speed, length, distance) for unit conversion
- `format()`: display formatter respecting the user's unit preference
- `source`: `'hrrr'` (default) or `'ofs'`

**Current catalog groups:** Temperature (2), Wind (2), Moisture (2), Instability (4), Precipitation (4), Radar (2), Clouds (2), Lightning (1), Other (1), Ocean (1)

#### Static palette ranges

Colormap ranges are fixed per variable rather than dynamically computed per timestep. This prevents visual flickering when advancing through forecast hours — the same color always represents the same physical value, making temporal comparisons meaningful.

#### Unit conversion system

All data is stored in native GRIB2 units (Kelvin, m/s, mm, meters). Conversion to display units happens at render time via the catalog's `format()` function.

**Supported dimensions and units:**
| Dimension | Units | Native |
|-----------|-------|--------|
| Temperature | °F, °C | Kelvin |
| Speed | kt, mph, m/s, km/h | m/s |
| Length | in, mm, cm | mm |
| Distance | mi, km, m, ft | meters |

User preferences persist to `localStorage` and are reactive — changing a unit preference updates the legend and tooltip displays via a listener pattern.

---

### UI Components (`src/demo/`)

**Panel** (`panel.ts`): Grouped variable picker with collapsible sections. Renders the CATALOG grouped by category, shows active state highlighting and level count badges.

**Timeline** (`timeline.ts`): Combined cycle selector (dropdown of 6 recent HRRR cycles with date/hour labels) and forecast hour ticks grouped by calendar day. Preserves valid time when switching cycles. Supports `stepHour()` for keyboard navigation.

**Level Slider** (`levelSlider.ts`): Atmospheric level picker dynamically populated from the selected variable's levels array (e.g., 2m, 850 hPa, 500 hPa, 250 hPa).

**Legend** (`legend.ts`): Colormap bar with tick labels in the user's preferred units. Updates on variable change or unit preference change.

**Keyboard shortcuts:** Left/right arrow keys step through forecast hours; up/down step through atmospheric levels.

---

## Data Sources

| Source | Endpoint | Format | Grid | Resolution | Variables |
|--------|----------|--------|------|------------|-----------|
| **HRRR** | `noaa-hrrr-bdp-pds.s3.amazonaws.com` | GRIB2 + .idx | Lambert Conformal Conic | 3 km, 1799x1059 | Temperature, wind, precipitation, reflectivity, CAPE, clouds, visibility, etc. |
| **SFBOFS** | `opendap.co-ops.nos.noaa.gov` (via CORS proxy) | DAP2 binary | Regular lat/lon | 329x553 | Ocean surface currents (u/v) |
| **Lightning** | `wss://ws1.blitzortung.org/` | LZW-compressed JSON | Point data | Real-time | Strike lat/lon/time/polarity |
| **Basemap** | OpenFreeMap | Vector tiles | — | — | Dark style map tiles |

---

## Key Design Decisions

**Browser-native GRIB2 decoding.** No server-side processing — all binary parsing and decompression runs in the browser. This eliminates server infrastructure costs and latency, at the expense of requiring modern browser capabilities (WebGL2, Web Workers, Float32 textures).

**HTTP Range requests via .idx sidecar.** Instead of downloading entire GRIB2 files (~300 MB for HRRR surface), the parser uses NOAA's .idx files to locate specific messages by byte offset and fetches only the needed slice (~200-800 KB). This is what makes real-time browsing of HRRR data practical in a browser.

**Web Worker for off-thread decoding.** GRIB2 decompression (especially JPEG 2000) can take hundreds of milliseconds. Running it in a Web Worker with transferable ArrayBuffer posting keeps the UI responsive.

**Canvas 2D overlay for wind particles.** The vendored leaflet-velocity `windy.js` engine was chosen over a custom WebGL2 particle renderer because it produces the nullschool-style soft trailing-line visual that was specifically desired. The trade-off (canvas above basemap labels, clears during pan/zoom) was accepted as cosmetically acceptable given the demo's dimmed road layer.

**LCC projection in the fragment shader.** Scalar fields are projected per-pixel in the GPU rather than pre-resampled on the CPU. This preserves native resolution at all zoom levels without the memory and computation cost of creating a lat/lon texture. The wind layer *does* resample to lat/lon because windy.js has no projection concept.

**Static colormaps with fixed ranges.** Each variable has a fixed value-to-color mapping rather than auto-scaling per timestep. This prevents visual flickering when navigating through forecast hours and makes colors comparable across time.

**Custom DAP2 parser.** The OPeNDAP binary format is simple enough (~130 lines) that a full NetCDF library isn't warranted. The custom parser handles exactly the data types SFBOFS uses and nothing more.

**Late-bound unit conversion.** All data is stored in native SI/GRIB2 units. Conversion to display units happens only at tooltip/legend render time via catalog format functions, keeping the data pipeline unit-agnostic.

---

## Development

### Prerequisites

- Node.js (18+)
- npm

### Setup

```bash
npm install
```

### Dev server

```bash
npm run dev
```

Starts Vite at `http://localhost:5173/webgrib/` with proxy configuration for OFS data:
- `/ofs-proxy` → `https://opendap.co-ops.nos.noaa.gov`
- `/ofs-s3` → `https://noaa-nos-ofs-pds.s3.amazonaws.com`

### Build

```bash
npm run build
```

Produces a production build in `dist/` with source maps enabled.

### Type checking

```bash
npm run typecheck
```

### Tests

```bash
npm test
```

Runs smoke tests against live NOAA HRRR data (requires network access). Tests verify:
- Simple packing (template 5.0) decoding: UGRD 10m
- Spatial differencing (template 5.3) decoding: VIS, REFC
- Grid shape and value range validation
- Tests skip gracefully on network failure or missing JPEG 2000 decoder

### Production deployment

For production, OFS data access requires a CORS proxy since the NOAA OPeNDAP server doesn't serve CORS headers. Set `VITE_OFS_PROXY_URL` to your deployed Cloudflare Worker URL:

```bash
VITE_OFS_PROXY_URL=https://ofs-proxy.yourname.workers.dev npm run build
```
