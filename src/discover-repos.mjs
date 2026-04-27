export function mergeCandidateRepos({ discoveredRepos, includeRepos, excludeRepos }) {
  const repoSet = new Set([...discoveredRepos, ...includeRepos]);

  for (const excluded of excludeRepos) {
    repoSet.delete(excluded);
  }

  return [...repoSet].sort();
}

export function contributionReposFromGraphql(data) {
  return data.user.contributionsCollection.commitContributionsByRepository
    .map((entry) => entry.repository.nameWithOwner)
    .sort();
}
