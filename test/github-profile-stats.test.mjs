import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildLiveStats,
  discoverReposForLogins,
  main,
  mapWithConcurrency,
  resolveGithubToken
} from '../scripts/github-profile-stats.mjs';
import { toCollectedCommit } from '../src/collect-commits.mjs';

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

test('buildLiveStats warns and skips failing repos, failing identities, and failing commit details', async () => {
  const warnings = [];
  const config = {
    identities: {
      logins: ['rhanka'],
      emails: ['rhanka@example.com']
    },
    includeRepos: ['org/included'],
    excludeRepos: ['org/excluded'],
    windowWeeks: 1
  };
  const authoredAt = '2026-04-29T11:00:00.000Z';

  const stats = await buildLiveStats(config, 'secret-token', {
    nowIso: '2026-04-30T12:00:00.000Z',
    warn: (message) => warnings.push(message),
    discoverReposForLoginsImpl: async () => [
      { repo: 'org/good', defaultBranch: 'main' },
      { repo: 'org/no-branch', defaultBranch: null },
      { repo: 'org/bad-list', defaultBranch: 'main' },
      { repo: 'org/excluded', defaultBranch: 'main' }
    ],
    fetchDefaultBranchImpl: async (owner, repo) => {
      if (`${owner}/${repo}` === 'org/no-branch') {
        throw new Error('403 branch lookup denied');
      }

      return 'main';
    },
    listCommitsForAuthorImpl: async ({ owner, repo, author }) => {
      const fullRepo = `${owner}/${repo}`;

      if (fullRepo === 'org/bad-list') {
        throw new Error(`502 listing failed for ${author}`);
      }

      if (fullRepo === 'org/good') {
        if (author === 'rhanka') {
          return [
            toCollectedCommit(fullRepo, {
              sha: 'ok-sha',
              commit: {
                author: {
                  name: 'Rhanka',
                  email: 'rhanka@example.com',
                  date: authoredAt
                }
              }
            }, author),
            toCollectedCommit(fullRepo, {
              sha: 'bad-sha',
              commit: {
                author: {
                  name: 'Rhanka',
                  email: 'rhanka@example.com',
                  date: authoredAt
                }
              }
            }, author)
          ];
        }

        return [
          toCollectedCommit(fullRepo, {
            sha: 'ok-sha',
            commit: {
              author: {
                name: 'Rhanka',
                email: 'rhanka@example.com',
                date: authoredAt
              }
            }
          }, author)
        ];
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
    '[github-profile-stats] skipping author "rhanka" for repo "org/bad-list" while listing commits: 502 listing failed for rhanka',
    '[github-profile-stats] skipping author "rhanka@example.com" for repo "org/bad-list" while listing commits: 502 listing failed for rhanka@example.com',
    '[github-profile-stats] skipping repo "org/no-branch" while fetching default branch: 403 branch lookup denied',
    '[github-profile-stats] skipping commit "bad-sha" in repo "org/good" while fetching details: 500 detail lookup failed'
  ].sort());
});
