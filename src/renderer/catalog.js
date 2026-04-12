/**
 * Declarative catalog of HRRR weather variables, each with one or more
 * atmospheric levels. The panel shows variables; selecting one reveals a
 * level slider to move up/down the atmosphere.
 */
// ---- helpers ----------------------------------------------------------------
const K_TO_C = (k) => k - 273.15;
const K_TO_F = (k) => (k - 273.15) * 9 / 5 + 32;
const fmtTemp = (v) => `${K_TO_F(v).toFixed(1)} °F  (${K_TO_C(v).toFixed(1)} °C)`;
const fmtTempC = (v) => `${v.toFixed(1)} °C`;
const fmtPct = (v) => `${v.toFixed(0)} %`;
const fmtDbz = (v) => `${v.toFixed(1)} dBZ`;
const KT_TO_MS = 0.514444;
const fmtWind = (v) => `${(v / KT_TO_MS).toFixed(1)} kt  (${v.toFixed(1)} m/s)`;
const fmtMm = (v) => `${v.toFixed(1)} mm`;
const fmtM = (v) => `${v.toFixed(0)} m`;
const fmtJkg = (v) => `${v.toFixed(0)} J/kg`;
const fmtPas = (v) => `${v.toFixed(2)} Pa/s`;
const metersToMi = (v) => `${(v / 1609.344).toFixed(1)} mi`;
const fmtM2s2 = (v) => `${v.toFixed(0)} m\u00B2/s\u00B2`;
const fmtCm = (v) => `${v.toFixed(1)} cm`;
const fmtKgm2s = (v) => `${(v * 3600).toFixed(2)} mm/hr`;
// ---- shorthand level builder ------------------------------------------------
function scalarLevel(label, parameter, level) {
    return { label, query: { parameter, level } };
}
function windLevel(label, uParam, vParam, level) {
    return { label, queryU: { parameter: uParam, level }, queryV: { parameter: vParam, level } };
}
// ---- catalog ----------------------------------------------------------------
export const CATALOG = [
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
        colormap: 'cape', range: [-500, 0], unit: 'J/kg', format: fmtJkg,
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
        levels: [scalarLevel('Surface', /^APCP$/, /^surface$/)],
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
export const GROUPS = [...new Set(CATALOG.map((v) => v.group))];
/** Look up a catalog variable by id. */
export function findVariable(id) {
    return CATALOG.find((v) => v.id === id);
}
