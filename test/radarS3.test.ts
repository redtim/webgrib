import { test } from 'node:test';
import assert from 'node:assert/strict';

import { findRecentScans, listScans, listSites, listSitesOn, scanTimeFromKey, scanUrl } from '../src/radar/s3.js';

/** Stands in for the bucket: maps a listed prefix to its XML. */
function bucket(listings: Record<string, string>) {
  const requested: string[] = [];
  const fetchFn = (async (input: string | URL | Request) => {
    const prefix = new URL(String(input)).searchParams.get('prefix')!;
    requested.push(prefix);
    return new Response(`<ListBucketResult><Prefix>${prefix}</Prefix>${listings[prefix] ?? ''}</ListBucketResult>`);
  }) as typeof fetch;
  return { fetchFn, requested };
}

const keys = (...names: string[]) => names.map((k) => `<Contents><Key>${k}</Key></Contents>`).join('');
const folders = (...names: string[]) => names.map((p) => `<CommonPrefixes><Prefix>${p}</Prefix></CommonPrefixes>`).join('');

const now = new Date('2026-11-25T00:03:00Z');

const scanKey = (day: string, time: string) => `2026/11/${day}/KMUX/KMUX202611${day}_${time}_V06`;

test('lists the newest scans oldest first, ignoring metadata files', async () => {
  const { fetchFn, requested } = bucket({
    '2026/11/25/KMUX/': keys(
      scanKey('25', '000010'),
      scanKey('25', '000100'),
      scanKey('25', '000200'),
      `${scanKey('25', '000200')}_MDM`,
    ),
  });
  assert.deepEqual(await findRecentScans('KMUX', 2, now, fetchFn), [scanKey('25', '000100'), scanKey('25', '000200')]);
  assert.deepEqual(requested, ['2026/11/25/KMUX/']);
});

test('reaches into yesterday to fill the window after midnight UTC', async () => {
  const { fetchFn, requested } = bucket({
    '2026/11/25/KMUX/': keys(scanKey('25', '000010')),
    '2026/11/24/KMUX/': keys(scanKey('24', '234800'), scanKey('24', '235300'), scanKey('24', '235800')),
  });
  assert.deepEqual(await findRecentScans('KMUX', 3, now, fetchFn), [
    scanKey('24', '235300'), scanKey('24', '235800'), scanKey('25', '000010'),
  ]);
  assert.deepEqual(requested, ['2026/11/25/KMUX/', '2026/11/24/KMUX/']);
});

test('reports no scans for a silent site', async () => {
  assert.deepEqual(await findRecentScans('KZZZ', 5, now, bucket({}).fetchFn), []);
});

test('surfaces a failed listing', async () => {
  const denied = (async () => new Response('<Error/>', { status: 403 })) as typeof fetch;
  await assert.rejects(findRecentScans('KMUX', 1, now, denied), /403/);
});

test('lists sites that reported today or yesterday, once each', async () => {
  const { fetchFn } = bucket({
    '2026/11/25/': folders('2026/11/25/KMUX/', '2026/11/25/KDAX/'),
    '2026/11/24/': folders('2026/11/24/KMUX/', '2026/11/24/KABR/'),
  });
  assert.deepEqual(await listSites(now, fetchFn), ['KABR', 'KDAX', 'KMUX']);
});

test('reads the scan time from a key and builds its URL', () => {
  const key = '2026/11/24/KMUX/KMUX20261124_235800_V06';
  assert.equal(scanTimeFromKey(key)!.toISOString(), '2026-11-24T23:58:00.000Z');
  assert.equal(scanUrl(key), `https://unidata-nexrad-level2.s3.amazonaws.com/${key}`);
});

const object = (key: string, size: number) =>
  `<Contents><Key>${key}</Key><LastModified>2025-06-28T17:30:26.000Z</LastModified><ETag>&quot;x&quot;</ETag><Size>${size}</Size><StorageClass>STANDARD</StorageClass></Contents>`;

test('lists a day of scans under every historical naming, with sizes and times', async () => {
  const { fetchFn } = bucket({
    '2013/05/20/KTLX/': [
      object('2013/05/20/KTLX/KTLX20130520_120000_V06.gz', 40),
      object('2013/05/20/KTLX/KTLX20130520_110000_V03.gz', 30),
      object('2013/05/20/KTLX/KTLX20130520_100000.gz', 20),
      object('2013/05/20/KTLX/KTLX20130520_130000_V06', 50),
      object('2013/05/20/KTLX/KTLX20130520_130000_V06_MDM', 1),
    ].join(''),
  });
  const scans = await listScans('KTLX', ['2013/05/20/'], fetchFn);
  assert.deepEqual(scans.map((s) => s.size), [20, 30, 40, 50]);
  assert.equal(new Date(scans[0]!.time).toISOString(), '2013-05-20T10:00:00.000Z');
  assert.equal(scans[3]!.key, '2013/05/20/KTLX/KTLX20130520_130000_V06');
});

test('merges two date folders in time order', async () => {
  const { fetchFn, requested } = bucket({
    '2013/05/21/KTLX/': object('2013/05/21/KTLX/KTLX20130521_000100_V06.gz', 2),
    '2013/05/20/KTLX/': object('2013/05/20/KTLX/KTLX20130520_235900_V06.gz', 1),
  });
  const scans = await listScans('KTLX', ['2013/05/21/', '2013/05/20/'], fetchFn);
  assert.deepEqual(scans.map((s) => s.size), [1, 2]);
  assert.equal(requested.length, 2);
});

test('lists the sites of chosen date folders', async () => {
  const { fetchFn } = bucket({ '2013/05/20/': folders('2013/05/20/KTLX/', '2013/05/20/KFDR/') });
  assert.deepEqual(await listSitesOn(['2013/05/20/'], fetchFn), ['KFDR', 'KTLX']);
});

test('reads the scan time from a gzip-era name', () => {
  assert.equal(scanTimeFromKey('1999/05/03/KTLX/KTLX19990503_125138.gz')!.toISOString(), '1999-05-03T12:51:38.000Z');
});

/** A bucket that hands out one listing in pages, as S3 does past 1,000 entries. */
function paged(...pages: string[]) {
  return (async (input: string | URL | Request) => {
    const page = Number(new URL(String(input)).searchParams.get('continuation-token') ?? 0);
    const more = page + 1 < pages.length;
    return new Response(`<ListBucketResult><IsTruncated>${more}</IsTruncated>${
      more ? `<NextContinuationToken>${page + 1}</NextContinuationToken>` : ''}${pages[page]}</ListBucketResult>`);
  }) as typeof fetch;
}

test('follows a listing onto further pages', async () => {
  const scans = await listScans('KTLX', ['2013/05/20/'], paged(
    object('2013/05/20/KTLX/KTLX20130520_100000_V06', 1),
    object('2013/05/20/KTLX/KTLX20130520_110000_V06', 2),
  ));
  assert.deepEqual(scans.map((s) => s.size), [1, 2]);
  const sites = await listSitesOn(['2013/05/20/'], paged(folders('2013/05/20/KFDR/'), folders('2013/05/20/KTLX/')));
  assert.deepEqual(sites, ['KFDR', 'KTLX']);
});
