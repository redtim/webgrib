/**
 * End-to-end smoke test: fetches a recent HRRR message from NOAA's public S3
 * bucket, decodes it with our parser, and asserts the basics (grid shape,
 * value bounds). Skipped automatically if we can't reach the network.
 *
 * Only hits templates 5.0 and 5.3 (TMP uses complex packing with spatial
 * differencing in HRRR). 5.40 (JPEG2000) requires a decoder be registered
 * before the test is meaningful — see `jpxBootstrap.ts`.
 *
 * Run: `npm test`
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { decodeMessage, fetchMessageBytes, hrrrUrls, walkMessages } from '../src/grib2/index.js';
import type { LambertConformalGrid } from '../src/grib2/types.js';

async function mostRecentCycle(): Promise<string> {
  // Step back hour by hour until a cycle's idx file exists.
  const now = new Date(Date.now() - 2 * 3600 * 1000); // 2h safety
  for (let i = 0; i < 12; i++) {
    const d = new Date(now.getTime() - i * 3600 * 1000);
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, '0');
    const day = String(d.getUTCDate()).padStart(2, '0');
    const h = String(d.getUTCHours()).padStart(2, '0');
    const cycle = `${y}${m}${day}${h}`;
    const urls = hrrrUrls(cycle, 0);
    try {
      const res = await fetch(urls.idx, { method: 'HEAD' });
      if (res.ok) return cycle;
    } catch {
      // fall through
    }
  }
  throw new Error('No reachable HRRR cycle found');
}

// We try the test, but mark it as skipped rather than failed if network is
// unavailable — this lets offline runs still pass `npm test`.
async function maybeFetchOrSkip<T>(fn: () => Promise<T>, t: { skip: (reason?: string) => void }): Promise<T | undefined> {
  try {
    return await fn();
  } catch (err) {
    t.skip(`network unavailable: ${(err as Error).message}`);
    return undefined;
  }
}

test('HRRR UGRD 10m decode (simple packing 5.0)', async (t) => {
  const cycle = await maybeFetchOrSkip(mostRecentCycle, t);
  if (!cycle) return;
  const urls = hrrrUrls(cycle, 0);
  const res = await maybeFetchOrSkip(
    () => fetchMessageBytes(urls.idx, { parameter: /^UGRD$/, level: /^10 m above ground$/ }),
    t,
  );
  if (!res) return;
  const [msg] = [...walkMessages(res.bytes)];
  if (!msg) throw new Error('no message parsed');
  assert.equal(msg.section5.template, 0);
  const field = await decodeMessage(msg);
  assert.ok(field.min >= -120 && field.min <= 120, `U wind min in m/s range, got ${field.min}`);
  assert.ok(field.max >= -120 && field.max <= 120, `U wind max in m/s range, got ${field.max}`);
});

test('HRRR VIS decode (spatial diff 5.3)', async (t) => {
  const cycle = await maybeFetchOrSkip(mostRecentCycle, t);
  if (!cycle) return;
  const urls = hrrrUrls(cycle, 0);
  const res = await maybeFetchOrSkip(
    () => fetchMessageBytes(urls.idx, { parameter: /^VIS$/, level: /^surface$/ }),
    t,
  );
  if (!res) return;
  const [msg] = [...walkMessages(res.bytes)];
  if (!msg) throw new Error('no message parsed');
  assert.equal(msg.section5.template, 3);
  const field = await decodeMessage(msg);
  // Visibility is in meters; HRRR caps it at 24140 (~15 mi) or similar.
  assert.ok(field.min >= 0 && field.min <= 100000, `VIS min reasonable, got ${field.min}`);
  assert.ok(field.max >= 0 && field.max <= 100000, `VIS max reasonable, got ${field.max}`);
});

test('HRRR REFC decode (spatial diff 5.3)', async (t) => {
  const cycle = await maybeFetchOrSkip(mostRecentCycle, t);
  if (!cycle) return;
  const urls = hrrrUrls(cycle, 0);
  const res = await maybeFetchOrSkip(
    () => fetchMessageBytes(urls.idx, { parameter: /^REFC$/, level: /entire atmosphere/ }),
    t,
  );
  if (!res) return;

  const messages = [...walkMessages(res.bytes)];
  assert.equal(messages.length, 1, 'range-fetched bytes should contain exactly one message');
  const msg = messages[0]!;

  // HRRR is template 3.30 (Lambert Conformal)
  assert.equal(msg.section3.grid.template, 30);
  const g = msg.section3.grid as LambertConformalGrid;
  assert.equal(g.nx, 1799);
  assert.equal(g.ny, 1059);
  assert.ok(Math.abs(g.dx - 3000) < 1, `HRRR dx ≈ 3000m, got ${g.dx}`);
  assert.ok(Math.abs(g.dy - 3000) < 1, `HRRR dy ≈ 3000m, got ${g.dy}`);
  assert.ok(Math.abs(g.latin1 + 38.5) < 1 || Math.abs(g.latin1 - 38.5) < 1, 'HRRR latin1 ≈ 38.5°');

  // Decode. REFC is usually template 5.3 (complex + spatial diff), nothing
  // wrong with 5.0 either; both are supported without external decoders.
  let field;
  try {
    field = await decodeMessage(msg);
  } catch (err) {
    // REFC is sometimes 5.40 (JPEG2000). If so, the bundled decoder isn't
    // loaded in Node — skip rather than fail.
    if (String(err).includes('JPEG2000')) {
      t.skip('REFC is JPEG2000-packed in this cycle; no JPX decoder in Node test env');
      return;
    }
    throw err;
  }
  assert.equal(field.values.length, g.nx * g.ny);
  assert.ok(field.min >= -40 && field.min <= 100, `REFC min in dBZ range, got ${field.min}`);
  assert.ok(field.max >= -40 && field.max <= 100, `REFC max in dBZ range, got ${field.max}`);
});
