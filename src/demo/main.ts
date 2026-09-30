/**
 * Demo entry point. Wires a MapLibre map with HRRR/RRFS weather layers driven
 * by the catalog (variable + levels), a grouped picker panel, level slider,
 * timeline control, and legend.
 *
 * Keyboard shortcuts:
 *   Left/Right arrow — step through forecast hours
 *   Up/Down arrow    — step through atmospheric levels
 */

import maplibregl from 'maplibre-gl';
import { ScalarFieldLayer, WindyLayer, LightningLayer, IsobarLayer } from '../renderer/index.js';
import { politeFetch, hrrrUrls, rrfsUrls, forecastQuery, gefsUrls, gefsStatsUrls, GEFS_FHOURS } from '../grib2/idx.js';
import type { LatLonGrid, GridDefinition, LambertConformalGrid } from '../grib2/types.js';
import { DecodeClient } from '../worker/client.js';
import { CATALOG, findVariable, displayRange, displayUnit, isAvailableFor } from '../renderer/catalog.js';
import type { CatalogVariable, VariableLevel, DeterministicModel, LayerQuery } from '../renderer/catalog.js';
import { fetchSfbofsSurface, fetchSfbofsWaterLevel, latestCycle as sfbofsLatestCycle, SFBOFS_MAX_FHOUR } from '../ofs/sfbofs.js';
import { computeWaterDepth } from '../bathymetry/waterDepth.js';
import { fillMissingNearest } from '../ofs/extrapolate.js';
import { WaterMask } from '../renderer/layers/waterMask.js';
import { sampleHrrrAtLatLon, sampleLccScalarAtLatLon, sampleLccPoint } from '../grib2/resample.js';
import type { DecodedField } from '../grib2/types.js';
import type { LatLonBounds } from '../renderer/projections/latlon.js';
import {
  UNIT_OPTIONS, getUnitPref, setUnitPref, onUnitChange,
  convertSpeed, unitLabel,
} from './units.js';
import type { Dimension } from './units.js';
import { Panel } from './panel.js';
import { Timeline } from './timeline.js';
import { Legend } from './legend.js';
import type { LegendTick } from './legend.js';
import { LevelSlider } from './levelSlider.js';
import { TideStationManager } from './tides.js';
import { EasyUI, getUiMode, easyLabel } from './easyMode.js';
import { PointForecast } from './pointForecast.js';
import type { ForecastCell } from './pointForecast.js';
import { colormap } from '../renderer/colormaps.js';
import type { ColormapName } from '../renderer/colormaps.js';
import type { IdxQuery } from '../grib2/idx.js';

// Wind speed raster range in m/s — must match WIND_MAX_MS in colormaps.ts.
const WIND_MAX = 35 * 0.514444; // 18 m/s = 35 kt

/** Compute the best available SFBOFS cycle and forecast hour for a given valid time. */
function ofsSchedule(validDate: Date): { cycle: number; date: string; fhour: number } {
  const { cycle, date } = sfbofsLatestCycle();
  const cycleMs = Date.UTC(
    parseInt(date.slice(0, 4)), parseInt(date.slice(4, 6)) - 1,
    parseInt(date.slice(6, 8)), cycle,
  );
  const fhour = Math.max(1, Math.min(SFBOFS_MAX_FHOUR, Math.round((validDate.getTime() - cycleMs) / 3600000)));
  return { cycle, date, fhour };
}

// Wind tick marks in m/s (native unit) — converted to display unit dynamically
const WIND_TICK_MS = [0, 2.57, 5.14, 7.72, 10.29, 12.86, 15.43, 18.01]; // ~0,5,10,15,20,25,30,35 kt

/**
 * High-resolution SF Bay shoreline used to clip OFS layers (see
 * scripts/build-shoreline.py). Loaded once on first use; a failed fetch
 * degrades to the model's own ~275 m land mask.
 */
let waterMaskPromise: Promise<WaterMask | null> | null = null;
function ensureWaterMask(): Promise<WaterMask | null> {
  if (!waterMaskPromise) {
    waterMaskPromise = WaterMask.load(`${import.meta.env.BASE_URL}shoreline/sfbay-water.geojson`)
      .then((m) => { console.info(`water mask loaded: ${m.polygons.length} polygons, ${m.vertexCount} vertices`); return m; })
      .catch((err: unknown) => { console.warn('water mask unavailable, using model land mask', err); return null; });
  }
  return waterMaskPromise;
}

/**
 * Passes of nearest-neighbour extrapolation applied to OFS fields before a
 * fine shoreline mask clips them. Four passes ≈ 1.1 km, comfortably past
 * the gap between the model's coarse coast and the real one.
 */
const OFS_FILL_PASSES = 4;
/** Same for the ~250 m bathymetry grid behind the water-depth layer (~500 m). */
const DEPTH_FILL_PASSES = 2;

/**
 * Particle motion for ocean currents. Currents peak around 1.5 m/s versus
 * ~20 m/s for wind, so with the shared default velocityScale they barely
 * crawl. Push them harder and let trails linger so tidal flow reads as
 * long streamlines.
 */
const CURRENT_PARTICLE_MOTION = {
  velocityScale: 0.035,
  particleAge: 240,
  trailPersistence: 0.985,
  frameRate: 24,
} as const;

/** Build wind legend args in the user's current speed unit. */
function windLegendArgs(): [number, number, string, LegendTick[]] {
  const u = getUnitPref('speed');
  const ticks: LegendTick[] = WIND_TICK_MS.map((ms) => {
    const v = convertSpeed(ms, u);
    return { value: v, label: Math.round(v).toString() };
  });
  const maxDisplay = convertSpeed(WIND_MAX, u);
  return [0, maxDisplay, unitLabel('speed'), ticks];
}

const MODEL_NAMES: Record<DeterministicModel, string> = { hrrr: 'HRRR', rrfs: 'RRFS' };

/**
 * .idx URL for a deterministic-model level. HRRR keeps everything in one
 * wrfsfc file; RRFS splits isobaric levels into prslev.
 */
function deterministicIdxUrl(model: DeterministicModel, cycle: string, fhour: number, level?: VariableLevel): string {
  return model === 'rrfs'
    ? rrfsUrls(cycle, fhour, level?.rrfsProduct).idx
    : hrrrUrls(cycle, fhour).idx;
}

/** Per-model scalar query — RRFS encodes a few records differently. */
function scalarQueryFor(model: DeterministicModel, level: VariableLevel): LayerQuery | undefined {
  return (model === 'rrfs' && level.rrfsQuery) || level.query;
}

/**
 * Cheap existence check for a forecast hour of a model cycle: a 1-byte ranged
 * GET of its .idx (the HRRR bucket's CORS policy rejects HEAD).
 */
async function cycleExists(model: DeterministicModel, cycle: string, fhour: number): Promise<boolean> {
  // no-store: a cached non-CORS response for the same URL would fail the CORS check.
  const res = await politeFetch(deterministicIdxUrl(model, cycle, fhour), { headers: { Range: 'bytes=0-0' }, cache: 'no-store' });
  void res.body?.cancel();
  return res.ok;
}

type GefsMemberChoice = number | 'mean' | 'spread';

const GEFS_MEMBER_COUNT = 31; // 0 = control, 1-30 = perturbations

function gefsIdxUrlsForAllMembers(cycle: string, fhour: number): string[] {
  return Array.from({ length: GEFS_MEMBER_COUNT }, (_, i) => gefsUrls(cycle, fhour, i).idx);
}

function latLonGridToBounds(grid: LatLonGrid): LatLonBounds {
  let lo1 = grid.lo1;
  let lo2 = grid.lo2;
  if (lo1 > 180) lo1 -= 360;
  if (lo2 > 180) lo2 -= 360;
  return {
    lonMin: Math.min(lo1, lo2),
    lonMax: Math.max(lo1, lo2),
    latMin: Math.min(grid.la1, grid.la2),
    latMax: Math.max(grid.la1, grid.la2),
  };
}

/**
 * GEFS global grids start at 0°E. Shift data so it starts at -180° for
 * MapLibre's coordinate system. Returns shifted values and updated bounds.
 */
function shiftGlobalGrid(
  values: Float32Array,
  nx: number,
  ny: number,
  grid: LatLonGrid,
): { values: Float32Array; bounds: LatLonBounds } {
  // Clamp to Mercator-safe range (±85.05° is the Web Mercator limit)
  const MAX_LAT = 85.05;
  const clampBounds = (b: LatLonBounds): LatLonBounds => ({
    ...b,
    latMin: Math.max(b.latMin, -MAX_LAT),
    latMax: Math.min(b.latMax, MAX_LAT),
  });

  const needFlipLat = grid.la1 > grid.la2;
  const needShiftLon = grid.lo1 > 180 || grid.lo2 > 180;

  if (!needFlipLat && !needShiftLon) {
    return { values, bounds: clampBounds(latLonGridToBounds(grid)) };
  }

  const splitCol = needShiftLon ? Math.round(180 / grid.dx) : 0;
  const out = new Float32Array(values.length);

  for (let row = 0; row < ny; row++) {
    const srcRow = needFlipLat ? (ny - 1 - row) : row;
    const srcOff = srcRow * nx;
    const dstOff = row * nx;

    if (needShiftLon) {
      const rightCount = nx - splitCol;
      out.set(values.subarray(srcOff + splitCol, srcOff + nx), dstOff);
      out.set(values.subarray(srcOff, srcOff + splitCol), dstOff + rightCount);
    } else {
      out.set(values.subarray(srcOff, srcOff + nx), dstOff);
    }
  }

  const lonMin = needShiftLon ? -180 : Math.min(grid.lo1, grid.lo2);
  const lonMax = needShiftLon ? 180 - grid.dx : Math.max(grid.lo1, grid.lo2);

  return {
    values: out,
    bounds: clampBounds({
      lonMin,
      lonMax,
      latMin: Math.min(grid.la1, grid.la2),
      latMax: Math.max(grid.la1, grid.la2),
    }),
  };
}

const setStatus = (text: string, error = false): void => {
  const el = document.getElementById('status')!;
  el.textContent = text;
  el.classList.toggle('err', error);
  // Easy mode only surfaces problems, not routine load details.
  document.getElementById('easy-status')!.textContent = error ? text : '';
};

/** Colormap color for a value within a range, as a translucent CSS color. */
function colormapCss(name: ColormapName, value: number, range: [number, number]): string {
  const t = Math.max(0, Math.min(1, (value - range[0]) / (range[1] - range[0])));
  const rgba = colormap(name);
  const i = Math.round(t * 255) * 4;
  return `rgba(${rgba[i]},${rgba[i + 1]},${rgba[i + 2]},0.6)`;
}

/** Compact UTC hour stamp (YYYYMMDDHH), the same shape as a model cycle. */
function formatUtcHour(d: Date): string {
  return d.toISOString().slice(0, 13).replace(/[-T]/g, '');
}

function parseUtcHour(s: string | null): number | null {
  if (!s || !/^\d{10}$/.test(s)) return null;
  return Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8), +s.slice(8, 10));
}

async function main(): Promise<void> {
  // Shared-link state, read before anything below starts rewriting the URL.
  const urlParams = new URLSearchParams(location.search);
  const urlLayer = urlParams.get('layer');
  const urlLevel = Number(urlParams.get('level') ?? 0);
  const urlOverlays = urlParams.get('overlays')?.split(',') ?? null;
  const urlTime = parseUtcHour(urlParams.get('t'));
  const urlModel = urlParams.get('model');
  let urlReady = false; // don't write the URL until the shared state has been applied

  const panelRoot = document.getElementById('panel')!;
  const timelineBar = document.getElementById('timeline-bar')!;

  // Created now, appended after Legend so it sits below legend/status
  const layersWrap = document.createElement('div');
  layersWrap.id = 'panel-layers';
  const expandBtn = document.createElement('div');
  expandBtn.id = 'panel-expand';
  expandBtn.textContent = 'Hide layers';
  let layersVisible = true;
  expandBtn.addEventListener('click', () => {
    layersVisible = !layersVisible;
    layersWrap.classList.toggle('collapsed', !layersVisible);
    expandBtn.classList.toggle('collapsed', !layersVisible);
    expandBtn.textContent = layersVisible ? 'Hide layers' : 'Show layers';
    timelineBar.classList.toggle('panel-hidden', !layersVisible);
  });

  const map = new maplibregl.Map({
    container: 'map',
    style: 'https://tiles.openfreemap.org/styles/dark',
    center: [-96, 38],
    zoom: 3.5,
    minZoom: 2,
    maxZoom: 16,
    hash: true,
    keyboard: false,
  });

  map.on('error', (e) => {
    console.warn('MapLibre error:', e.error ?? e);
  });

  // Layers are created once, reused across presets.
  const FILL_OPACITY = 0.85;
  const scalarLayer = new ScalarFieldLayer({ id: 'hrrr-scalar', colormap: 'turbo', opacity: FILL_OPACITY });

  // Grey particle palette — subtle trails over the colored wind-speed raster.
  const GREY_PARTICLES = [
    'rgba(180,180,180,0.4)',
    'rgba(190,190,190,0.5)',
    'rgba(200,200,200,0.6)',
    'rgba(210,210,210,0.7)',
    'rgba(220,220,220,0.8)',
    'rgba(230,230,230,0.85)',
    'rgba(240,240,240,0.9)',
    'rgba(245,245,245,0.95)',
    'rgba(255,255,255,1.0)',
  ];
  const windLayer = new WindyLayer({ id: 'hrrr-wind', opacity: 0.9, colorScale: GREY_PARTICLES });
  const lightningLayer = new LightningLayer();
  const isobarLayer = new IsobarLayer();
  const client = new DecodeClient();

  let currentVariable: CatalogVariable | null = null;
  let loadGen = 0;
  let lastFitVariable: string | null = null; // track which variable we last zoomed to
  let tideManager: TideStationManager | null = null;
  let gefsMember: GefsMemberChoice = 'mean';
  let isobarsEnabled = false;
  // Wind particles drawn over a fill that has no particles of its own.
  let particlesEnabled = false;
  let activeLoads = 0;

  /** True when the fill itself drives the particle layer (wind, currents). */
  const fillOwnsParticles = (variable: CatalogVariable | null): boolean =>
    variable?.kind === 'wind' && !(variable.source === 'gefs' && gefsMember === 'spread');

  /** Called by scalar fills: clear particles unless the overlay wants them kept. */
  const hideFillParticles = (): void => {
    if (!particlesEnabled && windLayer.isAttached()) windLayer.setVisible(false);
  };

  // ---- UI components --------------------------------------------------------

  const legend = new Legend(panelRoot);
  const legendEl = panelRoot.querySelector<HTMLElement>('.legend')!;

  // Append collapsible layers section after the legend
  panelRoot.appendChild(expandBtn);
  panelRoot.appendChild(layersWrap);

  const timeline = new Timeline({
    parent: timelineBar,
    probeCycle: cycleExists,
    onChange: (_cycle, _fhour) => {
      tideManager?.setForecastTime(timeline.validDate());
      if (currentVariable) {
        return loadLevel(currentVariable, levelSlider.index, _cycle, _fhour);
      }
    },
  });

  const levelSlider = new LevelSlider({
    parent: layersWrap,
    onChange: (levelIndex) => {
      if (currentVariable) {
        void loadLevel(currentVariable, levelIndex, timeline.cycle, timeline.fhour);
      }
    },
  });

  const selectVariable = (variable: CatalogVariable, load = true): void => {
    currentVariable = variable;
    levelSlider.setLevels(variable.levels);
    // Switch timeline between deterministic (HRRR/RRFS) and GEFS modes
    const needsGefs = variable.source === 'gefs';
    if (needsGefs && timeline.source !== 'gefs') {
      timeline.setSource('gefs', GEFS_FHOURS);
    } else if (!needsGefs && timeline.source === 'gefs') {
      timeline.setSource(timeline.model);
    }
    gefsMemberWrap.style.display = needsGefs ? '' : 'none';
    if (load) void loadLevel(variable, 0, timeline.cycle, timeline.fhour);
  };

  const panel = new Panel({ parent: layersWrap, onSelect: selectVariable });

  // The one legend moves between the expert panel and the easy-mode card.
  const placeLegend = (): void => {
    if (getUiMode() === 'easy') easyUi.legendSlot.appendChild(legendEl);
    else panelRoot.insertBefore(legendEl, expandBtn);
  };
  const easyUi: EasyUI = new EasyUI({
    onSelect: selectVariable,
    // Every overlay is backed by its expert-panel checkbox, which owns the state.
    onOverlay: (id, visible) => {
      const box = overlayBoxes.get(id);
      if (!box) return;
      box.checked = visible;
      box.dispatchEvent(new Event('change'));
    },
    onModeChange: placeLegend,
  });
  placeLegend();
  const overlayBoxes = new Map<string, HTMLInputElement>();
  const registerOverlay = (id: string, box: HTMLInputElement): void => {
    overlayBoxes.set(id, box);
    box.addEventListener('change', () => {
      easyUi.setOverlay(id, box.checked);
      syncUrl();
      refreshForecast();
    });
    easyUi.setOverlay(id, box.checked);
  };

  /** Mirror the layer, level, overlays and time into the URL so it can be shared. */
  function syncUrl(): void {
    if (!urlReady || !currentVariable) return;
    const url = new URL(location.href);
    url.searchParams.set('layer', currentVariable.id);
    if (levelSlider.index > 0) url.searchParams.set('level', String(levelSlider.index));
    else url.searchParams.delete('level');
    const on = [...overlayBoxes].filter(([, box]) => box.checked).map(([id]) => id);
    url.searchParams.set('overlays', on.join(','));
    url.searchParams.set('t', formatUtcHour(timeline.validDate()));
    // HRRR is the default, so only a different model needs spelling out.
    if (timeline.model === 'hrrr') url.searchParams.delete('model');
    else url.searchParams.set('model', timeline.model);
    history.replaceState(history.state, '', url);
  }

  const opacityInput = document.getElementById('easy-opacity') as HTMLInputElement;
  opacityInput.value = String(FILL_OPACITY);
  opacityInput.addEventListener('input', () => scalarLayer.setOpacity(Number(opacityInput.value)));

  // ---- map setup ------------------------------------------------------------

  await new Promise<void>((r) => map.once('load', () => r()));

  const findInsertionPoint = (): string | undefined => {
    const layers = map.getStyle().layers ?? [];
    for (const sl of ['transportation', 'boundary', 'place'] as const) {
      const found = layers.find(
        (l) => (l as { 'source-layer'?: string })['source-layer'] === sl,
      );
      if (found) return found.id;
    }
    return undefined;
  };
  const beforeId = findInsertionPoint();

  map.addLayer(scalarLayer, beforeId);
  windLayer.attach(map);
  isobarLayer.attach(map);
  lightningLayer.attach(map);

  tideManager = new TideStationManager();
  tideManager.attach(map);

  // Coastline stroke
  map.addLayer(
    {
      id: 'ofm-coastline',
      type: 'line',
      source: 'openmaptiles',
      'source-layer': 'water',
      paint: { 'line-color': '#3d4d60', 'line-width': 1.8, 'line-opacity': 1.0 },
    },
    beforeId,
  );

  // Restyle base map layers for weather overlay readability
  for (const layer of map.getStyle().layers ?? []) {
    const sl = (layer as { 'source-layer'?: string })['source-layer'];
    if (!sl) continue;

    // Dim roads — near-invisible uniform treatment
    if (sl.startsWith('transportation')) {
      if (layer.type === 'line') {
        try { map.setPaintProperty(layer.id, 'line-opacity', 0.05); } catch { /* */ }
      } else if (layer.type === 'symbol') {
        try { map.setPaintProperty(layer.id, 'text-opacity', 0.1); } catch { /* */ }
        try { map.setPaintProperty(layer.id, 'icon-opacity', 0.1); } catch { /* */ }
      }
    }

    // Place names — clean, legible labels; only show significant places
    if (sl === 'place' && layer.type === 'symbol') {
      try { map.setPaintProperty(layer.id, 'text-color', '#e0e6ed'); } catch { /* */ }
      try { map.setPaintProperty(layer.id, 'text-halo-color', 'rgba(0,0,0,0.7)'); } catch { /* */ }
      try { map.setPaintProperty(layer.id, 'text-halo-width', 1.5); } catch { /* */ }
      try { map.setPaintProperty(layer.id, 'text-halo-blur', 1); } catch { /* */ }
      try { map.setLayoutProperty(layer.id, 'text-font', ['Noto Sans Regular']); } catch { /* */ }
      try { map.setPaintProperty(layer.id, 'text-opacity', 0.9); } catch { /* */ }
      // Only keep cities — hide villages, towns, suburbs, etc.
      const id = layer.id.toLowerCase();
      if (id.includes('village') || id.includes('suburb') || id.includes('hamlet')
          || id.includes('quarter') || id.includes('neighbourhood') || id.includes('isolated')) {
        try { map.setLayoutProperty(layer.id, 'visibility', 'none'); } catch { /* */ }
      } else if (id.includes('town')) {
        try { map.setLayerZoomRange(layer.id, 8, 24); } catch { /* */ }
      }
    }
  }

  // ---- lightning toggle ------------------------------------------------------

  const ltToggle = document.createElement('div');
  ltToggle.style.marginTop = '8px';
  ltToggle.style.borderTop = '1px solid #30363d';
  ltToggle.style.paddingTop = '6px';
  ltToggle.innerHTML = `
    <label style="display:flex;align-items:center;gap:6px;cursor:pointer;padding:3px 6px;font-size:11px;">
      <input type="checkbox" id="toggle-lightning" checked style="margin:0" />
      <span class="layer-kind" style="background:#3d2d1f;color:#ffcf57;width:16px;height:16px;border-radius:3px;display:inline-flex;align-items:center;justify-content:center;font-size:9px;font-weight:bold;flex-shrink:0">&#9889;</span>
      <span>Live Lightning <span id="lightning-count" style="color:#8b949e;font-size:10px"></span></span>
    </label>`;
  layersWrap.appendChild(ltToggle);

  const ltCheckbox = document.getElementById('toggle-lightning') as HTMLInputElement;
  const ltCount = document.getElementById('lightning-count')!;
  ltCheckbox.addEventListener('change', () => {
    lightningLayer.setVisible(ltCheckbox.checked);
  });
  registerOverlay('lightning', ltCheckbox);
  // Update strike count periodically
  setInterval(() => {
    const n = lightningLayer.strikeCount;
    ltCount.textContent = n > 0 ? `(${n})` : '';
  }, 2000);

  // ---- wind particle overlay toggle --------------------------------------------

  const ptToggle = document.createElement('div');
  ptToggle.style.cssText = 'margin-top:4px;';
  ptToggle.innerHTML = `
    <label style="display:flex;align-items:center;gap:6px;cursor:pointer;padding:3px 6px;font-size:11px;">
      <input type="checkbox" id="toggle-particles" style="margin:0" />
      <span class="layer-kind layer-kind-wind">W</span>
      <span>Wind Particles</span>
    </label>`;
  layersWrap.appendChild(ptToggle);

  const ptCheckbox = document.getElementById('toggle-particles') as HTMLInputElement;
  ptCheckbox.addEventListener('change', () => {
    particlesEnabled = ptCheckbox.checked;
    if (particlesEnabled) void loadParticleOverlay(timeline.cycle, timeline.fhour);
    else if (!fillOwnsParticles(currentVariable)) hideFillParticles();
  });
  registerOverlay('particles', ptCheckbox);

  /** Show 10 m wind particles over a fill that has none of its own. */
  async function loadParticleOverlay(
    cycle: string,
    fhour: number,
    isStale: () => boolean = () => false,
  ): Promise<void> {
    if (!particlesEnabled || fillOwnsParticles(currentVariable)) return;
    const fcRe = forecastQuery(fhour);
    const queryU = { parameter: /^UGRD$/, level: /^10 m above ground$/, forecast: fcRe };
    const queryV = { parameter: /^VGRD$/, level: /^10 m above ground$/, forecast: fcRe };
    const stale = (): boolean => isStale() || !particlesEnabled || fillOwnsParticles(currentVariable);

    try {
      if (timeline.source === 'gefs') {
        const { u, v, grid } = await client.decodePair(gefsStatsUrls(cycle, fhour, 'mean').idx, queryU, queryV);
        if (stale() || grid.template !== 0) return;
        const shiftedU = shiftGlobalGrid(u.values, u.nx, u.ny, grid as LatLonGrid);
        const shiftedV = shiftGlobalGrid(v.values, v.nx, v.ny, grid as LatLonGrid);
        if (!windLayer.isAttached()) windLayer.attach(map);
        windLayer.setVisible(true);
        windLayer.setWindLatLon(shiftedU.values, shiftedV.values, u.nx, u.ny, shiftedU.bounds);
      } else {
        const { u, v, grid } = await client.decodePair(deterministicIdxUrl(timeline.model, cycle, fhour), queryU, queryV);
        if (stale()) return;
        if (!windLayer.isAttached()) windLayer.attach(map);
        windLayer.setVisible(true);
        windLayer.setWind({ ...u, missingValue: NaN }, { ...v, missingValue: NaN }, grid as LambertConformalGrid);
      }
    } catch (err) {
      console.warn('Failed to load wind particle overlay:', err);
    }
  }

  // ---- isobar toggle ----------------------------------------------------------

  const isoToggle = document.createElement('div');
  isoToggle.style.cssText = 'margin-top:4px;';
  isoToggle.innerHTML = `
    <label style="display:flex;align-items:center;gap:6px;cursor:pointer;padding:3px 6px;font-size:11px;">
      <input type="checkbox" id="toggle-isobars" style="margin:0" />
      <span class="layer-kind" style="background:#1a2a3a;color:#8bc4ea;width:16px;height:16px;border-radius:3px;display:inline-flex;align-items:center;justify-content:center;font-size:9px;font-weight:bold;flex-shrink:0">P</span>
      <span>MSLP Isobars</span>
    </label>`;
  layersWrap.appendChild(isoToggle);

  const isoCheckbox = document.getElementById('toggle-isobars') as HTMLInputElement;
  isoCheckbox.addEventListener('change', () => {
    isobarsEnabled = isoCheckbox.checked;
    isobarLayer.setVisible(isobarsEnabled);
    if (isobarsEnabled) void fetchAndShowIsobars(timeline.cycle, timeline.fhour);
  });
  registerOverlay('isobars', isoCheckbox);

  // ~0.25 degree over CONUS: coarse enough to contour quickly and to smooth
  // out the terrain noise in 3 km sea-level pressure.
  const ISOBAR_NX = 240;
  const ISOBAR_NY = 110;
  // Full-resolution pressure behind the contours, so the click readout
  // matches the point forecast. Null for GEFS, whose grid is contoured as-is.
  let isobarSource: { field: DecodedField; grid: LambertConformalGrid } | null = null;

  async function fetchAndShowIsobars(
    cycle: string,
    fhour: number,
    isStale: () => boolean = () => false,
  ): Promise<void> {
    if (!isobarsEnabled) return;
    const fcRe = forecastQuery(fhour);

    try {
      if (timeline.source !== 'gefs') {
        // HRRR names it MSLMA; accept the other common MSLP names for RRFS.
        const query = { parameter: /^(MSLMA|MSLET|PRMSL)$/, level: /^mean sea level$/, forecast: fcRe };
        const result = await client.decode(deterministicIdxUrl(timeline.model, cycle, fhour), query);
        if (isStale() || !isobarsEnabled) return;
        const field = { ...result.field, missingValue: NaN };
        const grid = result.grid as LambertConformalGrid;
        const p = sampleLccScalarAtLatLon(field, grid, ISOBAR_NX, ISOBAR_NY);
        isobarSource = { field, grid };
        isobarLayer.setData(p.values, p.nx, p.ny, p.bounds);
        isobarLayer.setVisible(true);
        return;
      }

      const query = { parameter: /^PRMSL$/, level: /^mean sea level$/, forecast: fcRe };
      // Always use ensemble mean for isobar overlay (most useful synoptic view)
      const urls = gefsMember === 'mean' || gefsMember === 'spread'
        ? gefsStatsUrls(cycle, fhour, 'mean')
        : gefsUrls(cycle, fhour, gefsMember);
      const result = await client.decode(urls.idx, query);
      if (isStale() || !isobarsEnabled || result.grid.template !== 0) return;
      const shifted = shiftGlobalGrid(result.field.values, result.field.nx, result.field.ny, result.grid as LatLonGrid);
      isobarSource = null;
      isobarLayer.setData(shifted.values, result.field.nx, result.field.ny, shifted.bounds);
      isobarLayer.setVisible(true);
    } catch (err) {
      console.warn('Failed to load isobar data:', err);
    }
  }

  // ---- tide station toggles ---------------------------------------------------

  tideManager.createToggles(layersWrap);
  for (const box of layersWrap.querySelectorAll<HTMLInputElement>('input[data-tide-type]')) {
    registerOverlay(box.dataset.tideType!, box);
  }

  // ---- unit preference selectors ---------------------------------------------

  const unitWrap = document.createElement('div');
  unitWrap.style.cssText = 'margin-top:8px;border-top:1px solid #30363d;padding-top:6px;';
  const unitTitle = document.createElement('div');
  unitTitle.style.cssText = 'color:#8b949e;font-size:10px;font-weight:bold;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:4px;';
  unitTitle.textContent = 'Units';
  unitWrap.appendChild(unitTitle);

  const UNIT_LABELS: Record<string, string> = {
    temperature: 'Temp', speed: 'Speed', length: 'Precip', distance: 'Dist',
  };
  for (const dim of Object.keys(UNIT_OPTIONS) as Dimension[]) {
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;align-items:center;gap:6px;margin-bottom:3px;font-size:11px;';
    const lbl = document.createElement('span');
    lbl.style.cssText = 'color:#8b949e;min-width:40px;';
    lbl.textContent = UNIT_LABELS[dim] ?? dim;
    row.appendChild(lbl);

    const sel = document.createElement('select');
    sel.style.cssText = 'background:#161b22;color:#e6edf3;border:1px solid #30363d;border-radius:3px;font-size:10px;font-family:inherit;padding:1px 4px;';
    for (const opt of UNIT_OPTIONS[dim]) {
      const o = document.createElement('option');
      o.value = opt as string;
      o.textContent = dim === 'temperature' ? `\u00B0${opt}` : (opt as string);
      if (opt === getUnitPref(dim)) o.selected = true;
      sel.appendChild(o);
    }
    sel.addEventListener('change', () => {
      setUnitPref(dim, sel.value as never);
    });
    row.appendChild(sel);
    unitWrap.appendChild(row);
  }
  layersWrap.appendChild(unitWrap);

  // ---- GEFS member picker -----------------------------------------------------

  const gefsMemberWrap = document.createElement('div');
  gefsMemberWrap.style.cssText = 'margin-top:8px;border-top:1px solid #30363d;padding-top:6px;display:none;';
  const gefsMemberTitle = document.createElement('div');
  gefsMemberTitle.style.cssText = 'color:#8b949e;font-size:10px;font-weight:bold;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:4px;';
  gefsMemberTitle.textContent = 'Ensemble Member';
  gefsMemberWrap.appendChild(gefsMemberTitle);

  const gefsMemberSel = document.createElement('select');
  gefsMemberSel.style.cssText = 'background:#161b22;color:#e6edf3;border:1px solid #30363d;border-radius:3px;font-size:11px;font-family:inherit;padding:2px 4px;width:100%;';
  const memberOptions: { value: string; label: string }[] = [
    { value: 'mean', label: 'Ensemble Mean' },
    { value: 'spread', label: 'Ensemble Spread' },
    { value: '0', label: 'Control (c00)' },
  ];
  for (let i = 1; i <= 30; i++) {
    memberOptions.push({ value: String(i), label: `Member ${String(i).padStart(2, '0')}` });
  }
  for (const opt of memberOptions) {
    const o = document.createElement('option');
    o.value = opt.value;
    o.textContent = opt.label;
    if (opt.value === 'mean') o.selected = true;
    gefsMemberSel.appendChild(o);
  }
  gefsMemberSel.addEventListener('change', () => {
    const v = gefsMemberSel.value;
    gefsMember = v === 'mean' || v === 'spread' ? v : parseInt(v, 10);
    if (currentVariable?.source === 'gefs') {
      void loadLevel(currentVariable, levelSlider.index, timeline.cycle, timeline.fhour);
    }
  });
  gefsMemberWrap.appendChild(gefsMemberSel);
  layersWrap.appendChild(gefsMemberWrap);

  // Refresh legend when unit preferences change
  function refreshLegend(): void {
    if (!currentVariable?.colormap) return;
    if (currentVariable.kind === 'wind' && currentVariable.source !== 'ofs') {
      legend.update('wind', ...windLegendArgs());
    } else {
      const dr = displayRange(currentVariable);
      legend.update(currentVariable.colormap, dr[0], dr[1], displayUnit(currentVariable));
    }
  }
  onUnitChange(refreshLegend);

  // ---- load a variable at a specific level ----------------------------------

  /** loadLevelNow, with the easy-mode busy indicator shown while any load is in flight. */
  async function loadLevel(
    variable: CatalogVariable,
    levelIndex: number,
    cycle: string,
    fhour: number,
  ): Promise<void> {
    easyUi.setBusy(++activeLoads > 0);
    try {
      const fill = loadLevelNow(variable, levelIndex, cycle, fhour);
      syncUrl();
      refreshForecast();
      const gen = loadGen; // loadLevelNow has already claimed its generation
      const isStale = (): boolean => gen !== loadGen;
      await Promise.all([
        fill,
        loadParticleOverlay(cycle, fhour, isStale),
        fetchAndShowIsobars(cycle, fhour, isStale),
      ]);
    } finally {
      easyUi.setBusy(--activeLoads > 0);
    }
  }

  async function loadLevelNow(
    variable: CatalogVariable,
    levelIndex: number,
    cycle: string,
    fhour: number,
  ): Promise<void> {
    // Each load gets a unique generation id — if a newer load starts while
    // this one is in flight, we skip rendering the stale result but let the
    // fetch complete in the background so it populates caches.
    const gen = ++loadGen;
    const isStale = () => gen !== loadGen;

    currentVariable = variable;
    panel.setActive(variable.id);
    easyUi.setActive(variable);

    const level = variable.levels[levelIndex];
    if (!level) return;

    // Route OFS variables to the OFS loader
    if (variable.source === 'ofs') {
      try {
        await loadOfsLevel(variable, isStale);
      } catch (err) {
        if (isStale()) return;
        setStatus(err instanceof Error ? err.message : String(err), true);
      }
      return;
    }

    // Everything below is on the HRRR/RRFS/GEFS grids — no shoreline clip.
    // (OFS loads keep the mask in place across time changes so the previous
    // frame never flashes unclipped while the next one is fetching.)
    scalarLayer.setWaterMask(null);
    windLayer.setWaterMask(null);
    windLayer.setMotion(null);

    // Route GEFS variables to the GEFS loader
    if (variable.source === 'gefs') {
      try {
        await loadGefsLevel(variable, levelIndex, cycle, fhour, isStale);
      } catch (err) {
        if (isStale()) return;
        setStatus(err instanceof Error ? err.message : String(err), true);
      }
      return;
    }

    const model = timeline.model;
    const modelName = MODEL_NAMES[model];
    const idxUrl = deterministicIdxUrl(model, cycle, fhour, level);
    const fcRe = forecastQuery(fhour);
    const displayName = variable.levels.length > 1
      ? `${variable.label} @ ${level.label}`
      : variable.label;

    if (!isAvailableFor(variable, model)) {
      scalarLayer.setVisible(false);
      hideFillParticles();
      legend.hide();
      setStatus(`${displayName} is not published by ${modelName}`, true);
      return;
    }
    setStatus(`fetching ${modelName} ${displayName}...`);

    try {
      const query = scalarQueryFor(model, level);
      if (variable.kind === 'scalar' && query) {
        const layerFcRe = query.forecast?.(fhour) ?? fcRe;
        // Accumulated / windowed fields have no data at analysis time (fhour 0)
        if (query.forecast && fhour === 0) {
          scalarLayer.setVisible(false);
          hideFillParticles();
          legend.hide();
          setStatus(`${displayName} — no data at analysis hour`);
          return;
        }
        const { field, grid } = await client.decode(idxUrl, {
          parameter: query.parameter,
          level: query.level,
          forecast: layerFcRe,
        });
        if (isStale()) return;
        if (!map.getLayer('hrrr-scalar')) map.addLayer(scalarLayer, beforeId);
        scalarLayer.setVisible(true);
        scalarLayer.setData({ ...field, missingValue: NaN }, grid as LambertConformalGrid);
        if (variable.colormap) scalarLayer.setColormap(variable.colormap);
        scalarLayer.setValueRange(variable.range!);
        hideFillParticles();

        if (variable.colormap) {
          const dr = displayRange(variable);
          legend.update(variable.colormap, dr[0], dr[1], displayUnit(variable));
        }
        setStatus(`${modelName} ${displayName}`);
      } else if (variable.kind === 'wind' && level.queryU && level.queryV) {
        const { u, v, grid } = await client.decodePair(
          idxUrl,
          { parameter: level.queryU.parameter, level: level.queryU.level, forecast: fcRe },
          { parameter: level.queryV.parameter, level: level.queryV.level, forecast: fcRe },
        );
        if (isStale()) return;

        // Compute wind speed magnitude for the scalar raster underneath particles
        const speed = new Float32Array(u.values.length);
        let sMin = Infinity, sMax = -Infinity;
        for (let i = 0; i < speed.length; i++) {
          const s = Math.hypot(u.values[i]!, v.values[i]!);
          speed[i] = s;
          if (s < sMin) sMin = s;
          if (s > sMax) sMax = s;
        }
        const speedField = { values: speed, nx: u.nx, ny: u.ny, min: sMin, max: sMax, missingValue: NaN };

        // Show scalar raster (wind speed) underneath particles
        if (!map.getLayer('hrrr-scalar')) map.addLayer(scalarLayer, beforeId);
        scalarLayer.setVisible(true);
        scalarLayer.setColormap('wind');
        scalarLayer.setData(speedField, grid as LambertConformalGrid);
        scalarLayer.setValueRange(variable.range!);

        // Show wind particles on top
        if (!windLayer.isAttached()) windLayer.attach(map);
        windLayer.setVisible(true);
        windLayer.setWind({ ...u, missingValue: NaN }, { ...v, missingValue: NaN }, grid as LambertConformalGrid);

        legend.update('wind', ...windLegendArgs());
        setStatus(`${modelName} ${displayName} loaded (${u.nx}\u00D7${u.ny})`);
      }
    } catch (err) {
      if (isStale()) return;
      setStatus(err instanceof Error ? err.message : String(err), true);
    }
  }

  // ---- load OFS variable -----------------------------------------------------

  async function loadOfsLevel(variable: CatalogVariable, isStale: () => boolean): Promise<void> {
    // Apply the shoreline clip before fetching so it's already in place
    // (and stays in place) while the new time step loads. The promise is
    // cached, so after the first load this resolves immediately.
    const mask = await ensureWaterMask();
    if (isStale()) return;
    scalarLayer.setWaterMask(mask);
    windLayer.setWaterMask(mask);

    if (variable.ofsModel === 'apparent-wind') {
      await loadApparentWind(variable, isStale);
      return;
    }
    if (variable.ofsModel !== 'sfbofs') {
      setStatus(`Unknown OFS model: ${variable.ofsModel}`, true);
      return;
    }
    if (variable.id === 'sfbofs-water-level') {
      await loadSfbofsWaterLevel(variable, isStale);
      return;
    }
    if (variable.id === 'sfbay-water-depth') {
      await loadSfBayWaterDepth(variable, isStale);
      return;
    }
    const displayName = variable.label;
    setStatus(`fetching ${displayName}...`);

    const { cycle, date, fhour } = ofsSchedule(timeline.validDate());

    const [rawField, waterMask] = await Promise.all([fetchSfbofsSurface(cycle, date, fhour), ensureWaterMask()]);
    if (isStale()) return;

    // With a fine shoreline available, grow the field into the model's land
    // cells so the mask (not the coarse model coast) decides the edge.
    const field = waterMask
      ? {
          ...rawField,
          u: fillMissingNearest(rawField.u, rawField.nx, rawField.ny, OFS_FILL_PASSES),
          v: fillMissingNearest(rawField.v, rawField.nx, rawField.ny, OFS_FILL_PASSES),
        }
      : rawField;
    scalarLayer.setWaterMask(waterMask);
    windLayer.setWaterMask(waterMask);

    // Compute speed magnitude for the scalar raster
    const speed = new Float32Array(field.u.length);
    let sMin = Infinity, sMax = -Infinity;
    for (let i = 0; i < speed.length; i++) {
      const s = Math.hypot(field.u[i]!, field.v[i]!);
      speed[i] = Number.isNaN(s) ? NaN : s;
      if (s < sMin && Number.isFinite(s)) sMin = s;
      if (s > sMax && Number.isFinite(s)) sMax = s;
    }
    const speedField = { values: speed, nx: field.nx, ny: field.ny, min: sMin, max: sMax, missingValue: NaN };

    // Show scalar raster (current speed) with lat/lon projection
    if (!map.getLayer('hrrr-scalar')) map.addLayer(scalarLayer, beforeId);
    scalarLayer.setVisible(true);
    if (variable.colormap) scalarLayer.setColormap(variable.colormap);
    scalarLayer.setDataLatLon(speedField, field.bounds);
    if (variable.range) scalarLayer.setValueRange(variable.range);

    // Show current particles
    if (!windLayer.isAttached()) windLayer.attach(map);
    windLayer.setVisible(true);
    windLayer.setMotion(CURRENT_PARTICLE_MOTION);
    windLayer.setWindLatLon(field.u, field.v, field.nx, field.ny, field.bounds);

    const range = variable.range ?? [sMin, sMax];
    if (variable.colormap) {
      legend.update(variable.colormap, range[0], range[1], variable.unit ?? '');
    }

    // Zoom to the SF Bay area only on first selection of this variable
    if (lastFitVariable !== variable.id) {
      lastFitVariable = variable.id;
      map.fitBounds(
        [[field.bounds.lonMin, field.bounds.latMin], [field.bounds.lonMax, field.bounds.latMax]],
        { padding: 20, maxZoom: 16 },
      );
    }

    setStatus(`${displayName} loaded (${field.nx}\u00D7${field.ny}, cycle ${date} t${String(cycle).padStart(2, '0')}z f${String(fhour).padStart(3, '0')})`);
  }

  // ---- SFBOFS water level (zeta) — scalar only, no particles ----------------

  async function loadSfbofsWaterLevel(variable: CatalogVariable, isStale: () => boolean): Promise<void> {
    const displayName = variable.label;
    setStatus(`fetching ${displayName}...`);

    const { cycle, date, fhour } = ofsSchedule(timeline.validDate());

    const [rawField, waterMask] = await Promise.all([fetchSfbofsWaterLevel(cycle, date, fhour), ensureWaterMask()]);
    if (isStale()) return;

    const field = waterMask
      ? { ...rawField, values: fillMissingNearest(rawField.values, rawField.nx, rawField.ny, OFS_FILL_PASSES) }
      : rawField;
    scalarLayer.setWaterMask(waterMask);

    let zMin = Infinity, zMax = -Infinity;
    for (let i = 0; i < field.values.length; i++) {
      const v = field.values[i]!;
      if (Number.isFinite(v)) {
        if (v < zMin) zMin = v;
        if (v > zMax) zMax = v;
      }
    }
    const scalarInput = {
      values: field.values,
      nx: field.nx, ny: field.ny,
      min: Number.isFinite(zMin) ? zMin : 0,
      max: Number.isFinite(zMax) ? zMax : 0,
      missingValue: NaN,
    };

    if (!map.getLayer('hrrr-scalar')) map.addLayer(scalarLayer, beforeId);
    scalarLayer.setVisible(true);
    if (variable.colormap) scalarLayer.setColormap(variable.colormap);
    scalarLayer.setDataLatLon(scalarInput, field.bounds);
    if (variable.range) scalarLayer.setValueRange(variable.range);

    // Water level is a scalar-only layer — hide any lingering particle overlay.
    hideFillParticles();

    if (variable.colormap && variable.range) {
      legend.update(variable.colormap, variable.range[0], variable.range[1], variable.unit ?? 'm');
    }

    if (lastFitVariable !== variable.id) {
      lastFitVariable = variable.id;
      map.fitBounds(
        [[field.bounds.lonMin, field.bounds.latMin], [field.bounds.lonMax, field.bounds.latMax]],
        { padding: 20, maxZoom: 16 },
      );
    }

    setStatus(`${displayName} loaded (${field.nx}\u00D7${field.ny}, cycle ${date} t${String(cycle).padStart(2, '0')}z f${String(fhour).padStart(3, '0')})`);
  }

  // ---- SF Bay live water depth (CUDEM bathy + SFBOFS zeta) -----------------

  async function loadSfBayWaterDepth(variable: CatalogVariable, isStale: () => boolean): Promise<void> {
    const displayName = variable.label;
    setStatus(`fetching ${displayName}...`);

    const { cycle, date, fhour } = ofsSchedule(timeline.validDate());

    const [zeta, waterMask] = await Promise.all([fetchSfbofsWaterLevel(cycle, date, fhour), ensureWaterMask()]);
    if (isStale()) return;
    const depth = await computeWaterDepth(zeta);
    if (isStale()) return;

    // The bathymetry grid is ~250 m, so cells whose centre is on land are
    // NaN even where part of the cell is water. With the 3 m shoreline doing
    // the clipping, grow the field two cells so those partial cells fill in.
    const values = waterMask
      ? fillMissingNearest(depth.values, depth.nx, depth.ny, DEPTH_FILL_PASSES)
      : depth.values;
    scalarLayer.setWaterMask(waterMask);

    const scalarInput = {
      values,
      nx: depth.nx, ny: depth.ny,
      min: depth.min,
      max: depth.max,
      missingValue: NaN,
    };

    if (!map.getLayer('hrrr-scalar')) map.addLayer(scalarLayer, beforeId);
    scalarLayer.setVisible(true);
    if (variable.colormap) scalarLayer.setColormap(variable.colormap);
    scalarLayer.setDataLatLon(scalarInput, depth.bounds);
    if (variable.range) scalarLayer.setValueRange(variable.range);

    hideFillParticles();

    if (variable.colormap && variable.range) {
      legend.update(variable.colormap, variable.range[0], variable.range[1], variable.unit ?? 'm');
    }

    if (lastFitVariable !== variable.id) {
      lastFitVariable = variable.id;
      map.fitBounds(
        [[depth.bounds.lonMin, depth.bounds.latMin], [depth.bounds.lonMax, depth.bounds.latMax]],
        { padding: 20, maxZoom: 16 },
      );
    }

    setStatus(`${displayName} loaded (${depth.nx}\u00D7${depth.ny}, cycle ${date} t${String(cycle).padStart(2, '0')}z f${String(fhour).padStart(3, '0')})`);
  }

  // ---- apparent wind (HRRR/RRFS 10m wind − OFS current) ---------------------

  async function loadApparentWind(variable: CatalogVariable, isStale: () => boolean): Promise<void> {
    const displayName = variable.label;
    setStatus(`fetching ${displayName}...`);

    const { cycle: ofsCycle, date: ofsDate, fhour: ofsFhour } = ofsSchedule(timeline.validDate());

    // Deterministic model cycle/fhour from timeline (10 m wind is in RRFS 2dfld)
    const model = timeline.model;
    const windIdxUrl = deterministicIdxUrl(model, timeline.cycle, timeline.fhour);
    const fcRe = forecastQuery(timeline.fhour);

    // Fetch both in parallel
    const [rawOfs, hrrrWind, waterMask] = await Promise.all([
      fetchSfbofsSurface(ofsCycle, ofsDate, ofsFhour),
      client.decodePair(
        windIdxUrl,
        { parameter: /^UGRD$/, level: /^10 m above ground$/, forecast: fcRe },
        { parameter: /^VGRD$/, level: /^10 m above ground$/, forecast: fcRe },
      ),
      ensureWaterMask(),
    ]);
    if (isStale()) return;

    const ofsField = waterMask
      ? {
          ...rawOfs,
          u: fillMissingNearest(rawOfs.u, rawOfs.nx, rawOfs.ny, OFS_FILL_PASSES),
          v: fillMissingNearest(rawOfs.v, rawOfs.nx, rawOfs.ny, OFS_FILL_PASSES),
        }
      : rawOfs;
    scalarLayer.setWaterMask(waterMask);
    windLayer.setWaterMask(waterMask);

    // Resample model wind onto the OFS grid (true-north frame) — HRRR and RRFS share the LCC grid
    const hrrrOnOfs = sampleHrrrAtLatLon(
      { ...hrrrWind.u, missingValue: NaN },
      { ...hrrrWind.v, missingValue: NaN },
      hrrrWind.grid as LambertConformalGrid,
      ofsField.nx, ofsField.ny,
      ofsField.bounds,
    );

    // Vector subtraction: apparent = wind − current
    // A boat moving with the current at velocity C feels wind W − C
    const apparentU = new Float32Array(ofsField.u.length);
    const apparentV = new Float32Array(ofsField.v.length);
    const speed = new Float32Array(ofsField.u.length);
    let sMin = Infinity, sMax = -Infinity;

    for (let i = 0; i < apparentU.length; i++) {
      const wu = hrrrOnOfs.u[i]!;
      const wv = hrrrOnOfs.v[i]!;
      // Treat missing current as zero (no current effect)
      const cu = Number.isFinite(ofsField.u[i]!) ? ofsField.u[i]! : 0;
      const cv = Number.isFinite(ofsField.v[i]!) ? ofsField.v[i]! : 0;

      if (!Number.isFinite(wu)) {
        apparentU[i] = NaN;
        apparentV[i] = NaN;
        speed[i] = NaN;
        continue;
      }

      apparentU[i] = wu - cu;
      apparentV[i] = wv - cv;
      const s = Math.hypot(apparentU[i]!, apparentV[i]!);
      speed[i] = s;
      if (s < sMin) sMin = s;
      if (s > sMax) sMax = s;
    }

    const speedField = { values: speed, nx: ofsField.nx, ny: ofsField.ny, min: sMin, max: sMax, missingValue: NaN };

    // Show scalar raster (apparent wind speed)
    if (!map.getLayer('hrrr-scalar')) map.addLayer(scalarLayer, beforeId);
    scalarLayer.setVisible(true);
    if (variable.colormap) scalarLayer.setColormap(variable.colormap);
    scalarLayer.setDataLatLon(speedField, ofsField.bounds);
    if (variable.range) scalarLayer.setValueRange(variable.range);

    // Show apparent wind particles
    if (!windLayer.isAttached()) windLayer.attach(map);
    windLayer.setVisible(true);
    windLayer.setMotion(null);
    windLayer.setWindLatLon(apparentU, apparentV, ofsField.nx, ofsField.ny, ofsField.bounds);

    legend.update('wind', ...windLegendArgs());

    if (lastFitVariable !== variable.id) {
      lastFitVariable = variable.id;
      map.fitBounds(
        [[ofsField.bounds.lonMin, ofsField.bounds.latMin], [ofsField.bounds.lonMax, ofsField.bounds.latMax]],
        { padding: 20, maxZoom: 16 },
      );
    }

    setStatus(`${displayName} loaded (${MODEL_NAMES[model]} t${timeline.cycle.slice(8)}z f${String(timeline.fhour).padStart(2, '0')} + SFBOFS t${String(ofsCycle).padStart(2, '0')}z f${String(ofsFhour).padStart(3, '0')})`);
  }

  // ---- load GEFS variable ----------------------------------------------------

  async function loadGefsLevel(
    variable: CatalogVariable,
    levelIndex: number,
    cycle: string,
    fhour: number,
    isStale: () => boolean,
  ): Promise<void> {
    const level = variable.levels[levelIndex];
    if (!level) return;

    const displayName = variable.levels.length > 1
      ? `${variable.label} @ ${level.label}`
      : variable.label;
    const memberLabel = typeof gefsMember === 'number'
      ? (gefsMember === 0 ? 'control' : `member ${String(gefsMember).padStart(2, '0')}`)
      : gefsMember;
    setStatus(`fetching ${displayName} (${memberLabel})...`);

    if (variable.kind === 'wind' && level.queryU && level.queryV) {
      await loadGefsWind(variable, level, cycle, fhour, displayName, isStale);
    } else if (variable.kind === 'scalar' && level.query) {
      await loadGefsScalar(variable, level, cycle, fhour, displayName, isStale);
    }
  }

  async function loadGefsScalar(
    variable: CatalogVariable,
    level: VariableLevel,
    cycle: string,
    fhour: number,
    displayName: string,
    isStale: () => boolean,
  ): Promise<void> {
    const fcRe = forecastQuery(fhour);
    const query = {
      parameter: level.query!.parameter,
      level: level.query!.level,
      forecast: fcRe,
    };

    let field: { values: Float32Array; nx: number; ny: number; min: number; max: number; missingValue: number };
    let grid: GridDefinition;

    if (gefsMember === 'mean' || gefsMember === 'spread') {
      const urls = gefsStatsUrls(cycle, fhour, gefsMember);
      const result = await client.decode(urls.idx, query);
      if (isStale()) return;
      grid = result.grid;
      field = { ...result.field, missingValue: NaN };
    } else {
      const urls = gefsUrls(cycle, fhour, gefsMember);
      const result = await client.decode(urls.idx, query);
      if (isStale()) return;
      grid = result.grid;
      field = { ...result.field, missingValue: NaN };
    }

    if (grid.template !== 0) throw new Error('GEFS data expected lat/lon grid');
    const shifted = shiftGlobalGrid(field.values, field.nx, field.ny, grid as LatLonGrid);
    field = { ...field, values: shifted.values };
    const bounds = shifted.bounds;

    if (!map.getLayer('hrrr-scalar')) map.addLayer(scalarLayer, beforeId);
    scalarLayer.setVisible(true);
    const cmap = gefsMember === 'spread' ? 'spread' as const : variable.colormap;
    if (cmap) scalarLayer.setColormap(cmap);
    scalarLayer.setDataLatLon(field, bounds);
    if (variable.range) scalarLayer.setValueRange(
      gefsMember === 'spread' ? [0, (variable.range[1] - variable.range[0]) * 0.15] : variable.range,
    );
    hideFillParticles();

    if (cmap) {
      const range = gefsMember === 'spread'
        ? [0, (variable.range![1] - variable.range![0]) * 0.15] as [number, number]
        : (variable.range ?? [field.min, field.max]);
      const unit = gefsMember === 'spread' ? (variable.unit ?? '') : displayUnit(variable);
      legend.update(cmap, range[0], range[1], unit);
    }

    setStatus(`${displayName} (${typeof gefsMember === 'number' ? (gefsMember === 0 ? 'control' : `m${String(gefsMember).padStart(2, '0')}`) : gefsMember}) loaded (${field.nx}×${field.ny})`);
  }

  async function loadGefsWind(
    variable: CatalogVariable,
    level: VariableLevel,
    cycle: string,
    fhour: number,
    displayName: string,
    isStale: () => boolean,
  ): Promise<void> {
    const fcRe = forecastQuery(fhour);
    const queryU = { parameter: level.queryU!.parameter, level: level.queryU!.level, forecast: fcRe };
    const queryV = { parameter: level.queryV!.parameter, level: level.queryV!.level, forecast: fcRe };

    let uField: { values: Float32Array; nx: number; ny: number; min: number; max: number };
    let vField: { values: Float32Array; nx: number; ny: number; min: number; max: number };
    let grid: GridDefinition;
    let isSpread = false;

    if (gefsMember === 'mean') {
      const urls = gefsStatsUrls(cycle, fhour, 'mean');
      const result = await client.decodePair(urls.idx, queryU, queryV);
      if (isStale()) return;
      uField = result.u;
      vField = result.v;
      grid = result.grid;
    } else if (gefsMember === 'spread') {
      // Fetch pre-computed spread U/V and show speed spread as a scalar field
      const urls = gefsStatsUrls(cycle, fhour, 'spread');
      const result = await client.decodePair(urls.idx, queryU, queryV);
      if (isStale()) return;
      grid = result.grid;

      // Compute wind speed spread magnitude from U/V spreads
      const spreadSpeed = new Float32Array(result.u.values.length);
      for (let i = 0; i < spreadSpeed.length; i++) {
        spreadSpeed[i] = Math.hypot(result.u.values[i]!, result.v.values[i]!);
      }

      if (grid.template !== 0) throw new Error('GEFS data expected lat/lon grid');
      const shifted = shiftGlobalGrid(spreadSpeed, result.u.nx, result.u.ny, grid as LatLonGrid);

      if (!map.getLayer('hrrr-scalar')) map.addLayer(scalarLayer, beforeId);
      scalarLayer.setVisible(true);
      scalarLayer.setColormap('spread');
      scalarLayer.setDataLatLon({ values: shifted.values, nx: result.u.nx, ny: result.u.ny, min: 0, max: 15, missingValue: NaN }, shifted.bounds);
      scalarLayer.setValueRange([0, 15]);
      hideFillParticles();
      legend.update('spread', 0, 15, 'm/s');
      setStatus(`${displayName} (spread) loaded (${result.u.nx}×${result.u.ny})`);
      return;
    } else {
      const urls = gefsUrls(cycle, fhour, gefsMember);
      const result = await client.decodePair(urls.idx, queryU, queryV);
      if (isStale()) return;
      uField = result.u;
      vField = result.v;
      grid = result.grid;
    }

    if (grid.template !== 0) throw new Error('GEFS data expected lat/lon grid');
    const llGrid = grid as LatLonGrid;
    const shiftedU = shiftGlobalGrid(uField.values, uField.nx, uField.ny, llGrid);
    const shiftedV = shiftGlobalGrid(vField.values, vField.nx, vField.ny, llGrid);
    const bounds = shiftedU.bounds;

    // Compute wind speed magnitude for the scalar raster
    const speed = new Float32Array(shiftedU.values.length);
    let sMin = Infinity, sMax = -Infinity;
    for (let i = 0; i < speed.length; i++) {
      const s = Math.hypot(shiftedU.values[i]!, shiftedV.values[i]!);
      speed[i] = Number.isNaN(s) ? NaN : s;
      if (s < sMin && Number.isFinite(s)) sMin = s;
      if (s > sMax && Number.isFinite(s)) sMax = s;
    }
    const speedField = { values: speed, nx: uField.nx, ny: uField.ny, min: sMin, max: sMax, missingValue: NaN };

    if (!map.getLayer('hrrr-scalar')) map.addLayer(scalarLayer, beforeId);
    scalarLayer.setVisible(true);
    if (variable.colormap) scalarLayer.setColormap(variable.colormap);
    scalarLayer.setDataLatLon(speedField, bounds);
    if (variable.range) scalarLayer.setValueRange(variable.range);

    if (!windLayer.isAttached()) windLayer.attach(map);
    windLayer.setVisible(true);
    windLayer.setWindLatLon(shiftedU.values, shiftedV.values, uField.nx, uField.ny, bounds);

    legend.update('wind', ...windLegendArgs());
    const memberLabel = typeof gefsMember === 'number'
      ? (gefsMember === 0 ? 'control' : `m${String(gefsMember).padStart(2, '0')}`)
      : gefsMember;
    setStatus(`${displayName} (${memberLabel}) loaded (${uField.nx}×${uField.ny})`);
  }

  // ---- keyboard shortcuts ---------------------------------------------------

  document.addEventListener('keydown', (ev) => {
    // Don't intercept when focused on input elements
    const tag = (ev.target as HTMLElement).tagName;
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;

    switch (ev.key) {
      case 'ArrowLeft':
        ev.preventDefault();
        timeline.stepHour(-1);
        break;
      case 'ArrowRight':
        ev.preventDefault();
        timeline.stepHour(1);
        break;
      case 'ArrowUp':
        ev.preventDefault();
        levelSlider.step(1);  // up = higher altitude = higher index
        break;
      case 'ArrowDown':
        ev.preventDefault();
        levelSlider.step(-1); // down = lower altitude = lower index
        break;
    }
  });

  // ---- click-to-inspect -----------------------------------------------------

  let popup: maplibregl.Popup | null = null;
  const showPopup = (lngLat: maplibregl.LngLat, html: string): void => {
    if (popup) popup.remove();
    popup = new maplibregl.Popup({ closeButton: true, closeOnClick: true, maxWidth: '280px' })
      .setLngLat(lngLat)
      .setHTML(html)
      .addTo(map);
  };

  // Wire popup callback for DOM marker clicks (water level / tide stations)
  tideManager?.setPopupCallback((lngLat, html) =>
    showPopup(new maplibregl.LngLat(lngLat.lng, lngLat.lat), html));

  map.on('click', (ev) => {
    // Check tide station layers first — they handle their own popup
    if (tideManager.handleClick(ev, map, (lngLat, html) => showPopup(new maplibregl.LngLat(lngLat.lng, lngLat.lat), html))) {
      return;
    }

    const { lng, lat } = ev.lngLat;
    const rows = (getUiMode() === 'easy' ? easyReadout : expertReadout)(lng, lat);
    rows.push('<button class="forecast-btn">Forecast for this point</button>');
    showPopup(ev.lngLat, rows.join(''));
    popup?.getElement()?.querySelector('.forecast-btn')?.addEventListener('click', () => {
      popup?.remove();
      forecastPoint = { lng, lat };
      void loadForecast();
    });
  });

  // ---- point forecast ---------------------------------------------------------

  let forecastPoint: { lng: number; lat: number } | null = null;
  let forecastKey = '';
  let forecastGen = 0;
  const FORECAST_CONCURRENCY = 4;

  const forecastStrip = new PointForecast({
    parent: document.body,
    onSelectHour: (fhour) => timeline.selectHour(fhour),
    onClose: () => {
      forecastPoint = null;
      forecastGen++;
    },
  });

  /** Everything the forecast rows depend on, other than the selected hour. */
  const forecastSignature = (): string => [
    currentVariable?.id, levelSlider.index, timeline.source, timeline.model, timeline.slotsKey,
    particlesEnabled, isobarsEnabled,
  ].join('|');

  /** Reload the open forecast if its inputs changed; otherwise just track the hour. */
  function refreshForecast(): void {
    if (!forecastPoint) return;
    if (forecastSignature() !== forecastKey) void loadForecast();
    else forecastStrip.setActiveHour(timeline.fhour);
  }

  interface ForecastRow {
    label: string;
    idxUrl: (cycle: string, fhour: number) => string;
    /** Null where the layer has no record for that hour. */
    queries: (fhour: number) => IdxQuery[] | null;
    cell: (values: number[], convergence: number) => ForecastCell | null;
  }

  function windForecastRow(label: string, u: LayerQuery, v: LayerQuery, level?: VariableLevel): ForecastRow {
    const model = timeline.model;
    return {
      label,
      idxUrl: (cycle, fhour) => deterministicIdxUrl(model, cycle, fhour, level),
      queries: (fhour) => [
        { parameter: u.parameter, level: u.level, forecast: forecastQuery(fhour) },
        { parameter: v.parameter, level: v.level, forecast: forecastQuery(fhour) },
      ],
      cell: ([gu, gv], convergence) => {
        if (!Number.isFinite(gu) || !Number.isFinite(gv)) return null;
        // Grid-relative to true-north, as in resampleLccToLatLon.
        const uTrue = gu! * Math.cos(convergence) + gv! * Math.sin(convergence);
        const vTrue = -gu! * Math.sin(convergence) + gv! * Math.cos(convergence);
        const speed = Math.hypot(uTrue, vTrue);
        return {
          text: `${convertSpeed(speed, getUnitPref('speed')).toFixed(0)} ${unitLabel('speed')}`,
          background: colormapCss('wind', speed, [0, WIND_MAX]),
          fromDeg: (Math.atan2(-uTrue, -vTrue) * 180 / Math.PI + 360) % 360,
        };
      },
    };
  }

  function forecastRows(): ForecastRow[] {
    const rows: ForecastRow[] = [];
    if (timeline.source === 'gefs') return rows;
    const model = timeline.model;
    const variable = currentVariable;
    const level = variable?.levels[levelSlider.index];
    const name = variable ? (getUiMode() === 'easy' ? easyLabel(variable) : variable.label) : '';

    if (variable && level && (variable.source ?? 'hrrr') === 'hrrr' && isAvailableFor(variable, model)) {
      const query = scalarQueryFor(model, level);
      if (variable.kind === 'wind' && level.queryU && level.queryV) {
        rows.push(windForecastRow(name, level.queryU, level.queryV, level));
      } else if (variable.kind === 'scalar' && query) {
        rows.push({
          label: name,
          idxUrl: (cycle, fhour) => deterministicIdxUrl(model, cycle, fhour, level),
          // Accumulated / windowed fields have no record at the analysis hour.
          queries: (fhour) => (query.forecast && fhour === 0 ? null : [{
            parameter: query.parameter,
            level: query.level,
            forecast: query.forecast?.(fhour) ?? forecastQuery(fhour),
          }]),
          cell: ([v]) => (Number.isFinite(v) ? {
            text: variable.format?.(v!) ?? v!.toFixed(1),
            background: variable.colormap && variable.range
              ? colormapCss(variable.colormap, v!, variable.range)
              : undefined,
          } : null),
        });
      }
    }

    if (particlesEnabled && !fillOwnsParticles(variable)) {
      const at10m = /^10 m above ground$/;
      rows.push(windForecastRow('Wind', { parameter: /^UGRD$/, level: at10m }, { parameter: /^VGRD$/, level: at10m }));
    }

    if (isobarsEnabled) {
      rows.push({
        label: 'Pressure',
        idxUrl: (cycle, fhour) => deterministicIdxUrl(model, cycle, fhour),
        queries: (fhour) => [{
          parameter: /^(MSLMA|MSLET|PRMSL)$/, level: /^mean sea level$/, forecast: forecastQuery(fhour),
        }],
        cell: ([p]) => (Number.isFinite(p) ? { text: `${(p! / 100).toFixed(0)} hPa` } : null),
      });
    }
    return rows;
  }

  async function loadForecast(): Promise<void> {
    if (!forecastPoint) return;
    const { lng, lat } = forecastPoint;
    const gen = ++forecastGen;
    forecastKey = forecastSignature();

    const title = `Forecast at ${Math.abs(lat).toFixed(2)}\u00B0${lat >= 0 ? 'N' : 'S'}, `
      + `${Math.abs(lng).toFixed(2)}\u00B0${lng >= 0 ? 'E' : 'W'}`;
    const rows = forecastRows();
    if (rows.length === 0) {
      forecastStrip.showMessage(title, 'A point forecast is not available for this layer yet.');
      return;
    }

    // RRFS comes from rate-limited NOMADS, so thin its long range to 3-hourly.
    const slots = timeline.model === 'rrfs'
      ? timeline.slots().filter((s, i) => i <= 18 || s.fhour % 3 === 0)
      : timeline.slots();
    forecastStrip.open(
      title,
      slots.map(({ fhour, validMs }) => ({ fhour, valid: new Date(validMs) })),
      rows.map((r) => r.label),
    );
    forecastStrip.setActiveHour(timeline.fhour);

    const tasks = slots.flatMap(({ cycle, fhour }) => rows.map((row, rowIndex) => ({ cycle, fhour, row, rowIndex })));
    let next = 0;
    const worker = async (): Promise<void> => {
      while (next < tasks.length && gen === forecastGen) {
        const { cycle, fhour, row, rowIndex } = tasks[next++]!;
        const queries = row.queries(fhour);
        let cell: ForecastCell | null = null;
        if (queries) {
          try {
            const s = await client.samplePoint(row.idxUrl(cycle, fhour), queries, lng, lat);
            cell = row.cell(s.values, s.convergence);
          } catch (err) {
            console.warn(`Point forecast: ${row.label} f${fhour} failed:`, err);
          }
        }
        if (gen !== forecastGen) return;
        forecastStrip.setCell(rowIndex, fhour, cell);
        if (fhour === timeline.fhour) forecastStrip.setActiveHour(fhour);
      }
    };
    await Promise.all(Array.from({ length: FORECAST_CONCURRENCY }, worker));
  }

  /** Scalar fill value at a point, or null where the fill has no data. */
  const sampleFill = (lng: number, lat: number): ReturnType<typeof scalarLayer.sampleAt> => {
    if (!map.getLayer('hrrr-scalar') || !scalarLayer.isVisible()) return null;
    if (!windLayer.isWaterAt(lng, lat)) return null;
    const s = scalarLayer.sampleAt(lng, lat);
    return s && !Number.isNaN(s.value) ? s : null;
  };

  const sampleWind = (lng: number, lat: number): ReturnType<typeof windLayer.sampleAt> => {
    if (!windLayer.isAttached() || !windLayer.isVisible()) return null;
    if (!windLayer.isWaterAt(lng, lat)) return null;
    const w = windLayer.sampleAt(lng, lat);
    return w && Number.isFinite(w.speed) ? w : null;
  };

  const samplePressure = (lng: number, lat: number): number | null => {
    if (!isobarLayer.isVisible()) return null;
    if (!isobarSource) return isobarLayer.sampleAt(lng, lat);
    const p = sampleLccPoint([isobarSource.field], isobarSource.grid, lng, lat).values[0]!;
    return Number.isFinite(p) ? p : null;
  };

  const sampleLightning = (lng: number, lat: number): string | null => {
    if (!lightningLayer.isAttached() || !lightningLayer.isVisible()) return null;
    const hit = lightningLayer.hitTest(lng, lat);
    if (!hit) return null;
    const ago = Math.round((Date.now() - hit.time) / 1000);
    return ago < 60 ? `${ago}s ago` : `${Math.floor(ago / 60)}m ${ago % 60}s ago`;
  };

  const inspectRow = (key: string, value: string): string =>
    `<div class="inspect-row"><span class="k">${escapeHtml(key)}</span><span>${escapeHtml(value)}</span></div>`;

  /** One plain-language line per active layer. */
  function easyReadout(lng: number, lat: number): string[] {
    const rows: string[] = [];
    const fillName = currentVariable ? easyLabel(currentVariable) : 'Value';
    const ownsParticles = fillOwnsParticles(currentVariable);

    const w = sampleWind(lng, lat);
    const windText = w
      ? `${convertSpeed(w.speed, getUnitPref('speed')).toFixed(0)} ${unitLabel('speed')} from ${compassFromBearing(w.directionDeg)}`
      : null;

    // A wind-type fill reads best as speed + direction, which the particle sample carries.
    if (ownsParticles && windText) {
      rows.push(inspectRow(fillName, windText));
    } else {
      const s = sampleFill(lng, lat);
      if (s) rows.push(inspectRow(fillName, currentVariable?.format?.(s.value) ?? s.value.toFixed(1)));
      if (windText) rows.push(inspectRow('Wind', windText));
    }

    const p = samplePressure(lng, lat);
    if (p !== null) rows.push(inspectRow('Pressure', `${(p / 100).toFixed(0)} hPa`));

    const strike = sampleLightning(lng, lat);
    if (strike) rows.push(inspectRow('Lightning strike', strike));

    if (rows.length === 0) rows.push('<div class="inspect-title" style="color:#8b949e">No data here</div>');
    return rows;
  }

  function expertReadout(lng: number, lat: number): string[] {
    const rows: string[] = [];
    const level = currentVariable?.levels[levelSlider.index];
    const displayName = currentVariable && level && currentVariable.levels.length > 1
      ? `${currentVariable.label} @ ${level.label}`
      : currentVariable?.label ?? '';
    const spacer = (): void => { if (rows.length) rows.push('<div style="height:4px"></div>'); };

    const s = sampleFill(lng, lat);
    if (s) {
      rows.push(`<div class="inspect-title">${escapeHtml(displayName || 'Scalar')}</div>`);
      rows.push(inspectRow('value', currentVariable?.format?.(s.value) ?? s.value.toFixed(3)));
      rows.push(inspectRow('grid i,j', `${s.i}, ${s.j}`));
      if (s.missing > 0) rows.push(inspectRow('note', `${s.missing}/4 corners missing`));
    }

    const w = sampleWind(lng, lat);
    if (w) {
      spacer();
      const windTitle = fillOwnsParticles(currentVariable) ? displayName : 'Wind';
      rows.push(`<div class="inspect-title">${escapeHtml(windTitle || 'Wind')}</div>`);
      rows.push(inspectRow('speed', `${convertSpeed(w.speed, getUnitPref('speed')).toFixed(1)} ${unitLabel('speed')}`));
      rows.push(inspectRow('from', `${compassFromBearing(w.directionDeg)} (${w.directionDeg.toFixed(0)}\u00B0)`));
      rows.push(inspectRow('u / v', `${w.u.toFixed(1)} / ${w.v.toFixed(1)}`));
    }

    const p = samplePressure(lng, lat);
    if (p !== null) {
      spacer();
      rows.push('<div class="inspect-title">MSLP</div>');
      rows.push(inspectRow('value', `${(p / 100).toFixed(1)} hPa`));
    }

    if (lightningLayer.isAttached() && lightningLayer.isVisible()) {
      const hit = lightningLayer.hitTest(lng, lat);
      const strike = sampleLightning(lng, lat);
      if (hit && strike) {
        spacer();
        rows.push('<div class="inspect-title" style="color:#ffcf57">&#9889; Lightning Strike</div>');
        rows.push(inspectRow('time', strike));
        rows.push(inspectRow('location', `${hit.lon.toFixed(3)}, ${hit.lat.toFixed(3)}`));
      }
    }

    if (rows.length === 0) rows.push('<div class="inspect-title" style="color:#8b949e">no data at this point</div>');
    rows.push(`<div style="margin-top:6px">${inspectRow('lon, lat', `${lng.toFixed(3)}, ${lat.toFixed(3)}`)}</div>`);
    return rows;
  }

  // ---- dev tool: regenerate the easy-mode icons --------------------------------

  if (import.meta.env.DEV && urlParams.has('capture-icons')) {
    const { captureIcons } = await import('./iconCapture.js');
    urlReady = false; // leave the URL alone while layers are cycled
    void captureIcons({
      map,
      showFill: async (id) => {
        const variable = findVariable(id);
        if (!variable) throw new Error(`Unknown layer ${id}`);
        selectVariable(variable, false);
        await loadLevel(variable, 0, timeline.cycle, timeline.fhour);
      },
      hideFill: () => {
        scalarLayer.setVisible(false);
        windLayer.setVisible(false);
      },
      setOverlay: (id, on) => {
        const box = overlayBoxes.get(id);
        if (!box) return;
        box.checked = on;
        box.dispatchEvent(new Event('change'));
      },
    });
    return;
  }

  // ---- auto-load default variable on startup --------------------------------

  const defaultVar = (urlLayer && findVariable(urlLayer)) || findVariable('wind') || CATALOG[0];
  if (defaultVar) {
    // A shared link's overlay list replaces the defaults.
    if (urlOverlays) {
      for (const [id, box] of overlayBoxes) {
        if (box.checked === urlOverlays.includes(id)) continue;
        box.checked = !box.checked;
        box.dispatchEvent(new Event('change'));
      }
    }
    urlReady = true;

    // Each step below that changes something starts a load; the last one wins.
    if (urlModel === 'rrfs') timeline.setModel(urlModel);
    selectVariable(defaultVar, false);
    if (urlLevel > 0) levelSlider.select(urlLevel);
    // Easy mode opens on the current conditions rather than the start of the run.
    if (urlTime !== null && timeline.covers(urlTime)) timeline.selectValidTime(urlTime);
    else if (getUiMode() === 'easy') timeline.selectNow();
    else void loadLevel(defaultVar, levelSlider.index, timeline.cycle, timeline.fhour);
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

function compassFromBearing(deg: number): string {
  const dirs = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
  return dirs[Math.round((((deg % 360) + 360) % 360) / 22.5) % 16]!;
}

void main();
