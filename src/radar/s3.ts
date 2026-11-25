/**
 * Discovery of Level II files in the public NEXRAD bucket. Keys look like
 * `YYYY/MM/DD/SITE/SITEYYYYMMDD_HHMMSS_V06`, dated in UTC; older ones end
 * `_V06.gz`, `_V03.gz` or just `.gz`. (The older `noaa-nexrad-level2` bucket no
 * longer allows anonymous access.)
 */

const BUCKET_URL = 'https://unidata-nexrad-level2.s3.amazonaws.com';

const DAY_MS = 86_400_000;

/** The tail of a scan's key; `_MDM` metadata files do not match. */
const SCAN_NAME = /(\d{4})(\d\d)(\d\d)_(\d\d)(\d\d)(\d\d)(?:_V0\d)?(?:\.gz)?$/;

export interface ScanFile {
  key: string;
  /** Start of the scan, ms since the epoch. */
  time: number;
  /** File size in bytes. */
  size: number;
}

function datePrefix(date: Date): string {
  return `${date.toISOString().slice(0, 10).replaceAll('-', '/')}/`;
}

/** A listing's XML, with any further pages appended. */
async function list(params: Record<string, string>, fetchFn: typeof fetch): Promise<string> {
  let pages = '';
  let token: string | undefined;
  do {
    const query = new URLSearchParams({ 'list-type': '2', ...params });
    if (token) query.set('continuation-token', token);
    const response = await fetchFn(`${BUCKET_URL}/?${query}`, { cache: 'no-store' });
    if (!response.ok) throw new Error(`Radar file listing failed (HTTP ${response.status})`);
    const page = await response.text();
    pages += page;
    token = page.includes('<IsTruncated>true</IsTruncated>')
      ? /<NextContinuationToken>([^<]+)</.exec(page)?.[1]
      : undefined;
  } while (token);
  return pages;
}

/** One site's scans in the given date folders (`YYYY/MM/DD/`), oldest first. */
export async function listScans(site: string, folders: string[], fetchFn: typeof fetch = fetch): Promise<ScanFile[]> {
  const listings = await Promise.all(folders.map((f) => list({ prefix: `${f}${site}/` }, fetchFn)));
  const scans: ScanFile[] = [];
  for (const xml of listings) {
    for (const [, entry] of xml.matchAll(/<Contents>(.*?)<\/Contents>/gs)) {
      const key = /<Key>([^<]+)<\/Key>/.exec(entry!)?.[1];
      const time = key ? scanTimeFromKey(key) : null;
      if (key && time) scans.push({ key, time: time.getTime(), size: Number(/<Size>(\d+)<\/Size>/.exec(entry!)?.[1] ?? 0) });
    }
  }
  return scans.sort((a, b) => a.time - b.time);
}

/** Keys of a site's newest `count` complete scans, oldest first, looking back one day. */
export async function findRecentScans(
  site: string,
  count: number,
  now: Date = new Date(),
  fetchFn: typeof fetch = fetch,
): Promise<string[]> {
  let found: string[] = [];
  for (const date of [now, new Date(now.getTime() - DAY_MS)]) {
    const xml = await list({ prefix: `${datePrefix(date)}${site}/` }, fetchFn);
    const scans = [...xml.matchAll(/<Key>([^<]+)<\/Key>/g)].map((m) => m[1]!).filter((k) => SCAN_NAME.test(k)).sort();
    found = [...scans, ...found];
    if (found.length >= count) break;
  }
  return found.slice(-count);
}

/** Site identifiers with files in any of the date folders, sorted. */
export async function listSitesOn(folders: string[], fetchFn: typeof fetch = fetch): Promise<string[]> {
  const sites = new Set<string>();
  const listings = await Promise.all(folders.map((prefix) => list({ prefix, delimiter: '/' }, fetchFn)));
  for (const xml of listings) {
    for (const match of xml.matchAll(/<Prefix>\d{4}\/\d\d\/\d\d\/([A-Z0-9]{4})\/<\/Prefix>/g)) sites.add(match[1]!);
  }
  return [...sites].sort();
}

/** Site identifiers with files from today or yesterday, sorted. */
export function listSites(now: Date = new Date(), fetchFn: typeof fetch = fetch): Promise<string[]> {
  return listSitesOn([datePrefix(now), datePrefix(new Date(now.getTime() - DAY_MS))], fetchFn);
}

export function scanTimeFromKey(key: string): Date | null {
  const m = SCAN_NAME.exec(key);
  if (!m) return null;
  const [, year, month, day, hour, minute, second] = m;
  return new Date(`${year}-${month}-${day}T${hour}:${minute}:${second}Z`);
}

export function scanUrl(key: string): string {
  return `${BUCKET_URL}/${key}`;
}
