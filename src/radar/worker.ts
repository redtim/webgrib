/** Fetches, parses and grids one scan off the main thread. */

import type { ProductId } from './colors.js';
import { readVolume } from './level2.js';
import { buildPolarGrid, lowestSweepWith, type PolarGrid } from './polar.js';
import { scanUrl } from './s3.js';

export interface Scan {
  key: string;
  site: string;
  time: Date;
  latitude: number;
  longitude: number;
  vcp: number;
  /** Lowest tilt of each product present in the file. */
  grids: Partial<Record<ProductId, PolarGrid>>;
}

export type WorkerReply = { scan: Scan } | { key: string; error: string; outOfMemory?: boolean };

const PRODUCT_IDS: ProductId[] = ['REF', 'VEL'];

// Every coverage pattern opens with a split cut: tilt 1 surveys reflectivity,
// tilt 2 repeats the same angle in Doppler mode for velocity.
const LOWEST_TILTS = 2;

async function load(key: string): Promise<Scan> {
  const response = await fetch(scanUrl(key));
  if (!response.ok || !response.body) throw new Error(`Radar file download failed (HTTP ${response.status})`);
  // The low tilts come first in the file; the rest is never downloaded.
  const volume = await readVolume(response.body, { maxElevationNumber: LOWEST_TILTS });
  const grids: Scan['grids'] = {};
  for (const product of PRODUCT_IDS) {
    const sweep = lowestSweepWith(volume, product);
    if (sweep) grids[product] = buildPolarGrid(sweep, product);
  }
  const { site, time, latitude, longitude, vcp } = volume;
  return { key, site, time, latitude, longitude, vcp, grids };
}

const scope = self as unknown as Worker;

scope.onmessage = async (event: MessageEvent<{ key: string }>) => {
  const { key } = event.data;
  try {
    const scan = await load(key);
    const buffers = Object.values(scan.grids).map((g) => g.data.buffer as ArrayBuffer);
    scope.postMessage({ scan } satisfies WorkerReply, buffers);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // Browsers word allocation failures differently, but all name one of these.
    const outOfMemory = /allocation|out of memory/i.test(message);
    scope.postMessage({ key, error: message, outOfMemory } satisfies WorkerReply);
  }
};
