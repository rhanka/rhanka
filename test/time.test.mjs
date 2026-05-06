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
  assert.equal(window.start, '2025-05-04T00:00:00.000Z');
  assert.equal(window.end, '2026-05-02T23:59:59.999Z');
  assert.equal(window.weeks[0], '2025-05-04T00:00:00.000Z');
  assert.equal(window.weeks[51], '2026-04-26T00:00:00.000Z');

  for (let index = 1; index < window.weeks.length; index += 1) {
    assert.equal(
      Date.parse(window.weeks[index]) - Date.parse(window.weeks[index - 1]),
      7 * 24 * 60 * 60 * 1000
    );
  }
});
