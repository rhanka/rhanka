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

// GitHub caps the cost of a single contributionsCollection query. A full
// rolling-year window across a high-volume account trips
// "Resource limits for this query exceeded", so split the discovery window
// into cheaper sub-ranges and union the repos. Empirically 30-day windows
// stay under the budget even across the densest weeks while ~90-day windows
// exceed it, so keep the chunk conservative.
const defaultDiscoverWindowDays = 30;

export function splitDiscoveryWindow(from, to, maxWindowDays = defaultDiscoverWindowDays) {
  const fromMs = Date.parse(from);
  const toMs = Date.parse(to);
  const maxMs = maxWindowDays * 24 * 60 * 60 * 1000;

  if (
    !Number.isFinite(fromMs) ||
    !Number.isFinite(toMs) ||
    fromMs >= toMs ||
    !(maxMs > 0) ||
    toMs - fromMs <= maxMs
  ) {
    return [{ from, to }];
  }

  const chunks = [];
  let startMs = fromMs;

  while (startMs < toMs) {
    const endMs = Math.min(startMs + maxMs, toMs);
    chunks.push({
      from: new Date(startMs).toISOString(),
      to: new Date(endMs).toISOString()
    });
    startMs = endMs;
  }

  return chunks;
}

export function mergeCandidateRepos({ discoveredRepos, includeRepos, excludeRepos }) {
  const repoSet = new Set([...discoveredRepos, ...includeRepos]);

  for (const excluded of excludeRepos) {
    repoSet.delete(excluded);
  }

  return [...repoSet].sort();
}

export async function discoverRepos({
  login,
  from,
  to,
  token,
  fetchImpl = fetch,
  maxWindowDays = defaultDiscoverWindowDays
}) {
  const windows = splitDiscoveryWindow(from, to, maxWindowDays);
  const byRepo = new Map();

  for (const windowRange of windows) {
    const data = await githubGraphql(
      DISCOVER_REPOS_QUERY,
      { login, from: windowRange.from, to: windowRange.to },
      token,
      fetchImpl
    );

    for (const entry of contributionReposFromGraphql(data)) {
      const existing = byRepo.get(entry.repo);

      if (!existing) {
        byRepo.set(entry.repo, { ...entry });
        continue;
      }

      if (existing.defaultBranch === null && entry.defaultBranch !== null) {
        existing.defaultBranch = entry.defaultBranch;
      }
    }
  }

  return [...byRepo.values()].sort((left, right) => left.repo.localeCompare(right.repo));
}

export function contributionReposFromGraphql(data) {
  return (data.user?.contributionsCollection?.commitContributionsByRepository ?? [])
    .map((entry) => ({
      repo: entry.repository.nameWithOwner,
      defaultBranch: entry.repository.defaultBranchRef?.name ?? null
    }))
    .sort((left, right) => left.repo.localeCompare(right.repo));
}
