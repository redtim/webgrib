/**
 * Declarative catalog of HRRR weather variables, each with one or more
 * atmospheric levels. The panel shows variables; selecting one reveals a
 * level slider to move up/down the atmosphere.
 */

import type { ColormapName } from './colormaps.js';
import { accForecastQuery } from '../grib2/idx.js';
import {
  getUnitPref, convertTemp, convertSpeed, convertLength, convertDistance,
  unitLabel,
} from '../demo/units.js';
import type { Dimension } from '../demo/units.js';

export type { Dimension };
export type LayerKind = 'scalar' | 'wind';

export interface LayerQuery {
  parameter: RegExp;
  level: RegExp;
  forecast?: (fhour: number) => RegExp;
}

/** One atmospheric level within a variable. */
export interface VariableLevel {
  /** Short label shown on the level slider, e.g. "2m", "850 hPa". */
  label: string;
  /** For scalar layers. */
  query?: LayerQuery;
  /** For wind layers: U and V queries. */
  queryU?: LayerQuery;
  queryV?: LayerQuery;
}

/** A weather variable with one or more vertical levels. */
export interface CatalogVariable {
  id: string;
  group: string;
  label: string;
  kind: LayerKind;
  /** Ordered from surface (index 0) to upper atmosphere. */
  levels: VariableLevel[];
  colormap?: ColormapName;
  /** Fixed range in native units (K for temp, m/s for speed, etc.). */
  range?: [number, number];
  /** Physical dimension — drives unit conversion. */
  dimension?: Dimension | 'percent' | 'none';
  /** Legacy display unit string (used as fallback when dimension is not set). */
  unit?: string;
  /** Format a raw (native-unit) value for display, respecting the current unit pref. */
  format?: (v: number) => string;
  /** Data source. Defaults to 'hrrr'. */
  source?: 'hrrr' | 'ofs';
  /** OFS model identifier (e.g., 'sfbofs'). Only used when source === 'ofs'. */
  ofsModel?: string;
}

// ---- unit-aware helpers -----------------------------------------------------

const fmtTemp = (v: number): string => {
  const u = getUnitPref('temperature');
  return `${convertTemp(v, u).toFixed(1)} ${unitLabel('temperature')}`;
};

const fmtSpeed = (v: number): string => {
  const u = getUnitPref('speed');
  return `${convertSpeed(v, u).toFixed(1)} ${unitLabel('speed')}`;
};

const fmtLength = (v: number): string => {
  const u = getUnitPref('length');
  return `${convertLength(v, u).toFixed(1)} ${unitLabel('length')}`;
};

const fmtDistance = (v: number): string => {
  const u = getUnitPref('distance');
  return `${convertDistance(v, u).toFixed(1)} ${unitLabel('distance')}`;
};

// Precip rate: native is kg/m2/s, convert to mm/hr then to user's length unit per hour
const fmtPrecipRate = (v: number): string => {
  const mmhr = v * 3600;
  const u = getUnitPref('length');
  return `${convertLength(mmhr, u).toFixed(2)} ${unitLabel('length')}/hr`;
};

// Snow depth: native is meters, convert to user's length unit
const fmtSnowDepth = (v: number): string => {
  const mm = v * 1000; // m -> mm
  const u = getUnitPref('length');
  return `${convertLength(mm, u).toFixed(1)} ${unitLabel('length')}`;
};

const fmtPct = (v: number): string => `${v.toFixed(0)} %`;
const fmtDbz = (v: number): string => `${v.toFixed(1)} dBZ`;
const fmtJkg = (v: number): string => `${v.toFixed(0)} J/kg`;
const fmtPas = (v: number): string => `${v.toFixed(2)} Pa/s`;
const fmtM2s2 = (v: number): string => `${v.toFixed(0)} m\u00B2/s\u00B2`;

// ---- display helpers for legend/ticks ---------------------------------------

/**
 * Convert a native-unit range to the user's preferred display units.
 * Returns [displayMin, displayMax].
 */
export function displayRange(v: CatalogVariable): [number, number] {
  if (!v.range) return [0, 1];
  const [lo, hi] = v.range;
  switch (v.dimension) {
    case 'temperature': {
      const u = getUnitPref('temperature');
      return [convertTemp(lo, u), convertTemp(hi, u)];
    }
    case 'speed': {
      const u = getUnitPref('speed');
      return [convertSpeed(lo, u), convertSpeed(hi, u)];
    }
    case 'length': {
      const u = getUnitPref('length');
      return [convertLength(lo, u), convertLength(hi, u)];
    }
    case 'distance': {
      const u = getUnitPref('distance');
      return [convertDistance(lo, u), convertDistance(hi, u)];
    }
    default:
      return [lo, hi];
  }
}

/** Return the display unit label for the user's current preference. */
export function displayUnit(v: CatalogVariable): string {
  switch (v.dimension) {
    case 'temperature': return unitLabel('temperature');
    case 'speed':       return unitLabel('speed');
    case 'length':      return unitLabel('length');
    case 'distance':    return unitLabel('distance');
    default:            return v.unit ?? '';
  }
}

// ---- shorthand level builder ------------------------------------------------

function scalarLevel(label: string, parameter: RegExp, level: RegExp): VariableLevel {
  return { label, query: { parameter, level } };
}

function windLevel(label: string, uParam: RegExp, vParam: RegExp, level: RegExp): VariableLevel {
  return { label, queryU: { parameter: uParam, level }, queryV: { parameter: vParam, level } };
}

// ---- catalog ----------------------------------------------------------------

export const CATALOG: CatalogVariable[] = [
  // Temperature
  {
    id: 'temperature', group: 'Temperature', label: 'Temperature', kind: 'scalar',
    colormap: 'temperature', range: [203, 320], dimension: 'temperature', format: fmtTemp,
    levels: [
      scalarLevel('2m', /^TMP$/, /^2 m above ground$/),
      scalarLevel('850 hPa', /^TMP$/, /^850 mb$/),
      scalarLevel('700 hPa', /^TMP$/, /^700 mb$/),
      scalarLevel('500 hPa', /^TMP$/, /^500 mb$/),
      scalarLevel('300 hPa', /^TMP$/, /^300 mb$/),
      scalarLevel('250 hPa', /^TMP$/, /^250 mb$/),
    ],
  },
  {
    id: 'freezing-lvl', group: 'Temperature', label: 'Freezing Level', kind: 'scalar',
    colormap: 'viridis', range: [0, 5000], dimension: 'distance', format: fmtDistance,
    levels: [scalarLevel('0°C iso', /^HGT$/, /^0C isotherm$/)],
  },

  // Wind
  {
    id: 'wind', group: 'Wind', label: 'Wind', kind: 'wind', range: [0, 18], dimension: 'speed',
    levels: [
      windLevel('10m', /^UGRD$/, /^VGRD$/, /^10 m above ground$/),
      windLevel('80m', /^UGRD$/, /^VGRD$/, /^80 m above ground$/),
      windLevel('850 hPa', /^UGRD$/, /^VGRD$/, /^850 mb$/),
      windLevel('700 hPa', /^UGRD$/, /^VGRD$/, /^700 mb$/),
      windLevel('500 hPa', /^UGRD$/, /^VGRD$/, /^500 mb$/),
      windLevel('300 hPa', /^UGRD$/, /^VGRD$/, /^300 mb$/),
      windLevel('250 hPa', /^UGRD$/, /^VGRD$/, /^250 mb$/),
    ],
  },
  {
    id: 'gust', group: 'Wind', label: 'Wind Gust', kind: 'scalar',
    colormap: 'wind', range: [0, 18], dimension: 'speed', format: fmtSpeed,
    levels: [scalarLevel('Surface', /^GUST$/, /^surface$/)],
  },

  // Moisture
  {
    id: 'dewpoint', group: 'Moisture', label: 'Dew Point', kind: 'scalar',
    colormap: 'temperature', range: [203, 320], dimension: 'temperature', format: fmtTemp,
    levels: [
      scalarLevel('2m', /^DPT$/, /^2 m above ground$/),
    ],
  },
  {
    id: 'rh', group: 'Moisture', label: 'Relative Humidity', kind: 'scalar',
    colormap: 'humidity', range: [0, 100], dimension: 'percent', unit: '%', format: fmtPct,
    levels: [
      scalarLevel('2m', /^RH$/, /^2 m above ground$/),
      scalarLevel('850 hPa', /^RH$/, /^850 mb$/),
      scalarLevel('700 hPa', /^RH$/, /^700 mb$/),
    ],
  },

  // Instability
  {
    id: 'cape', group: 'Instability', label: 'CAPE', kind: 'scalar',
    colormap: 'cape', range: [0, 5000], dimension: 'none', unit: 'J/kg', format: fmtJkg,
    levels: [scalarLevel('Surface', /^CAPE$/, /^surface$/)],
  },
  {
    id: 'cin', group: 'Instability', label: 'CIN', kind: 'scalar',
    colormap: 'cin', range: [-500, 0], dimension: 'none', unit: 'J/kg', format: fmtJkg,
    levels: [scalarLevel('Surface', /^CIN$/, /^surface$/)],
  },
  {
    id: 'lftx', group: 'Instability', label: 'Lifted Index', kind: 'scalar',
    colormap: 'turbo', range: [-10, 10], dimension: 'none', unit: '\u00B0C', format: (v: number) => `${v.toFixed(1)} \u00B0C`,
    levels: [scalarLevel('500-1000mb', /^LFTX$/, /^500-1000 mb$/)],
  },
  {
    id: 'helicity', group: 'Instability', label: 'Storm Rel. Helicity', kind: 'scalar',
    colormap: 'cape', range: [0, 500], dimension: 'none', unit: 'm\u00B2/s\u00B2', format: fmtM2s2,
    levels: [scalarLevel('0-3km', /^HLCY$/, /^3000-0 m above ground$/)],
  },

  // Precipitation
  {
    id: 'apcp', group: 'Precipitation', label: '1h Precipitation', kind: 'scalar',
    colormap: 'precipitation', range: [0, 50], dimension: 'length', format: fmtLength,
    levels: [{ label: 'Surface', query: { parameter: /^APCP$/, level: /^surface$/, forecast: accForecastQuery } }],
  },
  {
    id: 'prate', group: 'Precipitation', label: 'Precip Rate', kind: 'scalar',
    colormap: 'precipitation', range: [0, 0.01], dimension: 'none', unit: 'mm/hr', format: fmtPrecipRate,
    levels: [scalarLevel('Surface', /^PRATE$/, /^surface$/)],
  },
  {
    id: 'snod', group: 'Precipitation', label: 'Snow Depth', kind: 'scalar',
    colormap: 'snow', range: [0, 1], dimension: 'none', unit: '', format: fmtSnowDepth,
    levels: [scalarLevel('Surface', /^SNOD$/, /^surface$/)],
  },
  {
    id: 'weasd', group: 'Precipitation', label: 'Snow Water Equiv.', kind: 'scalar',
    colormap: 'snow', range: [0, 50], dimension: 'length', format: fmtLength,
    levels: [scalarLevel('Surface', /^WEASD$/, /^surface$/)],
  },

  // Radar
  {
    id: 'refc', group: 'Radar', label: 'Composite Reflectivity', kind: 'scalar',
    colormap: 'turbo', range: [-10, 75], dimension: 'none', unit: 'dBZ', format: fmtDbz,
    levels: [scalarLevel('Entire atm', /^REFC$/, /entire atmosphere/)],
  },
  {
    id: 'retop', group: 'Radar', label: 'Echo Top', kind: 'scalar',
    colormap: 'viridis', range: [0, 20000], dimension: 'distance', format: fmtDistance,
    levels: [scalarLevel('Cloud top', /^RETOP$/, /^cloud top$/)],
  },

  // Clouds
  {
    id: 'cloud-cover', group: 'Clouds', label: 'Cloud Cover', kind: 'scalar',
    colormap: 'cloud', range: [0, 100], dimension: 'percent', unit: '%', format: fmtPct,
    levels: [
      scalarLevel('Total', /^TCDC$/, /entire atmosphere/),
      scalarLevel('Low', /^LCDC$/, /^low cloud layer$/),
      scalarLevel('Mid', /^MCDC$/, /^middle cloud layer$/),
      scalarLevel('High', /^HCDC$/, /^high cloud layer$/),
    ],
  },
  {
    id: 'vis', group: 'Clouds', label: 'Surface Visibility', kind: 'scalar',
    colormap: 'viridis', range: [0, 24000], dimension: 'distance', format: fmtDistance,
    levels: [scalarLevel('Surface', /^VIS$/, /^surface$/)],
  },

  // Lightning
  {
    id: 'lightning', group: 'Lightning', label: 'Lightning Threat', kind: 'scalar',
    colormap: 'lightning', range: [0, 10], dimension: 'none', unit: 'fl/hr',
    format: (v: number) => `${v.toFixed(1)} flashes/hr`,
    levels: [scalarLevel('Entire Atm', /^LTNG$/, /^entire atmosphere$/)],
  },

  // Other
  {
    id: 'vvel', group: 'Other', label: 'Vertical Velocity', kind: 'scalar',
    colormap: 'turbo', range: [-10, 10], dimension: 'none', unit: 'Pa/s', format: fmtPas,
    levels: [
      scalarLevel('850 hPa', /^VVEL$/, /^850 mb$/),
      scalarLevel('700 hPa', /^VVEL$/, /^700 mb$/),
      scalarLevel('500 hPa', /^VVEL$/, /^500 mb$/),
    ],
  },

  // Ocean
  {
    id: 'sfbofs-currents', group: 'Ocean', label: 'SF Bay Currents', kind: 'wind',
    source: 'ofs', ofsModel: 'sfbofs',
    colormap: 'ocean-currents', range: [0, 3], unit: 'm/s',
    format: (v: number) => `${v.toFixed(2)} m/s`,
    levels: [{ label: 'Surface' }],
  },
  {
    id: 'apparent-wind', group: 'Ocean', label: 'Apparent Wind', kind: 'wind',
    source: 'ofs', ofsModel: 'apparent-wind',
    colormap: 'wind', range: [0, 18], dimension: 'speed',
    format: fmtSpeed,
    levels: [{ label: 'Surface' }],
  },
];

/** All groups in display order. */
export const GROUPS: string[] = [...new Set(CATALOG.map((v) => v.group))];

/** Look up a catalog variable by id. */
export function findVariable(id: string): CatalogVariable | undefined {
  return CATALOG.find((v) => v.id === id);
}
