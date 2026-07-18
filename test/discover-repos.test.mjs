import test from 'node:test';
import assert from 'node:assert/strict';
import {
  discoverRepos,
  contributionReposFromGraphql,
  mergeCandidateRepos,
  splitDiscoveryWindow
} from '../src/discover-repos.mjs';

test('mergeCandidateRepos merges GraphQL repos with manual includes and excludes', () => {
  const repos = mergeCandidateRepos({
    discoveredRepos: ['rhanka/graphify', 'rhanka/rhanka'],
    includeRepos: ['matchID-project/deces-dataprep'],
    excludeRepos: ['rhanka/rhanka']
  });

  assert.deepEqual(repos, [
    'matchID-project/deces-dataprep',
    'rhanka/graphify'
  ]);
});

test('contributionReposFromGraphql returns repository names and default branches from GraphQL payload', () => {
  const repos = contributionReposFromGraphql({
    user: {
      contributionsCollection: {
        commitContributionsByRepository: [
          {
            repository: {
              nameWithOwner: 'rhanka/rhanka',
              defaultBranchRef: {
                name: 'main'
              }
            }
          },
          {
            repository: {
              nameWithOwner: 'rhanka/graphify',
              defaultBranchRef: {
                name: 'master'
              }
            }
          }
        ]
      }
    }
  });

  assert.deepEqual(repos, [
    { repo: 'rhanka/graphify', defaultBranch: 'master' },
    { repo: 'rhanka/rhanka', defaultBranch: 'main' }
  ]);
});

test('splitDiscoveryWindow keeps a short window as a single unchanged range', () => {
  assert.deepEqual(
    splitDiscoveryWindow('2026-04-01T00:00:00.000Z', '2026-04-30T23:59:59.999Z', 90),
    [{ from: '2026-04-01T00:00:00.000Z', to: '2026-04-30T23:59:59.999Z' }]
  );
});

test('splitDiscoveryWindow chunks a long window into consecutive sub-ranges', () => {
  const chunks = splitDiscoveryWindow('2025-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z', 90);

  assert.equal(chunks.length, 5);
  assert.equal(chunks[0].from, '2025-07-01T00:00:00.000Z');
  assert.equal(chunks.at(-1).to, '2026-07-01T00:00:00.000Z');

  for (let i = 1; i < chunks.length; i += 1) {
    assert.equal(chunks[i].from, chunks[i - 1].to);
  }
});

test('discoverRepos unions repos across chunked windows and prefers a known default branch', async () => {
  const requestedRanges = [];
  const payloadsByFrom = {
    '2025-07-01T00:00:00.000Z': [
      { repository: { nameWithOwner: 'rhanka/graphify', defaultBranchRef: null } }
    ],
    '2025-09-29T00:00:00.000Z': [
      { repository: { nameWithOwner: 'rhanka/graphify', defaultBranchRef: { name: 'main' } } },
      { repository: { nameWithOwner: 'rhanka/geo', defaultBranchRef: { name: 'main' } } }
    ]
  };

  const repos = await discoverRepos({
    login: 'rhanka',
    from: '2025-07-01T00:00:00.000Z',
    to: '2026-07-01T00:00:00.000Z',
    token: 'secret-token',
    maxWindowDays: 90,
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(init.body);
      requestedRanges.push([body.variables.from, body.variables.to]);
      const entries = payloadsByFrom[body.variables.from] ?? [];

      return {
        ok: true,
        async json() {
          return {
            data: {
              user: {
                contributionsCollection: {
                  commitContributionsByRepository: entries
                }
              }
            }
          };
        }
      };
    }
  });

  assert.equal(requestedRanges.length, 5);
  assert.deepEqual(repos, [
    { repo: 'rhanka/geo', defaultBranch: 'main' },
    { repo: 'rhanka/graphify', defaultBranch: 'main' }
  ]);
});

test('discoverRepos queries GitHub GraphQL with the requested login, window and token', async () => {
  let requestBody;
  let requestHeaders;

  const repos = await discoverRepos({
    login: 'rhanka',
    from: '2026-04-01T00:00:00.000Z',
    to: '2026-04-30T23:59:59.999Z',
    token: 'secret-token',
    fetchImpl: async (_url, init) => {
      requestHeaders = init.headers;
      requestBody = JSON.parse(init.body);

      return {
        ok: true,
        async json() {
          return {
            data: {
              user: {
                contributionsCollection: {
                  commitContributionsByRepository: [
                    {
                      repository: {
                        nameWithOwner: 'rhanka/graphify',
                        defaultBranchRef: { name: 'main' }
                      }
                    }
                  ]
                }
              }
            }
          };
        }
      };
    }
  });

  assert.equal(requestHeaders.Authorization, 'Bearer secret-token');
  assert.match(requestBody.query, /commitContributionsByRepository/);
  assert.deepEqual(requestBody.variables, {
    login: 'rhanka',
    from: '2026-04-01T00:00:00.000Z',
    to: '2026-04-30T23:59:59.999Z'
  });
  assert.deepEqual(repos, [
    { repo: 'rhanka/graphify', defaultBranch: 'main' }
  ]);
});
