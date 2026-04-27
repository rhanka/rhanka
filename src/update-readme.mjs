function formatDate(isoDate) {
  return isoDate ? isoDate.slice(0, 10) : '';
}

export function renderTopReposTable(rows) {
  const lines = [
    '| Repo | Derniere activite | Commits (4 sem.) | Lignes modifiees (4 sem.) |',
    '| --- | --- | --- | --- |'
  ];

  for (const row of rows) {
    lines.push(
      `| ${row.repo} | ${formatDate(row.lastActivityAt)} | ${row.commits4w} | ${row.lines4w} |`
    );
  }

  return lines.join('\n');
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
