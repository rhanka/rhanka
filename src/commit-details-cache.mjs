// Persistent cache of GitHub commit details used to compute line statistics.
//
// Storage format (schema v2): NDJSON, one JSON document per line.
//   line 1: {"schemaVersion":2,"format":"ndjson","updatedAt":"..."}
//   line N: {"key":"owner/repo#sha","detail":{...slim commit detail...}}
//
// Writing and reading line by line means no single string ever holds the whole
// cache, so the cache can no longer hit V8's maximum string length the way the
// legacy single-document JSON file (schema v1) did. Each entry also keeps only
// the fields the stats actually use (no patches, URLs, messages or signatures).

import { once } from 'node:events';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';

export const commitCacheSchemaVersion = 2;
export const legacyCommitCacheSchemaVersion = 1;
export const commitCacheFileName = 'commit-details-cache.ndjson';
export const legacyCommitCacheFileName = 'commit-details-cache.json';

export function createCommitCacheEnvelope(entries = {}) {
  return {
    schemaVersion: commitCacheSchemaVersion,
    updatedAt: new Date().toISOString(),
    entries
  };
}

function slimPerson(person) {
  if (!person || typeof person !== 'object') {
    return undefined;
  }

  return {
    name: person.name,
    email: person.email,
    date: person.date
  };
}

function toCount(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

// Keep only what the stats read from a commit detail:
// - sha, author/committer name+email+date (identity matching, week bucketing)
// - parents (merge detection only needs the count)
// - stats additions/deletions (raw line counts, also the "hydrated" marker)
// - per-file filename/additions/deletions (path-filtered line counts; kept per
//   file so a change of lineFilters.excludePathGlobs still applies to cached
//   commits without refetching them)
export function slimCommitDetail(detail, fetchedAt = new Date().toISOString()) {
  if (!detail || typeof detail !== 'object') {
    return null;
  }

  const slim = {};

  if (typeof detail.sha === 'string') {
    slim.sha = detail.sha;
  }

  if (Array.isArray(detail.parents)) {
    slim.parents = detail.parents.map((parent) => ({ sha: parent?.sha ?? null }));
  }

  if (detail.commit && typeof detail.commit === 'object') {
    slim.commit = {
      author: slimPerson(detail.commit.author),
      committer: slimPerson(detail.commit.committer)
    };
  }

  if (detail.stats && typeof detail.stats === 'object') {
    slim.stats = {
      additions: toCount(detail.stats.additions),
      deletions: toCount(detail.stats.deletions),
      total: toCount(detail.stats.total)
    };
  }

  if (Array.isArray(detail.files)) {
    slim.files = detail.files.map((file) => ({
      filename: file?.filename,
      additions: toCount(file?.additions),
      deletions: toCount(file?.deletions)
    }));
  }

  slim.fetchedAt = typeof detail.fetchedAt === 'string' ? detail.fetchedAt : fetchedAt;
  return slim;
}

function latestCommitTime(detail) {
  const times = [detail?.commit?.author?.date, detail?.commit?.committer?.date]
    .map((value) => (typeof value === 'string' ? Date.parse(value) : Number.NaN))
    .filter((value) => Number.isFinite(value));

  return times.length > 0 ? Math.max(...times) : null;
}

// Bound the cache to the rolling window: an entry whose author and committer
// dates are both before the window start can never be listed again (listing
// uses `since=window.start`) nor counted (aggregation ignores weeks outside the
// window). Entries without any usable date are dropped too.
export function pruneCommitDetailsCache(cache, { before }) {
  const cutoff = Date.parse(before);
  if (!cache?.entries || !Number.isFinite(cutoff)) {
    return 0;
  }

  let pruned = 0;
  for (const [key, detail] of Object.entries(cache.entries)) {
    const latest = latestCommitTime(detail);
    if (latest === null || latest < cutoff) {
      delete cache.entries[key];
      pruned += 1;
    }
  }

  return pruned;
}

async function* readLines(filePath) {
  const input = createReadStream(filePath, { encoding: 'utf8' });
  const lines = createInterface({ input, crlfDelay: Infinity });

  try {
    for await (const line of lines) {
      yield line;
    }
  } finally {
    lines.close();
    input.destroy();
  }
}

async function readNdjsonCache(filePath, warn) {
  const entries = {};
  let header = null;
  let skipped = 0;

  for await (const line of readLines(filePath)) {
    if (line.trim() === '') {
      continue;
    }

    if (header === null) {
      header = JSON.parse(line);
      if (header?.schemaVersion !== commitCacheSchemaVersion) {
        throw new Error(`unsupported cache schemaVersion ${header?.schemaVersion}`);
      }
      continue;
    }

    try {
      const record = JSON.parse(line);
      if (typeof record?.key === 'string' && record.detail && typeof record.detail === 'object') {
        entries[record.key] = record.detail;
      } else {
        skipped += 1;
      }
    } catch {
      // A truncated or corrupt line only loses that one entry.
      skipped += 1;
    }
  }

  if (header === null) {
    throw new Error('empty cache file');
  }

  if (skipped > 0) {
    warn(`[github-profile-stats] ignored ${skipped} unreadable commit cache lines in ${path.basename(filePath)}`);
  }

  return {
    schemaVersion: commitCacheSchemaVersion,
    updatedAt: typeof header.updatedAt === 'string' ? header.updatedAt : new Date().toISOString(),
    entries
  };
}

// Stream the legacy v1 file without ever holding it in one string. It was
// always written with JSON.stringify(cache, null, 2), so each entry of
// `entries` starts on a line indented by 4 spaces and ends on a line that is
// exactly `    }` or `    },`. JSON strings never contain raw newlines, so this
// line structure is reliable; each entry is then parsed and slimmed alone.
async function readLegacyJsonCache(filePath) {
  const entries = {};
  let schemaVersion;
  let updatedAt;
  let inEntries = false;
  let sawEntries = false;
  let chunk = null;

  const addChunk = (text) => {
    const parsed = JSON.parse(`{${text.replace(/,\s*$/, '')}}`);
    for (const [key, detail] of Object.entries(parsed)) {
      const slim = slimCommitDetail(detail);
      if (slim) {
        entries[key] = slim;
      }
    }
  };

  for await (const line of readLines(filePath)) {
    if (chunk !== null) {
      chunk.push(line);
      if (line === '    }' || line === '    },') {
        addChunk(chunk.join('\n'));
        chunk = null;
      }
      continue;
    }

    if (inEntries) {
      if (line === '  }' || line === '  },') {
        inEntries = false;
        continue;
      }

      if (!line.startsWith('    "')) {
        throw new Error('unexpected legacy cache layout');
      }

      if (line.endsWith('{')) {
        chunk = [line];
      } else {
        // Single-line entry such as `"key": {},` or `"key": null,`.
        addChunk(line);
      }
      continue;
    }

    const schemaMatch = /^  "schemaVersion": (\d+),?$/.exec(line);
    if (schemaMatch) {
      schemaVersion = Number(schemaMatch[1]);
      continue;
    }

    const updatedMatch = /^  "updatedAt": ("(?:[^"\\]|\\.)*"),?$/.exec(line);
    if (updatedMatch) {
      updatedAt = JSON.parse(updatedMatch[1]);
      continue;
    }

    if (/^  "entries": \{\},?$/.test(line)) {
      sawEntries = true;
      continue;
    }

    if (line === '  "entries": {') {
      sawEntries = true;
      inEntries = true;
    }
  }

  if (chunk !== null || inEntries) {
    throw new Error('truncated legacy cache file');
  }

  if (schemaVersion !== legacyCommitCacheSchemaVersion || !sawEntries) {
    throw new Error(`unsupported legacy cache schemaVersion ${schemaVersion}`);
  }

  return {
    schemaVersion: commitCacheSchemaVersion,
    updatedAt: updatedAt ?? new Date().toISOString(),
    entries
  };
}

export async function loadCommitDetailsCache({ cacheDir, warn = console.warn }) {
  const cachePath = path.join(cacheDir, commitCacheFileName);
  const legacyPath = path.join(cacheDir, legacyCommitCacheFileName);

  try {
    return await readNdjsonCache(cachePath, warn);
  } catch (error) {
    if (error.code !== 'ENOENT') {
      warn(`[github-profile-stats] starting from an empty commit cache: cannot read ${commitCacheFileName}: ${error.message}`);
      return createCommitCacheEnvelope();
    }
  }

  try {
    const migrated = await readLegacyJsonCache(legacyPath);
    warn(`[github-profile-stats] migrated ${Object.keys(migrated.entries).length} entries from legacy ${legacyCommitCacheFileName}`);
    return migrated;
  } catch (error) {
    if (error.code !== 'ENOENT') {
      warn(`[github-profile-stats] starting from an empty commit cache: cannot read legacy ${legacyCommitCacheFileName}: ${error.message}`);
    }
    return createCommitCacheEnvelope();
  }
}

async function writeLine(stream, line) {
  if (!stream.write(`${line}\n`)) {
    await once(stream, 'drain');
  }
}

export async function saveCommitDetailsCache(cache, { cacheDir }) {
  await mkdir(cacheDir, { recursive: true });
  const cachePath = path.join(cacheDir, commitCacheFileName);
  const tmpPath = `${cachePath}.tmp-${process.pid}`;
  const stream = createWriteStream(tmpPath, { encoding: 'utf8' });
  const failed = new Promise((_, reject) => stream.once('error', reject));
  failed.catch(() => {});

  try {
    await Promise.race([
      (async () => {
        await writeLine(stream, JSON.stringify({
          schemaVersion: commitCacheSchemaVersion,
          format: 'ndjson',
          updatedAt: new Date().toISOString()
        }));

        for (const [key, detail] of Object.entries(cache?.entries ?? {})) {
          if (detail && typeof detail === 'object') {
            await writeLine(stream, JSON.stringify({ key, detail }));
          }
        }

        stream.end();
        await once(stream, 'finish');
      })(),
      failed
    ]);
  } catch (error) {
    stream.destroy();
    await rm(tmpPath, { force: true });
    throw error;
  }

  await rename(tmpPath, cachePath);
  // The legacy single-document file has been migrated; drop it so it is not
  // restored or re-uploaded to the Actions cache again.
  await rm(path.join(cacheDir, legacyCommitCacheFileName), { force: true });
}
