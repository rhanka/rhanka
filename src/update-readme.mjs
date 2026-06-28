function normalizeNumber(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return '0';
  }

  return new Intl.NumberFormat('fr-FR').format(Math.round(value)).replace(/\u202f/g, ' ');
}

function formatSignedNumber(value) {
  if (value > 0) {
    return `+${normalizeNumber(value)}`;
  }

  if (value < 0) {
    return `−${normalizeNumber(Math.abs(value))}`;
  }

  return '+0';
}

function formatWeekLabel(weekStart) {
  if (!weekStart) {
    return '';
  }

  const date = new Date(weekStart);

  return new Intl.DateTimeFormat('fr-FR', {
    day: 'numeric',
    month: 'long',
    timeZone: 'UTC'
  }).format(date);
}

function formatLastActivity(isoDate) {
  if (!isoDate) {
    return '';
  }

  const date = new Date(isoDate);
  const dateLabel = new Intl.DateTimeFormat('fr-FR', {
    day: 'numeric',
    month: 'long',
    timeZone: 'UTC'
  }).format(date);
  const hour = String(date.getUTCHours()).padStart(2, '0');
  const minute = String(date.getUTCMinutes()).padStart(2, '0');

  return `${dateLabel} ${hour}:${minute}`;
}

function formatTrend(previous, current) {
  if (previous == null || current == null) {
    return '';
  }

  if (current > previous) {
    return '↑↑';
  }

  if (current < previous) {
    return '↓↓';
  }

  return '↔';
}

function padValue(value, width, align = 'left') {
  if (align === 'right') {
    return value.padStart(width);
  }

  return value.padEnd(width);
}

function renderBoxTable(columns, rows) {
  const colCount = columns.length;
  const widths = Array.from({ length: colCount }, (_, colIndex) => {
    const heading = columns[colIndex].heading ?? '';
    let width = heading.length;

    for (const row of rows) {
      const value = row[colIndex] ?? '';
      width = Math.max(width, value.length);
    }

    return width;
  });

  const top = `┌${widths.map((width) => '─'.repeat(width + 2)).join('┬')}┐`;
  const divider = `├${widths.map((width) => '─'.repeat(width + 2)).join('┼')}┤`;
  const bottom = `└${widths.map((width) => '─'.repeat(width + 2)).join('┴')}┘`;

  const lines = [top];
  lines.push(
    `│ ${columns.map((column, index) => padValue(column.heading, widths[index], column.align)).join(' │ ')} │`
  );
  lines.push(divider);

  for (const row of rows) {
    lines.push(
      `│ ${row.map((value, index) => padValue(value, widths[index], columns[index].align)).join(' │ ')} │`
    );
  }

  lines.push(bottom);

  return lines.join('\n');
}

export function renderWeeklySummaryTable(weeklyCommits = [], weeklyLines = [], weekCount = 2) {
  if (!Array.isArray(weeklyCommits) || !Array.isArray(weeklyLines) || weeklyCommits.length === 0) {
    return '_Aucune activité sur la période récente._';
  }

  const totalRows = Math.min(weekCount, weeklyCommits.length);
  const start = Math.max(0, weeklyCommits.length - totalRows);
  const rows = [];

  for (let index = start; index < weeklyCommits.length; index += 1) {
    const commits = weeklyCommits[index] ?? {};
    const lines = weeklyLines[index] ?? {};
    const previousCommits = weeklyCommits[index - 1]?.count;

    rows.push([
      formatWeekLabel(commits.weekStart),
      `${normalizeNumber(commits.count ?? 0)} ${formatTrend(previousCommits, commits.count ?? 0)}`.trim(),
      `${formatSignedNumber(lines.additions ?? 0)} / ${formatSignedNumber(-(lines.deletions ?? 0))}`,
      formatSignedNumber(lines.net ?? ((lines.additions ?? 0) - (lines.deletions ?? 0)))
    ]);
  }

  return renderBoxTable(
    [
      { heading: 'Semaine', align: 'left' },
      { heading: 'Commits', align: 'right' },
      { heading: 'Lignes (+/−)', align: 'right' },
      { heading: 'Net', align: 'right' }
    ],
    rows
  );
}

export function renderTopReposTable(rows, { weekCount = 5 } = {}) {
  if (!Array.isArray(rows) || rows.length === 0) {
    return `_Aucune activité sur les ${weekCount} dernières semaines._`;
  }

  const lineKey = `lines${weekCount}w`;
  const commitKey = `commits${weekCount}w`;
  const renderedRows = rows.map((row, index) => [
    `${index + 1}`,
    `${row.repo ?? ''}`,
    normalizeNumber(row[lineKey] ?? row.lines4w ?? 0),
    normalizeNumber(row[commitKey] ?? row.commits4w ?? 0),
    formatLastActivity(row.lastActivityAt)
  ]);

  return renderBoxTable(
    [
      { heading: '#', align: 'right' },
      { heading: 'Repo', align: 'left' },
      { heading: `Lignes ${weekCount}s`, align: 'right' },
      { heading: `Commits ${weekCount}s`, align: 'right' },
      { heading: 'Dernière activité', align: 'left' }
    ],
    renderedRows
  );
}

export function replaceStatsBlock(readme, block) {
  const startMarker = '<!-- github-profile-stats:start -->';
  const endMarker = '<!-- github-profile-stats:end -->';
  const start = readme.indexOf(startMarker);
  const end = readme.indexOf(endMarker);

  if (start === -1 || end === -1 || end < start) {
    throw new Error('README is missing github-profile-stats markers');
  }

  const before = readme.slice(0, start + startMarker.length);
  const after = readme.slice(end);
  const content = block.endsWith('\n') ? block.slice(0, -1) : block;

  return `${before}\n${content}\n${after}`;
}
