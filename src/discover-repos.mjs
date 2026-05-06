import { githubGraphql } from './github-api.mjs';

const DISCOVER_REPOS_QUERY = `
  query DiscoverRepos($login: String!, $from: DateTime!, $to: DateTime!) {
    user(login: $login) {
      contributionsCollection(from: $from, to: $to) {
        commitContributionsByRepository(maxRepositories: 100) {
          repository {
            nameWithOwner
            defaultBranchRef {
              name
            }
          }
        }
      }
    }
  }
`;

export function mergeCandidateRepos({ discoveredRepos, includeRepos, excludeRepos }) {
  const repoSet = new Set([...discoveredRepos, ...includeRepos]);

  for (const excluded of excludeRepos) {
    repoSet.delete(excluded);
  }

  return [...repoSet].sort();
}

export async function discoverRepos({ login, from, to, token, fetchImpl = fetch }) {
  const data = await githubGraphql(
    DISCOVER_REPOS_QUERY,
    { login, from, to },
    token,
    fetchImpl
  );

  return contributionReposFromGraphql(data);
}

export function contributionReposFromGraphql(data) {
  return (data.user?.contributionsCollection?.commitContributionsByRepository ?? [])
    .map((entry) => ({
      repo: entry.repository.nameWithOwner,
      defaultBranch: entry.repository.defaultBranchRef?.name ?? null
    }))
    .sort((left, right) => left.repo.localeCompare(right.repo));
}
