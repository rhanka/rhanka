function maxValue(series, key) {
  let max = 0;

  for (const item of series) {
    const value = item[key] ?? 0;
    if (value > max) {
      max = value;
    }
  }

  return max;
}

export function renderWeeklyCommitsSvg(series) {
  const width = 680;
  const height = 180;
  const originX = 20;
  const pitch = 12;
  const barWidth = 8;
  const topPad = 20;
  const chartHeight = 120;
  const maxCount = Math.max(1, maxValue(series, 'count'));

  const rects = [];
  for (const [index, week] of series.entries()) {
    const count = week.count ?? 0;
    const x = originX + index * pitch;
    const barHeight = count === 0 ? 0 : Math.max(1, Math.round((count / maxCount) * chartHeight));
    const y = topPad + (chartHeight - barHeight);

    rects.push(
      `<rect x="${x}" y="${y}" width="${barWidth}" height="${barHeight}" fill="#2563eb"/>`
    );
  }

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="title-desc">`,
    '<title id="title">Weekly commits</title>',
    '<desc id="desc">Weekly commits by week</desc>',
    `<rect width="${width}" height="${height}" fill="#ffffff"/>`,
    '<text x="16" y="22" fill="#111827" font-size="14">Weekly commits</text>',
    rects.join('\n'),
    '</svg>'
  ].join('\n');
}

export function renderWeeklyLinesSvg(series) {
  const width = 680;
  const height = 180;
  const axisY = 90;
  const originX = 20;
  const pitch = 12;
  const barWidth = 8;
  const chartHeight = 60;
  const maxMagnitude = Math.max(
    1,
    ...series.map((week) => Math.max(week.additions ?? 0, week.deletions ?? 0))
  );
  const scale = chartHeight / maxMagnitude;
  const rects = [];

  for (const [index, week] of series.entries()) {
    const x = originX + index * pitch;
    const additions = week.additions ?? 0;
    const deletions = week.deletions ?? 0;
    const additionsHeight = additions === 0 ? 0 : Math.max(1, Math.round(additions * scale));
    const deletionsHeight = deletions === 0 ? 0 : Math.max(1, Math.round(deletions * scale));

    rects.push(
      `<rect x="${x}" y="${axisY - additionsHeight}" width="${barWidth}" height="${additionsHeight}" fill="#16a34a"/>`,
      `<rect x="${x}" y="${axisY}" width="${barWidth}" height="${deletionsHeight}" fill="#dc2626"/>`
    );
  }

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="title-desc">`,
    '<title id="title">Weekly lines changed</title>',
    '<desc id="desc">Weekly lines changed by week</desc>',
    `<rect width="${width}" height="${height}" fill="#ffffff"/>`,
    '<text x="16" y="22" fill="#111827" font-size="14">Weekly lines changed</text>',
    `<line x1="20" y1="${axisY}" x2="${width - 20}" y2="${axisY}" stroke="#111827" stroke-width="2"/>`,
    rects.join('\n'),
    '</svg>'
  ].join('\n');
}
