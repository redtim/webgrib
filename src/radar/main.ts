/** Radar viewer proof of concept (radar.html): live loop and archive browsing. */

import maplibregl from 'maplibre-gl';
import {
  dateOf, dayBounds, estimateLoad, formatViewState, latestOnly, MIN_DATE, parseViewState, scansBetween, utcFolders,
  type Range, type ViewState,
} from './archive.js';
import { ArchiveBar } from './archiveView.js';
import { fallBackIfStyleFails } from './basemap.js';
import { buildLut, PRODUCTS, RANGE_FOLDED_COLOR, type ProductId } from './colors.js';
import { outcomeMessage, ScanLoader, type LoadOutcome } from './loader.js';
import { FrameLoop, frameDelay } from './loop.js';
import { RadarLayer } from './radarLayer.js';
import { findRecentScans, listScans, listSites, listSitesOn, type ScanFile } from './s3.js';
import { spaced } from './throttle.js';
import type { Scan } from './worker.js';

const REFRESH_MS = 60_000;
const STYLE_TIMEOUT_MS = 10_000;

const element = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const siteSelect = element<HTMLSelectElement>('site');
const statusLine = element('status');
const playButton = element<HTMLButtonElement>('play');
const scrubber = element<HTMLInputElement>('scrub');
const countSelect = element<HTMLSelectElement>('count');
const progressLine = element('progress');
const legend = element<HTMLCanvasElement>('legend');
const legendLabels = element('legend-labels');
const productButtons = [...document.querySelectorAll<HTMLButtonElement>('[data-product]')];
const modeButtons = [...document.querySelectorAll<HTMLButtonElement>('[data-mode]')];

const state: ViewState = parseViewState(location.search, new Date());

let loop = newLoop();
/** Bumped to abandon loads in progress, so their results are dropped. */
let generation = 0;
/** A live refresh is listing or loading. */
let busy = false;
/** Scans of the current window still downloading. */
let loading = 0;
/** Most recent failure, shown until the next load. */
let problem = '';
let playing = false;
let playTimer: ReturnType<typeof setTimeout> | undefined;
/** Which frame and product the map layer holds, to skip needless uploads. */
let drawn = '';
let centredSite = '';
/** Set when the base map could not be loaded. */
let mapNote = '';

/** The archive day on the timeline. */
let day: { scans: ScanFile[]; bounds: [number, number]; message: string; failed: boolean } = {
  scans: [], bounds: [0, 1], message: '', failed: false,
};
/** Whether the latest listing was to load a bookmarked range, for Retry. */
let listingAutoLoads = false;
const dayRequests = latestOnly();
const siteRequests = latestOnly();

const loader = new ScanLoader(() => new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' }));

function newLoop(): FrameLoop<Scan> {
  // The live loop tracks new scans; an archive loop stays where the viewer is.
  return new FrameLoop<Scan>({ followNewest: state.mode === 'live' });
}

// ── Map ──

const map = new maplibregl.Map({
  container: 'map',
  style: 'https://tiles.openfreemap.org/styles/dark',
  center: [-96, 38],
  zoom: 3.5,
});
map.addControl(new maplibregl.NavigationControl(), 'top-right');
const layer = new RadarLayer();
fallBackIfStyleFails(
  {
    on: (type, listener) => void map.on(type, listener),
    setStyle: (style) => void map.setStyle(style, { diff: false }),
  },
  { version: 8, sources: {}, layers: [{ id: 'background', type: 'background', paint: { 'background-color': '#0b0d10' } }] },
  () => {
    mapNote = 'Base map unavailable';
    render();
  },
  STYLE_TIMEOUT_MS,
);

// ── Loading ──

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Load scans into the loop; resolves when finished or abandoned. */
async function loadScans(keys: string[], onFailure: (message: string) => void): Promise<LoadOutcome> {
  const mine = generation;
  loading = keys.length;
  render();
  return loader.load(keys, {
    scan(scan) {
      if (mine !== generation) return;
      loop.add(scan);
      if (centredSite !== scan.site) {
        centredSite = scan.site;
        map.jumpTo({ center: [scan.longitude, scan.latitude], zoom: 7 });
      }
      loading--;
      render();
    },
    failed(key, message) {
      if (mine !== generation) return;
      console.error(`${key}: ${message}`);
      onFailure(message);
      loading--;
      render();
    },
  });
}

/** Bring the live loop up to date with the newest scans in the bucket. */
async function refresh(): Promise<void> {
  if (state.mode !== 'live' || busy) return;
  busy = true;
  const mine = generation;
  try {
    const keys = await findRecentScans(state.site, Number(countSelect.value));
    if (mine !== generation) return;
    if (keys.length === 0) {
      problem = `No scans from ${state.site} since yesterday (UTC)`;
      return;
    }
    const queue = loop.setWindow(keys);
    problem = '';
    const outcome = await loadScans(queue, (message) => (problem = message));
    if (mine === generation && (outcome === 'out-of-memory' || outcome === 'older-format')) {
      problem = outcomeMessage(outcome, loop.frames.length, keys.length, 0);
    }
  } catch (error) {
    // Frames already loaded stay on screen, labelled with their own times.
    console.error(error);
    if (mine === generation) problem = messageOf(error);
  } finally {
    if (mine === generation) {
      busy = false;
      loading = 0;
      render();
    }
  }
}

/** Abandon downloads in progress. */
function abandonLoads(): void {
  generation++;
  loader.cancel();
  busy = false;
  loading = 0;
  problem = '';
}

// ── Archive ──

/** List the chosen radar's day, then optionally load a bookmarked range. */
async function openDay({ autoLoad = false } = {}): Promise<void> {
  const isCurrent = dayRequests();
  listingAutoLoads = autoLoad;
  const { site, date, zone, range } = state;
  let [start, end] = dayBounds(date, zone);
  // A shared bookmark's range may reach past this viewer's day.
  if (range && range.from <= range.to) [start, end] = [Math.min(start, range.from), Math.max(end, range.to + 1)];
  day = { scans: [], bounds: [start, end], message: 'Listing scans…', failed: false };
  renderBar();
  try {
    const folders = utcFolders(start, end);
    const [listed, sites] = await Promise.all([listScans(site, folders), listSitesOn(folders)]);
    if (!isCurrent() || state.mode !== 'archive') return;
    const scans = listed.filter((s) => s.time >= start && s.time < end);
    showSites(sites);
    day = { scans, bounds: [start, end], message: scans.length ? '' : `${site} has no files on this date`, failed: false };
    renderBar();
    if (autoLoad && state.range) {
      const chosen = scansBetween(scans, state.range);
      // A large bookmarked range waits for the viewer to press Load.
      if (chosen.length > 0 && !estimateLoad(chosen).large) void loadRange();
    }
  } catch (error) {
    console.error(error);
    if (!isCurrent()) return;
    day = { ...day, message: `Could not list this day: ${messageOf(error)}`, failed: true };
    renderBar();
  }
}

/** Load every scan in the selected range, reusing any already held. */
async function loadRange(): Promise<void> {
  const keys = scansBetween(day.scans, state.range).map((s) => s.key);
  if (keys.length === 0) return;
  abandonLoads();
  const mine = generation;
  let skipped = 0;
  // Oldest first, so playback can start at the beginning while the rest arrives.
  const queue = loop.setWindow(keys).reverse();
  const finished = loadScans(queue, () => skipped++);
  renderBar();
  const outcome = await finished;
  if (mine !== generation) return;
  problem = outcomeMessage(outcome, loop.frames.length, keys.length, skipped);
  loading = 0;
  render();
  renderBar();
}

function selectRange(range: Range, final: boolean): void {
  state.range = range;
  renderBar();
  // Browsers throttle address changes, so only settled ranges are recorded.
  if (final) syncUrl();
}

const bar = new ArchiveBar({
  date(date) {
    const today = dateOf(Date.now(), state.zone);
    state.date = date < MIN_DATE ? MIN_DATE : date > today ? today : date;
    state.range = null;
    clearFrames();
    syncUrl();
    void openDay();
  },
  zone(zone) {
    if (zone === state.zone) return;
    state.zone = zone;
    // Keep the chosen scans in view by following the range to its new date.
    if (state.range) state.date = dateOf(state.range.from, zone);
    const today = dateOf(Date.now(), zone);
    if (state.date > today) state.date = today;
    syncUrl();
    render();
    void openDay();
  },
  range: selectRange,
  load: () => void loadRange(),
  // The load reports itself cancelled and keeps what arrived.
  cancel: () => loader.cancel(),
  retry: () => void openDay({ autoLoad: listingAutoLoads }),
});

function renderBar(): void {
  bar.render({
    date: state.date,
    zone: state.zone,
    today: dateOf(Date.now(), state.zone),
    range: state.range,
    scans: day.scans,
    bounds: day.bounds,
    message: day.message,
    loading: state.mode === 'archive' && loading > 0,
    failed: day.failed,
  });
}

// ── Playback ──

function scheduleFrame(): void {
  playTimer = setTimeout(() => {
    loop.step(1);
    render();
    scheduleFrame();
  }, frameDelay(loop.index, loop.frames.length));
}

function setPlaying(next: boolean): void {
  clearTimeout(playTimer);
  playing = next;
  playButton.textContent = playing ? '❚❚' : '▶';
  playButton.setAttribute('aria-label', playing ? 'Pause' : 'Play');
  if (playing) {
    // Move at once so the press has a visible effect.
    loop.step(1);
    render();
    scheduleFrame();
  }
}

// ── UI ──

function whenText(time: Date): string {
  const clock = { hour: 'numeric', minute: '2-digit', timeZoneName: 'short' } as const;
  if (state.mode === 'live') {
    const minutes = Math.max(0, Math.round((Date.now() - time.getTime()) / 60_000));
    return `${time.toLocaleTimeString([], clock)} · ${minutes} min ago`;
  }
  const timeZone = state.zone === 'utc' ? 'UTC' : undefined;
  return time.toLocaleString([], { ...clock, timeZone, year: 'numeric', month: 'short', day: 'numeric' });
}

function statusText(): string {
  return [scanText(), mapNote].filter(Boolean).join('\n');
}

function scanText(): string {
  const scan = loop.current;
  if (!scan) {
    if (problem) return problem;
    if (state.mode === 'live' || loading > 0) return 'Loading…';
    return `${state.site} archive\nChoose a time range below`;
  }
  const grid = scan.grids[state.product];
  const detail = grid
    ? `${grid.elevation.toFixed(1)}° tilt · VCP ${scan.vcp}`
    : `No ${PRODUCTS[state.product].label.toLowerCase()} in this scan`;
  return [`${scan.site} · ${whenText(scan.time)}`, detail, problem].filter(Boolean).join('\n');
}

function render(): void {
  const scan = loop.current;
  const grid = scan?.grids[state.product];
  const next = scan && grid ? `${scan.key} ${state.product}` : '';
  if (next !== drawn) {
    layer.setFrame(scan && grid ? { latitude: scan.latitude, longitude: scan.longitude, product: state.product, grid } : null);
    drawn = next;
  }

  const count = loop.frames.length;
  scrubber.max = String(Math.max(0, count - 1));
  scrubber.value = String(loop.index);
  scrubber.disabled = count < 2;
  playButton.disabled = count < 2 && !playing;
  progressLine.textContent = [
    count > 0 ? `Frame ${loop.index + 1} of ${count}` : '',
    loading > 0 ? `loading ${loading} more` : '',
  ].filter(Boolean).join(' · ');
  statusLine.textContent = statusText();
}

function drawLegend(): void {
  const { label, unit, min, max, stops } = PRODUCTS[state.product];
  const lut = buildLut(PRODUCTS[state.product]);
  // Show only the part of the table the stops use.
  const low = stops[0]![0];
  const high = state.product === 'REF' ? 80 : stops[stops.length - 1]![0];
  const context = legend.getContext('2d')!;
  for (let x = 0; x < legend.width; x++) {
    const value = low + (x / legend.width) * (high - low);
    const i = Math.min(255, Math.floor(((value - min) / (max - min)) * 256)) * 4;
    context.fillStyle = `rgb(${lut[i]}, ${lut[i + 1]}, ${lut[i + 2]})`;
    context.fillRect(x, 0, 1, legend.height);
  }
  const note = state.product === 'VEL' ? `<i style="background: rgb(${RANGE_FOLDED_COLOR})"></i>range folded` : label;
  legendLabels.innerHTML = `<span>${low}</span><span>${unit} · ${note}</span><span>${high}</span>`;
}

function selectProduct(next: ProductId): void {
  state.product = next;
  for (const button of productButtons) button.setAttribute('aria-pressed', String(button.dataset.product === next));
  syncUrl();
  drawLegend();
  render();
}

const syncUrl = spaced(() => {
  try {
    history.replaceState(null, '', formatViewState(state));
  } catch (error) {
    console.warn(error); // a stale address is not worth interrupting anything for
  }
}, 400);

function clearFrames(): void {
  abandonLoads();
  setPlaying(false);
  loop = newLoop();
  render();
}

function showSites(sites: string[]): void {
  const all = sites.includes(state.site) ? sites : [state.site, ...sites];
  siteSelect.replaceChildren(...all.map((id) => new Option(id, id, false, id === state.site)));
  siteSelect.value = state.site;
}

async function fillLiveSites(): Promise<void> {
  const isCurrent = siteRequests();
  showSites([]);
  try {
    const sites = await listSites();
    if (isCurrent() && state.mode === 'live') showSites(sites);
  } catch (error) {
    console.error(error);
  }
}

/** Lay out the page for the current mode and start loading its data. */
function enterMode({ autoLoad = false } = {}): void {
  document.body.classList.toggle('archive', state.mode === 'archive');
  for (const button of modeButtons) button.setAttribute('aria-pressed', String(button.dataset.mode === state.mode));
  element('archive').hidden = state.mode !== 'archive';
  if (state.mode === 'live') {
    void fillLiveSites();
    void refresh();
  } else {
    void openDay({ autoLoad });
  }
}

siteSelect.addEventListener('change', () => {
  state.site = siteSelect.value;
  const keepPlaying = playing && state.mode === 'live';
  clearFrames();
  if (keepPlaying) setPlaying(true);
  syncUrl();
  if (state.mode === 'live') void refresh();
  else void openDay();
});
for (const button of productButtons) {
  button.addEventListener('click', () => selectProduct(button.dataset.product as ProductId));
}
for (const button of modeButtons) {
  button.addEventListener('click', () => {
    const mode = button.dataset.mode as ViewState['mode'];
    if (mode === state.mode) return;
    state.mode = mode;
    clearFrames();
    syncUrl();
    enterMode();
  });
}
playButton.addEventListener('click', () => setPlaying(!playing));
scrubber.addEventListener('input', () => {
  setPlaying(false);
  loop.seek(Number(scrubber.value));
  render();
});
countSelect.addEventListener('change', () => {
  if (countSelect.value === '1') setPlaying(false);
  abandonLoads();
  render();
  void refresh();
});

map.on('load', () => {
  // Under the first label layer, so place names stay readable.
  const labels = map.getStyle().layers.find((l) => l.type === 'symbol')?.id;
  map.addLayer(layer, labels);
  selectProduct(state.product);
  enterMode({ autoLoad: true });
  setInterval(() => void refresh(), REFRESH_MS);
});
