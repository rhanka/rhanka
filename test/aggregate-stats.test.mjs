import test from 'node:test';
import assert from 'node:assert/strict';
import { aggregateStats } from '../src/aggregate-stats.mjs';

test('aggregateStats aligns weekly series and ranks repos by last activity in the last 4 weeks', () => {
  const weeks = [
    '2026-04-05T00:00:00.000Z',
    '2026-04-12T00:00:00.000Z',
    '2026-04-19T00:00:00.000Z',
    '2026-04-26T00:00:00.000Z'
  ];

  const commits = [
    {
      repo: 'rhanka/graphify',
      weekStart: '2026-04-19T00:00:00.000Z',
      authoredAt: '2026-04-20T10:00:00.000Z',
      additions: 10,
      deletions: 2
    },
    {
      repo: 'rhanka/graphify',
      weekStart: '2026-04-19T00:00:00.000Z',
      authoredAt: '2026-04-22T08:00:00.000Z',
      additions: 4,
      deletions: 1
    },
    {
      repo: 'rhanka/rhanka',
      weekStart: '2026-04-26T00:00:00.000Z',
      authoredAt: '2026-04-27T09:00:00.000Z',
      additions: 3,
      deletions: 5
    }
  ];

  const summary = aggregateStats({ weeks, commits });

  assert.deepEqual(summary.weeklyCommits, [
    { weekStart: '2026-04-05T00:00:00.000Z', count: 0 },
    { weekStart: '2026-04-12T00:00:00.000Z', count: 0 },
    { weekStart: '2026-04-19T00:00:00.000Z', count: 2 },
    { weekStart: '2026-04-26T00:00:00.000Z', count: 1 }
  ]);

  assert.deepEqual(summary.weeklyLines, [
    { weekStart: '2026-04-05T00:00:00.000Z', additions: 0, deletions: 0, net: 0 },
    { weekStart: '2026-04-12T00:00:00.000Z', additions: 0, deletions: 0, net: 0 },
    { weekStart: '2026-04-19T00:00:00.000Z', additions: 14, deletions: 3, net: 11 },
    { weekStart: '2026-04-26T00:00:00.000Z', additions: 3, deletions: 5, net: -2 }
  ]);

  assert.deepEqual(summary.topReposLast4Weeks, [
    {
      repo: 'rhanka/rhanka',
      lastActivityAt: '2026-04-27T09:00:00.000Z',
      commits4w: 1,
      lines4w: 8
    },
    {
      repo: 'rhanka/graphify',
      lastActivityAt: '2026-04-22T08:00:00.000Z',
      commits4w: 2,
      lines4w: 17
    }
  ]);
});

test('aggregateStats ignores commits outside the four-week window', () => {
  const weeks = [
    '2026-03-29T00:00:00.000Z',
    '2026-04-05T00:00:00.000Z',
    '2026-04-12T00:00:00.000Z',
    '2026-04-19T00:00:00.000Z',
    '2026-04-26T00:00:00.000Z'
  ];

  const summary = aggregateStats({
    weeks,
    commits: [
      {
        repo: 'rhanka/graphify',
        weekStart: '2026-04-26T00:00:00.000Z',
        authoredAt: '2026-04-27T09:00:00.000Z',
        additions: 3,
        deletions: 5
      },
      {
        repo: 'rhanka/graphify',
        weekStart: '2026-03-29T00:00:00.000Z',
        authoredAt: '2026-03-30T09:00:00.000Z',
        additions: 100,
        deletions: 100
      }
    ]
  });

  assert.deepEqual(summary.topReposLast4Weeks, [
    {
      repo: 'rhanka/graphify',
      lastActivityAt: '2026-04-27T09:00:00.000Z',
      commits4w: 1,
      lines4w: 8
    }
  ]);
});

test('aggregateStats reads commit.stats when root line counts are absent', () => {
  const weeks = ['2026-04-26T00:00:00.000Z'];

  const summary = aggregateStats({
    weeks,
    commits: [
      {
        repo: 'rhanka/graphify',
        weekStart: '2026-04-26T00:00:00.000Z',
        authoredAt: '2026-04-27T09:00:00.000Z',
        commit: { stats: { additions: 7, deletions: 4 } }
      }
    ]
  });

  assert.deepEqual(summary.weeklyCommits, [
    { weekStart: '2026-04-26T00:00:00.000Z', count: 1 }
  ]);

  assert.deepEqual(summary.weeklyLines, [
    { weekStart: '2026-04-26T00:00:00.000Z', additions: 7, deletions: 4, net: 3 }
  ]);

  assert.deepEqual(summary.topReposLast4Weeks, [
    {
      repo: 'rhanka/graphify',
      lastActivityAt: '2026-04-27T09:00:00.000Z',
      commits4w: 1,
      lines4w: 11
    }
  ]);
});

test('aggregateStats prefers root line counts over commit.stats', () => {
  const weeks = ['2026-04-26T00:00:00.000Z'];

  const summary = aggregateStats({
    weeks,
    commits: [
      {
        repo: 'rhanka/graphify',
        weekStart: '2026-04-26T00:00:00.000Z',
        authoredAt: '2026-04-27T09:00:00.000Z',
        additions: 3,
        deletions: 5,
        commit: { stats: { additions: 70, deletions: 40 } }
      }
    ]
  });

  assert.deepEqual(summary.weeklyLines, [
    { weekStart: '2026-04-26T00:00:00.000Z', additions: 3, deletions: 5, net: -2 }
  ]);

  assert.deepEqual(summary.topReposLast4Weeks, [
    {
      repo: 'rhanka/graphify',
      lastActivityAt: '2026-04-27T09:00:00.000Z',
      commits4w: 1,
      lines4w: 8
    }
  ]);
});
