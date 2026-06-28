import test from 'node:test';
import assert from 'node:assert/strict';
import { aggregateStats } from '../src/aggregate-stats.mjs';

test('aggregateStats aligns weekly series and ranks repos by lines changed in the last 5 weeks', () => {
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

  assert.deepEqual(summary.topReposLast5Weeks, [
    {
      repo: 'rhanka/graphify',
      lastActivityAt: '2026-04-22T08:00:00.000Z',
      commits5w: 2,
      lines5w: 17
    },
    {
      repo: 'rhanka/rhanka',
      lastActivityAt: '2026-04-27T09:00:00.000Z',
      commits5w: 1,
      lines5w: 8
    }
  ]);
});

test('aggregateStats ranks a higher-volume repo above a more recently active one', () => {
  const weeks = [
    '2026-04-05T00:00:00.000Z',
    '2026-04-12T00:00:00.000Z',
    '2026-04-19T00:00:00.000Z',
    '2026-04-26T00:00:00.000Z'
  ];

  const commits = [
    {
      repo: 'rhanka/big',
      weekStart: '2026-04-19T00:00:00.000Z',
      authoredAt: '2026-04-20T10:00:00.000Z',
      additions: 200,
      deletions: 30
    },
    {
      repo: 'rhanka/fresh',
      weekStart: '2026-04-26T00:00:00.000Z',
      authoredAt: '2026-04-27T09:00:00.000Z',
      additions: 1,
      deletions: 0
    }
  ];

  const summary = aggregateStats({ weeks, commits });

  assert.deepEqual(summary.topReposLast5Weeks, [
    {
      repo: 'rhanka/big',
      lastActivityAt: '2026-04-20T10:00:00.000Z',
      commits5w: 1,
      lines5w: 230
    },
    {
      repo: 'rhanka/fresh',
      lastActivityAt: '2026-04-27T09:00:00.000Z',
      commits5w: 1,
      lines5w: 1
    }
  ]);
});

test('aggregateStats ignores commits outside the five-week window', () => {
  const weeks = [
    '2026-03-22T00:00:00.000Z',
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
        weekStart: '2026-03-22T00:00:00.000Z',
        authoredAt: '2026-03-23T09:00:00.000Z',
        additions: 100,
        deletions: 100
      }
    ]
  });

  assert.deepEqual(summary.topReposLast5Weeks, [
    {
      repo: 'rhanka/graphify',
      lastActivityAt: '2026-04-27T09:00:00.000Z',
      commits5w: 1,
      lines5w: 8
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

  assert.deepEqual(summary.topReposLast5Weeks, [
    {
      repo: 'rhanka/graphify',
      lastActivityAt: '2026-04-27T09:00:00.000Z',
      commits5w: 1,
      lines5w: 11
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
        rawAdditions: 70,
        rawDeletions: 40,
        commit: { stats: { additions: 70, deletions: 40 } }
      }
    ]
  });

  assert.deepEqual(summary.weeklyLines, [
    { weekStart: '2026-04-26T00:00:00.000Z', additions: 3, deletions: 5, net: -2 }
  ]);
  assert.deepEqual(summary.weeklyLinesRaw, [
    { weekStart: '2026-04-26T00:00:00.000Z', additions: 70, deletions: 40, net: 30 }
  ]);

  assert.deepEqual(summary.topReposLast5Weeks, [
    {
      repo: 'rhanka/graphify',
      lastActivityAt: '2026-04-27T09:00:00.000Z',
      commits5w: 1,
      lines5w: 8
    }
  ]);
});
