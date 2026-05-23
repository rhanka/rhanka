import { githubRest } from './github-api.mjs';
import { weekStartUtc } from './time.mjs';

export function dedupeCommitsBySha(commits) {
  const seen = new Set();
  const deduped = [];

  for (const commit of commits) {
    if (seen.has(commit.sha)) {
      continue;
    }

    seen.add(commit.sha);
    deduped.push(commit);
  }

  return deduped;
}

export function toCollectedCommit(repo, apiCommit, sourceAuthor = null) {
  const author = apiCommit.commit?.author ?? null;
  const authoredAt = author?.date ?? null;

  return {
    sha: apiCommit.sha,
    repo,
    ...(sourceAuthor === null ? {} : { sourceAuthor }),
    authorName: author?.name ?? null,
    authorEmail: author?.email ?? null,
    authoredAt,
    weekStart: authoredAt ? weekStartUtc(authoredAt) : null,
    commit: apiCommit
  };
}

export function buildListCommitsPath({
  owner,
  repo,
  branch,
  author,
  since,
  until,
  page
}) {
  const params = new URLSearchParams();
  if (branch) {
    params.set('sha', branch);
  }

  if (author) {
    params.set('author', author);
  }

  params.set('since', since);
  params.set('until', until);
  params.set('per_page', '100');
  params.set('page', String(page));

  return `/repos/${owner}/${repo}/commits?${params.toString()}`;
}

export async function fetchCommitDetails(owner, repo, sha, token, fetchImpl = fetch) {
  return githubRest(`/repos/${owner}/${repo}/commits/${sha}`, token, fetchImpl);
}
