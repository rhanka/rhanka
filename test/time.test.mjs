import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRollingWindow, weekStartUtc } from '../src/time.mjs';

test('weekStartUtc normalizes any timestamp to sunday 00:00:00.000Z', () => {
  assert.equal(
    weekStartUtc('2026-04-26T15:37:00.000Z'),
    '2026-04-26T00:00:00.000Z'
  );
  assert.equal(
    weekStartUtc('2026-04-29T11:00:00.000Z'),
    '2026-04-26T00:00:00.000Z'
  );
});

test('buildRollingWindow returns 52 ordered weeks ending on the target week', () => {
  const window = buildRollingWindow('2026-04-26T15:37:00.000Z', 52);
  assert.equal(window.weeks.length, 52);
  assert.equal(window.weeks[0], '2025-05-04T00:00:00.000Z');
  assert.equal(window.weeks[51], '2026-04-26T00:00:00.000Z');
});
