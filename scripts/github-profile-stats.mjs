import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { normalizeConfig } from '../src/config.mjs';
import { aggregateStats } from '../src/aggregate-stats.mjs';
import {
  buildListCommitsPath,
  dedupeCommitsBySha,
  fetchCommitDetails,
  toCollectedCommit
} from '../src/collect-commits.mjs';
import { discoverRepos, mergeCandidateRepos } from '../src/discover-repos.mjs';
import { githubRest } from '../src/github-api.mjs';
import { buildRollingWindow } from '../src/time.mjs';
import { renderWeeklyCommitsSvg, renderWeeklyLinesSvg } from '../src/render-svg.mjs';
import { renderTopReposTable, replaceStatsBlock } from '../src/update-readme.mjs';
import { createPathExcluder } from '../src/path-filter.mjs';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const configPath = path.join(rootDir, 'config/stats.config.json');
const readmePath = path.join(rootDir, 'README.md');
const generatedDir = path.join(rootDir, 'generated');
const statsPath = path.join(generatedDir, 'stats.json');
const weeklyCommitsPath = path.join(generatedDir, 'weekly-commits.svg');
const weeklyLinesPath = path.join(generatedDir, 'weekly-lines.svg');
const cacheDir = path.join(rootDir, '.cache', 'github-profile-stats');
const commitDetailsCachePath = path.join(cacheDir, 'commit-details-cache.json');
const cacheSchemaVersion = 1;

function buildStats(config, { generatedAt, window, commits }) {
  const aggregates = aggregateStats({ weeks: window.weeks, commits });

  return {
    generatedAt,
    window,
    identities: config.identities,
    weeklyCommits: aggregates.weeklyCommits,
    weeklyLines: aggregates.weeklyLines,
    weeklyLinesRaw: aggregates.weeklyLinesRaw,
    topReposLast4Weeks: aggregates.topReposLast4Weeks
  };
}

function buildEmptyStats(config) {
  const generatedAt = new Date().toISOString();
  const window = buildRollingWindow(generatedAt, config.windowWeeks);

  return buildStats(config, { generatedAt, window, commits: [] });
}

function warningMessage(message, error) {
  const detail = error instanceof Error ? error.message : String(error);
  return `[github-profile-stats] ${message}: ${detail}`;
}

function createCommitCacheEnvelope(entries = {}) {
  return {
    schemaVersion: cacheSchemaVersion,
    updatedAt: new Date().toISOString(),
    entries
  };
}

function buildCommitCacheKey(repo, sha) {
  return `${repo}#${sha}`;
}

function sanitizeCommitDetail(detail) {
  if (!detail || typeof detail !== 'object') {
    return null;
  }

  return {
    sha: detail.sha,
    parents: detail.parents,
    commit: detail.commit,
    stats: detail.stats,
    files: detail.files
  };
}

async function loadCommitDetailsCache() {
  try {
    const raw = await readFile(commitDetailsCachePath, 'utf8');
    const parsed = JSON.parse(raw);

    if (parsed && parsed.schemaVersion === cacheSchemaVersion && parsed.entries) {
      return parsed;
    }

    return createCommitCacheEnvelope();
  } catch (error) {
    if (error.code === 'ENOENT') {
      return createCommitCacheEnvelope();
    }

    return createCommitCacheEnvelope();
  }
}

async function saveCommitDetailsCache(cache) {
  await mkdir(cacheDir, { recursive: true });
  await writeFile(commitDetailsCachePath, `${JSON.stringify({ ...cache, updatedAt: new Date().toISOString() }, null, 2)}\n`);
}

export async function mapWithConcurrency(limit, items, worker) {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new RangeError(`Concurrency limit must be a positive integer, got ${limit}`);
  }

  const results = new Array(items.length);
  let nextIndex = 0;

  async function runWorker() {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      results[currentIndex] = await worker(items[currentIndex], currentIndex);
    }
  }

  const workerCount = Math.min(limit, items.length);
  await Promise.all(Array.from({ length: workerCount }, () => runWorker()));

  return results;
}

export function resolveGithubToken(env = process.env) {
  const profileStatsToken = typeof env.PROFILE_STATS_TOKEN === 'string'
    ? env.PROFILE_STATS_TOKEN.trim()
    : '';

  if (profileStatsToken) {
    return profileStatsToken;
  }

  return typeof env.GITHUB_TOKEN === 'string' ? env.GITHUB_TOKEN.trim() : '';
}

function splitRepoName(repo) {
  const [owner, name] = repo.split('/');

  if (!owner || !name) {
    throw new Error(`Invalid repository name: ${repo}`);
  }

  return { owner, name };
}

function toLineCounts(stats = {}) {
  return {
    additions: stats.additions ?? 0,
    deletions: stats.deletions ?? 0
  };
}

function normalizeIdentity(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function buildIdentitySets(config) {
  return {
    logins: new Set(config.identities.logins.map(normalizeIdentity)),
    emails: new Set(config.identities.emails.map(normalizeIdentity))
  };
}

function commitMatchesTrackedIdentity(entry, identitySets) {
  const login = normalizeIdentity(entry.author?.login);
  if (login && identitySets.logins.has(login)) {
    return true;
  }

  const commitAuthor = entry.commit?.author;
  const commitAuthorName = normalizeIdentity(commitAuthor?.name);
  if (commitAuthorName && identitySets.logins.has(commitAuthorName)) {
    return true;
  }

  const commitAuthorEmail = normalizeIdentity(commitAuthor?.email);
  if (commitAuthorEmail && identitySets.emails.has(commitAuthorEmail)) {
    return true;
  }

  return false;
}

function toFilteredFileLineCounts(files, excludePath) {
  return files.reduce((total, file) => {
    if (excludePath(file.filename)) {
      return total;
    }

    total.additions += file.additions ?? 0;
    total.deletions += file.deletions ?? 0;
    return total;
  }, { additions: 0, deletions: 0 });
}

function toAggregatedCommit(commit, fallback, { excludePath = () => false } = {}) {
  const isMergeCommit = Array.isArray(commit.commit?.parents) && commit.commit.parents.length > 1;
  const rawLines = isMergeCommit ? { additions: 0, deletions: 0 } : toLineCounts(commit.commit?.stats);
  const filteredLines = isMergeCommit
    ? rawLines
    : Array.isArray(commit.commit?.files)
      ? toFilteredFileLineCounts(commit.commit.files, excludePath)
      : rawLines;

  return {
    repo: commit.repo,
    authoredAt: commit.authoredAt ?? fallback.authoredAt,
    weekStart: commit.weekStart ?? fallback.weekStart,
    additions: filteredLines.additions,
    deletions: filteredLines.deletions,
    rawAdditions: rawLines.additions,
    rawDeletions: rawLines.deletions
  };
}

function isMergeCommitEntry(entry) {
  const commitParents = Array.isArray(entry.commit?.parents) ? entry.commit.parents : [];
  const topLevelParents = Array.isArray(entry.parents) ? entry.parents : [];
  return commitParents.length > 1 || topLevelParents.length > 1;
}

async function listCommitsForRepo({
  owner,
  repo,
  branch,
  since,
  until,
  token,
  commitMatches = () => true
}) {
  const commits = [];

  for (let page = 1; ; page += 1) {
    const entries = await githubRest(
      buildListCommitsPath({
        owner,
        repo,
        branch,
        since,
        until,
        page
      }),
      token
    );

    if (entries.length === 0) {
      break;
    }

    for (const entry of entries) {
      if (!commitMatches(entry)) {
        continue;
      }

      commits.push(toCollectedCommit(`${owner}/${repo}`, entry));
    }

    if (entries.length < 100) {
      break;
    }
  }

  return commits;
}

export function mergeDiscoveredRepoEntries(discoveredRepoEntries) {
  const merged = new Map();

  for (const entry of discoveredRepoEntries) {
    const existing = merged.get(entry.repo);

    if (!existing) {
      merged.set(entry.repo, {
        repo: entry.repo,
        defaultBranch: entry.defaultBranch ?? null
      });
      continue;
    }

    if (existing.defaultBranch === null && entry.defaultBranch !== null) {
      existing.defaultBranch = entry.defaultBranch;
    }
  }

  return [...merged.values()].sort((left, right) => left.repo.localeCompare(right.repo));
}

export async function discoverReposForLogins({
  logins,
  from,
  to,
  token,
  discoverReposImpl = discoverRepos,
  warn = console.warn
}) {
  const discoveredRepoEntries = [];

  for (const login of [...new Set(logins)]) {
    const repos = await discoverReposImpl({
      login,
      from,
      to,
      token
    });

    if (repos.length === 100) {
      warn(
        `[github-profile-stats] repo discovery for login "${login}" returned 100 repositories; results may be truncated`
      );
    }

    discoveredRepoEntries.push(...repos);
  }

  return mergeDiscoveredRepoEntries(discoveredRepoEntries);
}

export async function buildLiveStats(config, token, {
  nowIso = new Date().toISOString(),
  warn = console.warn,
  discoverReposForLoginsImpl = discoverReposForLogins,
  listCommitsForRepoImpl = listCommitsForRepo,
  fetchCommitDetailsImpl = fetchCommitDetails,
  loadCommitDetailsCacheImpl = loadCommitDetailsCache,
  saveCommitDetailsCacheImpl = saveCommitDetailsCache,
  listReposConcurrency = 2,
  hydrateCommitsConcurrency = 10,
  mapWithConcurrencyImpl = mapWithConcurrency
} = {}) {
  const generatedAt = nowIso;
  const window = buildRollingWindow(generatedAt, config.windowWeeks);
  const excludeLinePath = createPathExcluder(config.lineFilters?.excludePathGlobs ?? []);
  const discoveredRepoEntries = await discoverReposForLoginsImpl({
    logins: config.identities.logins,
    from: window.start,
    to: window.end,
    token,
    warn
  });
  const identitySets = buildIdentitySets(config);
  const candidateRepos = mergeCandidateRepos({
    discoveredRepos: discoveredRepoEntries.map(({ repo }) => repo),
    includeRepos: config.includeRepos,
    excludeRepos: config.excludeRepos
  });
  const repoTasks = [];

  for (const candidateRepo of candidateRepos) {
    const { owner, name } = splitRepoName(candidateRepo);

    repoTasks.push({
      owner,
      repo: name,
      candidateRepo
    });
  }

  const collectedCommits = (
    await mapWithConcurrencyImpl(listReposConcurrency, repoTasks, async ({
      owner,
      repo,
      candidateRepo
    }) => {
      try {
        return await listCommitsForRepoImpl({
          owner,
          repo,
          since: window.start,
          until: window.end,
          token,
          commitMatches(entry) {
            return commitMatchesTrackedIdentity(entry, identitySets);
          }
        });
      } catch (error) {
        warn(
          warningMessage(
            `skipping commits for repo "${candidateRepo}" while listing commits`,
            error
          )
        );
        return [];
      }
    })
  ).flat();

  const commitDetailsCache = await loadCommitDetailsCacheImpl();
  const hydratedCommits = (
    await mapWithConcurrencyImpl(
      hydrateCommitsConcurrency,
      dedupeCommitsBySha(collectedCommits),
      async (commit) => {
        if (isMergeCommitEntry(commit)) {
          return toAggregatedCommit(commit, commit, {
            excludePath: excludeLinePath
          });
        }

        const { owner, name } = splitRepoName(commit.repo);
        const cacheKey = buildCommitCacheKey(commit.repo, commit.sha);
        const cachedEntry = commitDetailsCache?.entries?.[cacheKey];
        let details = cachedEntry;

        try {
          if (!details) {
            details = sanitizeCommitDetail(
              await fetchCommitDetailsImpl(owner, name, commit.sha, token)
            );

            if (details) {
              commitDetailsCache.entries = commitDetailsCache.entries ?? {};
              commitDetailsCache.entries[cacheKey] = details;
            }
          }

          if (!details) {
            return null;
          }

          return toAggregatedCommit(toCollectedCommit(commit.repo, details), commit, {
            excludePath: excludeLinePath
          });
        } catch (error) {
          warn(
            warningMessage(
              `skipping commit "${commit.sha}" in repo "${commit.repo}" while fetching details`,
              error
            )
          );
          return null;
        }
      }
    )
  ).filter((commit) => commit !== null);

  await saveCommitDetailsCacheImpl(commitDetailsCache);

  return buildStats(config, {
    generatedAt,
    window,
    commits: hydratedCommits
  });
}

function buildReadmeBlock(stats) {
  return [
    '## GitHub activity',
    '',
    '<img src="generated/weekly-commits.svg" alt="Weekly commits" width="100%">',
    '',
    '<img src="generated/weekly-lines.svg" alt="Weekly line deltas" width="100%">',
    '',
    '<details>',
    '<summary>Top 5 recent repos</summary>',
    '',
    renderTopReposTable(stats.topReposLast4Weeks),
    '',
    '</details>'
  ].join('\n');
}

export async function main({
  argv = process.argv.slice(2),
  env = process.env
} = {}) {
  const writeMode = argv.includes('--write');
  const token = resolveGithubToken(env);

  if (writeMode && !token) {
    throw new Error('PROFILE_STATS_TOKEN or GITHUB_TOKEN is required for live API collection');
  }

  const rawConfig = JSON.parse(await readFile(configPath, 'utf8'));
  const config = normalizeConfig(rawConfig);
  const stats = token ? await buildLiveStats(config, token) : buildEmptyStats(config);

  if (!writeMode) {
    console.log(JSON.stringify(stats, null, 2));
    return;
  }

  await mkdir(generatedDir, { recursive: true });
  await writeFile(statsPath, `${JSON.stringify(stats, null, 2)}\n`);
  await writeFile(weeklyCommitsPath, `${renderWeeklyCommitsSvg(stats.weeklyCommits)}\n`);
  await writeFile(weeklyLinesPath, `${renderWeeklyLinesSvg(stats.weeklyLines)}\n`);

  const readme = await readFile(readmePath, 'utf8');
  const updatedReadme = replaceStatsBlock(readme, buildReadmeBlock(stats));
  await writeFile(readmePath, updatedReadme);

  console.log(JSON.stringify(stats, null, 2));
}

const entrypoint = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href
  : null;

if (entrypoint === import.meta.url) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
