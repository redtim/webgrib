/**
 * NOAA Tides & Currents station layers. Manages three toggleable overlay
 * layers showing water level stations, tide prediction stations, and current
 * prediction stations as clustered circle markers on the MapLibre map.
 *
 * Station metadata is fetched from the NOAA CO-OPS Metadata API and cached.
 * Per-station detail data is fetched on click from the CO-OPS Data API.
 */

import maplibregl from 'maplibre-gl';
import type { Map as MlMap, MapMouseEvent, GeoJSONSource } from 'maplibre-gl';
import { generatePrediction, generateCurrentPrediction,
  fetchHarmonics, fetchDatum, fetchCurrentHarmonics, getCurrentAzimuth,
  fetchCurrentSubordinateOffsets, fetchSubordinateOffsets,
  promptCacheConsent,
} from '../tides/noaa.js';
import { computeAstro, predictTideHeightWithAstro, predictCurrentVelocityWithAstro } from '../tides/predict.js';
import type { StationHarmonic, StationDatum, CurrentHarmonic, AstroParams } from '../tides/predict.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type TideLayerType = 'waterlevels' | 'tidepredictions' | 'currentpredictions';

interface CachedData {
  data: unknown;
  fetchedAt: number;
}

interface LayerConfig {
  label: string;
  badge: string;
  color: string;
  badgeBg: string;
  metaParam: string; // query param for the metadata endpoint
  product: string;   // product param for the data endpoint
}

const LAYER_CONFIGS: Record<TideLayerType, LayerConfig> = {
  waterlevels: {
    label: 'Water Levels',
    badge: 'W',
    color: '#58a6ff',
    badgeBg: '#1f2d3d',
    metaParam: 'waterlevels',
    product: 'water_level',
  },
  tidepredictions: {
    label: 'Tide Predictions',
    badge: 'T',
    color: '#7ee787',
    badgeBg: '#1f3d2e',
    metaParam: 'tidepredictions',
    product: 'predictions',
  },
  currentpredictions: {
    label: 'Current Predictions',
    badge: 'C',
    color: '#d2a8ff',
    badgeBg: '#2d1f3d',
    metaParam: 'currentpredictions',
    product: 'currents_predictions',
  },
};

const LAYER_TYPES: TideLayerType[] = ['waterlevels', 'tidepredictions', 'currentpredictions'];

const META_BASE = 'https://api.tidesandcurrents.noaa.gov/mdapi/prod/webapi/stations.json';
const DATA_BASE = 'https://api.tidesandcurrents.noaa.gov/api/prod/datagetter';
const DATA_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

// ---------------------------------------------------------------------------
// TideStationManager
// ---------------------------------------------------------------------------

export class TideStationManager {
  private map: MlMap | null = null;
  private stationCache = new Map<TideLayerType, GeoJSON.FeatureCollection>();
  private dataCache = new Map<string, CachedData>();
  private enabledLayers = new Set<TideLayerType>();
  private countEls = new Map<TideLayerType, HTMLElement>();

  // Forecast time state
  private forecastDate: Date = new Date();
  // Per-station harmonic caches (keyed by station ID)
  private tideHarmonics = new Map<string, { harmonics: StationHarmonic[]; datum: StationDatum }>();
  private currentHarmonics = new Map<string, { harmonics: CurrentHarmonic[]; floodDir: number; ebbDir: number }>();
  // Water level observation cache: station ID → { observed, predicted, time, fetchedAt }
  private waterLevelCache = new Map<string, { observed: number; predicted: number; time: string; fetchedAt: number }>();
  private fetching = new Set<string>(); // stations currently being fetched
  // Active popup state — so we can re-render when forecast time changes
  private activePopup: {
    type: TideLayerType;
    stationId: string;
    stationType: string;
    popupId: string;
    color: string;
    series: Array<{ t: number; v: number }>;
    floodDir?: number;
    ebbDir?: number;
  } | null = null;
  // DOM markers for water level / tide labels (keyed by station ID)
  private domMarkers = new Map<string, maplibregl.Marker>();
  // Popup callback — set by handleClick, reused by DOM marker clicks
  private showPopupFn: ((lngLat: { lng: number; lat: number }, html: string) => void) | null = null;

  attach(map: MlMap): void {
    this.map = map;
    map.on('moveend', () => {
      void this.fetchVisibleHarmonics();
      this.declutterMarkers();
    });
    map.on('zoom', () => { this.declutterMarkers(); });
  }

  /** Set the popup callback used by DOM marker clicks. Call after attach. */
  setPopupCallback(fn: (lngLat: { lng: number; lat: number }, html: string) => void): void {
    this.showPopupFn = fn;
  }

  // ---------------------------------------------------------------------- UI

  createToggles(container: HTMLElement): void {
    const wrap = document.createElement('div');
    wrap.style.cssText = 'margin-top:8px;border-top:1px solid #30363d;padding-top:6px;';

    const title = document.createElement('div');
    title.style.cssText = 'color:#8b949e;font-size:10px;font-weight:bold;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:4px;';
    title.textContent = 'Tides & Currents';
    wrap.appendChild(title);

    for (const type of LAYER_TYPES) {
      const cfg = LAYER_CONFIGS[type];
      const row = document.createElement('div');
      row.innerHTML = `
        <label style="display:flex;align-items:center;gap:6px;cursor:pointer;padding:3px 6px;font-size:11px;">
          <input type="checkbox" data-tide-type="${type}" style="margin:0" />
          <span class="layer-kind" style="background:${cfg.badgeBg};color:${cfg.color};width:16px;height:16px;border-radius:3px;display:inline-flex;align-items:center;justify-content:center;font-size:9px;font-weight:bold;flex-shrink:0">${cfg.badge}</span>
          <span>${cfg.label} <span class="tide-count" style="color:#8b949e;font-size:10px"></span></span>
        </label>`;
      const checkbox = row.querySelector('input') as HTMLInputElement;
      const countEl = row.querySelector('.tide-count') as HTMLElement;
      this.countEls.set(type, countEl);

      checkbox.addEventListener('change', () => {
        void this.setLayerVisible(type, checkbox.checked);
      });
      wrap.appendChild(row);
    }

    container.appendChild(wrap);
  }

  // ----------------------------------------------------------- layer control

  async setLayerVisible(type: TideLayerType, visible: boolean): Promise<void> {
    if (!this.map) return;

    if (visible) {
      this.enabledLayers.add(type);
      if (type === 'tidepredictions' || type === 'currentpredictions') {
        promptCacheConsent();
      }
      try {
        await this.ensureMetadata(type);
        this.addMapLayers(type);
        void this.fetchVisibleHarmonics();
      } catch (err) {
        console.error(`Failed to load ${type} stations:`, err);
        this.enabledLayers.delete(type);
      }
    } else {
      this.enabledLayers.delete(type);
      this.removeMapLayers(type);
    }
  }

  private async ensureMetadata(type: TideLayerType): Promise<void> {
    if (this.stationCache.has(type)) return;

    const url = `${META_BASE}?type=${LAYER_CONFIGS[type].metaParam}`;
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`HTTP ${resp.status} fetching ${type} metadata`);
    const json = await resp.json();

    const features: GeoJSON.Feature[] = [];
    for (const s of json.stations ?? []) {
      const lat = parseFloat(s.lat);
      const lng = parseFloat(s.lng);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
      features.push({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [lng, lat] },
        properties: {
          id: s.id,
          name: s.name,
          state: s.state ?? '',
          layerType: type,
          stationType: s.type ?? 'R', // R=reference, S=subordinate
        },
      });
    }

    const fc: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features };
    this.stationCache.set(type, fc);

    const countEl = this.countEls.get(type);
    if (countEl) countEl.textContent = `(${features.length})`;
  }

  // ---------------------------------------------------------- MapLibre layers

  private sourceId(type: TideLayerType): string { return `noaa-${type}`; }
  private clusterLayerId(type: TideLayerType): string { return `noaa-${type}-clusters`; }
  private clusterCountLayerId(type: TideLayerType): string { return `noaa-${type}-cluster-count`; }
  private pointLayerId(type: TideLayerType): string { return `noaa-${type}-points`; }

  private addMapLayers(type: TideLayerType): void {
    const map = this.map!;
    const sid = this.sourceId(type);

    if (map.getSource(sid)) return; // already added

    const cfg = LAYER_CONFIGS[type];
    const fc = this.stationCache.get(type)!;

    // All types use DOM markers — no clustering needed
    map.addSource(sid, {
      type: 'geojson',
      data: fc,
      cluster: false,
    });

    // Circle dots — only shown for stations without data yet
    map.addLayer({
      id: this.pointLayerId(type),
      type: 'circle',
      source: sid,
      filter: ['!', ['get', 'hasData']],
      paint: {
        'circle-color': cfg.color,
        'circle-radius': 4,
        'circle-stroke-width': 1,
        'circle-stroke-color': '#ffffff',
        'circle-opacity': 0.85,
      },
    });
  }

  /** Create the current arrow SDF icon if not already added to the map. */
  private ensureArrowIcon(map: MlMap): void {
    if (map.hasImage('current-arrow')) return;
    const size = 24;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d')!;
    // Simple upward-pointing triangle arrow
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.moveTo(size / 2, 2);
    ctx.lineTo(size - 4, size - 4);
    ctx.lineTo(size / 2, size - 8);
    ctx.lineTo(4, size - 4);
    ctx.closePath();
    ctx.fill();
    const imgData = ctx.getImageData(0, 0, size, size);
    map.addImage('current-arrow', { width: size, height: size, data: new Uint8Array(imgData.data.buffer) }, { sdf: true });
  }



  private removeMapLayers(type: TideLayerType): void {
    const map = this.map!;
    const sid = this.sourceId(type);
    const ids = [
      this.clusterLayerId(type), this.clusterCountLayerId(type),
      this.pointLayerId(type), `${sid}-labels`, `${sid}-arrows`,
    ];
    for (const id of ids) {
      if (map.getLayer(id)) map.removeLayer(id);
    }
    if (map.getSource(sid)) map.removeSource(sid);
    this.clearDomMarkers(type);
  }

  /** Remove all DOM markers for a layer type. */
  private clearDomMarkers(type: TideLayerType): void {
    const prefix = `${type}:`;
    for (const [key, marker] of this.domMarkers) {
      if (key.startsWith(prefix)) {
        marker.remove();
        this.domMarkers.delete(key);
      }
    }
  }

  // --------------------------------------------------- forecast predictions

  /**
   * Set the forecast time and recompute predictions for all visible stations.
   * Called by the timeline onChange callback.
   */
  setForecastTime(date: Date): void {
    this.forecastDate = date;
    this.updateAllPredictions();
    this.refreshActivePopup();
  }

  /**
   * Fetch harmonic data for visible stations that haven't been fetched yet.
   * Each layer type is processed independently so slow types don't block others.
   */
  private async fetchVisibleHarmonics(): Promise<void> {
    const map = this.map;
    if (!map) return;

    // Launch each type independently — water levels won't wait behind tides
    const tasks: Promise<void>[] = [];
    for (const type of this.enabledLayers) {
      tasks.push(this.fetchVisibleForType(type));
    }
    await Promise.allSettled(tasks);
  }

  private async fetchVisibleForType(type: TideLayerType): Promise<void> {
    const map = this.map;
    if (!map) return;

    const fc = this.stationCache.get(type);
    if (!fc) return;

    const toFetch: Array<{ id: string; stationType: string }> = [];
    const bounds = map.getBounds();

    // All types use DOM markers — iterate FeatureCollection directly
    for (const feat of fc.features) {
      const coords = (feat.geometry as GeoJSON.Point).coordinates;
      if (!bounds.contains([coords[0]!, coords[1]!] as [number, number])) continue;
      const props = feat.properties as { id: string; stationType: string };
      const id = props.id;
      if (!id) continue;

      if (type === 'waterlevels') {
        const cached = this.waterLevelCache.get(id);
        if (cached && Date.now() - cached.fetchedAt < 6 * 60 * 1000) continue;
        if (this.fetching.has(`wl:${id}`)) continue;
      } else if (type === 'tidepredictions') {
        if (this.tideHarmonics.has(id) || this.fetching.has(`tide:${id}`)) continue;
      } else if (type === 'currentpredictions') {
        if ((props.stationType ?? '') === 'W') continue;
        if (this.currentHarmonics.has(id) || this.fetching.has(`cur:${id}`)) continue;
      }
      toFetch.push({ id, stationType: props.stationType ?? 'R' });
    }

    if (toFetch.length === 0) return;

    const CONCURRENCY = 15;
    for (let i = 0; i < toFetch.length; i += CONCURRENCY) {
      const batch = toFetch.slice(i, i + CONCURRENCY);
      await Promise.allSettled(batch.map((s) => this.fetchStationHarmonics(s.id, type, s.stationType)));
      // Update predictions after each batch so markers appear progressively
      this.updateAllPredictions();
    }
  }

  private async fetchStationHarmonics(id: string, type: TideLayerType, stationType: string): Promise<void> {
    if (type === 'waterlevels') {
      const key = `wl:${id}`;
      if (this.fetching.has(key)) return;
      this.fetching.add(key);
      try {
        // Fetch observed and predicted in parallel
        const base = 'https://api.tidesandcurrents.noaa.gov/api/prod/datagetter';
        const common = `station=${id}&datum=MLLW&time_zone=gmt&units=english&format=json&date=latest`;
        const [obsResp, predResp] = await Promise.all([
          fetch(`${base}?${common}&product=water_level`),
          fetch(`${base}?${common}&product=predictions`),
        ]);
        let observed = NaN, predicted = NaN, time = '';
        if (obsResp.ok) {
          const obsData = await obsResp.json();
          const latest = obsData?.data?.[0];
          if (latest?.v) { observed = parseFloat(latest.v); time = latest.t; }
        }
        if (predResp.ok) {
          const predData = await predResp.json();
          // Find the prediction closest to the observation time
          const preds = predData?.predictions ?? [];
          if (preds.length > 0) {
            // Last prediction is closest to "latest"
            predicted = parseFloat(preds[preds.length - 1].v);
          }
        }
        if (Number.isFinite(observed)) {
          this.waterLevelCache.set(id, {
            observed,
            predicted: Number.isFinite(predicted) ? predicted : observed,
            time,
            fetchedAt: Date.now(),
          });
        }
      } catch { /* ignore */ }
      this.fetching.delete(key);
      return;
    }

    if (type === 'tidepredictions') {
      const key = `tide:${id}`;
      if (this.fetching.has(key)) return;
      this.fetching.add(key);
      try {
        if (stationType === 'R') {
          const [harmonics, datum] = await Promise.all([fetchHarmonics(id), fetchDatum(id)]);
          if (harmonics.length > 0) this.tideHarmonics.set(id, { harmonics, datum });
        } else {
          // Subordinate: fetch offsets + reference station harmonics
          const offsets = await fetchSubordinateOffsets(id);
          if (offsets) {
            const [refH, refD] = await Promise.all([
              fetchHarmonics(offsets.refStationId),
              fetchDatum(offsets.refStationId),
            ]);
            if (refH.length > 0) {
              // Approximate: use reference harmonics with averaged offset
              const avgRatio = (offsets.heightOffsetHighTide + offsets.heightOffsetLowTide) / 2;
              const adjusted: StationHarmonic[] = offsets.heightAdjustedType === 'R'
                ? refH.map((h) => ({ ...h, amplitude: h.amplitude * avgRatio }))
                : refH.map((h) => ({ ...h, amplitude: h.amplitude }));
              const datumAdj: StationDatum = offsets.heightAdjustedType === 'A'
                ? { msl: refD.msl + (offsets.heightOffsetHighTide + offsets.heightOffsetLowTide) / 2 }
                : { msl: refD.msl * avgRatio };
              this.tideHarmonics.set(id, { harmonics: adjusted, datum: datumAdj });
            }
          }
        }
      } catch { /* ignore failed fetches */ }
      this.fetching.delete(key);
    } else if (type === 'currentpredictions') {
      const key = `cur:${id}`;
      if (this.fetching.has(key)) return;
      this.fetching.add(key);
      try {
        if (stationType === 'H') {
          const harmonics = await fetchCurrentHarmonics(id);
          const azi = getCurrentAzimuth(id) ?? { floodDir: 0, ebbDir: 180 };
          if (harmonics.length > 0) this.currentHarmonics.set(id, { harmonics, ...azi });
        } else if (stationType === 'S') {
          const offsets = await fetchCurrentSubordinateOffsets(id);
          if (offsets) {
            const refH = await fetchCurrentHarmonics(offsets.refStationId, offsets.refStationBin);
            if (refH.length > 0) {
              const avgAdj = (offsets.mfcAmpAdj + offsets.mecAmpAdj) / 2;
              const adjusted = refH.map((h) => ({ ...h, majorAmplitude: h.majorAmplitude * avgAdj }));
              this.currentHarmonics.set(id, {
                harmonics: adjusted,
                floodDir: offsets.meanFloodDir,
                ebbDir: offsets.meanEbbDir,
              });
            }
          }
        }
      } catch { /* ignore */ }
      this.fetching.delete(key);
    }
  }

  /** Recompute prediction values and update GeoJSON properties for all active layers. */
  private updateAllPredictions(): void {
    const map = this.map;
    if (!map) return;
    const astro = computeAstro(this.forecastDate);

    for (const type of this.enabledLayers) {
      const fc = this.stationCache.get(type);
      if (!fc) continue;

      // Update feature properties with predicted values
      for (const feat of fc.features) {
        const props = feat.properties as Record<string, unknown>;
        const id = props['id'] as string;

        if (type === 'waterlevels') {
          const cached = this.waterLevelCache.get(id);
          if (cached) {
            props['wlObserved'] = cached.observed;
            props['wlAnomaly'] = +(cached.observed - cached.predicted).toFixed(2);
            props['hasData'] = true;
          } else {
            props['hasData'] = false;
          }
        } else if (type === 'tidepredictions') {
          const cached = this.tideHarmonics.get(id);
          if (cached) {
            props['tideHeight'] = predictTideHeightWithAstro(astro, cached.harmonics, cached.datum);
            props['hasData'] = true;
          } else {
            props['hasData'] = false;
          }
        } else if (type === 'currentpredictions') {
          const cached = this.currentHarmonics.get(id);
          if (cached) {
            const velocity = predictCurrentVelocityWithAstro(astro, cached.harmonics);
            props['currentSpeed'] = Math.abs(velocity);
            props['currentDir'] = velocity >= 0 ? cached.floodDir : cached.ebbDir;
            props['hasData'] = true;
          } else {
            props['hasData'] = false;
          }
        }
      }

      // Push updated data to MapLibre source
      const sid = this.sourceId(type);
      const source = map.getSource(sid) as GeoJSONSource | undefined;
      if (source) source.setData(fc);

      // Update DOM markers for all station types
      this.updateDomMarkers(type, fc);
    }
  }

  /** Create or update DOM markers with rich HTML labels. */
  private updateDomMarkers(type: TideLayerType, fc: GeoJSON.FeatureCollection): void {
    const map = this.map;
    if (!map) return;
    const cfg = LAYER_CONFIGS[type];

    for (const feat of fc.features) {
      const props = feat.properties as Record<string, unknown>;
      if (!props['hasData']) continue;

      const id = props['id'] as string;
      const coords = (feat.geometry as GeoJSON.Point).coordinates;
      const key = `${type}:${id}`;

      let html: string;
      let markerClass = 'station-marker';
      if (type === 'waterlevels') {
        const observed = props['wlObserved'] as number;
        const anomaly = props['wlAnomaly'] as number;
        const anomalyColor = anomaly >= 0 ? '#7ee787' : '#ff7b72';
        const anomalySign = anomaly >= 0 ? '+' : '';
        html = `<span class="station-badge" style="color:${cfg.color}">W</span>`
          + `<span class="station-val">${observed.toFixed(1)}</span>`
          + `<span class="station-anom" style="color:${anomalyColor}">${anomalySign}${anomaly.toFixed(1)}</span>`;
      } else if (type === 'currentpredictions') {
        const speed = props['currentSpeed'] as number;
        const dir = props['currentDir'] as number;
        const speedColor = speed < 0.3 ? '#8b949e' : speed < 1 ? '#79c0ff' : speed < 2 ? '#7ee787' : speed < 3 ? '#f0c040' : '#ff7b72';
        html = `<span class="station-badge" style="color:${cfg.color}">C</span>`
          + `<span class="station-arrow" style="color:${speedColor};transform:rotate(${dir}deg)">&#x2191;</span>`
          + `<span class="station-val" style="color:${speedColor}">${speed.toFixed(1)}</span>`;
        markerClass = 'station-marker station-marker-current';
      } else {
        const height = props['tideHeight'] as number;
        const valColor = height >= 0 ? '#7ee787' : '#ff7b72';
        html = `<span class="station-badge" style="color:${cfg.color}">T</span>`
          + `<span class="station-val" style="color:${valColor}">${height.toFixed(1)}</span>`;
      }

      const existing = this.domMarkers.get(key);
      if (existing) {
        existing.getElement().innerHTML = html;
      } else {
        const el = document.createElement('div');
        el.className = markerClass;
        el.innerHTML = html;
        el.addEventListener('click', (e) => {
          e.stopPropagation();
          this.showStationPopup(type, id, props as Record<string, unknown>, coords[0]!, coords[1]!);
        });
        const marker = new maplibregl.Marker({ element: el, anchor: 'left' })
          .setLngLat([coords[0]!, coords[1]!])
          .addTo(map);
        this.domMarkers.set(key, marker);
      }
    }

    this.declutterMarkers();
  }

  /**
   * Hide DOM markers that overlap with each other. Projects each marker
   * to screen coordinates and uses a simple greedy collision pass —
   * first marker in wins, any that overlap it are hidden.
   */
  private declutterMarkers(): void {
    const map = this.map;
    if (!map) return;

    // Collect all markers with their screen positions
    const items: Array<{ key: string; marker: maplibregl.Marker; x: number; y: number; w: number; h: number }> = [];
    const bounds = map.getBounds();

    for (const [key, marker] of this.domMarkers) {
      const lngLat = marker.getLngLat();
      // Skip markers outside viewport
      if (!bounds.contains(lngLat)) {
        marker.getElement().style.display = 'none';
        continue;
      }
      const pt = map.project(lngLat);
      // Estimate width based on type (waterlevels has anomaly text, wider)
      const isWl = key.startsWith('waterlevels:');
      const w = isWl ? 95 : 50;
      const h = 20;
      items.push({ key, marker, x: pt.x, y: pt.y, w, h });
    }

    // Greedy collision detection — earlier items win
    const occupied: Array<{ x: number; y: number; w: number; h: number }> = [];
    const PAD = 4; // pixels of padding between markers

    for (const item of items) {
      const ax = item.x;
      const ay = item.y - item.h / 2;
      const aw = item.w + PAD;
      const ah = item.h + PAD;

      let collides = false;
      for (const box of occupied) {
        if (ax < box.x + box.w && ax + aw > box.x &&
            ay < box.y + box.h && ay + ah > box.y) {
          collides = true;
          break;
        }
      }

      if (collides) {
        item.marker.getElement().style.display = 'none';
      } else {
        item.marker.getElement().style.display = '';
        occupied.push({ x: ax, y: ay, w: aw, h: ah });
      }
    }
  }

  // ---------------------------------------------------------- click handling

  /** Returns list of active point layer IDs for queryRenderedFeatures. */
  getActivePointLayerIds(): string[] {
    return [...this.enabledLayers].map((t) => this.pointLayerId(t));
  }

  /** Determine which layer type a point layer ID belongs to. */
  layerTypeFromLayerId(layerId: string): TideLayerType | null {
    for (const t of LAYER_TYPES) {
      if (this.pointLayerId(t) === layerId) return t;
    }
    return null;
  }

  /**
   * Handle a map click event. If a station was clicked, shows a popup and
   * returns true. Otherwise returns false so the caller can proceed with
   * its default click behavior.
   */
  handleClick(
    ev: MapMouseEvent,
    map: MlMap,
    showPopup: (lngLat: { lng: number; lat: number }, html: string) => void,
  ): boolean {
    this.showPopupFn = showPopup;
    this.activePopup = null;
    const layerIds = this.getActivePointLayerIds().filter((id) => map.getLayer(id));
    if (layerIds.length === 0) return false;

    const features = map.queryRenderedFeatures(ev.point, { layers: layerIds });
    if (features.length === 0) return false;

    const feat = features[0]!;
    const type = this.layerTypeFromLayerId(feat.layer.id);
    if (!type) return false;

    const props = feat.properties as { id: string; name: string; state: string; stationType: string };
    const cfg = LAYER_CONFIGS[type];

    // Build initial popup with loading state
    const popupId = `tide-popup-${Date.now()}`;
    const html = [
      `<div class="inspect-title" style="color:${cfg.color}">${escapeHtml(props.name)}${props.state ? `, ${escapeHtml(props.state)}` : ''}</div>`,
      `<div class="inspect-row"><span class="k">station</span><span>${escapeHtml(props.id)}</span></div>`,
      `<div class="inspect-row"><span class="k">type</span><span>${escapeHtml(cfg.label)}</span></div>`,
      `<div id="${popupId}" class="tide-loading">Loading data...</div>`,
      `<canvas id="${popupId}-canvas" class="tide-sparkline" width="240" height="70" style="display:none"></canvas>`,
      `<div style="margin-top:6px"><div class="inspect-row"><span class="k">lon, lat</span><span>${ev.lngLat.lng.toFixed(3)}, ${ev.lngLat.lat.toFixed(3)}</span></div></div>`,
    ].join('');

    showPopup(ev.lngLat, html);

    // Fetch and render detail data async
    void this.fetchAndRenderDetail(type, props.id, popupId, cfg.color, props.stationType);
    return true;
  }

  // ---------------------------------------------------------- data fetching

  private async fetchStationData(type: TideLayerType, stationId: string): Promise<unknown> {
    const cacheKey = `${type}:${stationId}`;
    const cached = this.dataCache.get(cacheKey);
    if (cached && Date.now() - cached.fetchedAt < DATA_CACHE_TTL) return cached.data;

    const cfg = LAYER_CONFIGS[type];
    const params = new URLSearchParams({
      station: stationId,
      product: cfg.product,
      datum: 'MLLW',
      time_zone: 'lst_ldt',
      units: 'english',
      format: 'json',
    });

    if (type === 'waterlevels') {
      params.set('date', 'latest');
      params.set('range', '24');
    } else {
      params.set('date', 'today');
      params.set('range', '48');
    }

    // Current predictions don't use datum
    if (type === 'currentpredictions') {
      params.delete('datum');
    }

    const resp = await fetch(`${DATA_BASE}?${params}`);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();

    this.dataCache.set(cacheKey, { data, fetchedAt: Date.now() });
    return data;
  }

  /** Show a popup for a station clicked via a DOM marker. */
  private showStationPopup(type: TideLayerType, stationId: string, props: Record<string, unknown>, lng: number, lat: number): void {
    if (!this.showPopupFn) return;
    this.activePopup = null;
    const cfg = LAYER_CONFIGS[type];
    const name = (props['name'] as string) ?? '';
    const state = (props['state'] as string) ?? '';
    const stationType = (props['stationType'] as string) ?? 'R';

    const popupId = `tide-popup-${Date.now()}`;
    const html = [
      `<div class="inspect-title" style="color:${cfg.color}">${escapeHtml(name)}${state ? `, ${escapeHtml(state)}` : ''}</div>`,
      `<div class="inspect-row"><span class="k">station</span><span>${escapeHtml(stationId)}</span></div>`,
      `<div class="inspect-row"><span class="k">type</span><span>${escapeHtml(cfg.label)}</span></div>`,
      `<div id="${popupId}" class="tide-loading">Loading data...</div>`,
      `<canvas id="${popupId}-canvas" class="tide-sparkline" width="240" height="70" style="display:none"></canvas>`,
      `<div style="margin-top:6px"><div class="inspect-row"><span class="k">lon, lat</span><span>${lng.toFixed(3)}, ${lat.toFixed(3)}</span></div></div>`,
    ].join('');

    this.showPopupFn({ lng, lat }, html);
    void this.fetchAndRenderDetail(type, stationId, popupId, cfg.color, stationType);
  }

  private async fetchAndRenderDetail(
    type: TideLayerType,
    stationId: string,
    popupId: string,
    color: string,
    stationType = 'R',
  ): Promise<void> {
    try {
      if (type === 'tidepredictions') {
        await this.renderLocalTidePrediction(stationId, stationType, popupId, color);
        return;
      }

      if (type === 'currentpredictions' && stationType !== 'W') {
        await this.renderLocalCurrentPrediction(stationId, stationType, popupId, color);
        return;
      }

      // Water levels (real-time) and W-type current stations fall through to NOAA API
      const data = await this.fetchStationData(type, stationId);
      const el = document.getElementById(popupId);
      if (!el) return;

      if (type === 'waterlevels') {
        this.renderWaterLevel(el, data as WaterLevelResponse, popupId, color);
      } else {
        this.renderCurrentPrediction(el, data as PredictionResponse, popupId, color);
      }
    } catch (err) {
      const el = document.getElementById(popupId);
      if (el) {
        el.className = '';
        el.innerHTML = `<div class="inspect-row" style="color:#ff7b72">Failed to load data</div>`;
      }
    }
  }

  // --------------------------------------------------------- render helpers

  private renderWaterLevel(el: HTMLElement, data: WaterLevelResponse, popupId: string, color: string): void {
    const points = (data.data ?? []).filter((d) => d.v !== '');
    if (points.length === 0) {
      el.className = '';
      el.innerHTML = '<div class="inspect-row" style="color:#8b949e">No recent data</div>';
      return;
    }

    const latest = points[points.length - 1]!;
    const level = parseFloat(latest.v);
    const time = latest.t;

    // Determine trend from last two points
    let trend = '';
    if (points.length >= 2) {
      const prev = parseFloat(points[points.length - 2]!.v);
      if (level > prev) trend = ' rising';
      else if (level < prev) trend = ' falling';
      else trend = ' steady';
    }

    el.className = '';
    el.innerHTML = [
      `<div class="inspect-row"><span class="k">level</span><span>${level.toFixed(2)} ft MLLW</span></div>`,
      `<div class="inspect-row"><span class="k">trend</span><span>${trendArrow(trend)}${trend}</span></div>`,
      `<div class="inspect-row"><span class="k">time</span><span>${escapeHtml(time)}</span></div>`,
    ].join('');

    // Draw sparkline
    if (points.length > 1) {
      const values = points.map((p) => parseFloat(p.v)).filter(Number.isFinite);
      const times = points.map((p) => new Date(p.t).getTime()).filter(Number.isFinite);
      this.drawSparkline(popupId, times, values, color);
    }
  }

  private async renderLocalTidePrediction(
    stationId: string,
    stationType: string,
    popupId: string,
    color: string,
  ): Promise<void> {
    const el = document.getElementById(popupId);
    if (!el) return;

    const now = Date.now();
    const start = new Date(now - 6 * 3600000);  // 6 hours ago
    const end = new Date(now + 42 * 3600000);    // 42 hours ahead

    const series = await generatePrediction(stationId, stationType, start, end, 6);
    if (!document.getElementById(popupId)) return;

    if (series.length === 0) {
      el.className = '';
      el.innerHTML = '<div class="inspect-row" style="color:#8b949e">No prediction data</div>';
      return;
    }

    // Store for live updates when forecast time changes
    this.activePopup = { type: 'tidepredictions', stationId, stationType, popupId, color, series };

    this.renderTidePopupContent(el, series, popupId, color, now);
  }

  private async renderLocalCurrentPrediction(
    stationId: string,
    stationType: string,
    popupId: string,
    color: string,
  ): Promise<void> {
    const el = document.getElementById(popupId);
    if (!el) return;

    const now = Date.now();
    const start = new Date(now - 6 * 3600000);
    const end = new Date(now + 42 * 3600000);

    const { series, floodDir, ebbDir } = await generateCurrentPrediction(
      stationId, stationType, start, end, 6,
    );
    if (!document.getElementById(popupId)) return;

    if (series.length === 0) {
      el.className = '';
      el.innerHTML = '<div class="inspect-row" style="color:#8b949e">No prediction data</div>';
      return;
    }

    // Store for live updates when forecast time changes
    this.activePopup = { type: 'currentpredictions', stationId, stationType, popupId, color, series, floodDir, ebbDir };

    this.renderCurrentPopupContent(el, series, popupId, color, now, floodDir, ebbDir);
  }

  /** Render tide popup text + sparkline (called on initial load and on forecast time change). */
  private renderTidePopupContent(
    el: HTMLElement,
    series: Array<{ t: number; v: number }>,
    popupId: string,
    color: string,
    nowMs: number,
  ): void {
    const mapped = series.map((p) => ({ t: p.t, v: p.v }));
    const currentLevel = interpolateAtTime(mapped, nowMs);
    const nextHigh = findNextExtreme(mapped, nowMs, 'high');
    const nextLow = findNextExtreme(mapped, nowMs, 'low');

    const rows: string[] = [];
    if (currentLevel !== null) {
      rows.push(`<div class="inspect-row"><span class="k">now (${formatTime(nowMs)})</span><span>${currentLevel.toFixed(2)} ft MLLW</span></div>`);
    }
    const fcMs = this.forecastDate.getTime();
    if (Math.abs(fcMs - nowMs) > 30 * 60000) {
      const fcLevel = interpolateAtTime(mapped, fcMs);
      if (fcLevel !== null) {
        rows.push(`<div class="inspect-row"><span class="k">@ ${formatTime(fcMs)}</span><span>${fcLevel.toFixed(2)} ft MLLW</span></div>`);
      }
    }
    if (nextHigh) rows.push(`<div class="inspect-row"><span class="k">next high</span><span>${nextHigh.v.toFixed(2)} ft @ ${formatTime(nextHigh.t)}</span></div>`);
    if (nextLow) rows.push(`<div class="inspect-row"><span class="k">next low</span><span>${nextLow.v.toFixed(2)} ft @ ${formatTime(nextLow.t)}</span></div>`);

    el.className = '';
    el.innerHTML = rows.join('');

    if (series.length > 1) {
      this.drawSparkline(popupId, series.map((p) => p.t), series.map((p) => p.v), color, nowMs, fcMs);
    }
  }

  /** Render current popup text + sparkline. */
  private renderCurrentPopupContent(
    el: HTMLElement,
    series: Array<{ t: number; v: number }>,
    popupId: string,
    color: string,
    nowMs: number,
    floodDir: number,
    ebbDir: number,
  ): void {
    const mapped = series.map((p) => ({ t: p.t, v: p.v }));
    const nowSpeed = interpolateAtTime(mapped, nowMs);
    const phase = nowSpeed !== null ? (nowSpeed > 0.05 ? 'flood' : nowSpeed < -0.05 ? 'ebb' : 'slack') : 'unknown';
    const currentDir = phase === 'flood' ? floodDir : phase === 'ebb' ? ebbDir : null;

    const rows: string[] = [];
    if (nowSpeed !== null) {
      rows.push(`<div class="inspect-row"><span class="k">now (${formatTime(nowMs)})</span><span>${Math.abs(nowSpeed).toFixed(2)} kt ${phase}</span></div>`);
    }
    if (currentDir !== null) {
      rows.push(`<div class="inspect-row"><span class="k">dir</span><span>${compassFromDeg(currentDir)} (${currentDir.toFixed(0)}\u00B0)</span></div>`);
    }
    const fcMs = this.forecastDate.getTime();
    if (Math.abs(fcMs - nowMs) > 30 * 60000) {
      const fcSpeed = interpolateAtTime(mapped, fcMs);
      if (fcSpeed !== null) {
        const fcPhase = fcSpeed > 0.05 ? 'flood' : fcSpeed < -0.05 ? 'ebb' : 'slack';
        const fcDir = fcPhase === 'flood' ? floodDir : fcPhase === 'ebb' ? ebbDir : null;
        let fcText = `${Math.abs(fcSpeed).toFixed(2)} kt ${fcPhase}`;
        if (fcDir !== null) fcText += ` ${compassFromDeg(fcDir)}`;
        rows.push(`<div class="inspect-row"><span class="k">@ ${formatTime(fcMs)}</span><span>${fcText}</span></div>`);
      }
    }

    el.className = '';
    el.innerHTML = rows.join('');

    if (series.length > 1) {
      this.drawSparkline(popupId, series.map((p) => p.t), series.map((p) => p.v), color, nowMs, fcMs);
    }
  }

  /** Re-render the active popup when the forecast time changes. */
  private refreshActivePopup(): void {
    const p = this.activePopup;
    if (!p) return;
    const el = document.getElementById(p.popupId);
    if (!el) { this.activePopup = null; return; }

    const now = Date.now();
    if (p.type === 'tidepredictions') {
      this.renderTidePopupContent(el, p.series, p.popupId, p.color, now);
    } else if (p.type === 'currentpredictions') {
      this.renderCurrentPopupContent(el, p.series, p.popupId, p.color, now, p.floodDir ?? 0, p.ebbDir ?? 180);
    }
  }

  private renderCurrentPrediction(el: HTMLElement, data: PredictionResponse, popupId: string, color: string): void {
    const preds = data.current_predictions?.cp ?? data.predictions ?? [];
    if (preds.length === 0) {
      el.className = '';
      el.innerHTML = '<div class="inspect-row" style="color:#8b949e">No prediction data</div>';
      return;
    }

    const now = Date.now();
    const extremes = preds.map((p: CurrentPredEntry) => ({
      t: new Date(p.Time ?? p.t ?? '').getTime(),
      speed: Number(p.Velocity_Major ?? p.v ?? 0),
      dir: Number(p.meanFloodDir ?? p.d ?? 0),
      type: (p.Type ?? '').toLowerCase(),
    })).filter((p) => Number.isFinite(p.t));

    if (extremes.length < 2) {
      el.className = '';
      el.innerHTML = '<div class="inspect-row" style="color:#8b949e">Insufficient data</div>';
      return;
    }

    // Build a smooth cosine-interpolated curve from the sparse extremes.
    // Tidal currents follow approximately sinusoidal patterns between
    // slack, max flood, slack, max ebb.
    const curve = interpolateCurrentCurve(extremes);

    // Interpolate current speed from the smooth curve
    const nowSpeed = interpolateAtTime(
      curve.map((p) => ({ t: p.t, v: p.v })), now,
    );
    const phase = nowSpeed !== null
      ? (nowSpeed > 0.05 ? 'flood' : nowSpeed < -0.05 ? 'ebb' : 'slack')
      : 'unknown';

    // Find the flood/ebb direction from the extremes
    const floodDir = extremes.find((e) => e.type === 'flood');
    const ebbDir = extremes.find((e) => e.type === 'ebb');
    const currentDir = phase === 'flood' && floodDir
      ? floodDir.dir
      : phase === 'ebb' && ebbDir
        ? ebbDir.dir
        : null;

    el.className = '';
    const rows: string[] = [];
    if (nowSpeed !== null) {
      rows.push(`<div class="inspect-row"><span class="k">speed</span><span>${Math.abs(nowSpeed).toFixed(2)} kt</span></div>`);
    }
    rows.push(`<div class="inspect-row"><span class="k">phase</span><span>${phase}</span></div>`);
    if (currentDir !== null) {
      rows.push(`<div class="inspect-row"><span class="k">dir</span><span>${compassFromDeg(currentDir)} (${currentDir.toFixed(0)}\u00B0)</span></div>`);
    }
    el.innerHTML = rows.join('');

    this.drawSparkline(popupId, curve.map((p) => p.t), curve.map((p) => p.v), color, now);
  }

  // ------------------------------------------------------------ sparkline

  private drawSparkline(
    popupId: string,
    times: number[],
    values: number[],
    color: string,
    nowMs?: number,
    forecastMs?: number,
  ): void {
    const canvas = document.getElementById(`${popupId}-canvas`) as HTMLCanvasElement | null;
    if (!canvas) return;
    canvas.style.display = 'block';

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const w = canvas.width;
    const h = canvas.height;
    const pad = { top: 8, right: 8, bottom: 14, left: 32 };
    const pw = w - pad.left - pad.right;
    const ph = h - pad.top - pad.bottom;

    const tMin = times[0]!;
    const tMax = times[times.length - 1]!;
    const tRange = tMax - tMin || 1;

    let vMin = Infinity, vMax = -Infinity;
    for (const v of values) {
      if (v < vMin) vMin = v;
      if (v > vMax) vMax = v;
    }
    const vPad = (vMax - vMin) * 0.1 || 0.5;
    vMin -= vPad;
    vMax += vPad;
    const vRange = vMax - vMin || 1;

    const toX = (t: number): number => pad.left + ((t - tMin) / tRange) * pw;
    const toY = (v: number): number => pad.top + ph - ((v - vMin) / vRange) * ph;

    ctx.clearRect(0, 0, w, h);

    // Zero line
    if (vMin < 0 && vMax > 0) {
      const y0 = toY(0);
      ctx.strokeStyle = 'rgba(139,148,158,0.3)';
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(pad.left, y0);
      ctx.lineTo(w - pad.right, y0);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // Filled area
    ctx.beginPath();
    ctx.moveTo(toX(times[0]!), toY(0));
    for (let i = 0; i < times.length; i++) {
      ctx.lineTo(toX(times[i]!), toY(values[i]!));
    }
    ctx.lineTo(toX(times[times.length - 1]!), toY(0));
    ctx.closePath();
    ctx.fillStyle = hexToRgba(color, 0.15);
    ctx.fill();

    // Line
    ctx.beginPath();
    for (let i = 0; i < times.length; i++) {
      const x = toX(times[i]!);
      const y = toY(values[i]!);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.stroke();

    // "Now" marker
    if (nowMs !== undefined && nowMs >= tMin && nowMs <= tMax) {
      const nx = toX(nowMs);
      ctx.strokeStyle = 'rgba(255,255,255,0.6)';
      ctx.lineWidth = 1;
      ctx.setLineDash([2, 2]);
      ctx.beginPath();
      ctx.moveTo(nx, pad.top);
      ctx.lineTo(nx, h - pad.bottom);
      ctx.stroke();
      ctx.setLineDash([]);

      ctx.fillStyle = '#ffffff';
      ctx.font = '8px ui-monospace, monospace';
      ctx.textAlign = 'center';
      ctx.fillText('now', nx, h - 2);
    }

    // Forecast time marker
    if (forecastMs !== undefined && forecastMs >= tMin && forecastMs <= tMax
        && (nowMs === undefined || Math.abs(forecastMs - nowMs) > 30 * 60000)) {
      const fx = toX(forecastMs);
      ctx.strokeStyle = 'rgba(126, 231, 135, 0.6)';
      ctx.lineWidth = 1;
      ctx.setLineDash([2, 2]);
      ctx.beginPath();
      ctx.moveTo(fx, pad.top);
      ctx.lineTo(fx, h - pad.bottom);
      ctx.stroke();
      ctx.setLineDash([]);

      ctx.fillStyle = '#7ee787';
      ctx.font = '8px ui-monospace, monospace';
      ctx.textAlign = 'center';
      ctx.fillText('fcst', fx, pad.top - 1);
    }

    // Y-axis labels
    ctx.fillStyle = '#8b949e';
    ctx.font = '8px ui-monospace, monospace';
    ctx.textAlign = 'right';
    ctx.fillText(formatVal(vMax), pad.left - 3, pad.top + 6);
    ctx.fillText(formatVal(vMin + vPad), pad.left - 3, h - pad.bottom);
  }
}

// ---------------------------------------------------------------------------
// Response types
// ---------------------------------------------------------------------------

interface WaterLevelResponse {
  metadata?: { id: string; name: string; lat: string; lon: string };
  data?: Array<{ t: string; v: string; s: string; f: string; q: string }>;
  error?: { message: string };
}

interface PredictionResponse {
  predictions?: Array<{ t: string; v: string; type?: string }>;
  current_predictions?: { cp: CurrentPredEntry[] };
  error?: { message: string };
}

interface CurrentPredEntry {
  Time?: string;
  t?: string;
  Velocity_Major?: number | string;
  v?: string;
  meanFloodDir?: number | string;
  d?: string;
  Type?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

function trendArrow(trend: string): string {
  if (trend.includes('rising')) return '\u2191 ';
  if (trend.includes('falling')) return '\u2193 ';
  return '\u2194 ';
}

function formatTime(ms: number): string {
  const d = new Date(ms);
  const h = d.getHours();
  const m = d.getMinutes();
  const ampm = h >= 12 ? 'pm' : 'am';
  const h12 = h % 12 || 12;
  return `${h12}:${String(m).padStart(2, '0')}${ampm}`;
}

function formatVal(v: number): string {
  return Math.abs(v) >= 10 ? v.toFixed(0) : v.toFixed(1);
}

function hexToRgba(hex: string, alpha: number): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

interface TimedValue { t: number; v: number }

function findNextExtreme(
  data: TimedValue[],
  nowMs: number,
  type: 'high' | 'low',
): TimedValue | null {
  // Look for local extremes after now
  for (let i = 1; i < data.length - 1; i++) {
    if (data[i]!.t < nowMs) continue;
    const prev = data[i - 1]!.v;
    const curr = data[i]!.v;
    const next = data[i + 1]!.v;
    if (type === 'high' && curr > prev && curr > next) return data[i]!;
    if (type === 'low' && curr < prev && curr < next) return data[i]!;
  }
  return null;
}

function interpolateAtTime(data: TimedValue[], nowMs: number): number | null {
  for (let i = 0; i < data.length - 1; i++) {
    if (data[i]!.t <= nowMs && data[i + 1]!.t >= nowMs) {
      const t0 = data[i]!.t;
      const t1 = data[i + 1]!.t;
      const v0 = data[i]!.v;
      const v1 = data[i + 1]!.v;
      const frac = (nowMs - t0) / (t1 - t0);
      return v0 + frac * (v1 - v0);
    }
  }
  return data.length > 0 ? data[0]!.v : null;
}

/**
 * Interpolate a smooth curve from sparse tidal current extremes (slack/flood/ebb).
 * Uses cosine interpolation between each pair of extremes, which closely
 * approximates the sinusoidal shape of tidal current velocity.
 * Returns ~200 evenly-spaced points suitable for the sparkline.
 */
function interpolateCurrentCurve(
  extremes: Array<{ t: number; speed: number }>,
): TimedValue[] {
  if (extremes.length < 2) return extremes.map((e) => ({ t: e.t, v: e.speed }));

  const tMin = extremes[0]!.t;
  const tMax = extremes[extremes.length - 1]!.t;
  const numPoints = 200;
  const step = (tMax - tMin) / (numPoints - 1);
  const result: TimedValue[] = [];

  for (let i = 0; i < numPoints; i++) {
    const t = tMin + i * step;

    // Find the surrounding extremes
    let segIdx = 0;
    for (let j = 0; j < extremes.length - 1; j++) {
      if (extremes[j]!.t <= t && extremes[j + 1]!.t >= t) {
        segIdx = j;
        break;
      }
      if (j === extremes.length - 2) segIdx = j; // clamp to last segment
    }

    const e0 = extremes[segIdx]!;
    const e1 = extremes[segIdx + 1]!;
    const dt = e1.t - e0.t;
    const frac = dt > 0 ? (t - e0.t) / dt : 0;

    // Cosine interpolation: smooth S-curve between extremes
    const mu = (1 - Math.cos(frac * Math.PI)) / 2;
    const v = e0.speed * (1 - mu) + e1.speed * mu;

    result.push({ t, v });
  }

  return result;
}

function compassFromDeg(deg: number): string {
  const dirs = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
  return dirs[Math.round(((deg % 360 + 360) % 360) / 22.5) % 16]!;
}
