import test from 'node:test';
import assert from 'node:assert/strict';
import {
  discoverRepos,
  contributionReposFromGraphql,
  mergeCandidateRepos
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
