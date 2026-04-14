/**
 * Demo entry point. Wires a MapLibre map with HRRR weather layers driven
 * by the catalog (variable + levels), a grouped picker panel, level slider,
 * timeline control, and legend.
 *
 * Keyboard shortcuts:
 *   Left/Right arrow — step through forecast hours
 *   Up/Down arrow    — step through atmospheric levels
 */

import maplibregl from 'maplibre-gl';
import { ScalarFieldLayer, WindyLayer, LightningLayer } from '../renderer/index.js';
import { hrrrUrls, forecastQuery } from '../grib2/idx.js';
import { DecodeClient } from '../worker/client.js';
import { CATALOG, findVariable, displayRange, displayUnit } from '../renderer/catalog.js';
import type { CatalogVariable, VariableLevel } from '../renderer/catalog.js';
import { fetchSfbofsSurface, fetchSfbofsWaterLevel, latestCycle as sfbofsLatestCycle, SFBOFS_MAX_FHOUR } from '../ofs/sfbofs.js';
import { computeWaterDepth } from '../bathymetry/waterDepth.js';
import { sampleHrrrAtLatLon } from '../grib2/resample.js';
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

const setStatus = (text: string, error = false): void => {
  const el = document.getElementById('status')!;
  el.textContent = text;
  el.classList.toggle('err', error);
};

async function main(): Promise<void> {
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
  const scalarLayer = new ScalarFieldLayer({ id: 'hrrr-scalar', colormap: 'turbo', opacity: 0.85 });

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
  const client = new DecodeClient();

  let currentVariable: CatalogVariable | null = null;
  let loadGen = 0;
  let lastFitVariable: string | null = null; // track which variable we last zoomed to
  let tideManager: TideStationManager | null = null;

  // ---- UI components --------------------------------------------------------

  const legend = new Legend(panelRoot);

  // Append collapsible layers section after the legend
  panelRoot.appendChild(expandBtn);
  panelRoot.appendChild(layersWrap);

  const timeline = new Timeline({
    parent: timelineBar,
    onChange: (_cycle, _fhour) => {
      tideManager?.setForecastTime(timeline.validDate());
      if (currentVariable) {
        void loadLevel(currentVariable, levelSlider.index, _cycle, _fhour);
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

  const panel = new Panel({
    parent: layersWrap,
    onSelect: (variable) => {
      currentVariable = variable;
      levelSlider.setLevels(variable.levels);
      void loadLevel(variable, 0, timeline.cycle, timeline.fhour);
    },
  });

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
  // Update strike count periodically
  setInterval(() => {
    const n = lightningLayer.strikeCount;
    ltCount.textContent = n > 0 ? `(${n})` : '';
  }, 2000);

  // ---- tide station toggles ---------------------------------------------------

  tideManager.createToggles(layersWrap);

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

  async function loadLevel(
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

    const urls = hrrrUrls(cycle, fhour);
    const fcRe = forecastQuery(fhour);
    const displayName = variable.levels.length > 1
      ? `${variable.label} @ ${level.label}`
      : variable.label;
    setStatus(`fetching ${displayName}...`);

    try {
      if (variable.kind === 'scalar' && level.query) {
        const layerFcRe = level.query.forecast?.(fhour) ?? fcRe;
        // Accumulated fields have no data at analysis time (fhour 0)
        if (level.query.forecast && fhour === 0) {
          scalarLayer.setVisible(false);
          windLayer.setVisible(false);
          legend.hide();
          setStatus(`${displayName} — no data at analysis hour`);
          return;
        }
        const { field, grid } = await client.decode(urls.idx, {
          parameter: level.query.parameter,
          level: level.query.level,
          forecast: layerFcRe,
        });
        if (isStale()) return;
        if (!map.getLayer('hrrr-scalar')) map.addLayer(scalarLayer, beforeId);
        scalarLayer.setVisible(true);
        scalarLayer.setData({ ...field, missingValue: NaN }, grid);
        if (variable.colormap) scalarLayer.setColormap(variable.colormap);
        scalarLayer.setValueRange(variable.range!);
        windLayer.setVisible(false);

        if (variable.colormap) {
          const dr = displayRange(variable);
          legend.update(variable.colormap, dr[0], dr[1], displayUnit(variable));
        }
        setStatus(displayName);
      } else if (variable.kind === 'wind' && level.queryU && level.queryV) {
        const { u, v, grid } = await client.decodePair(
          urls.idx,
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
        scalarLayer.setData(speedField, grid);
        scalarLayer.setValueRange(variable.range!);

        // Show wind particles on top
        if (!windLayer.isAttached()) windLayer.attach(map);
        windLayer.setVisible(true);
        windLayer.setWind({ ...u, missingValue: NaN }, { ...v, missingValue: NaN }, grid);

        legend.update('wind', ...windLegendArgs());
        setStatus(`${displayName} loaded (${u.nx}\u00D7${u.ny})`);
      }
    } catch (err) {
      if (isStale()) return;
      setStatus(err instanceof Error ? err.message : String(err), true);
    }
  }

  // ---- load OFS variable -----------------------------------------------------

  async function loadOfsLevel(variable: CatalogVariable, isStale: () => boolean): Promise<void> {
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

    const field = await fetchSfbofsSurface(cycle, date, fhour);
    if (isStale()) return;

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

    const field = await fetchSfbofsWaterLevel(cycle, date, fhour);
    if (isStale()) return;

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
    if (windLayer.isAttached()) windLayer.setVisible(false);

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

    const zeta = await fetchSfbofsWaterLevel(cycle, date, fhour);
    if (isStale()) return;
    const depth = await computeWaterDepth(zeta);
    if (isStale()) return;

    const scalarInput = {
      values: depth.values,
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

    if (windLayer.isAttached()) windLayer.setVisible(false);

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

  // ---- apparent wind (HRRR 10m wind − OFS current) --------------------------

  async function loadApparentWind(variable: CatalogVariable, isStale: () => boolean): Promise<void> {
    const displayName = variable.label;
    setStatus(`fetching ${displayName}...`);

    const { cycle: ofsCycle, date: ofsDate, fhour: ofsFhour } = ofsSchedule(timeline.validDate());

    // HRRR cycle/fhour from timeline
    const hrrrUrlSet = hrrrUrls(timeline.cycle, timeline.fhour);
    const fcRe = forecastQuery(timeline.fhour);

    // Fetch both in parallel
    const [ofsField, hrrrWind] = await Promise.all([
      fetchSfbofsSurface(ofsCycle, ofsDate, ofsFhour),
      client.decodePair(
        hrrrUrlSet.idx,
        { parameter: /^UGRD$/, level: /^10 m above ground$/, forecast: fcRe },
        { parameter: /^VGRD$/, level: /^10 m above ground$/, forecast: fcRe },
      ),
    ]);
    if (isStale()) return;

    // Resample HRRR wind onto the OFS grid (true-north frame)
    const hrrrOnOfs = sampleHrrrAtLatLon(
      { ...hrrrWind.u, missingValue: NaN },
      { ...hrrrWind.v, missingValue: NaN },
      hrrrWind.grid,
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
    windLayer.setWindLatLon(apparentU, apparentV, ofsField.nx, ofsField.ny, ofsField.bounds);

    legend.update('wind', ...windLegendArgs());

    if (lastFitVariable !== variable.id) {
      lastFitVariable = variable.id;
      map.fitBounds(
        [[ofsField.bounds.lonMin, ofsField.bounds.latMin], [ofsField.bounds.lonMax, ofsField.bounds.latMax]],
        { padding: 20, maxZoom: 16 },
      );
    }

    setStatus(`${displayName} loaded (HRRR t${timeline.cycle.slice(8)}z f${String(timeline.fhour).padStart(2, '0')} + SFBOFS t${String(ofsCycle).padStart(2, '0')}z f${String(ofsFhour).padStart(3, '0')})`);
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
    const rows: string[] = [];

    const level = currentVariable?.levels[levelSlider.index];
    const displayName = currentVariable && level && currentVariable.levels.length > 1
      ? `${currentVariable.label} @ ${level.label}`
      : currentVariable?.label ?? '';

    // Scalar field readout
    if (map.getLayer('hrrr-scalar') && scalarLayer.isVisible()) {
      const s = scalarLayer.sampleAt(lng, lat);
      if (s && !Number.isNaN(s.value)) {
        const formatted = currentVariable?.format?.(s.value) ?? s.value.toFixed(3);
        rows.push(`<div class="inspect-title">${escapeHtml(displayName || 'Scalar')}</div>`);
        rows.push(`<div class="inspect-row"><span class="k">value</span><span>${escapeHtml(formatted)}</span></div>`);
        rows.push(`<div class="inspect-row"><span class="k">grid i,j</span><span>${s.i}, ${s.j}</span></div>`);
        if (s.missing > 0) rows.push(`<div class="inspect-row"><span class="k">note</span><span>${s.missing}/4 corners missing</span></div>`);
      }
    }

    // Wind readout
    if (windLayer.isAttached() && windLayer.isVisible()) {
      const w = windLayer.sampleAt(lng, lat);
      if (w && Number.isFinite(w.speed)) {
        if (rows.length) rows.push('<div style="height:4px"></div>');
        rows.push(`<div class="inspect-title">${escapeHtml(displayName || 'Wind')}</div>`);
        const su = getUnitPref('speed');
        rows.push(`<div class="inspect-row"><span class="k">speed</span><span>${convertSpeed(w.speed, su).toFixed(1)} ${unitLabel('speed')}</span></div>`);
        rows.push(`<div class="inspect-row"><span class="k">from</span><span>${compassFromBearing(w.directionDeg)} (${w.directionDeg.toFixed(0)}\u00B0)</span></div>`);
        rows.push(`<div class="inspect-row"><span class="k">u / v</span><span>${w.u.toFixed(1)} / ${w.v.toFixed(1)}</span></div>`);
      }
    }

    // Lightning strike readout
    if (lightningLayer.isAttached() && lightningLayer.isVisible()) {
      const hit = lightningLayer.hitTest(lng, lat);
      if (hit) {
        const ago = Math.round((Date.now() - hit.time) / 1000);
        const agoStr = ago < 60 ? `${ago}s ago` : `${Math.floor(ago / 60)}m ${ago % 60}s ago`;
        if (rows.length) rows.push('<div style="height:4px"></div>');
        rows.push(`<div class="inspect-title" style="color:#ffcf57">&#9889; Lightning Strike</div>`);
        rows.push(`<div class="inspect-row"><span class="k">time</span><span>${agoStr}</span></div>`);
        rows.push(`<div class="inspect-row"><span class="k">location</span><span>${hit.lon.toFixed(3)}, ${hit.lat.toFixed(3)}</span></div>`);
      }
    }

    rows.push(`<div style="margin-top:6px"><div class="inspect-row"><span class="k">lon, lat</span><span>${lng.toFixed(3)}, ${lat.toFixed(3)}</span></div></div>`);

    if (rows.length === 1) rows.unshift('<div class="inspect-title" style="color:#8b949e">no data at this point</div>');
    showPopup(ev.lngLat, rows.join(''));
  });

  // ---- auto-load default variable on startup --------------------------------

  const defaultVar = findVariable('wind') ?? CATALOG[0];
  if (defaultVar) {
    currentVariable = defaultVar;
    panel.setActive(defaultVar.id);
    levelSlider.setLevels(defaultVar.levels);
    void loadLevel(defaultVar, 0, timeline.cycle, timeline.fhour);
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
