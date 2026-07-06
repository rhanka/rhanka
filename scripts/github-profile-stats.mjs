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
import { renderTopReposTable, renderWeeklySummaryTable, replaceStatsBlock } from '../src/update-readme.mjs';
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
const defaultHydrationLimitPerRun = 800;
const requiredCoverageRepos = [
  'rhanka/sent-tech-design-system',
  'rhanka/sentropic'
];

function buildStats(config, { generatedAt, window, commits }) {
  const aggregates = aggregateStats({ weeks: window.weeks, commits });

  return {
    generatedAt,
    window,
    identities: config.identities,
    weeklyCommits: aggregates.weeklyCommits,
    weeklyLines: aggregates.weeklyLines,
    weeklyLinesRaw: aggregates.weeklyLinesRaw,
    topReposLast5Weeks: aggregates.topReposLast5Weeks,
    topReposLast4Weeks: aggregates.topReposLast5Weeks
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

function sanitizeCommitDetail(detail, fetchedAt = new Date().toISOString()) {
  if (!detail || typeof detail !== 'object') {
    return null;
  }

  return {
    sha: detail.sha,
    parents: detail.parents,
    commit: detail.commit,
    stats: detail.stats,
    files: detail.files,
    fetchedAt
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
  const sourceAuthor = normalizeIdentity(entry.sourceAuthor);
  if (sourceAuthor && identitySets.logins.has(sourceAuthor)) {
    return true;
  }

  const login = normalizeIdentity(entry.author?.login);
  if (login && identitySets.logins.has(login)) {
    return true;
  }

  const committerLogin = normalizeIdentity(entry.committer?.login);
  if (committerLogin && identitySets.logins.has(committerLogin)) {
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

  const commitCommitter = entry.commit?.committer;
  const commitCommitterName = normalizeIdentity(commitCommitter?.name);
  if (commitCommitterName && identitySets.logins.has(commitCommitterName)) {
    return true;
  }

  const commitCommitterEmail = normalizeIdentity(commitCommitter?.email);
  if (commitCommitterEmail && identitySets.emails.has(commitCommitterEmail)) {
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

function hasHydratableCommitDetails(detail) {
  return Boolean(
    detail &&
    typeof detail === 'object' &&
    detail.stats
  );
}

function collectCachedCommitsForRepo({
  repo,
  commitDetailsCache,
  identitySets,
  window
}) {
  const entries = commitDetailsCache?.entries ?? {};
  const prefix = `${repo}#`;
  const collected = [];

  for (const [cacheKey, detail] of Object.entries(entries)) {
    if (!cacheKey.startsWith(prefix) || !hasHydratableCommitDetails(detail)) {
      continue;
    }

    const commit = toCollectedCommit(repo, detail);
    if (!commit.authoredAt || commit.authoredAt < window.start || commit.authoredAt > window.end) {
      continue;
    }

    if (!commitMatchesTrackedIdentity(commit.commit, identitySets)) {
      continue;
    }

    collected.push(commit);
  }

  return dedupeCommitsBySha(collected);
}

function parseHydrationLimit(value, fallback = defaultHydrationLimitPerRun) {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new RangeError(`Hydration limit must be a non-negative integer, got ${value}`);
  }

  return parsed;
}

function parseOptionalInteger(value, name) {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new RangeError(`${name} must be a non-negative integer, got ${value}`);
  }

  return parsed;
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
  authors = [],
  since,
  until,
  token,
  commitMatches = () => true
}) {
  const commits = [];
  const authorList = [...new Set(authors.filter(Boolean))];
  const effectiveAuthors = authorList.length > 0 ? authorList : [undefined];
  const byAuthorCommits = await Promise.all(
    effectiveAuthors.map(async (entryAuthor) => {
      const authorCommits = [];

      for (let page = 1; ; page += 1) {
        const entries = await githubRest(
          buildListCommitsPath({
            owner,
            repo,
            branch,
            author: entryAuthor,
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

          authorCommits.push(toCollectedCommit(`${owner}/${repo}`, entry, entryAuthor));
        }

        if (entries.length < 100) {
          break;
        }
      }

      return authorCommits;
    })
  );

  for (const byAuthor of byAuthorCommits) {
    commits.push(...byAuthor);
  }

  return dedupeCommitsBySha(commits);
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
  hydrateLimit = defaultHydrationLimitPerRun,
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

  const commitDetailsCache = await loadCommitDetailsCacheImpl();

  const liveCollectedCommits = (
    await mapWithConcurrencyImpl(listReposConcurrency, repoTasks, async ({
      owner,
      repo,
      candidateRepo
    }) => {
      try {
        const byAuthor = await listCommitsForRepoImpl({
          owner,
          repo,
          since: window.start,
          until: window.end,
          token,
          authors: [...identitySets.logins],
          commitMatches(entry) {
            return commitMatchesTrackedIdentity(entry, identitySets);
          }
        });

        if (identitySets.emails.size === 0 || byAuthor.length > 0 || identitySets.logins.length === 0) {
          return byAuthor;
        }

        return listCommitsForRepoImpl({
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
        const cachedCommits = collectCachedCommitsForRepo({
          repo: candidateRepo,
          commitDetailsCache,
          identitySets,
          window
        });
        const fallbackSuffix = cachedCommits.length > 0
          ? `; using ${cachedCommits.length} cached commits for this repo`
          : '; no cached commits available for this repo';

        warn(
          `${warningMessage(
            `skipping commits for repo "${candidateRepo}" while listing commits`,
            error
          )}${fallbackSuffix}`
        );
        return cachedCommits;
      }
    })
  ).flat();

  const liveReposWithCommits = new Set(liveCollectedCommits.map((commit) => commit.repo));
  const cachedRequiredCommits = requiredCoverageRepos.flatMap((repo) => {
    if (!candidateRepos.includes(repo)) {
      return [];
    }

    const cachedCommits = collectCachedCommitsForRepo({
      repo,
      commitDetailsCache,
      identitySets,
      window
    });

    if (cachedCommits.length > 0) {
      const reason = liveReposWithCommits.has(repo)
        ? 'merging cached coverage with live commits'
        : 'using cached coverage because live listing returned no commits';
      warn(`[github-profile-stats] ${reason} for required repo "${repo}" (${cachedCommits.length} cached commits)`);
    }

    return cachedCommits;
  });
  const collectedCommits = [...liveCollectedCommits, ...cachedRequiredCommits];

  const uniqueCommits = dedupeCommitsBySha(collectedCommits).sort((left, right) => {
    const leftRequiredIndex = requiredCoverageRepos.indexOf(left.repo);
    const rightRequiredIndex = requiredCoverageRepos.indexOf(right.repo);
    const leftRequiredRank = leftRequiredIndex === -1 ? Number.POSITIVE_INFINITY : leftRequiredIndex;
    const rightRequiredRank = rightRequiredIndex === -1 ? Number.POSITIVE_INFINITY : rightRequiredIndex;

    if (leftRequiredRank !== rightRequiredRank) {
      return leftRequiredRank - rightRequiredRank;
    }

    return (right.authoredAt ?? '').localeCompare(left.authoredAt ?? '');
  });
  let remainingHydrations = hydrateLimit;
  const commitsWithHydrationPlan = uniqueCommits.map((commit) => {
    if (isMergeCommitEntry(commit)) {
      return {
        commit,
        cacheKey: null,
        cachedEntry: null,
        shouldFetch: false
      };
    }

    const cacheKey = buildCommitCacheKey(commit.repo, commit.sha);
    const cachedEntry = commitDetailsCache?.entries?.[cacheKey] ?? null;
    const shouldFetch = !hasHydratableCommitDetails(cachedEntry) && remainingHydrations > 0;

    if (shouldFetch) {
      remainingHydrations -= 1;
    }

    return {
      commit,
      cacheKey,
      cachedEntry,
      shouldFetch
    };
  });

  const skippedHydrationCount = commitsWithHydrationPlan.filter(
    ({ cacheKey, cachedEntry, shouldFetch }) => cacheKey && !hasHydratableCommitDetails(cachedEntry) && !shouldFetch
  ).length;

  if (skippedHydrationCount > 0) {
    warn(
      `[github-profile-stats] skipped hydration for ${skippedHydrationCount} uncached commits after reaching PROFILE_STATS_HYDRATE_LIMIT=${hydrateLimit}; they will be retried on a later run`
    );
  }

  const hydratedCommits = (
    await mapWithConcurrencyImpl(
      hydrateCommitsConcurrency,
      commitsWithHydrationPlan,
      async ({ commit, cacheKey, cachedEntry, shouldFetch }) => {
        if (isMergeCommitEntry(commit)) {
          return toAggregatedCommit(commit, commit, {
            excludePath: excludeLinePath
          });
        }

        let details = cachedEntry;

        try {
          if (!hasHydratableCommitDetails(details)) {
            if (!shouldFetch) {
              return null;
            }

            const { owner, name } = splitRepoName(commit.repo);
            details = sanitizeCommitDetail(
              await fetchCommitDetailsImpl(owner, name, commit.sha, token)
            );

            if (details) {
              commitDetailsCache.entries = commitDetailsCache.entries ?? {};
              commitDetailsCache.entries[cacheKey] = details;
            }
          }

          if (!hasHydratableCommitDetails(details)) {
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
    '```text',
    '📊 5 dernières semaines',
    '',
    renderWeeklySummaryTable(stats.weeklyCommits, stats.weeklyLines, 5),
    '',
    '🏆 Top 5 repos (5 sem glissantes) — par lignes modifiées',
    '',
    renderTopReposTable(stats.topReposLast5Weeks ?? stats.topReposLast4Weeks),
    '```'
  ].join('\n');
}


function repoLineCount(row) {
  return row?.lines5w ?? row?.lines4w ?? 0;
}

function repoCommitCount(row) {
  return row?.commits5w ?? row?.commits4w ?? 0;
}

function sortTopRepoRows(rows) {
  return [...rows].sort((left, right) => {
    const rightLines = repoLineCount(right);
    const leftLines = repoLineCount(left);
    if (rightLines !== leftLines) {
      return rightLines - leftLines;
    }

    const rightCommits = repoCommitCount(right);
    const leftCommits = repoCommitCount(left);
    if (rightCommits !== leftCommits) {
      return rightCommits - leftCommits;
    }

    if (left.lastActivityAt !== right.lastActivityAt) {
      if (!left.lastActivityAt) {
        return 1;
      }

      if (!right.lastActivityAt) {
        return -1;
      }

      return right.lastActivityAt.localeCompare(left.lastActivityAt);
    }

    return left.repo.localeCompare(right.repo);
  });
}

export function retainRequiredRepoCoverageFromPrevious(nextStats, previousStats, {
  minSentTechLines = 350000,
  minSentropicLines = 95000,
  warn = console.warn
} = {}) {
  const requiredThresholds = new Map([
    ['rhanka/sent-tech-design-system', minSentTechLines],
    ['rhanka/sentropic', minSentropicLines]
  ]);
  const nextRows = Array.isArray(nextStats?.topReposLast5Weeks)
    ? nextStats.topReposLast5Weeks
    : Array.isArray(nextStats?.topReposLast4Weeks) ? nextStats.topReposLast4Weeks : [];
  const previousRows = Array.isArray(previousStats?.topReposLast5Weeks)
    ? previousStats.topReposLast5Weeks
    : Array.isArray(previousStats?.topReposLast4Weeks) ? previousStats.topReposLast4Weeks : [];
  const byRepo = new Map(nextRows.map((row) => [row.repo, { ...row }]));
  let changed = false;

  for (const [repo, threshold] of requiredThresholds) {
    const current = byRepo.get(repo);
    if (repoLineCount(current) >= threshold) {
      continue;
    }

    const previous = previousRows.find((row) => row.repo === repo);
    if (repoLineCount(previous) < threshold) {
      continue;
    }

    byRepo.set(repo, { ...previous, retainedFromPreviousRun: true });
    changed = true;
    warn(`[github-profile-stats] retained previous published coverage for required repo "${repo}" (${repoLineCount(previous)} lines) because current collection had ${repoLineCount(current)} lines`);
  }

  if (!changed) {
    return nextStats;
  }

  const topReposLast5Weeks = sortTopRepoRows([...byRepo.values()]).slice(0, 5);
  return {
    ...nextStats,
    topReposLast5Weeks,
    topReposLast4Weeks: topReposLast5Weeks
  };
}

export function findRequiredRepoCoverageFailure(stats, {
  minSentTechLines = 350000,
  minSentropicLines = 95000
} = {}) {
  const rows = Array.isArray(stats?.topReposLast5Weeks)
    ? stats.topReposLast5Weeks
    : Array.isArray(stats?.topReposLast4Weeks) ? stats.topReposLast4Weeks : [];
  const byRepo = new Map(rows.map((row) => [row.repo, row]));
  const sentTechRow = byRepo.get('rhanka/sent-tech-design-system');
  const sentropicRow = byRepo.get('rhanka/sentropic');
  const sentTechLines = sentTechRow?.lines5w ?? sentTechRow?.lines4w ?? 0;
  const sentropicLines = sentropicRow?.lines5w ?? sentropicRow?.lines4w ?? 0;

  if (sentTechLines < minSentTechLines) {
    return `rhanka/sent-tech-design-system has only ${sentTechLines} lines over 5w; expected at least ${minSentTechLines}`;
  }

  if (sentropicLines < minSentropicLines) {
    return `rhanka/sentropic has only ${sentropicLines} lines over 5w; expected at least ${minSentropicLines}`;
  }

  return null;
}

export function totalWindowCommits(stats) {
  return (stats?.weeklyCommits ?? []).reduce(
    (sum, week) => sum + (week?.count ?? 0),
    0
  );
}

// Guard against publishing a collection that silently failed (e.g. every repo
// skipped on a rate-limit 403). Returns a reason string when the freshly built
// stats look broken relative to what is already published, otherwise null.
export function findStatsRegression(nextStats, previousStats, {
  minRetainedRatio = 0.5
} = {}) {
  const nextTotal = totalWindowCommits(nextStats);

  if (nextTotal === 0) {
    return 'collected 0 commits across the window (likely a rate-limit or token failure)';
  }

  const previousTotal = totalWindowCommits(previousStats);

  if (previousTotal > 0 && nextTotal < previousTotal * minRetainedRatio) {
    return `window commit total collapsed from ${previousTotal} to ${nextTotal} (kept < ${Math.round(minRetainedRatio * 100)}% of the previous run)`;
  }

  return null;
}

async function readPreviousStats() {
  try {
    return JSON.parse(await readFile(statsPath, 'utf8'));
  } catch {
    return null;
  }
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
  const builtStats = token
    ? await buildLiveStats(config, token, {
      hydrateLimit: parseHydrationLimit(env.PROFILE_STATS_HYDRATE_LIMIT)
    })
    : buildEmptyStats(config);
  const previousStats = writeMode ? await readPreviousStats() : null;
  const stats = writeMode
    ? retainRequiredRepoCoverageFromPrevious(builtStats, previousStats, {
      minSentTechLines: parseOptionalInteger(env.PROFILE_STATS_MIN_SENT_TECH_LINES, 'PROFILE_STATS_MIN_SENT_TECH_LINES'),
      minSentropicLines: parseOptionalInteger(env.PROFILE_STATS_MIN_SENTROPIC_LINES, 'PROFILE_STATS_MIN_SENTROPIC_LINES')
    })
    : builtStats;

  if (!writeMode) {
    console.log(JSON.stringify(stats, null, 2));
    return;
  }

  const coverageFailure = findRequiredRepoCoverageFailure(stats, {
    minSentTechLines: parseOptionalInteger(env.PROFILE_STATS_MIN_SENT_TECH_LINES, 'PROFILE_STATS_MIN_SENT_TECH_LINES'),
    minSentropicLines: parseOptionalInteger(env.PROFILE_STATS_MIN_SENTROPIC_LINES, 'PROFILE_STATS_MIN_SENTROPIC_LINES')
  });
  if (coverageFailure) {
    throw new Error(
      `[github-profile-stats] refusing to overwrite published stats: incomplete required repo coverage: ${coverageFailure}`
    );
  }

  const regression = findStatsRegression(stats, previousStats);
  if (regression) {
    throw new Error(
      `[github-profile-stats] refusing to overwrite published stats: ${regression}`
    );
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
