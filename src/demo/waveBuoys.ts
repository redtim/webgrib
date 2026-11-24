/**
 * NDBC wave buoy overlay: a toggleable layer of the buoys that publish
 * directional wave spectra. Hovering names a buoy; clicking one opens the
 * spectrum panel (spectrumPanel.ts) with its last few days of spectra.
 */

import maplibregl from 'maplibre-gl';
import type { Map as MlMap, MapMouseEvent, MapLayerMouseEvent } from 'maplibre-gl';
import { fetchStationSpectra, fetchWaveStations } from '../waves/ndbc.js';
import type { WaveStation } from '../waves/ndbc.js';
import { SpectrumPanel } from './spectrumPanel.js';

export const WAVE_BUOY_OVERLAY_ID = 'wavebuoys';
export const WAVE_BUOY_COLOR = '#4fd1c5';
export const WAVE_BUOY_BADGE_BG = '#1f3d3a';

const SOURCE_ID = 'ndbc-wave-buoys';
const LAYER_ID = 'ndbc-wave-buoys-points';

export class WaveBuoyManager {
  private map: MlMap | null = null;
  private stations: WaveStation[] | null = null;
  private stationsPromise: Promise<WaveStation[]> | null = null;
  private visible = false;
  private countEl: HTMLElement | null = null;
  private hoverPopup: maplibregl.Popup | null = null;
  private panel: SpectrumPanel;
  private loadGen = 0;
  private abort: AbortController | null = null;

  constructor(panelParent: HTMLElement) {
    this.panel = new SpectrumPanel({
      parent: panelParent,
      onClose: () => {
        this.abort?.abort();
        this.abort = null;
      },
    });
  }

  attach(map: MlMap): void {
    this.map = map;
    map.on('mouseenter', LAYER_ID, (ev) => this.onHover(ev));
    map.on('mousemove', LAYER_ID, (ev) => this.onHover(ev));
    map.on('mouseleave', LAYER_ID, () => {
      map.getCanvas().style.cursor = '';
      this.hoverPopup?.remove();
      this.hoverPopup = null;
    });
  }

  /** Expert-panel checkbox row; the returned input owns the on/off state. */
  createToggle(container: HTMLElement): HTMLInputElement {
    const wrap = document.createElement('div');
    wrap.style.cssText = 'margin-top:8px;border-top:1px solid #30363d;padding-top:6px;';
    const title = document.createElement('div');
    title.style.cssText = 'color:#8b949e;font-size:10px;font-weight:bold;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:4px;';
    title.textContent = 'Waves';
    wrap.appendChild(title);

    const row = document.createElement('div');
    row.innerHTML = `
      <label style="display:flex;align-items:center;gap:6px;cursor:pointer;padding:3px 6px;font-size:11px;">
        <input type="checkbox" data-overlay="${WAVE_BUOY_OVERLAY_ID}" style="margin:0" />
        <span class="layer-kind" style="background:${WAVE_BUOY_BADGE_BG};color:${WAVE_BUOY_COLOR};width:16px;height:16px;border-radius:3px;display:inline-flex;align-items:center;justify-content:center;font-size:11px;font-weight:bold;flex-shrink:0">&#8779;</span>
        <span>Wave Spectra Buoys <span class="wave-count" style="color:#8b949e;font-size:10px"></span></span>
      </label>`;
    const box = row.querySelector('input') as HTMLInputElement;
    this.countEl = row.querySelector('.wave-count') as HTMLElement;
    box.addEventListener('change', () => { void this.setVisible(box.checked); });
    wrap.appendChild(row);
    container.appendChild(wrap);
    return box;
  }

  async setVisible(visible: boolean): Promise<void> {
    const map = this.map;
    if (!map) return;
    this.visible = visible;
    if (!visible) {
      if (map.getLayer(LAYER_ID)) map.removeLayer(LAYER_ID);
      if (map.getSource(SOURCE_ID)) map.removeSource(SOURCE_ID);
      this.hoverPopup?.remove();
      this.hoverPopup = null;
      this.panel.close();
      this.abort?.abort();
      return;
    }
    try {
      const stations = await this.ensureStations();
      if (!this.visible || map.getSource(SOURCE_ID)) return; // toggled off while loading
      map.addSource(SOURCE_ID, { type: 'geojson', data: toGeoJson(stations) });
      map.addLayer({
        id: LAYER_ID,
        type: 'circle',
        source: SOURCE_ID,
        paint: {
          'circle-color': WAVE_BUOY_COLOR,
          'circle-radius': ['interpolate', ['linear'], ['zoom'], 3, 3.5, 8, 6],
          'circle-stroke-width': 1.2,
          'circle-stroke-color': '#0b0d10',
          'circle-opacity': 0.9,
        },
      });
    } catch (err) {
      console.error('Failed to load NDBC wave buoys:', err);
      if (this.countEl) this.countEl.textContent = '(unavailable)';
    }
  }

  private ensureStations(): Promise<WaveStation[]> {
    if (this.stations) return Promise.resolve(this.stations);
    if (!this.stationsPromise) {
      this.stationsPromise = fetchWaveStations().then((stations) => {
        this.stations = stations;
        if (this.countEl) this.countEl.textContent = `(${stations.length})`;
        return stations;
      }).catch((err: unknown) => {
        this.stationsPromise = null;
        throw err;
      });
    }
    return this.stationsPromise;
  }

  private onHover(ev: MapLayerMouseEvent): void {
    const map = this.map;
    if (!map) return;
    map.getCanvas().style.cursor = 'pointer';
    const feat = ev.features?.[0];
    if (!feat) return;
    const props = feat.properties as { id: string; name: string };
    const coords = (feat.geometry as GeoJSON.Point).coordinates as [number, number];
    const html = `<span class="wave-hover-id">${escapeHtml(props.id)}</span>${props.name ? ` ${escapeHtml(props.name)}` : ''}`;
    if (!this.hoverPopup) {
      this.hoverPopup = new maplibregl.Popup({
        closeButton: false, closeOnClick: false, offset: 10, className: 'wave-hover',
      }).addTo(map);
    }
    this.hoverPopup.setLngLat(coords).setHTML(html);
  }

  /**
   * Map click: if a buoy was hit, open its spectrum and return true so the
   * caller skips its own click-to-inspect popup.
   */
  handleClick(ev: MapMouseEvent, map: MlMap): boolean {
    if (!this.visible || !map.getLayer(LAYER_ID)) return false;
    const feats = map.queryRenderedFeatures(ev.point, { layers: [LAYER_ID] });
    const feat = feats[0];
    if (!feat) return false;
    const props = feat.properties as { id: string; name: string };
    this.openStation(props.id, props.name);
    return true;
  }

  openStation(id: string, name: string): void {
    this.abort?.abort();
    const abort = new AbortController();
    this.abort = abort;
    const gen = ++this.loadGen;
    this.panel.open(id, name);
    fetchStationSpectra(id, abort.signal).then((data) => {
      if (gen !== this.loadGen) return;
      this.panel.setRecords(data.records);
    }).catch((err: unknown) => {
      if (gen !== this.loadGen || abort.signal.aborted) return;
      this.panel.showMessage(err instanceof Error ? err.message : String(err));
    });
  }
}

function toGeoJson(stations: WaveStation[]): GeoJSON.FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: stations.map((s) => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [s.lon, s.lat] },
      properties: { id: s.id, name: s.name, owner: s.owner },
    })),
  };
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}
