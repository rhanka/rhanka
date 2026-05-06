import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildListCommitsPath,
  dedupeCommitsBySha,
  fetchCommitDetails,
  toCollectedCommit
} from '../src/collect-commits.mjs';

test('dedupeCommitsBySha keeps the first commit for each sha across duplicated filters', () => {
  const commits = dedupeCommitsBySha([
    { sha: 'a1', authorName: 'Login Author', authorEmail: 'login@example.com' },
    { sha: 'a1', authorName: 'Email Author', authorEmail: 'email@example.com' },
    { sha: 'b2', authorName: 'Other Author', authorEmail: 'other@example.com' }
  ]);

  assert.deepEqual(commits, [
    { sha: 'a1', authorName: 'Login Author', authorEmail: 'login@example.com' },
    { sha: 'b2', authorName: 'Other Author', authorEmail: 'other@example.com' }
  ]);
});

test('toCollectedCommit normalizes authored commits to their utc week bucket', () => {
  const collected = toCollectedCommit('rhanka/graphify', {
    sha: 'c3',
    commit: {
      author: {
        name: 'Graph Author',
        email: 'graph@example.com',
        date: '2026-04-29T11:00:00.000Z'
      }
    }
  });

  assert.deepEqual(collected, {
    sha: 'c3',
    repo: 'rhanka/graphify',
    authorName: 'Graph Author',
    authorEmail: 'graph@example.com',
    authoredAt: '2026-04-29T11:00:00.000Z',
    weekStart: '2026-04-26T00:00:00.000Z',
    commit: {
      sha: 'c3',
      commit: {
        author: {
          name: 'Graph Author',
          email: 'graph@example.com',
          date: '2026-04-29T11:00:00.000Z'
        }
      }
    }
  });
});

test('toCollectedCommit tolerates a partial payload and preserves the full rest commit', () => {
  const apiCommit = {
    sha: 'd4',
    url: 'https://api.github.com/repos/rhanka/graphify/commits/d4',
    html_url: 'https://github.com/rhanka/graphify/commit/d4',
    commit: {
      message: 'Missing author block'
    }
  };

  const collected = toCollectedCommit('rhanka/graphify', apiCommit);

  assert.deepEqual(collected, {
    sha: 'd4',
    repo: 'rhanka/graphify',
    authorName: null,
    authorEmail: null,
    authoredAt: null,
    weekStart: null,
    commit: apiCommit
  });
});

test('buildListCommitsPath builds the commits rest path with filters and pagination', () => {
  assert.equal(
    buildListCommitsPath({
      owner: 'rhanka',
      repo: 'graphify',
      branch: 'main',
      author: 'graph-author',
      since: '2026-04-01T00:00:00.000Z',
      until: '2026-04-30T23:59:59.999Z',
      page: 3
    }),
    '/repos/rhanka/graphify/commits?sha=main&author=graph-author&since=2026-04-01T00%3A00%3A00.000Z&until=2026-04-30T23%3A59%3A59.999Z&per_page=100&page=3'
  );
});

test('fetchCommitDetails requests the full REST commit payload for a sha', async () => {
  const commit = await fetchCommitDetails('rhanka', 'graphify', 'abc123', 'secret-token', async (url, init) => {
    assert.equal(url, 'https://api.github.com/repos/rhanka/graphify/commits/abc123');
    assert.equal(init.headers.Authorization, 'Bearer secret-token');

    return {
      ok: true,
      async json() {
        return {
          sha: 'abc123',
          stats: {
            additions: 5,
            deletions: 3
          }
        };
      }
    };
  });

  assert.deepEqual(commit, {
    sha: 'abc123',
    stats: {
      additions: 5,
      deletions: 3
    }
  });
});
