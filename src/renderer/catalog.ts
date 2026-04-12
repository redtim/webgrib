/**
 * Declarative catalog of HRRR weather variables, each with one or more
 * atmospheric levels. The panel shows variables; selecting one reveals a
 * level slider to move up/down the atmosphere.
 */

import type { ColormapName } from './colormaps.js';
import { accForecastQuery } from '../grib2/idx.js';

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
  range?: [number, number];
  unit?: string;
  format?: (v: number) => string;
}

// ---- helpers ----------------------------------------------------------------

const K_TO_C = (k: number): number => k - 273.15;
const K_TO_F = (k: number): number => (k - 273.15) * 9 / 5 + 32;
const fmtTemp = (v: number): string => `${K_TO_F(v).toFixed(1)} °F  (${K_TO_C(v).toFixed(1)} °C)`;
const fmtTempC = (v: number): string => `${v.toFixed(1)} °C`;
const fmtPct = (v: number): string => `${v.toFixed(0)} %`;
const fmtDbz = (v: number): string => `${v.toFixed(1)} dBZ`;
const KT_TO_MS = 0.514444;
const fmtWind = (v: number): string => `${(v / KT_TO_MS).toFixed(1)} kt  (${v.toFixed(1)} m/s)`;
const fmtMm = (v: number): string => `${v.toFixed(1)} mm`;
const fmtM = (v: number): string => `${v.toFixed(0)} m`;
const fmtJkg = (v: number): string => `${v.toFixed(0)} J/kg`;
const fmtPas = (v: number): string => `${v.toFixed(2)} Pa/s`;
const metersToMi = (v: number): string => `${(v / 1609.344).toFixed(1)} mi`;
const fmtM2s2 = (v: number): string => `${v.toFixed(0)} m\u00B2/s\u00B2`;
const fmtCm = (v: number): string => `${v.toFixed(1)} cm`;
const fmtKgm2s = (v: number): string => `${(v * 3600).toFixed(2)} mm/hr`;

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
    colormap: 'temperature', unit: '°F', format: fmtTemp,
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
    colormap: 'viridis', range: [0, 5000], unit: 'm', format: fmtM,
    levels: [scalarLevel('0°C iso', /^HGT$/, /^0C isotherm$/)],
  },

  // Wind
  {
    id: 'wind', group: 'Wind', label: 'Wind', kind: 'wind', unit: 'kt',
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
    colormap: 'wind', range: [0, 30.87], unit: 'kt', format: fmtWind,
    levels: [scalarLevel('Surface', /^GUST$/, /^surface$/)],
  },

  // Moisture
  {
    id: 'dewpoint', group: 'Moisture', label: 'Dew Point', kind: 'scalar',
    colormap: 'temperature', unit: '°F', format: fmtTemp,
    levels: [
      scalarLevel('2m', /^DPT$/, /^2 m above ground$/),
    ],
  },
  {
    id: 'rh', group: 'Moisture', label: 'Relative Humidity', kind: 'scalar',
    colormap: 'humidity', range: [0, 100], unit: '%', format: fmtPct,
    levels: [
      scalarLevel('2m', /^RH$/, /^2 m above ground$/),
      scalarLevel('850 hPa', /^RH$/, /^850 mb$/),
      scalarLevel('700 hPa', /^RH$/, /^700 mb$/),
    ],
  },

  // Instability
  {
    id: 'cape', group: 'Instability', label: 'CAPE', kind: 'scalar',
    colormap: 'cape', range: [0, 5000], unit: 'J/kg', format: fmtJkg,
    levels: [scalarLevel('Surface', /^CAPE$/, /^surface$/)],
  },
  {
    id: 'cin', group: 'Instability', label: 'CIN', kind: 'scalar',
    colormap: 'cin', range: [-500, 0], unit: 'J/kg', format: fmtJkg,
    levels: [scalarLevel('Surface', /^CIN$/, /^surface$/)],
  },
  {
    id: 'lftx', group: 'Instability', label: 'Lifted Index', kind: 'scalar',
    colormap: 'temperature', range: [-10, 10], unit: '°C', format: fmtTempC,
    levels: [scalarLevel('500-1000mb', /^LFTX$/, /^500-1000 mb$/)],
  },
  {
    id: 'helicity', group: 'Instability', label: 'Storm Rel. Helicity', kind: 'scalar',
    colormap: 'cape', range: [0, 500], unit: 'm\u00B2/s\u00B2', format: fmtM2s2,
    levels: [scalarLevel('0-3km', /^HLCY$/, /^3000-0 m above ground$/)],
  },

  // Precipitation
  {
    id: 'apcp', group: 'Precipitation', label: '1h Precipitation', kind: 'scalar',
    colormap: 'precipitation', range: [0, 50], unit: 'mm', format: fmtMm,
    levels: [{ label: 'Surface', query: { parameter: /^APCP$/, level: /^surface$/, forecast: accForecastQuery } }],
  },
  {
    id: 'prate', group: 'Precipitation', label: 'Precip Rate', kind: 'scalar',
    colormap: 'precipitation', range: [0, 0.01], unit: 'mm/hr', format: fmtKgm2s,
    levels: [scalarLevel('Surface', /^PRATE$/, /^surface$/)],
  },
  {
    id: 'snod', group: 'Precipitation', label: 'Snow Depth', kind: 'scalar',
    colormap: 'snow', range: [0, 1], unit: 'cm', format: (v) => fmtCm(v * 100),
    levels: [scalarLevel('Surface', /^SNOD$/, /^surface$/)],
  },
  {
    id: 'weasd', group: 'Precipitation', label: 'Snow Water Equiv.', kind: 'scalar',
    colormap: 'snow', range: [0, 50], unit: 'mm', format: fmtMm,
    levels: [scalarLevel('Surface', /^WEASD$/, /^surface$/)],
  },

  // Radar
  {
    id: 'refc', group: 'Radar', label: 'Composite Reflectivity', kind: 'scalar',
    colormap: 'turbo', range: [-10, 75], unit: 'dBZ', format: fmtDbz,
    levels: [scalarLevel('Entire atm', /^REFC$/, /entire atmosphere/)],
  },
  {
    id: 'retop', group: 'Radar', label: 'Echo Top', kind: 'scalar',
    colormap: 'viridis', range: [0, 20000], unit: 'm', format: fmtM,
    levels: [scalarLevel('Cloud top', /^RETOP$/, /^cloud top$/)],
  },

  // Clouds
  {
    id: 'cloud-cover', group: 'Clouds', label: 'Cloud Cover', kind: 'scalar',
    colormap: 'cloud', range: [0, 100], unit: '%', format: fmtPct,
    levels: [
      scalarLevel('Total', /^TCDC$/, /entire atmosphere/),
      scalarLevel('Low', /^LCDC$/, /^low cloud layer$/),
      scalarLevel('Mid', /^MCDC$/, /^middle cloud layer$/),
      scalarLevel('High', /^HCDC$/, /^high cloud layer$/),
    ],
  },
  {
    id: 'vis', group: 'Clouds', label: 'Surface Visibility', kind: 'scalar',
    colormap: 'viridis', range: [0, 24000], unit: 'mi', format: metersToMi,
    levels: [scalarLevel('Surface', /^VIS$/, /^surface$/)],
  },

  // Lightning
  {
    id: 'lightning', group: 'Lightning', label: 'Lightning Threat', kind: 'scalar',
    colormap: 'lightning', unit: 'fl/hr',
    format: (v: number) => `${v.toFixed(1)} flashes/hr`,
    levels: [scalarLevel('Entire Atm', /^LTNG$/, /^entire atmosphere$/)],
  },

  // Other
  {
    id: 'vvel', group: 'Other', label: 'Vertical Velocity', kind: 'scalar',
    colormap: 'temperature', range: [-10, 10], unit: 'Pa/s', format: fmtPas,
    levels: [
      scalarLevel('850 hPa', /^VVEL$/, /^850 mb$/),
      scalarLevel('700 hPa', /^VVEL$/, /^700 mb$/),
      scalarLevel('500 hPa', /^VVEL$/, /^500 mb$/),
    ],
  },
];

/** All groups in display order. */
export const GROUPS: string[] = [...new Set(CATALOG.map((v) => v.group))];

/** Look up a catalog variable by id. */
export function findVariable(id: string): CatalogVariable | undefined {
  return CATALOG.find((v) => v.id === id);
}
