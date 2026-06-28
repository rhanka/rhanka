import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildLiveStats,
  discoverReposForLogins,
  findRequiredRepoCoverageFailure,
  findStatsRegression,
  main,
  mapWithConcurrency,
  resolveGithubToken,
  totalWindowCommits
} from '../scripts/github-profile-stats.mjs';

const commitCacheSchemaVersion = 1;

function buildEmptyCommitCache() {
  return {
    schemaVersion: commitCacheSchemaVersion,
    updatedAt: '2026-01-01T00:00:00.000Z',
    entries: {}
  };
}

function withNoCommitCache(overrides = {}) {
  return {
    loadCommitDetailsCacheImpl: async () => buildEmptyCommitCache(),
    saveCommitDetailsCacheImpl: async () => {},
    ...overrides
  };
}

test('github-profile-stats write mode requires a GitHub token for live collection', async () => {
  await assert.rejects(
    () =>
      main({
        argv: ['--write'],
        env: {
          ...process.env,
          PROFILE_STATS_TOKEN: '',
          GITHUB_TOKEN: ''
        }
      }),
    /PROFILE_STATS_TOKEN or GITHUB_TOKEN is required for live API collection/
  );
});

test('resolveGithubToken falls back to GITHUB_TOKEN when PROFILE_STATS_TOKEN is empty', () => {
  assert.equal(
    resolveGithubToken({
      PROFILE_STATS_TOKEN: '',
      GITHUB_TOKEN: 'fallback-token'
    }),
    'fallback-token'
  );
});

test('mapWithConcurrency runs more than one task in parallel without exceeding the limit', async () => {
  let activeTasks = 0;
  let maxActiveTasks = 0;

  const results = await mapWithConcurrency(2, [1, 2, 3, 4], async (value) => {
    activeTasks += 1;
    maxActiveTasks = Math.max(maxActiveTasks, activeTasks);
    await new Promise((resolve) => setTimeout(resolve, 20));
    activeTasks -= 1;
    return value * 10;
  });

  assert.deepEqual(results, [10, 20, 30, 40]);
  assert.equal(maxActiveTasks > 1, true);
  assert.equal(maxActiveTasks <= 2, true);
});

test('discoverReposForLogins merges repos across configured logins and keeps any available default branch', async () => {
  const repos = await discoverReposForLogins({
    logins: ['rhanka', 'rhanka-alt'],
    from: '2026-04-01T00:00:00.000Z',
    to: '2026-04-30T23:59:59.999Z',
    token: 'secret-token',
    discoverReposImpl: async ({ login }) => {
      if (login === 'rhanka') {
        return [
          { repo: 'org/alpha', defaultBranch: null },
          { repo: 'org/beta', defaultBranch: 'develop' }
        ];
      }

      return [
        { repo: 'org/alpha', defaultBranch: 'main' },
        { repo: 'org/gamma', defaultBranch: null }
      ];
    }
  });

  assert.deepEqual(repos, [
    { repo: 'org/alpha', defaultBranch: 'main' },
    { repo: 'org/beta', defaultBranch: 'develop' },
    { repo: 'org/gamma', defaultBranch: null }
  ]);
});

test('discoverReposForLogins warns when GitHub discovery returns 100 repos for a login', async () => {
  const warnings = [];

  await discoverReposForLogins({
    logins: ['rhanka'],
    from: '2026-04-01T00:00:00.000Z',
    to: '2026-04-30T23:59:59.999Z',
    token: 'secret-token',
    warn: (message) => warnings.push(message),
    discoverReposImpl: async () =>
      Array.from({ length: 100 }, (_, index) => ({
        repo: `org/repo-${index}`,
        defaultBranch: 'main'
      }))
  });

  assert.deepEqual(warnings, [
    '[github-profile-stats] repo discovery for login "rhanka" returned 100 repositories; results may be truncated'
  ]);
});

test('buildLiveStats warns and skips failing repos and failing commit details', async () => {
  const warnings = [];
  const config = {
    identities: {
      logins: ['rhanka', 'antoinefa'],
      emails: ['rhanka@example.com', 'antoinefa@example.com']
    },
    includeRepos: ['org/included'],
    excludeRepos: ['org/excluded'],
    windowWeeks: 1
  };
  const authoredAt = '2026-04-29T11:00:00.000Z';

  const stats = await buildLiveStats(config, 'secret-token', {
    nowIso: '2026-04-30T12:00:00.000Z',
    warn: (message) => warnings.push(message),
    ...withNoCommitCache(),
    discoverReposForLoginsImpl: async () => [
      { repo: 'org/good', defaultBranch: 'main' },
      { repo: 'org/no-branch', defaultBranch: null },
      { repo: 'org/bad-list', defaultBranch: 'main' },
      { repo: 'org/excluded', defaultBranch: 'main' }
    ],
    listCommitsForRepoImpl: async ({ owner, repo, commitMatches }) => {
      const fullRepo = `${owner}/${repo}`;

      if (fullRepo === 'org/bad-list') {
        throw new Error('502 listing failed for tracked identity set');
      }

      if (fullRepo === 'org/good') {
        return [
          {
            sha: 'ok-sha',
            repo: fullRepo,
            author: {
              login: 'rhanka'
            },
            commit: {
              author: {
                name: 'Rhanka',
                email: 'rhanka@example.com',
                date: authoredAt
              }
            }
          },
          {
            sha: 'other-sha',
            repo: fullRepo,
            commit: {
              author: {
                name: 'Other',
                email: 'other@example.com',
                date: authoredAt
              }
            }
          },
          {
            sha: 'bad-sha',
            repo: fullRepo,
            author: {
              login: 'rhanka'
            },
            commit: {
              author: {
                name: 'Rhanka',
                email: 'rhanka@example.com',
                date: authoredAt
              }
            }
          }
        ].filter((entry) => typeof commitMatches === 'function' ? commitMatches(entry) : true);
      }

      return [];
    },
    fetchCommitDetailsImpl: async (_owner, _repo, sha) => {
      if (sha === 'bad-sha') {
        throw new Error('500 detail lookup failed');
      }

      return {
        sha,
        commit: {
          author: {
            name: 'Rhanka',
            email: 'rhanka@example.com',
            date: authoredAt
          }
        },
        stats: {
          additions: 4,
          deletions: 1
        }
      };
    }
  });

  assert.equal(stats.weeklyCommits.at(-1).count, 1);
  assert.deepEqual(stats.topReposLast4Weeks, [
    {
      repo: 'org/good',
      lastActivityAt: authoredAt,
      commits4w: 1,
      lines4w: 5
    }
  ]);
  assert.deepEqual([...warnings].sort(), [
    '[github-profile-stats] skipping commits for repo "org/bad-list" while listing commits: 502 listing failed for tracked identity set',
    '[github-profile-stats] skipping commit "bad-sha" in repo "org/good" while fetching details: 500 detail lookup failed'
  ].sort());
});

test('buildLiveStats keeps merge commits in weekly counts but excludes their diff stats from line totals', async () => {
  const authoredAt = '2026-04-29T11:00:00.000Z';
  const config = {
    identities: {
      logins: ['rhanka'],
      emails: []
    },
    includeRepos: [],
    excludeRepos: [],
    windowWeeks: 1
  };

  const stats = await buildLiveStats(config, 'secret-token', {
    nowIso: '2026-04-30T12:00:00.000Z',
    ...withNoCommitCache(),
    discoverReposForLoginsImpl: async () => [
      { repo: 'org/good', defaultBranch: 'main' }
    ],
    listCommitsForRepoImpl: async ({ owner, repo, commitMatches }) => [
      {
        sha: 'merge-sha',
        repo: `${owner}/${repo}`,
        commit: {
          author: {
            name: 'Rhanka',
            email: 'rhanka@example.com',
            date: authoredAt
          }
        }
      },
      {
        sha: 'normal-sha',
        repo: `${owner}/${repo}`,
        commit: {
          author: {
            name: 'Rhanka',
            email: 'rhanka@example.com',
            date: authoredAt
          }
        }
      }
    ].filter((entry) => (commitMatches ? commitMatches(entry) : true)),
    fetchCommitDetailsImpl: async (_owner, _repo, sha) => {
      if (sha === 'merge-sha') {
        return {
          sha,
          parents: [{ sha: 'left' }, { sha: 'right' }],
          commit: {
            author: {
              name: 'Rhanka',
              email: 'rhanka@example.com',
              date: authoredAt
            }
          },
          stats: {
            additions: 700000,
            deletions: 300000
          }
        };
      }

      return {
        sha,
        parents: [{ sha: 'base' }],
        commit: {
          author: {
            name: 'Rhanka',
            email: 'rhanka@example.com',
            date: authoredAt
          }
        },
        stats: {
          additions: 4,
          deletions: 1
        }
      };
    }
  });

  assert.equal(stats.weeklyCommits.at(-1).count, 2);
  assert.equal(stats.weeklyLines.at(-1).additions, 4);
  assert.equal(stats.weeklyLines.at(-1).deletions, 1);
  assert.equal(stats.topReposLast4Weeks.at(0).lines4w, 5);
});

test('buildLiveStats respects a per-run hydration limit for uncached commit details', async () => {
  const authoredAt = '2026-04-29T11:00:00.000Z';
  const warnings = [];
  const fetchedShas = [];
  const savedCaches = [];

  const stats = await buildLiveStats({
    identities: {
      logins: ['rhanka'],
      emails: []
    },
    includeRepos: [],
    excludeRepos: [],
    windowWeeks: 1
  }, 'secret-token', {
    nowIso: '2026-04-30T12:00:00.000Z',
    warn: (message) => warnings.push(message),
    hydrateLimit: 2,
    loadCommitDetailsCacheImpl: async () => buildEmptyCommitCache(),
    saveCommitDetailsCacheImpl: async (cache) => savedCaches.push(cache),
    discoverReposForLoginsImpl: async () => [
      { repo: 'org/good', defaultBranch: 'main' }
    ],
    listCommitsForRepoImpl: async ({ commitMatches }) => [
      'one-sha',
      'two-sha',
      'three-sha'
    ].map((sha) => ({
      sha,
      repo: 'org/good',
      commit: {
        author: {
          name: 'Rhanka',
          email: 'rhanka@example.com',
          date: authoredAt
        }
      }
    })).filter((entry) => (commitMatches ? commitMatches(entry) : true)),
    fetchCommitDetailsImpl: async (_owner, _repo, sha) => {
      fetchedShas.push(sha);
      return {
        sha,
        parents: [{ sha: 'base' }],
        commit: {
          author: {
            name: 'Rhanka',
            email: 'rhanka@example.com',
            date: authoredAt
          }
        },
        stats: {
          additions: 10,
          deletions: 1
        }
      };
    }
  });

  assert.deepEqual(fetchedShas, ['one-sha', 'two-sha']);
  assert.equal(stats.weeklyCommits.at(-1).count, 2);
  assert.equal(stats.topReposLast4Weeks.at(0).lines4w, 22);
  assert.match(warnings.at(0), /skipped hydration for 1 uncached commits/);
  assert.deepEqual(Object.keys(savedCaches.at(0).entries).sort(), [
    'org/good#one-sha',
    'org/good#two-sha'
  ]);
});


test('buildLiveStats reuses commit details from cache and skips API fetch', async () => {
  const authoredAt = '2026-04-29T11:00:00.000Z';
  const cache = {
    schemaVersion: commitCacheSchemaVersion,
    updatedAt: '2026-04-30T12:00:00.000Z',
    entries: {
      'org/good#normal-sha': {
        sha: 'normal-sha',
        parents: [{ sha: 'base' }],
        commit: {
          author: {
            name: 'Rhanka',
            email: 'rhanka@example.com',
            date: authoredAt
          }
        },
        stats: {
          additions: 42,
          deletions: 2
        },
        files: [
          { filename: 'src/main.ts', additions: 42, deletions: 2 }
        ]
      }
    }
  };
  const warnings = [];
  let fetchCallCount = 0;

  const stats = await buildLiveStats({
    identities: {
      logins: ['rhanka'],
      emails: []
    },
    includeRepos: [],
    excludeRepos: [],
    windowWeeks: 1
  }, 'secret-token', {
    nowIso: '2026-04-30T12:00:00.000Z',
    warn: (message) => warnings.push(message),
    ...withNoCommitCache({
      loadCommitDetailsCacheImpl: async () => cache
    }),
    discoverReposForLoginsImpl: async () => [
      { repo: 'org/good', defaultBranch: 'main' }
    ],
    listCommitsForRepoImpl: async () => [
      {
        sha: 'normal-sha',
        repo: 'org/good',
        commit: {
          author: {
            name: 'Rhanka',
            email: 'rhanka@example.com',
            date: authoredAt
          }
        }
      }
    ],
    fetchCommitDetailsImpl: async () => {
      fetchCallCount += 1;
      return {};
    }
  });

  assert.equal(fetchCallCount, 0);
  assert.equal(stats.weeklyCommits.at(-1).count, 1);
  assert.deepEqual(stats.weeklyLines.at(-1), {
    weekStart: '2026-04-26T00:00:00.000Z',
    additions: 42,
    deletions: 2,
    net: 40
  });
  assert.equal(warnings.length, 0);
});

test('buildLiveStats filters noisy file paths from line totals while preserving raw line totals', async () => {
  const authoredAt = '2026-04-29T11:00:00.000Z';
  const config = {
    identities: {
      logins: ['rhanka'],
      emails: []
    },
    includeRepos: [],
    excludeRepos: [],
    windowWeeks: 1,
    lineFilters: {
      excludePathGlobs: ['**/.graphify/**', '**/*.json', '**/*.txt']
    }
  };

  const stats = await buildLiveStats(config, 'secret-token', {
    nowIso: '2026-04-30T12:00:00.000Z',
    ...withNoCommitCache(),
    discoverReposForLoginsImpl: async () => [
      { repo: 'org/good', defaultBranch: 'main' }
    ],
    listCommitsForRepoImpl: async ({ owner, repo, commitMatches }) => [
      {
        sha: 'normal-sha',
        repo: `${owner}/${repo}`,
        commit: {
          author: {
            name: 'Rhanka',
            email: 'rhanka@example.com',
            date: authoredAt
          }
        }
      }
    ].filter((entry) => (commitMatches ? commitMatches(entry) : true)),
    fetchCommitDetailsImpl: async (_owner, _repo, sha) => ({
      sha,
      parents: [{ sha: 'base' }],
      commit: {
        author: {
          name: 'Rhanka',
          email: 'rhanka@example.com',
          date: authoredAt
        }
      },
      stats: {
        additions: 115,
        deletions: 16
      },
      files: [
        { filename: 'src/index.ts', additions: 10, deletions: 2 },
        { filename: '.graphify/graph.json', additions: 90, deletions: 10 },
        { filename: 'data/config.json', additions: 10, deletions: 3 },
        { filename: 'corpus/story.txt', additions: 5, deletions: 1 }
      ]
    })
  });

  assert.equal(stats.weeklyCommits.at(-1).count, 1);
  assert.deepEqual(stats.weeklyLines.at(-1), {
    weekStart: '2026-04-26T00:00:00.000Z',
    additions: 10,
    deletions: 2,
    net: 8
  });
  assert.deepEqual(stats.weeklyLinesRaw.at(-1), {
    weekStart: '2026-04-26T00:00:00.000Z',
    additions: 115,
    deletions: 16,
    net: 99
  });
  assert.equal(stats.topReposLast4Weeks.at(0).lines4w, 12);
});

function statsWithWeeklyCounts(counts) {
  return {
    weeklyCommits: counts.map((count, index) => ({
      weekStart: `2026-01-${String(index + 1).padStart(2, '0')}T00:00:00.000Z`,
      count
    }))
  };
}

test('totalWindowCommits sums the weekly commit counts', () => {
  assert.equal(totalWindowCommits(statsWithWeeklyCounts([10, 0, 5])), 15);
  assert.equal(totalWindowCommits({}), 0);
  assert.equal(totalWindowCommits(null), 0);
});


test('findRequiredRepoCoverageFailure requires sentinel high-volume repos', () => {
  assert.match(
    findRequiredRepoCoverageFailure({
      topReposLast4Weeks: [
        { repo: 'rhanka/sent-tech-design-system', lines4w: 116391 }
      ]
    }),
    /sent-tech-design-system/
  );

  assert.match(
    findRequiredRepoCoverageFailure({
      topReposLast4Weeks: [
        { repo: 'rhanka/sent-tech-design-system', lines4w: 512235 },
        { repo: 'rhanka/graphify', lines4w: 91282 }
      ]
    }),
    /sentropic/
  );

  assert.equal(
    findRequiredRepoCoverageFailure({
      topReposLast4Weeks: [
        { repo: 'rhanka/sent-tech-design-system', lines4w: 512235 },
        { repo: 'rhanka/sentropic', lines4w: 106261 }
      ]
    }),
    null
  );
});

test('findStatsRegression flags a fully zeroed collection', () => {
  const next = statsWithWeeklyCounts([0, 0, 0]);
  const previous = statsWithWeeklyCounts([100, 200, 300]);
  assert.match(findStatsRegression(next, previous), /0 commits/);
});

test('findStatsRegression flags zero even without a previous baseline', () => {
  assert.match(findStatsRegression(statsWithWeeklyCounts([0, 0]), null), /0 commits/);
});

test('findStatsRegression flags a severe collapse versus the previous run', () => {
  const next = statsWithWeeklyCounts([777]);
  const previous = statsWithWeeklyCounts([7313]);
  assert.match(findStatsRegression(next, previous), /collapsed from 7313 to 777/);
});

test('findStatsRegression accepts a healthy run and normal fluctuations', () => {
  const previous = statsWithWeeklyCounts([7000, 300]);
  assert.equal(findStatsRegression(statsWithWeeklyCounts([7000, 320]), previous), null);
  // First-ever run with no baseline but real data is fine.
  assert.equal(findStatsRegression(statsWithWeeklyCounts([5000]), null), null);
  // Recovering from a previously-empty publish must not be blocked.
  assert.equal(findStatsRegression(statsWithWeeklyCounts([5000]), statsWithWeeklyCounts([0])), null);
});
