/**
 * Demo entry point. Wires a MapLibre map with a scalar HRRR layer and a
 * wind-particle layer, plus a tiny control panel to pick fields.
 *
 * HRRR lives on NOAA's S3 Open Data bucket:
 *   https://noaa-hrrr-bdp-pds.s3.amazonaws.com/hrrr.YYYYMMDD/conus/hrrr.tHHz.wrfsfcfFF.grib2[.idx]
 *
 * The S3 bucket is CORS-enabled and supports Range requests, which is what
 * makes in-browser HRRR feasible.
 */

import maplibregl from 'maplibre-gl';
import { ScalarFieldLayer, WindParticleLayer } from '../renderer/index.js';
import { hrrrUrls } from '../grib2/idx.js';
import { DecodeClient } from '../worker/client.js';

// A small catalog of interesting HRRR surface fields. Each preset carries its
// own unit/format metadata so click-to-inspect can show human-readable values.
interface FieldPreset {
  key: string;
  label: string;
  kind: 'scalar' | 'wind';
  scalar?: {
    param: RegExp;
    level: RegExp;
    forecast?: RegExp;
    colormap?: 'turbo' | 'viridis' | 'inferno' | 'temperature' | 'grayscale';
    /** Convert the raw decoded value into the display unit for inspection. */
    format: (raw: number) => string;
  };
  wind?: {
    uParam: RegExp;
    vParam: RegExp;
    level: RegExp;
    forecast?: RegExp;
  };
}

const kelvinToF = (k: number): string => `${((k - 273.15) * 9 / 5 + 32).toFixed(1)} °F`;
const metersToMi = (m: number): string => `${(m / 1609.344).toFixed(1)} mi`;

const PRESETS: FieldPreset[] = [
  {
    key: 't2m',
    label: '2 m Temperature',
    kind: 'scalar',
    scalar: {
      param: /^TMP$/,
      level: /^2 m above ground$/,
      colormap: 'temperature',
      format: (v) => `${kelvinToF(v)}  (${v.toFixed(1)} K)`,
    },
  },
  {
    key: 'refc',
    label: 'Composite Reflectivity',
    kind: 'scalar',
    scalar: {
      param: /^REFC$/,
      level: /entire atmosphere/,
      colormap: 'turbo',
      format: (v) => `${v.toFixed(1)} dBZ`,
    },
  },
  {
    key: 'gust',
    label: 'Surface Wind Gust',
    kind: 'scalar',
    scalar: {
      param: /^GUST$/,
      level: /^surface$/,
      colormap: 'viridis',
      format: (v) => `${v.toFixed(1)} m/s  (${(v * 2.237).toFixed(1)} mph)`,
    },
  },
  {
    key: 'tcdc',
    label: 'Total Cloud Cover',
    kind: 'scalar',
    scalar: {
      param: /^TCDC$/,
      level: /entire atmosphere/,
      colormap: 'grayscale',
      format: (v) => `${v.toFixed(0)} %`,
    },
  },
  {
    key: 'vis',
    label: 'Surface Visibility',
    kind: 'scalar',
    scalar: {
      param: /^VIS$/,
      level: /^surface$/,
      colormap: 'viridis',
      format: (v) => metersToMi(v),
    },
  },
  {
    key: 'wind10',
    label: '10 m Wind (particles)',
    kind: 'wind',
    wind: { uParam: /^UGRD$/, vParam: /^VGRD$/, level: /^10 m above ground$/ },
  },
];

const setStatus = (text: string, error = false): void => {
  const el = document.getElementById('status')!;
  el.textContent = text;
  el.classList.toggle('err', error);
};

function recentCycles(count = 6): string[] {
  // HRRR cycles every hour on the hour, ~90 min latency. Walk back from "now
  // minus 3 h" to be safe.
  const now = new Date(Date.now() - 3 * 3600 * 1000);
  const cycles: string[] = [];
  for (let i = 0; i < count; i++) {
    const d = new Date(now.getTime() - i * 3600 * 1000);
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, '0');
    const day = String(d.getUTCDate()).padStart(2, '0');
    const h = String(d.getUTCHours()).padStart(2, '0');
    cycles.push(`${y}${m}${day}${h}`);
  }
  return cycles;
}

function populate<T>(select: HTMLSelectElement, items: T[], getValue: (t: T) => string, getLabel: (t: T) => string): void {
  select.innerHTML = '';
  for (const it of items) {
    const opt = document.createElement('option');
    opt.value = getValue(it);
    opt.textContent = getLabel(it);
    select.appendChild(opt);
  }
}

async function main(): Promise<void> {
  const fieldSel = document.getElementById('field') as HTMLSelectElement;
  const cycleSel = document.getElementById('cycle') as HTMLSelectElement;
  const fhourSel = document.getElementById('fhour') as HTMLSelectElement;
  const loadBtn = document.getElementById('load') as HTMLButtonElement;
  const toggleScalarEl = document.getElementById('toggle-scalar') as HTMLInputElement;
  const toggleWindEl = document.getElementById('toggle-wind') as HTMLInputElement;
  const removeScalarBtn = document.getElementById('remove-scalar') as HTMLButtonElement;
  const removeWindBtn = document.getElementById('remove-wind') as HTMLButtonElement;

  populate(fieldSel, PRESETS, (p) => p.key, (p) => p.label);
  populate(cycleSel, recentCycles(), (c) => c, (c) => `${c.slice(0, 4)}-${c.slice(4, 6)}-${c.slice(6, 8)} ${c.slice(8, 10)}Z`);

  // HRRR publishes every forecast hour up to the cycle's maximum. Standard
  // cycles run to f18; the "extended" 00z/06z/12z/18z cycles run to f48.
  // https://rapidrefresh.noaa.gov/hrrr/
  const maxForecastHourForCycle = (cycleStr: string): number => {
    const hh = Number(cycleStr.slice(8, 10));
    return hh % 6 === 0 ? 48 : 18;
  };
  const rangeInclusive = (lo: number, hi: number): number[] => {
    const out: number[] = [];
    for (let i = lo; i <= hi; i++) out.push(i);
    return out;
  };
  const syncFhourOptions = (): void => {
    const max = maxForecastHourForCycle(cycleSel.value);
    const prev = Number(fhourSel.value);
    populate(fhourSel, rangeInclusive(0, max), (n) => String(n), (n) => `f${String(n).padStart(2, '0')}`);
    // Preserve the previous selection if it's still valid, otherwise clamp.
    fhourSel.value = String(prev >= 0 && prev <= max ? prev : Math.min(prev, max));
  };
  syncFhourOptions();
  cycleSel.addEventListener('change', syncFhourOptions);

  const map = new maplibregl.Map({
    container: 'map',
    // OpenFreeMap dark — free, no key, no rate limits, community-funded.
    // Published under OSM/OpenMapTiles licensing; attribution is pulled
    // automatically from the style JSON into MapLibre's attribution control.
    style: 'https://tiles.openfreemap.org/styles/dark',
    center: [-96, 38],
    zoom: 3.5,
    minZoom: 2,
    maxZoom: 10,
    hash: true,
  });

  // OpenFreeMap is community-funded; log fetch/tile failures rather than
  // crash the page. Custom data layers keep rendering even if individual
  // basemap tiles fail to load.
  map.on('error', (e) => {
    // eslint-disable-next-line no-console
    console.warn('MapLibre error:', e.error ?? e);
  });

  // Track the label of the currently-loaded scalar preset so the click popup
  // can show the right heading/formatter even after a different field gets
  // loaded later.
  let currentScalarPreset: FieldPreset | null = null;

  // Layers are created once; addLayer/removeLayer from the map as toggled.
  // Keeping them around across remove/re-add preserves their texture uploads
  // and particle state, so we don't re-download GRIB2 after removing.
  const scalarLayer = new ScalarFieldLayer({ id: 'hrrr-scalar', colormap: 'turbo', opacity: 0.85 });
  const windLayer = new WindParticleLayer({ id: 'hrrr-wind', particleCount: 65536, colormap: 'turbo', opacity: 0.9 });

  const client = new DecodeClient();

  await new Promise<void>((r) => map.once('load', () => r()));

  // Find a stable insertion point in the vector style so custom data layers
  // render over land/water fills but UNDER roads, boundaries, labels, and our
  // coastline stroke. Preference order follows OpenMapTiles schema source
  // layers: transportation (roads) → boundary → place labels. If none match
  // (e.g. a barebones style), `undefined` falls back to appending on top —
  // not ideal visually but non-fatal.
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
  map.addLayer(windLayer, beforeId);

  // Explicit coastline stroke — OpenMapTiles has no dedicated coastline
  // source layer; the water polygon edge IS the coastline. Adding a thin
  // line layer reading the same `water` source-layer gives us a crisp
  // reference stroke drawn ON TOP of the data layers but below roads.
  // Added AFTER the custom layers with the same beforeId so it stacks
  // between them and `firstRoad`.
  map.addLayer(
    {
      id: 'ofm-coastline',
      type: 'line',
      source: 'openmaptiles',
      'source-layer': 'water',
      paint: {
        'line-color': '#5c6b7f',
        'line-width': 0.8,
        'line-opacity': 0.9,
      },
    },
    beforeId,
  );

  // Dim the basemap road network so it acts as subtle geographic context
  // rather than competing with the weather data. OpenFreeMap's dark style
  // draws roads at full opacity by default; we walk every layer backed by
  // the `transportation` (or `transportation_name`) source-layer and
  // override its opacity. Line layers get a very low `line-opacity`; road
  // label symbols get a slightly higher `text-opacity` so major highway
  // shields remain legible for orientation.
  const dimTransportationLayers = (): void => {
    const layers = map.getStyle().layers ?? [];
    for (const layer of layers) {
      const sl = (layer as { 'source-layer'?: string })['source-layer'];
      if (!sl || !sl.startsWith('transportation')) continue;
      if (layer.type === 'line') {
        map.setPaintProperty(layer.id, 'line-opacity', 0.22);
      } else if (layer.type === 'symbol') {
        try { map.setPaintProperty(layer.id, 'text-opacity', 0.45); } catch { /* some styles lack text */ }
        try { map.setPaintProperty(layer.id, 'icon-opacity', 0.45); } catch { /* some styles lack icons */ }
      }
    }
  };
  dimTransportationLayers();

  // ---- layer visibility toggles -------------------------------------------

  const hasLayer = (id: string): boolean => Boolean(map.getLayer(id));

  const syncToggle = (el: HTMLInputElement, layerId: string, layer: ScalarFieldLayer | WindParticleLayer): void => {
    el.addEventListener('change', () => {
      if (el.checked) {
        // Re-add with the same beforeId we used initially so z-order is
        // preserved across toggle cycles.
        if (!hasLayer(layerId)) map.addLayer(layer, beforeId);
        layer.setVisible(true);
      } else {
        layer.setVisible(false);
      }
      map.triggerRepaint();
    });
  };
  syncToggle(toggleScalarEl, 'hrrr-scalar', scalarLayer);
  syncToggle(toggleWindEl, 'hrrr-wind', windLayer);

  const wireRemove = (btn: HTMLButtonElement, el: HTMLInputElement, layerId: string): void => {
    btn.addEventListener('click', () => {
      if (hasLayer(layerId)) map.removeLayer(layerId);
      el.checked = false;
      el.disabled = true;
      btn.disabled = true;
      btn.textContent = 'removed';
    });
  };
  wireRemove(removeScalarBtn, toggleScalarEl, 'hrrr-scalar');
  wireRemove(removeWindBtn, toggleWindEl, 'hrrr-wind');

  // ---- click-to-inspect ---------------------------------------------------

  // One shared popup we re-home on each click.
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

    // Scalar field readout
    if (hasLayer('hrrr-scalar') && scalarLayer.isVisible()) {
      const s = scalarLayer.sampleAt(lng, lat);
      if (s && !Number.isNaN(s.value)) {
        const label = currentScalarPreset?.label ?? 'Scalar';
        const formatted = currentScalarPreset?.scalar?.format(s.value) ?? s.value.toFixed(3);
        rows.push(`<div class="inspect-title">${escapeHtml(label)}</div>`);
        rows.push(`<div class="inspect-row"><span class="k">value</span><span>${escapeHtml(formatted)}</span></div>`);
        rows.push(`<div class="inspect-row"><span class="k">grid i,j</span><span>${s.i}, ${s.j}</span></div>`);
        if (s.missing > 0) rows.push(`<div class="inspect-row"><span class="k">note</span><span>${s.missing}/4 corners missing</span></div>`);
      }
    }

    // Wind readout
    if (hasLayer('hrrr-wind') && windLayer.isVisible()) {
      const w = windLayer.sampleAt(lng, lat);
      if (w && Number.isFinite(w.speed)) {
        if (rows.length) rows.push('<div style="height:4px"></div>');
        rows.push('<div class="inspect-title">10 m Wind</div>');
        rows.push(`<div class="inspect-row"><span class="k">speed</span><span>${w.speed.toFixed(1)} m/s  (${(w.speed * 2.237).toFixed(1)} mph)</span></div>`);
        rows.push(`<div class="inspect-row"><span class="k">from</span><span>${compassFromBearing(w.directionDeg)} (${w.directionDeg.toFixed(0)}°)</span></div>`);
        rows.push(`<div class="inspect-row"><span class="k">u / v</span><span>${w.u.toFixed(1)} / ${w.v.toFixed(1)}</span></div>`);
      }
    }

    rows.push(`<div style="margin-top:6px"><div class="inspect-row"><span class="k">lon, lat</span><span>${lng.toFixed(3)}, ${lat.toFixed(3)}</span></div></div>`);

    if (rows.length === 1) rows.unshift('<div class="inspect-title" style="color:#8b949e">no data at this point</div>');
    showPopup(ev.lngLat, rows.join(''));
  });

  // ---- load a field -------------------------------------------------------

  async function load(): Promise<void> {
    const preset = PRESETS.find((p) => p.key === fieldSel.value)!;
    const cycle = cycleSel.value;
    const fhour = Number(fhourSel.value);
    const urls = hrrrUrls(cycle, fhour);
    setStatus(`fetching ${preset.label}…`);

    try {
      if (preset.kind === 'scalar' && preset.scalar) {
        const { field, grid } = await client.decode(urls.idx, {
          parameter: preset.scalar.param,
          level: preset.scalar.level,
          forecast: fhour === 0 ? /^anl$/ : new RegExp(`^${fhour} hour fcst$`),
        });
        if (!hasLayer('hrrr-scalar')) map.addLayer(scalarLayer, beforeId);
        toggleScalarEl.checked = true;
        toggleScalarEl.disabled = false;
        removeScalarBtn.disabled = false;
        removeScalarBtn.textContent = 'remove';
        scalarLayer.setVisible(true);
        scalarLayer.setData({ ...field, missingValue: NaN }, grid);
        if (preset.scalar.colormap) scalarLayer.setColormap(preset.scalar.colormap);
        currentScalarPreset = preset;
        setStatus(`${preset.label}\nmin ${field.min.toFixed(2)}  max ${field.max.toFixed(2)}`);
      } else if (preset.kind === 'wind' && preset.wind) {
        const fcRe = fhour === 0 ? /^anl$/ : new RegExp(`^${fhour} hour fcst$`);
        const { u, v, grid } = await client.decodePair(
          urls.idx,
          { parameter: preset.wind.uParam, level: preset.wind.level, forecast: fcRe },
          { parameter: preset.wind.vParam, level: preset.wind.level, forecast: fcRe },
        );
        if (!hasLayer('hrrr-wind')) map.addLayer(windLayer, beforeId);
        toggleWindEl.checked = true;
        toggleWindEl.disabled = false;
        removeWindBtn.disabled = false;
        removeWindBtn.textContent = 'remove';
        windLayer.setVisible(true);
        windLayer.setWind({ ...u, missingValue: NaN }, { ...v, missingValue: NaN }, grid);
        setStatus(`${preset.label} loaded (${u.nx}×${u.ny})`);
      }
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err), true);
    }
  }

  loadBtn.addEventListener('click', () => { void load(); });
  // Auto-load a default view so first paint isn't empty.
  void load();
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

function compassFromBearing(deg: number): string {
  const dirs = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
  return dirs[Math.round(((deg % 360) / 22.5)) % 16]!;
}

void main();
