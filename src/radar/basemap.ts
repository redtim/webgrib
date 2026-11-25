/** Keeps the radar usable when the third-party base map cannot be loaded. */

import type { StyleSpecification } from 'maplibre-gl';

export interface StyleHost {
  on(type: 'style.load' | 'error', listener: () => void): void;
  setStyle(style: StyleSpecification): void;
}

/** Swap in `fallback` if the first style errors, or has not arrived in time. */
export function fallBackIfStyleFails(
  map: StyleHost,
  fallback: StyleSpecification,
  onFallback: () => void,
  timeoutMs: number,
): void {
  let settled = false;
  const fall = () => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    map.setStyle(fallback);
    onFallback();
  };
  const timer = setTimeout(fall, timeoutMs);
  map.on('style.load', () => {
    settled = true;
    clearTimeout(timer);
  });
  // Errors after the style has loaded, such as a missing tile, are ignored.
  map.on('error', fall);
}
