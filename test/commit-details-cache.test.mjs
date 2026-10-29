import test from 'node:test';
import assert from 'node:assert/strict';
import { createReadStream } from 'node:fs';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import {
  commitCacheFileName,
  commitCacheSchemaVersion,
  legacyCommitCacheFileName,
  loadCommitDetailsCache,
  pruneCommitDetailsCache,
  saveCommitDetailsCache,
  slimCommitDetail
} from '../src/commit-details-cache.mjs';

async function withTempDir(run) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'profile-stats-cache-'));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function exists(filePath) {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

function fullApiCommitDetail(sha, date = '2026-04-29T11:00:00Z') {
  return {
    sha,
    node_id: 'C_kwDO',
    url: `https://api.github.com/repos/org/repo/commits/${sha}`,
    html_url: `https://github.com/org/repo/commit/${sha}`,
    author: { login: 'rhanka', id: 1, avatar_url: 'https://example.com/a.png' },
    committer: { login: 'web-flow', id: 2 },
    parents: [{ sha: 'base', url: 'https://api.github.com/x', html_url: 'https://github.com/x' }],
    commit: {
      author: { name: 'Rhanka', email: 'rhanka@example.com', date },
      committer: { name: 'GitHub', email: 'noreply@github.com', date },
      message: 'feat: a long commit message\n\nwith a body',
      tree: { sha: 'tree', url: 'https://api.github.com/tree' },
      verification: { verified: true, reason: 'valid', signature: 'x'.repeat(500), payload: 'y'.repeat(500) }
    },
    stats: { total: 12, additions: 10, deletions: 2 },
    files: [
      {
        sha: 'blob1',
        filename: 'src/index.mjs',
        status: 'modified',
        additions: 7,
        deletions: 1,
        changes: 8,
        blob_url: 'https://github.com/blob',
        raw_url: 'https://github.com/raw',
        contents_url: 'https://api.github.com/contents',
        patch: '@@ -1 +1 @@\n-old\n+new\n'.repeat(200)
      },
      {
        sha: 'blob2',
        filename: 'docs/README.md',
        status: 'added',
        additions: 3,
        deletions: 1,
        changes: 4,
        patch: '+doc\n'.repeat(200)
      }
    ],
    fetchedAt: '2026-04-30T00:00:00.000Z'
  };
}

test('slimCommitDetail keeps only the fields the stats read', () => {
  const slim = slimCommitDetail(fullApiCommitDetail('abc'));

  assert.deepEqual(slim, {
    sha: 'abc',
    parents: [{ sha: 'base' }],
    commit: {
      author: { name: 'Rhanka', email: 'rhanka@example.com', date: '2026-04-29T11:00:00Z' },
      committer: { name: 'GitHub', email: 'noreply@github.com', date: '2026-04-29T11:00:00Z' }
    },
    stats: { additions: 10, deletions: 2, total: 12 },
    files: [
      { filename: 'src/index.mjs', additions: 7, deletions: 1 },
      { filename: 'docs/README.md', additions: 3, deletions: 1 }
    ],
    fetchedAt: '2026-04-30T00:00:00.000Z'
  });
  assert.ok(JSON.stringify(slim).length * 10 < JSON.stringify(fullApiCommitDetail('abc')).length);
  assert.equal(slimCommitDetail(null), null);
});

test('slimCommitDetail is idempotent and keeps missing files/stats absent', () => {
  const slim = slimCommitDetail({ sha: 'x', parents: [], commit: { author: { name: 'a', email: 'b', date: 'c' } } }, 'now');
  assert.deepEqual(slimCommitDetail(slim), slim);
  assert.equal('files' in slim, false);
  assert.equal('stats' in slim, false);
  assert.equal(slim.fetchedAt, 'now');
});

test('saveCommitDetailsCache writes NDJSON (header + one line per entry) that loads back identically', async () => {
  await withTempDir(async (dir) => {
    const entries = {
      'org/repo#a': slimCommitDetail(fullApiCommitDetail('a')),
      'org/repo#b': slimCommitDetail(fullApiCommitDetail('b'))
    };

    await saveCommitDetailsCache({ schemaVersion: commitCacheSchemaVersion, entries }, { cacheDir: dir });

    const lines = (await readFile(path.join(dir, commitCacheFileName), 'utf8')).trimEnd().split('\n');
    assert.equal(lines.length, 3);
    const header = JSON.parse(lines[0]);
    assert.equal(header.schemaVersion, commitCacheSchemaVersion);
    assert.equal(header.format, 'ndjson');
    assert.deepEqual(lines.slice(1).map((line) => JSON.parse(line).key), ['org/repo#a', 'org/repo#b']);

    const loaded = await loadCommitDetailsCache({ cacheDir: dir, warn: () => assert.fail('unexpected warning') });
    assert.equal(loaded.schemaVersion, commitCacheSchemaVersion);
    assert.deepEqual(loaded.entries, entries);
  });
});

test('loadCommitDetailsCache returns an empty cache when nothing is on disk', async () => {
  await withTempDir(async (dir) => {
    const warnings = [];
    const loaded = await loadCommitDetailsCache({ cacheDir: path.join(dir, 'missing'), warn: (m) => warnings.push(m) });
    assert.deepEqual(loaded.entries, {});
    assert.equal(loaded.schemaVersion, commitCacheSchemaVersion);
    assert.deepEqual(warnings, []);
  });
});

test('loadCommitDetailsCache migrates the legacy pretty-printed JSON file by streaming it, then save removes it', async () => {
  await withTempDir(async (dir) => {
    const legacy = {
      schemaVersion: 1,
      updatedAt: '2026-09-01T00:00:00.000Z',
      entries: {
        'org/repo#a': fullApiCommitDetail('a'),
        'org/repo#b': fullApiCommitDetail('b', '2026-04-28T10:00:00Z'),
        'org/repo#"quoted}\n"': fullApiCommitDetail('q'),
        'org/repo#empty': {}
      }
    };
    await writeFile(path.join(dir, legacyCommitCacheFileName), `${JSON.stringify(legacy, null, 2)}\n`);

    const warnings = [];
    const loaded = await loadCommitDetailsCache({ cacheDir: dir, warn: (m) => warnings.push(m) });

    assert.match(warnings.at(0), /migrated 4 entries from legacy commit-details-cache\.json/);
    assert.equal(loaded.updatedAt, '2026-09-01T00:00:00.000Z');
    assert.deepEqual(Object.keys(loaded.entries), Object.keys(legacy.entries));
    assert.deepEqual(loaded.entries['org/repo#a'], slimCommitDetail(fullApiCommitDetail('a')));
    assert.equal(loaded.entries['org/repo#b'].commit.author.date, '2026-04-28T10:00:00Z');
    assert.equal(loaded.entries['org/repo#a'].files[0].patch, undefined);

    await saveCommitDetailsCache(loaded, { cacheDir: dir });
    assert.equal(await exists(path.join(dir, legacyCommitCacheFileName)), false);
    const reloaded = await loadCommitDetailsCache({ cacheDir: dir, warn: () => {} });
    assert.deepEqual(reloaded.entries, loaded.entries);
  });
});

test('loadCommitDetailsCache migrates an empty legacy cache', async () => {
  await withTempDir(async (dir) => {
    await writeFile(
      path.join(dir, legacyCommitCacheFileName),
      `${JSON.stringify({ schemaVersion: 1, updatedAt: '2026-01-01T00:00:00.000Z', entries: {} }, null, 2)}\n`
    );
    const loaded = await loadCommitDetailsCache({ cacheDir: dir, warn: () => {} });
    assert.deepEqual(loaded.entries, {});
  });
});

test('loadCommitDetailsCache starts empty with a warning on an unreadable legacy file', async () => {
  await withTempDir(async (dir) => {
    const legacyPath = path.join(dir, legacyCommitCacheFileName);
    const full = JSON.stringify({ schemaVersion: 1, updatedAt: 'x', entries: { 'o/r#a': fullApiCommitDetail('a') } }, null, 2);

    for (const content of [full.slice(0, full.length / 2), '{"schemaVersion":1,"entries":{}}', full.replace('"schemaVersion": 1', '"schemaVersion": 7')]) {
      await writeFile(legacyPath, content);
      const warnings = [];
      const loaded = await loadCommitDetailsCache({ cacheDir: dir, warn: (m) => warnings.push(m) });
      assert.deepEqual(loaded.entries, {});
      assert.match(warnings.at(0), /starting from an empty commit cache: cannot read legacy/);
    }
  });
});

test('loadCommitDetailsCache prefers the NDJSON file, skips a corrupt line and rejects an unknown schema', async () => {
  await withTempDir(async (dir) => {
    const ndjsonPath = path.join(dir, commitCacheFileName);
    await writeFile(path.join(dir, legacyCommitCacheFileName), 'not even json');
    await writeFile(ndjsonPath, [
      JSON.stringify({ schemaVersion: commitCacheSchemaVersion, format: 'ndjson', updatedAt: 'u' }),
      JSON.stringify({ key: 'o/r#a', detail: { sha: 'a', stats: { additions: 1, deletions: 0 } } }),
      '{"key":"o/r#b","detail":{"sha":"b","sta'
    ].join('\n'));

    const warnings = [];
    const loaded = await loadCommitDetailsCache({ cacheDir: dir, warn: (m) => warnings.push(m) });
    assert.deepEqual(Object.keys(loaded.entries), ['o/r#a']);
    assert.match(warnings.at(0), /ignored 1 unreadable commit cache lines/);

    await writeFile(ndjsonPath, `${JSON.stringify({ schemaVersion: 99 })}\n`);
    const warnings2 = [];
    const reset = await loadCommitDetailsCache({ cacheDir: dir, warn: (m) => warnings2.push(m) });
    assert.deepEqual(reset.entries, {});
    assert.match(warnings2.at(0), /unsupported cache schemaVersion 99/);
  });
});

test('pruneCommitDetailsCache drops entries entirely before the window start', () => {
  const cache = {
    entries: {
      old: { commit: { author: { date: '2025-01-01T00:00:00Z' }, committer: { date: '2025-01-02T00:00:00Z' } }, stats: {} },
      rebased: { commit: { author: { date: '2025-01-01T00:00:00Z' }, committer: { date: '2026-05-01T00:00:00Z' } }, stats: {} },
      fresh: { commit: { author: { date: '2026-05-01T00:00:00Z' } }, stats: {} },
      undated: { stats: {} }
    }
  };

  assert.equal(pruneCommitDetailsCache(cache, { before: '2026-04-26T00:00:00.000Z' }), 2);
  assert.deepEqual(Object.keys(cache.entries).sort(), ['fresh', 'rebased']);
  assert.equal(pruneCommitDetailsCache(cache, { before: 'not a date' }), 0);
});

async function countLines(filePath) {
  let count = 0;
  let longest = 0;
  const lines = createInterface({ input: createReadStream(filePath, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of lines) {
    count += 1;
    longest = Math.max(longest, line.length);
  }
  return { count, longest };
}

// Entries share one large `files` array in memory, so the cache is cheap to
// build while its serialized form is large. Single-document JSON of this cache
// would need one string as long as the whole file.
function buildLargeCache(entryCount, filesPerEntry) {
  const files = Array.from({ length: filesPerEntry }, (_, index) => ({
    filename: `packages/some-package/src/components/generated/very/deep/path/file-${index}.ts`,
    additions: index,
    deletions: 1
  }));
  const entries = {};
  for (let index = 0; index < entryCount; index += 1) {
    const sha = index.toString(16).padStart(40, '0');
    entries[`rhanka/sentropic#${sha}`] = {
      sha,
      parents: [{ sha: 'base' }],
      commit: { author: { name: 'Rhanka', email: 'rhanka@example.com', date: '2026-04-29T11:00:00Z' } },
      stats: { additions: 10, deletions: 2, total: 12 },
      files,
      fetchedAt: '2026-04-30T00:00:00.000Z'
    };
  }
  return { schemaVersion: commitCacheSchemaVersion, entries };
}

test('saveCommitDetailsCache never builds a string proportional to the whole cache (large cache round-trip)', async () => {
  await withTempDir(async (dir) => {
    const cache = buildLargeCache(20000, 40);
    const originalStringify = JSON.stringify;
    let longestString = 0;
    JSON.stringify = (...args) => {
      const out = originalStringify(...args);
      longestString = Math.max(longestString, out?.length ?? 0);
      return out;
    };
    try {
      await saveCommitDetailsCache(cache, { cacheDir: dir });
    } finally {
      JSON.stringify = originalStringify;
    }

    const filePath = path.join(dir, commitCacheFileName);
    const { size } = await stat(filePath);
    const { count, longest } = await countLines(filePath);
    assert.ok(size > 80 * 1024 * 1024, `expected a large cache file, got ${size} bytes`);
    assert.equal(count, 20001);
    assert.ok(longestString < 16 * 1024, `longest serialized string was ${longestString}`);
    assert.ok(longest < 16 * 1024);

    const loaded = await loadCommitDetailsCache({ cacheDir: dir, warn: () => assert.fail('unexpected warning') });
    assert.equal(Object.keys(loaded.entries).length, 20000);
    assert.deepEqual(loaded.entries[`rhanka/sentropic#${(19999).toString(16).padStart(40, '0')}`].files.at(-1),
      cache.entries[`rhanka/sentropic#${(19999).toString(16).padStart(40, '0')}`].files.at(-1));
  });
});

// Opt-in: writes a cache larger than V8's maximum string length (~512 MiB),
// the exact size that made JSON.stringify throw "Invalid string length".
test('saveCommitDetailsCache writes a cache larger than the V8 max string length', {
  skip: process.env.PROFILE_STATS_HUGE_CACHE_TEST === '1' ? false : 'set PROFILE_STATS_HUGE_CACHE_TEST=1 to run (~700 MB on disk)'
}, async () => {
  await withTempDir(async (dir) => {
    const cache = buildLargeCache(60000, 120);
    assert.throws(() => JSON.stringify(cache), RangeError);

    await saveCommitDetailsCache(cache, { cacheDir: dir });

    const filePath = path.join(dir, commitCacheFileName);
    const { size } = await stat(filePath);
    const { count } = await countLines(filePath);
    assert.ok(size > 2 ** 29, `expected more than 512 MiB, got ${size} bytes`);
    assert.equal(count, 60001);
  });
});
