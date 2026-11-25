# Radar Archive Timeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Pick any day and radar on `radar.html`, select a time range on a day timeline, and loop it.

**Architecture:** Gate data stays as the file's own codes end to end (parser → grid → integer texture). Day, range and bookmark rules are pure functions in `archive.ts`; one `ScanLoader` serves both live and archive; DOM work lives in `timeline.ts`, `archiveView.ts` and `main.ts`.

**Tech Stack:** TypeScript, Vite, MapLibre GL 4.7, WebGL2, Web Worker, `DecompressionStream`, `node --test`.

**Spec:** `docs/superpowers/specs/2026-11-25-radar-archive-timeline-design.md`

## Global Constraints

- Browser only; reads `https://unidata-nexrad-level2.s3.amazonaws.com` directly. No new dependencies.
- **No maximum loop length**; no scan in the selected range is thinned or skipped silently.
- Bars are labelled exactly `activity (from file size)`.
- Warn above 1 GB (`1e9`) of download or memory, and still allow loading.
- Times default to the viewer's local zone, with a UTC switch. URL ranges are UTC.
- Live view behaviour must not change. No auto-refresh in Archive.
- No scan caching (tracked as redtim/webgrib#8).
- **Do not commit**; the user has not asked for commits.
- Tests: `npm test`; types: `npm run typecheck`. Both clean after every task.

## Review Focus

1. Date or radar changed quickly: a slow earlier listing must not replace the newer one (Task 4, `latestOnly`).
2. A local day spanning two UTC folders, or a 23/25-hour DST day: scans are neither lost nor taken from the neighbouring day (Task 4).
3. From later than To, or a range holding no scans: Load is disabled, nothing is fetched (Task 4).
4. A damaged or hand-edited bookmark: falls back to defaults without an error (Task 4).
5. Radials in one sweep with differing scale/offset: values are preserved (Task 1).

---

### Task 1: Keep gates as one- or two-byte codes

**Files:** Modify `src/radar/{level2,polar,radarLayer}.ts`; Test `test/radar{Level2,Polar}.test.ts`

**Interfaces — Produces:**
- `level2.ts`: `type Codes = Uint8Array | Uint16Array`; `Moment { firstGate; gateSpacing; scale; offset; codes: Codes }`; `gateValue(code, scale, offset): number` (0 → NaN, 1 → `RANGE_FOLDED`, scale 0 → code, else `(code - offset) / scale`)
- `polar.ts`: `PolarGrid { azimuthBins; gateCount; firstGate; gateSpacing; elevation; scale; offset; data: Codes }`; code 0 pads gaps

- [ ] **Step 1: Failing tests** — 8-bit moment yields `Uint8Array` codes `[0,1,66,146]` and `gateValue` gives NaN, `RANGE_FOLDED`, 0, 40; 16-bit yields `Uint16Array` and 249.5; grid keeps `Uint8Array` for 8-bit; a radial with a different scale/offset in the same sweep reads back the same physical values, and NaN/folded stay so.
- [ ] **Step 2:** `npm test` → those tests fail.
- [ ] **Step 3:** Implement. A grid takes the first radial's scale, offset and width; other codings are re-coded, clamped to `[2, max]`. Shader: `usampler2D`, `R8UI`/`R16UI` by array type, `UNPACK_ALIGNMENT` 1, decode in GLSL as `gateValue` does.
- [ ] **Step 4:** `npm test && npm run typecheck` pass.

### Task 2: Read 2008–2016 gzip files; name the older format

**Files:** Modify `src/radar/level2.ts`; Test `test/radarLevel2.test.ts`

**Interfaces — Produces:** `OLDER_FORMAT_MESSAGE = 'This scan uses an older data format that is not supported yet'`; `readVolume(body, options)` accepts gzip; `VolumeReader.push` accepts either bzip2 records or a bare message stream after the 24-byte header (chosen by whether bytes 28–30 are `BZh`).

- [ ] **Step 1: Failing tests** — gzip of header + bare messages, delivered 7 bytes at a time, parses equal to the bzip2 version of the same radials; early cancel reaches the source stream of a gzip download; a message type 1 frame throws `OLDER_FORMAT_MESSAGE`; an `ARCHIVE2.` header throws it too; a gzip stream cut inside a radial throws `/truncated/`.
- [ ] **Step 2:** `npm test` → fail.
- [ ] **Step 3:** Implement: one message-walking method shared by both modes; `readVolume` sniffs `1f 8b` on the first bytes and pipes through `DecompressionStream('gzip')`.
- [ ] **Step 4:** Tests and typecheck pass; smoke-read real 2009, 2013 and 2016 gzip files from scratchpad, and record the compressed fraction needed through tilt 2 (used by Task 4).

### Task 3: List any day

**Files:** Modify `src/radar/s3.ts`; Test `test/radarS3.test.ts`

**Interfaces — Produces:** `interface ScanFile { key: string; time: number; size: number }`; `listScans(site, folders, fetchFn?): Promise<ScanFile[]>` (sorted by time); `listSitesOn(folders, fetchFn?): Promise<string[]>`; folders look like `2013/05/20/`.

- [ ] **Step 1: Failing tests** — names ending `_V06`, `_V06.gz`, `_V03.gz`, `.gz` are scans and `_MDM` is not; sizes and times are read; two folders merge in time order; `scanTimeFromKey` reads `.gz` names; sites merge without duplicates.
- [ ] **Step 2–4:** Fail, implement (one shared scan-name pattern; `findRecentScans` and `listSites` reuse it), pass.

### Task 4: Day, range, estimate and bookmark rules

**Files:** Create `src/radar/archive.ts`; Test `test/radarArchive.test.ts`

**Interfaces — Produces:**
```ts
type Zone = 'local' | 'utc';
interface Range { from: number; to: number }            // ms, inclusive
interface ViewState { mode: 'live' | 'archive'; site: string; product: ProductId; date: string; zone: Zone; range: Range | null }
MIN_DATE = '2008-01-01'; WARN_BYTES = 1e9; FRAME_BYTES = 720 * (1832 + 1192);
dateOf(ms, zone): string            shiftDate(date, days): string
dayBounds(date, zone): [start: number, end: number]     // end exclusive
utcFolders(start, end): string[]
timeOfDay(ms, zone): string         atTimeOfDay(date, 'HH:MM', zone): number
scansBetween(scans, range | null): ScanFile[]
estimateLoad(scans): { count; downloadBytes; memoryBytes; large: boolean }
stepScan(scans, time, by): number   // time of the scan `by` places away, clamped
parseViewState(search, now: Date): ViewState            formatViewState(state): string
latestOnly(): () => () => boolean   // each call supersedes earlier ones
```

- [ ] **Step 1: Failing tests** — with `TZ=America/Chicago` set in the test file: `dayBounds('2013-05-20','local')` runs 05:00Z–05:00Z next day and `utcFolders` gives both folders; `2026-03-08` is 23 hours, `2026-11-01` 25; a UTC day gives one folder; reversed range selects nothing; estimate of two `_V06` scans of 10 MB is 3 MB download each and `2 * FRAME_BYTES` memory, `.gz` uses the Task 2 fraction, `large` flips above 1e9; state round-trips; `?mode=zzz&date=2013-13-45&from=abc&site=../x` yields live, today, no range, `KMUX`; dates before `MIN_DATE` clamp; `latestOnly` expires earlier guards.
- [ ] **Step 2–4:** Fail, implement, pass.

### Task 5: One loader for live and archive

**Files:** Create `src/radar/loader.ts`; Modify `src/radar/{loop,worker}.ts`; Test `test/radarLoader.test.ts`, `test/radarLoop.test.ts`

**Interfaces — Produces:**
- `worker.ts` reply on failure: `{ key; error; outOfMemory?: boolean }` (set for allocation `RangeError`s)
- `ScanLoader(createWorker: () => WorkerLike, concurrency = 3)`; `load(keys, { scan(s), failed(key, message) }): Promise<'done' | 'cancelled' | 'out-of-memory' | 'older-format'>`; `cancel()`. A new `load` cancels the previous one.
- `new FrameLoop<T>({ followNewest })`, default `true`; `false` keeps the view on the same scan as later ones arrive

- [ ] **Step 1: Failing tests** (fake worker) — all keys load with at most 3 in flight; a failure is reported and the rest continue; out-of-memory and older-format stop the queue with that outcome; `cancel` resolves `'cancelled'`, terminates the worker and ignores late replies; `followNewest: false` stays on the first frame.
- [ ] **Step 2–4:** Fail, implement, pass.

### Task 6: Timeline and Archive mode

**Files:** Create `src/radar/{timeline,archiveView}.ts`; Modify `src/radar/main.ts`, `radar.html`

**Interfaces — Consumes:** Tasks 3–5.
**Produces:** `new Timeline(root, onSelect(range | null))` with `setDay(scans, bounds, zone)`, `setRange(range | null)`.

- [ ] **Step 1:** Page: `Live | Archive` switch; bottom bar with date field and ‹ › buttons, `Local | UTC`, canvas of bars, two `role="slider"` handles, From/To `time` inputs, summary, Load/Cancel. Zoom control moves to top-right.
- [ ] **Step 2:** Timeline: bar height is size ÷ day's largest; pointer drag selects (`touch-action: none`); handle keys: arrows ±1 scan, PageUp/Down ±10, Home/End.
- [ ] **Step 3:** Wiring: Load reuses held frames, loads oldest first with `followNewest: false`; Cancel keeps arrivals; radar list follows the date; status shows date and time in the chosen zone; messages for no files, skipped count, out of memory ("Stopped at N of M scans"), older format; URL via `formatViewState`; a bookmarked range auto-loads unless `large`.
- [ ] **Step 4:** `npm test && npm run typecheck` pass.

### Task 7: Verify in the browser

- [ ] Synthetic echo placement and colour still correct with integer textures.
- [ ] Load a 2013 and a 2022 range; drag, type and keyboard selection; cancel; UTC switch; bookmark reload; Live return; phone width; no console errors.
