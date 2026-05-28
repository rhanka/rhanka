function emptyWeeklyLine(weekStart) {
  return {
    weekStart,
    additions: 0,
    deletions: 0,
    net: 0
  };
}

function toLines(commit) {
  const stats = commit.commit?.stats ?? {};

  return {
    additions: commit.additions ?? stats.additions ?? 0,
    deletions: commit.deletions ?? stats.deletions ?? 0
  };
}

function toRawLines(commit) {
  const stats = commit.commit?.stats ?? {};

  return {
    additions: commit.rawAdditions ?? commit.additions ?? stats.additions ?? 0,
    deletions: commit.rawDeletions ?? commit.deletions ?? stats.deletions ?? 0
  };
}

export function aggregateStats({ weeks = [], commits = [] } = {}) {
  const weeklyCommits = weeks.map((weekStart) => ({
    weekStart,
    count: 0
  }));

  const weeklyLines = weeks.map(emptyWeeklyLine);
  const weeklyLinesRaw = weeks.map(emptyWeeklyLine);
  const weekIndexByStart = new Map(weeks.map((weekStart, index) => [weekStart, index]));
  const topWeeks = new Set(weeks.slice(-4));
  const repoStats = new Map();

  for (const commit of commits) {
    const weekStart = commit.weekStart;
    const index = weekIndexByStart.get(weekStart);

    if (index !== undefined) {
      weeklyCommits[index].count += 1;

      const { additions, deletions } = toLines(commit);
      const weeklyLine = weeklyLines[index];

      weeklyLine.additions += additions;
      weeklyLine.deletions += deletions;
      weeklyLine.net += additions - deletions;

      const rawLines = toRawLines(commit);
      const weeklyLineRaw = weeklyLinesRaw[index];

      weeklyLineRaw.additions += rawLines.additions;
      weeklyLineRaw.deletions += rawLines.deletions;
      weeklyLineRaw.net += rawLines.additions - rawLines.deletions;
    }

    if (!topWeeks.has(weekStart)) {
      continue;
    }

    const { additions, deletions } = toLines(commit);
    const linesChanged = additions + deletions;
    const current = repoStats.get(commit.repo) ?? {
      repo: commit.repo,
      lastActivityAt: commit.authoredAt ?? null,
      commits4w: 0,
      lines4w: 0
    };

    current.commits4w += 1;
    current.lines4w += linesChanged;

    if (
      current.lastActivityAt === null ||
      (commit.authoredAt !== null && commit.authoredAt > current.lastActivityAt)
    ) {
      current.lastActivityAt = commit.authoredAt;
    }

    repoStats.set(commit.repo, current);
  }

  const topReposLast4Weeks = [...repoStats.values()]
    .sort((left, right) => {
      if (right.lines4w !== left.lines4w) {
        return right.lines4w - left.lines4w;
      }

      if (right.commits4w !== left.commits4w) {
        return right.commits4w - left.commits4w;
      }

      if (left.lastActivityAt !== right.lastActivityAt) {
        if (left.lastActivityAt === null) {
          return 1;
        }

        if (right.lastActivityAt === null) {
          return -1;
        }

        return right.lastActivityAt.localeCompare(left.lastActivityAt);
      }

      return left.repo.localeCompare(right.repo);
    })
    .slice(0, 5);

  return {
    weeklyCommits,
    weeklyLines,
    weeklyLinesRaw,
    topReposLast4Weeks
  };
}
