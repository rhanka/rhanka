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

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const configPath = path.join(rootDir, 'config/stats.config.json');
const readmePath = path.join(rootDir, 'README.md');
const generatedDir = path.join(rootDir, 'generated');
const statsPath = path.join(generatedDir, 'stats.json');
const weeklyCommitsPath = path.join(generatedDir, 'weekly-commits.svg');
const weeklyLinesPath = path.join(generatedDir, 'weekly-lines.svg');

function buildStats(config, { generatedAt, window, commits }) {
  const aggregates = aggregateStats({ weeks: window.weeks, commits });

  return {
    generatedAt,
    window,
    identities: config.identities,
    weeklyCommits: aggregates.weeklyCommits,
    weeklyLines: aggregates.weeklyLines,
    topReposLast4Weeks: aggregates.topReposLast4Weeks
  };
}

function buildEmptyStats(config) {
  const generatedAt = new Date().toISOString();
  const window = buildRollingWindow(generatedAt, config.windowWeeks);

  return buildStats(config, { generatedAt, window, commits: [] });
}

function splitRepoName(repo) {
  const [owner, name] = repo.split('/');

  if (!owner || !name) {
    throw new Error(`Invalid repository name: ${repo}`);
  }

  return { owner, name };
}

function toAggregatedCommit(commit, fallback) {
  return {
    repo: commit.repo,
    authoredAt: commit.authoredAt ?? fallback.authoredAt,
    weekStart: commit.weekStart ?? fallback.weekStart,
    additions: commit.commit?.stats?.additions ?? 0,
    deletions: commit.commit?.stats?.deletions ?? 0
  };
}

async function fetchDefaultBranch(owner, repo, token) {
  const repository = await githubRest(`/repos/${owner}/${repo}`, token);
  return repository.default_branch;
}

async function listCommitsForAuthor({
  owner,
  repo,
  branch,
  author,
  since,
  until,
  token
}) {
  const commits = [];

  for (let page = 1; ; page += 1) {
    const entries = await githubRest(
      buildListCommitsPath({
        owner,
        repo,
        branch,
        author,
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
      commits.push(toCollectedCommit(`${owner}/${repo}`, entry, author));
    }

    if (entries.length < 100) {
      break;
    }
  }

  return commits;
}

async function buildLiveStats(config, token) {
  const generatedAt = new Date().toISOString();
  const window = buildRollingWindow(generatedAt, config.windowWeeks);
  const primaryLogin = config.identities.logins[0] ?? null;
  const discoveredRepoEntries = primaryLogin
    ? await discoverRepos({
        login: primaryLogin,
        from: window.start,
        to: window.end,
        token
      })
    : [];
  const repoBranchByName = new Map(
    discoveredRepoEntries.map(({ repo, defaultBranch }) => [repo, defaultBranch])
  );
  const candidateRepos = mergeCandidateRepos({
    discoveredRepos: discoveredRepoEntries.map(({ repo }) => repo),
    includeRepos: config.includeRepos,
    excludeRepos: config.excludeRepos
  });
  const authors = [...new Set([...config.identities.logins, ...config.identities.emails])];
  const collectedCommits = [];

  for (const candidateRepo of candidateRepos) {
    const { owner, name } = splitRepoName(candidateRepo);
    const defaultBranch =
      repoBranchByName.get(candidateRepo) ?? (await fetchDefaultBranch(owner, name, token));

    for (const author of authors) {
      const commits = await listCommitsForAuthor({
        owner,
        repo: name,
        branch: defaultBranch,
        author,
        since: window.start,
        until: window.end,
        token
      });
      collectedCommits.push(...commits);
    }
  }

  const hydratedCommits = [];

  for (const commit of dedupeCommitsBySha(collectedCommits)) {
    const { owner, name } = splitRepoName(commit.repo);
    const details = await fetchCommitDetails(owner, name, commit.sha, token);
    hydratedCommits.push(toAggregatedCommit(toCollectedCommit(commit.repo, details), commit));
  }

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
    '![Commits hebdomadaires](generated/weekly-commits.svg)',
    '',
    '![Lignes modifiees hebdomadaires](generated/weekly-lines.svg)',
    '',
    '### Top 5 des 4 dernieres semaines',
    '',
    renderTopReposTable(stats.topReposLast4Weeks)
  ].join('\n');
}

export async function main({
  argv = process.argv.slice(2),
  env = process.env
} = {}) {
  const writeMode = argv.includes('--write');
  const token = env.PROFILE_STATS_TOKEN ?? env.GITHUB_TOKEN ?? '';

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
