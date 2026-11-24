import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  analyseRecord, buildDirectionalSpectrum, fourierDirectionFn, memDirectionFn,
  significantWaveHeight, peakFrequency, compass,
} from '../src/waves/spectrum.js';
import type { SpectrumRecord } from '../src/waves/spectrum.js';
import { mergeSpectralFiles, parseSpectralFile } from '../src/waves/ndbc.js';

const deg = (d: number): number => (d * Math.PI) / 180;

/** Integrate a spreading function over 0..2π. */
function integrate(D: (th: number) => number, n = 3600): number {
  let sum = 0;
  for (let k = 0; k < n; k++) sum += Math.max(0, D((2 * Math.PI * k) / n));
  return (sum * 2 * Math.PI) / n;
}

test('spreading functions integrate to one', () => {
  const fourier = fourierDirectionFn(deg(300), deg(300), 0.6, 0.3);
  assert.ok(Math.abs(integrate(fourier) - 1) < 0.02, `fourier ${integrate(fourier)}`);
  const mem = memDirectionFn(deg(300), deg(300), 0.6, 0.3);
  assert.ok(Math.abs(integrate(mem) - 1) < 0.02, `mem ${integrate(mem)}`);
});

test('both reconstructions reproduce the first directional moment', () => {
  // MEM may split into two lobes straddling the mean direction (its known
  // spurious bimodality), so test the moment it is built to honour rather
  // than the peak position: ∫D(θ)e^{iθ}dθ must equal r1·e^{iα1}.
  const a1 = deg(210);
  for (const [name, D] of [
    ['fourier', fourierDirectionFn(a1, a1, 0.8, 0.5)],
    ['mem', memDirectionFn(a1, a1, 0.8, 0.5)],
  ] as const) {
    let re = 0;
    let im = 0;
    const n = 3600;
    for (let k = 0; k < n; k++) {
      const th = (2 * Math.PI * k) / n;
      const d = D(th) * ((2 * Math.PI) / n);
      re += d * Math.cos(th);
      im += d * Math.sin(th);
    }
    assert.ok(Math.abs(re - 0.8 * Math.cos(a1)) < 0.01, `${name} re ${re}`);
    assert.ok(Math.abs(im - 0.8 * Math.sin(a1)) < 0.01, `${name} im ${im}`);
  }
});

/** Two Gaussian wave trains: 14 s swell from 290° and 6 s wind sea from 190°. */
function twoSystemRecord(): SpectrumRecord {
  const freqs: number[] = [];
  for (let f = 0.03; f <= 0.4001; f += 0.01) freqs.push(+f.toFixed(3));
  const energy: number[] = [];
  const alpha1: number[] = [];
  const alpha2: number[] = [];
  const r1: number[] = [];
  const r2: number[] = [];
  for (const f of freqs) {
    const swell = 6 * Math.exp(-(((f - 1 / 14) / 0.008) ** 2));
    const sea = 1.5 * Math.exp(-(((f - 1 / 6) / 0.03) ** 2));
    energy.push(swell + sea);
    const dir = swell > sea ? 290 : 190;
    alpha1.push(dir);
    alpha2.push(dir);
    r1.push(0.8);
    r2.push(0.5);
  }
  return { time: '2026-11-14T12:00', freqs, energy, alpha1, alpha2, r1, r2, hasDirection: true };
}

test('Hs and peak frequency from the 1-D spectrum', () => {
  const rec = twoSystemRecord();
  const hs = significantWaveHeight(rec.freqs, rec.energy);
  // m0 ≈ 6·0.008·√π + 1.5·0.03·√π ≈ 0.165 → Hs ≈ 1.63 m
  assert.ok(hs > 1.5 && hs < 1.8, `Hs ${hs}`);
  assert.ok(Math.abs(peakFrequency(rec.freqs, rec.energy) - 0.07) < 0.011);
});

test('directional grid conserves energy', () => {
  const rec = twoSystemRecord();
  const grid = buildDirectionalSpectrum(rec, 72, 'mem');
  const dth = (2 * Math.PI) / 72;
  for (let i = 0; i < grid.nFreq; i++) {
    let e = 0;
    for (let j = 0; j < 72; j++) e += grid.values[i * 72 + j]! * dth;
    const want = rec.energy[i]!;
    if (want < 0.05) continue;
    assert.ok(Math.abs(e - want) < 0.05 * want, `bin ${i}: ${e} vs ${want}`);
  }
});

test('partitioning separates swell from wind sea', () => {
  const rec = twoSystemRecord();
  for (const method of ['fourier', 'mem'] as const) {
    const { partitions } = analyseRecord(rec, 72, method);
    assert.ok(partitions.length >= 2, `${method}: ${partitions.length} systems`);
    const swell = partitions.find((p) => p.type === 'swell')!;
    const sea = partitions.find((p) => p.type === 'sea')!;
    assert.ok(swell && sea, `${method}: both types found`);
    assert.ok(Math.abs(swell.peakPeriod - 14) < 1.5, `${method}: swell Tp ${swell.peakPeriod}`);
    assert.ok(Math.abs(swell.meanDir - 290) < 15, `${method}: swell dir ${swell.meanDir}`);
    assert.ok(Math.abs(sea.peakPeriod - 6) < 1, `${method}: sea Tp ${sea.peakPeriod}`);
    assert.ok(Math.abs(sea.meanDir - 190) < 15, `${method}: sea dir ${sea.meanDir}`);
    assert.ok(swell.hs > sea.hs);
  }
});

test('compass labels', () => {
  assert.equal(compass(0), 'N');
  assert.equal(compass(292), 'WNW');
  assert.equal(compass(-90), 'W');
});

const SPEC = `#YY  MM DD hh mm Sep_Freq  < spec_1 (freq_1) spec_2 (freq_2) spec_3 (freq_3) ... >
2026 10 25 03 00 9.999 0.000 (0.025) 1.139 (0.065) 4.380 (0.105)
2026 10 25 02 00 0.080 0.100 (0.025) 1.000 (0.065) 4.000 (0.105)
2026 10 25 01 00 0.080 0.100 (0.025) 1.000 (0.065) 4.00`;

const SWDIR = `#YY  MM DD hh mm alpha1_1 (freq_1) ...
2026 10 25 03 00 300.0 (0.025) 192.0 (0.065) 316.0 (0.105)
`;

test('parseSpectralFile reads rows and drops a truncated last line', () => {
  const rows = parseSpectralFile(SPEC, true, true);
  assert.equal(rows.length, 2);
  assert.equal(rows[0]!.time, '2026-10-25T03:00');
  assert.deepEqual(rows[0]!.freqs, [0.025, 0.065, 0.105]);
  assert.deepEqual(rows[0]!.values, [0, 1.139, 4.38]);
  // Whole file: the short final line still parses whatever pairs it has.
  assert.equal(parseSpectralFile(SPEC, true, false).length, 3);
  const dir = parseSpectralFile(SWDIR, false);
  assert.equal(dir.length, 1);
  assert.deepEqual(dir[0]!.values, [300, 192, 316]);
});

test('mergeSpectralFiles joins on timestamp, oldest first', () => {
  const spec = parseSpectralFile(SPEC, true, true);
  const dir = parseSpectralFile(SWDIR, false);
  const recs = mergeSpectralFiles(spec, dir, dir, dir, dir);
  assert.equal(recs.length, 2);
  assert.equal(recs[0]!.time, '2026-10-25T02:00');
  assert.equal(recs[0]!.hasDirection, false);
  assert.equal(recs[1]!.hasDirection, true);
  assert.deepEqual(recs[1]!.alpha1, [300, 192, 316]);
});
