/**
 * Dev-only tool that regenerates the easy-mode rail icons from the live map.
 * Open the dev server with `?capture-icons`: it turns each layer on in turn,
 * picks the most interesting square of the map, and posts it to the dev
 * server, which writes it to src/demo/icons/<id>.jpg (see vite.config.ts).
 * Layers with nothing to show at the moment (no rain, no snow) are skipped
 * and keep whatever icon they already have.
 *
 * Progress is reported on `window.__iconCapture` and in the console.
 */

import type { Map as MlMap } from 'maplibre-gl';
import { EASY_LAYERS } from './easyMode.js';

export interface CaptureHost {
  map: MlMap;
  /** Load a fill layer by catalog id; resolves once its data is on the map. */
  showFill: (id: string) => Promise<void>;
  /** Hide the fill and its particles, leaving the bare basemap. */
  hideFill: () => void;
  setOverlay: (id: string, on: boolean) => void;
}

interface View {
  center: [number, number];
  zoom: number;
}

const CONUS: View = { center: [-96, 38], zoom: 3.5 };
const SF_BAY: View = { center: [-122.35, 37.82], zoom: 8.5 };

/**
 * Overlays worth capturing. Wind particles are left out: a still frame of
 * them is a few faint dots, so that overlay keeps its glyph icon.
 */
const CAPTURED_OVERLAYS = ['isobars'];

const ICON_PX = 96;
/** Snapshots are scored at this width; the crop itself uses full resolution. */
const SCORE_WIDTH = 320;
/** Overlay fetches are fire-and-forget, so give them a fixed time to land. */
const OVERLAY_SETTLE_MS = 6000;
/** Below this share of changed pixels a layer has nothing worth showing. */
const MIN_CHANGED = 0.02;
/** A fill in fewer colors than this is a flat wash (e.g. snow depth in summer). */
const MIN_COLORS = 6;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Composite the map and its overlay canvases into one canvas. */
function snapshot(map: MlMap): HTMLCanvasElement {
  map.redraw(); // synchronous, so the WebGL buffer is still readable below
  const src = map.getCanvas();
  const out = document.createElement('canvas');
  out.width = src.width;
  out.height = src.height;
  const ctx = out.getContext('2d')!;
  ctx.drawImage(src, 0, 0);
  for (const c of map.getCanvasContainer().querySelectorAll('canvas')) {
    if (c !== src && c.style.display !== 'none') ctx.drawImage(c, 0, 0, out.width, out.height);
  }
  return out;
}

function pixels(canvas: HTMLCanvasElement, width: number, height: number): Uint8ClampedArray {
  const small = document.createElement('canvas');
  small.width = width;
  small.height = height;
  const ctx = small.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(canvas, 0, 0, width, height);
  return ctx.getImageData(0, 0, width, height).data;
}

/**
 * Find the square that differs most from the bare basemap and has the most
 * varied color. Returns it in snapshot pixels, with the share of pixels in
 * it that the layer changed.
 */
function bestSquare(
  base: HTMLCanvasElement,
  shot: HTMLCanvasElement,
): { x: number; y: number; size: number; changed: number; colors: number } {
  const w = SCORE_WIDTH;
  const h = Math.round((shot.height / shot.width) * w);
  const a = pixels(base, w, h);
  const b = pixels(shot, w, h);
  const size = Math.round(h / 4);
  const step = Math.max(1, Math.round(size / 4));

  let best = { x: 0, y: 0, score: -1, changed: 0, colors: 0 };
  for (let y = 0; y + size <= h; y += step) {
    for (let x = 0; x + size <= w; x += step) {
      let changed = 0;
      const colors = new Set<number>();
      for (let j = y; j < y + size; j += 2) {
        for (let i = x; i < x + size; i += 2) {
          const p = (j * w + i) * 4;
          const diff = Math.abs(a[p]! - b[p]!) + Math.abs(a[p + 1]! - b[p + 1]!) + Math.abs(a[p + 2]! - b[p + 2]!);
          if (diff < 40) continue;
          changed++;
          // Coarse color bucket: 3 bits per channel.
          colors.add(((b[p]! >> 5) << 6) | ((b[p + 1]! >> 5) << 3) | (b[p + 2]! >> 5));
        }
      }
      const total = Math.ceil(size / 2) ** 2;
      const score = (changed / total) * (1 + colors.size / 16);
      if (score > best.score) best = { x, y, score, changed: changed / total, colors: colors.size };
    }
  }

  const scale = shot.width / w;
  return { x: best.x * scale, y: best.y * scale, size: size * scale, changed: best.changed, colors: best.colors };
}

async function saveIcon(id: string, shot: HTMLCanvasElement, sq: { x: number; y: number; size: number }): Promise<void> {
  const icon = document.createElement('canvas');
  icon.width = ICON_PX;
  icon.height = ICON_PX;
  icon.getContext('2d')!.drawImage(shot, sq.x, sq.y, sq.size, sq.size, 0, 0, ICON_PX, ICON_PX);
  const blob = await new Promise<Blob | null>((r) => icon.toBlob(r, 'image/jpeg', 0.85));
  if (!blob) throw new Error('could not encode icon');
  const res = await fetch(`/__save-icon?id=${encodeURIComponent(id)}`, { method: 'POST', body: blob });
  if (!res.ok) throw new Error(`save failed: ${res.status} ${await res.text()}`);
}

export async function captureIcons(host: CaptureHost): Promise<void> {
  const { map } = host;
  const report = { done: false, saved: [] as string[], skipped: [] as string[] };
  (window as unknown as { __iconCapture: typeof report }).__iconCapture = report;

  const setView = (view: View): void => {
    map.stop();
    map.jumpTo(view);
  };

  const capture = async (id: string, base: HTMLCanvasElement, minColors: number): Promise<void> => {
    const shot = snapshot(map);
    const sq = bestSquare(base, shot);
    if (sq.changed < MIN_CHANGED || sq.colors < minColors) {
      report.skipped.push(id);
      console.info(`[icons] ${id}: nothing to show right now, skipped`);
      return;
    }
    await saveIcon(id, shot, sq);
    report.saved.push(id);
    console.info(`[icons] ${id}: saved`);
  };

  // Place names are unreadable at icon size and hide the layer.
  for (const layer of map.getStyle().layers ?? []) {
    if (layer.type === 'symbol') map.setLayoutProperty(layer.id, 'visibility', 'none');
  }

  // Bare basemap for each view, to tell the layer apart from the map under it.
  for (const id of ['particles', 'isobars', 'lightning']) host.setOverlay(id, false);
  const bases = new Map<View, HTMLCanvasElement>();
  await host.showFill('temperature'); // so there is a fill to hide, and a current variable
  for (const view of [CONUS, SF_BAY]) {
    setView(view);
    host.hideFill();
    await sleep(500);
    bases.set(view, snapshot(map));
  }

  for (const layer of EASY_LAYERS) {
    const view = layer.group === 'SF Bay' ? SF_BAY : CONUS;
    try {
      await host.showFill(layer.id);
      setView(view);
      await sleep(500);
      await capture(layer.id, bases.get(view)!, MIN_COLORS);
    } catch (err) {
      report.skipped.push(layer.id);
      console.warn(`[icons] ${layer.id} failed:`, err);
    }
  }

  // Overlays are captured on their own, over the bare basemap.
  await host.showFill('temperature');
  setView(CONUS);
  for (const id of CAPTURED_OVERLAYS) {
    try {
      host.setOverlay(id, true);
      await sleep(OVERLAY_SETTLE_MS);
      host.hideFill();
      await sleep(300);
      await capture(id, bases.get(CONUS)!, 1);
    } catch (err) {
      report.skipped.push(id);
      console.warn(`[icons] ${id} failed:`, err);
    }
    host.setOverlay(id, false);
  }

  report.done = true;
  console.info('[icons] done', report);
}
