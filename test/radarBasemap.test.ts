import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';

import { fallBackIfStyleFails, type StyleHost } from '../src/radar/basemap.js';

const blank = { version: 8 as const, sources: {}, layers: [] };

function setup(t: TestContext) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const listeners: Record<string, (() => void)[]> = {};
  const styles: unknown[] = [];
  let fallbacks = 0;
  const map: StyleHost = {
    on: (type, listener) => void (listeners[type] ??= []).push(listener),
    setStyle: (style) => void styles.push(style),
  };
  fallBackIfStyleFails(map, blank, () => fallbacks++, 10_000);
  const emit = (type: string) => listeners[type]?.forEach((l) => l());
  return { emit, styles, count: () => fallbacks, wait: (ms: number) => t.mock.timers.tick(ms) };
}

test('switches to a blank map when the style fails to load, once', (t) => {
  const { emit, styles, count, wait } = setup(t);
  emit('error');
  emit('error');
  wait(20_000);
  assert.deepEqual([styles, count()], [[blank], 1]);
});

test('switches to a blank map when the style never arrives', (t) => {
  const { styles, wait } = setup(t);
  wait(9_999);
  assert.equal(styles.length, 0);
  wait(1);
  assert.deepEqual(styles, [blank]);
});

test('keeps a style that loaded, whatever fails afterwards', (t) => {
  const { emit, styles, wait } = setup(t);
  emit('style.load');
  emit('error'); // a missing tile
  wait(20_000);
  assert.equal(styles.length, 0);
});
