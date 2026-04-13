/**
 * Per-dimension unit preference system. Each physical dimension (temperature,
 * speed, etc.) has its own set of available units. Preferences are persisted
 * independently to localStorage.
 */

// ---- unit types -------------------------------------------------------------

export type TempUnit = 'F' | 'C';
export type SpeedUnit = 'kt' | 'mph' | 'm/s' | 'km/h';
export type LengthUnit = 'in' | 'mm' | 'cm';
export type DistanceUnit = 'mi' | 'km' | 'm' | 'ft';

export interface UnitPreferences {
  temperature: TempUnit;
  speed: SpeedUnit;
  length: LengthUnit;
  distance: DistanceUnit;
}

export type Dimension = keyof UnitPreferences;

/** All available choices for each dimension. */
export const UNIT_OPTIONS: { [K in Dimension]: readonly UnitPreferences[K][] } = {
  temperature: ['F', 'C'] as const,
  speed: ['kt', 'mph', 'm/s', 'km/h'] as const,
  length: ['in', 'mm', 'cm'] as const,
  distance: ['mi', 'km', 'm', 'ft'] as const,
};

// ---- defaults ---------------------------------------------------------------

const DEFAULTS: UnitPreferences = {
  temperature: 'F',
  speed: 'kt',
  length: 'mm',
  distance: 'mi',
};

const STORAGE_PREFIX = 'gribwebview-unit-';

// ---- state ------------------------------------------------------------------

const prefs: UnitPreferences = { ...DEFAULTS };
const listeners: Array<() => void> = [];

// Hydrate from localStorage on module load
for (const dim of Object.keys(DEFAULTS) as Dimension[]) {
  const stored = localStorage.getItem(STORAGE_PREFIX + dim);
  if (stored && (UNIT_OPTIONS[dim] as readonly string[]).includes(stored)) {
    (prefs as unknown as Record<string, string>)[dim] = stored;
  }
}

// ---- public API -------------------------------------------------------------

export function getUnitPref<K extends Dimension>(dim: K): UnitPreferences[K] {
  return prefs[dim];
}

export function setUnitPref<K extends Dimension>(dim: K, unit: UnitPreferences[K]): void {
  if (prefs[dim] === unit) return;
  prefs[dim] = unit;
  localStorage.setItem(STORAGE_PREFIX + dim, unit as string);
  for (const cb of listeners) cb();
}

export function onUnitChange(cb: () => void): void {
  listeners.push(cb);
}

// ---- conversion from native units -------------------------------------------

/** Convert a temperature from Kelvin to the requested unit. */
export function convertTemp(k: number, to: TempUnit): number {
  if (to === 'C') return k - 273.15;
  return (k - 273.15) * 9 / 5 + 32; // F
}

/** Convert a speed from m/s to the requested unit. */
export function convertSpeed(ms: number, to: SpeedUnit): number {
  switch (to) {
    case 'm/s': return ms;
    case 'kt':  return ms / 0.514444;
    case 'mph': return ms * 2.236936;
    case 'km/h': return ms * 3.6;
  }
}

/** Convert a length from mm to the requested unit. */
export function convertLength(mm: number, to: LengthUnit): number {
  switch (to) {
    case 'mm': return mm;
    case 'cm': return mm / 10;
    case 'in': return mm / 25.4;
  }
}

/**
 * Convert a distance from meters to the requested unit.
 * Also handles snow depth (native = meters).
 */
export function convertDistance(m: number, to: DistanceUnit): number {
  switch (to) {
    case 'm':  return m;
    case 'km': return m / 1000;
    case 'mi': return m / 1609.344;
    case 'ft': return m * 3.28084;
  }
}

/** Unit label string for display (e.g. "F" -> "\u00B0F"). */
export function unitLabel(dim: Dimension): string {
  const u = prefs[dim];
  if (dim === 'temperature') return `\u00B0${u}`;
  return u as string;
}
