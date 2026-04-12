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
import { CATALOG, findVariable } from '../renderer/catalog.js';
import type { CatalogVariable, VariableLevel } from '../renderer/catalog.js';
import { Panel } from './panel.js';
import { Timeline } from './timeline.js';
import { Legend } from './legend.js';
import type { LegendTick } from './legend.js';
import { LevelSlider } from './levelSlider.js';

// Wind speed raster range in m/s — must match WIND_MAX_MS in colormaps.ts.
const KT_TO_MS = 0.514444;
const WIND_RANGE_MS: [number, number] = [0, 104];

// Tick marks for the wind legend (in knots)
const WIND_TICKS: LegendTick[] = [
  { value: 0,  label: '0' },
  { value: 5,  label: '5' },
  { value: 10, label: '10' },
  { value: 20, label: '20' },
  { value: 30, label: '30' },
  { value: 40, label: '40' },
  { value: 60, label: '60' },
];

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
    maxZoom: 10,
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
  let loading = false;

  // ---- UI components --------------------------------------------------------

  const legend = new Legend(panelRoot);

  // Append collapsible layers section after the legend
  panelRoot.appendChild(expandBtn);
  panelRoot.appendChild(layersWrap);

  const timeline = new Timeline({
    parent: timelineBar,
    onChange: (_cycle, _fhour) => {
      if (currentVariable && !loading) {
        void loadLevel(currentVariable, levelSlider.index, _cycle, _fhour);
      }
    },
  });

  const levelSlider = new LevelSlider({
    parent: layersWrap,
    onChange: (levelIndex) => {
      if (currentVariable && !loading) {
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

  // ---- load a variable at a specific level ----------------------------------

  async function loadLevel(
    variable: CatalogVariable,
    levelIndex: number,
    cycle: string,
    fhour: number,
  ): Promise<void> {
    if (loading) return;
    loading = true;
    currentVariable = variable;
    panel.setActive(variable.id);

    const level = variable.levels[levelIndex];
    if (!level) { loading = false; return; }

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
          loading = false;
          return;
        }
        const { field, grid } = await client.decode(urls.idx, {
          parameter: level.query.parameter,
          level: level.query.level,
          forecast: layerFcRe,
        });
        if (!map.getLayer('hrrr-scalar')) map.addLayer(scalarLayer, beforeId);
        scalarLayer.setVisible(true);
        scalarLayer.setData({ ...field, missingValue: NaN }, grid);
        if (variable.colormap) scalarLayer.setColormap(variable.colormap);
        if (variable.range) scalarLayer.setValueRange(variable.range);
        windLayer.setVisible(false);

        const range = variable.range ?? [field.min, field.max];
        if (variable.colormap) {
          legend.update(variable.colormap, range[0], range[1], variable.unit ?? '');
        }
        setStatus(displayName);
      } else if (variable.kind === 'wind' && level.queryU && level.queryV) {
        const { u, v, grid } = await client.decodePair(
          urls.idx,
          { parameter: level.queryU.parameter, level: level.queryU.level, forecast: fcRe },
          { parameter: level.queryV.parameter, level: level.queryV.level, forecast: fcRe },
        );

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
        scalarLayer.setValueRange(WIND_RANGE_MS);

        // Show wind particles on top
        if (!windLayer.isAttached()) windLayer.attach(map);
        windLayer.setVisible(true);
        windLayer.setWind({ ...u, missingValue: NaN }, { ...v, missingValue: NaN }, grid);

        legend.update('wind', 0, 60, 'kt', WIND_TICKS);
        setStatus(`${displayName} loaded (${u.nx}\u00D7${u.ny})`);
      }
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err), true);
    } finally {
      loading = false;
    }
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

  map.on('click', (ev) => {
    const { lng, lat } = ev.lngLat;
    const rows: string[] = [];

    const level = currentVariable?.levels[levelSlider.index];
    const displayName = currentVariable && level && currentVariable.levels.length > 1
      ? `${currentVariable.label} @ ${level.label}`
      : currentVariable?.label ?? '';

    // Scalar field readout (skip when wind variable is active — wind readout below is richer)
    if (currentVariable?.kind !== 'wind' && map.getLayer('hrrr-scalar') && scalarLayer.isVisible()) {
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
        rows.push(`<div class="inspect-row"><span class="k">speed</span><span>${w.speed.toFixed(1)} m/s  (${(w.speed * 2.237).toFixed(1)} mph)</span></div>`);
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

  const defaultVar = findVariable('temperature') ?? CATALOG[0];
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
  return dirs[Math.round(((deg % 360) / 22.5)) % 16]!;
}

void main();
