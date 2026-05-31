import { formatCompactNumber, formatSignedCompactNumber } from './number-format.mjs';

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

const MONTH_LABELS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const GITHUB_FONT_STACK = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif, 'Apple Color Emoji', 'Segoe UI Emoji'";
const GITHUB_COLORS = {
  border: '#d0d7de',
  grid: '#eef2f6',
  axis: '#d8dee4',
  zero: '#8c959f',
  text: '#24292f',
  muted: '#57606a',
  blue: '#0969da',
  green: '#1a7f37',
  red: '#cf222e'
};

const CHART = {
  width: 800,
  height: 240,
  plotX: 64,
  plotRight: 734,
  pitch: 13,
  barWidth: 7,
  monthLabelY: 214
};

function escapeXml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function formatWeekDate(weekStart) {
  return String(weekStart).slice(0, 10);
}

function buildMonthTicks(series, originX, pitch, baselineY) {
  const labels = [];
  let previousMonth = null;

  for (const [index, week] of series.entries()) {
    const month = new Date(week.weekStart).getUTCMonth();
    if (index === 0 || month !== previousMonth) {
      labels.push(
        `<text x="${originX + index * pitch + 3.5}" y="${baselineY}" fill="${GITHUB_COLORS.muted}" font-size="10" text-anchor="middle">${MONTH_LABELS[month]}</text>`
      );
    }
    previousMonth = month;
  }

  return labels;
}

function renderFrame({ title, subtitle }) {
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${CHART.width}" height="${CHART.height}" viewBox="0 0 ${CHART.width} ${CHART.height}" role="img" aria-labelledby="title-desc" font-family="${GITHUB_FONT_STACK}">`,
    `<title id="title">${escapeXml(title)}</title>`,
    `<desc id="desc">${escapeXml(subtitle)}</desc>`,
    `<rect x="0.5" y="0.5" width="${CHART.width - 1}" height="${CHART.height - 1}" rx="8" fill="#ffffff" stroke="${GITHUB_COLORS.border}"/>`,
    `<text x="24" y="32" fill="${GITHUB_COLORS.text}" font-size="16" font-weight="600">${escapeXml(title)}</text>`,
    `<text x="24" y="53" fill="${GITHUB_COLORS.muted}" font-size="12">${escapeXml(subtitle)}</text>`
  ];
}

function renderGridLines({ yTicks, x1 = CHART.plotX, x2 = CHART.plotRight }) {
  return yTicks.map(({ y, emphasis = false }) => (
    `<line x1="${x1}" y1="${y}" x2="${x2}" y2="${y}" stroke="${emphasis ? GITHUB_COLORS.axis : GITHUB_COLORS.grid}" stroke-width="1"/>`
  ));
}

function renderYAxisLabels(ticks) {
  return ticks.map(({ y, label }) => (
    `<text x="${CHART.plotRight + 12}" y="${y + 4}" fill="${GITHUB_COLORS.muted}" font-size="10" text-anchor="start">${escapeXml(label)}</text>`
  ));
}

function scaledDeltaHeight(value, maxValueForScale, maxHeight) {
  if (value === 0) {
    return 0;
  }

  return Math.max(1, Math.round((value / maxValueForScale) * maxHeight));
}

export function renderWeeklyCommitsSvg(series) {
  const topY = 64;
  const midY = 122;
  const baselineY = 180;
  const chartHeight = baselineY - topY;
  const maxCount = Math.max(1, maxValue(series, 'count'));
  const midCount = Math.ceil(maxCount / 2);
  const monthTicks = buildMonthTicks(series, CHART.plotX, CHART.pitch, CHART.monthLabelY);
  const yTicks = [
    { y: topY, label: formatCompactNumber(maxCount) },
    { y: midY, label: formatCompactNumber(midCount) },
    { y: baselineY, label: '0', emphasis: true }
  ];

  const rects = [];
  for (const [index, week] of series.entries()) {
    const count = week.count ?? 0;
    if (count === 0) {
      continue;
    }

    const x = CHART.plotX + index * CHART.pitch;
    const barHeight = count === 0 ? 0 : Math.max(1, Math.round((count / maxCount) * chartHeight));
    const y = baselineY - barHeight;

    rects.push(
      `<rect x="${x}" y="${y}" width="${CHART.barWidth}" height="${barHeight}" rx="2" fill="${GITHUB_COLORS.blue}">`,
      `<title>${escapeXml(formatWeekDate(week.weekStart))}: ${count} commits</title>`,
      '</rect>'
    );
  }

  return [
    ...renderFrame({
      title: 'Weekly commits',
      subtitle: 'Commits per week'
    }),
    ...renderGridLines({ yTicks }),
    ...renderYAxisLabels(yTicks),
    rects.join('\n'),
    monthTicks.join('\n'),
    '</svg>'
  ].join('\n');
}

export function renderWeeklyLinesSvg(series) {
  const topY = 56;
  const positiveMidY = 86;
  const zeroY = 116;
  const negativeMidY = 148;
  const baselineY = 180;
  const positiveHeight = zeroY - topY;
  const negativeHeight = baselineY - zeroY;
  const maxMagnitude = Math.max(
    1,
    ...series.map((week) => Math.max(week.additions ?? 0, week.deletions ?? 0))
  );
  const halfMagnitude = Math.ceil(maxMagnitude / 2);
  const monthTicks = buildMonthTicks(series, CHART.plotX, CHART.pitch, CHART.monthLabelY);
  const yTicks = [
    { y: topY, label: formatSignedCompactNumber(maxMagnitude) },
    { y: positiveMidY, label: formatSignedCompactNumber(halfMagnitude) },
    { y: zeroY, label: '0', emphasis: true },
    { y: negativeMidY, label: formatSignedCompactNumber(-halfMagnitude) },
    { y: baselineY, label: formatSignedCompactNumber(-maxMagnitude) }
  ];
  const rects = [];

  for (const [index, week] of series.entries()) {
    const x = CHART.plotX + index * CHART.pitch;
    const additions = week.additions ?? 0;
    const deletions = week.deletions ?? 0;
    const additionsHeight = scaledDeltaHeight(additions, maxMagnitude, positiveHeight);
    const deletionsHeight = scaledDeltaHeight(deletions, maxMagnitude, negativeHeight);
    const title = `<title>${escapeXml(formatWeekDate(week.weekStart))}: +${additions} / -${deletions} lines</title>`;

    if (additionsHeight > 0) {
      rects.push(
        `<rect x="${x}" y="${zeroY - additionsHeight}" width="${CHART.barWidth}" height="${additionsHeight}" rx="2" fill="${GITHUB_COLORS.green}">`,
        title,
        '</rect>'
      );
    }

    if (deletionsHeight > 0) {
      rects.push(
        `<rect x="${x}" y="${zeroY}" width="${CHART.barWidth}" height="${deletionsHeight}" rx="2" fill="${GITHUB_COLORS.red}">`,
        title,
        '</rect>'
      );
    }
  }

  return [
    ...renderFrame({
      title: 'Weekly line deltas',
      subtitle: 'Additions and deletions per week, linear scale'
    }),
    ...renderGridLines({ yTicks }),
    `<line x1="${CHART.plotX}" y1="${zeroY}" x2="${CHART.plotRight}" y2="${zeroY}" stroke="${GITHUB_COLORS.zero}" stroke-width="1"/>`,
    ...renderYAxisLabels(yTicks),
    `<rect x="579" y="28" width="10" height="10" rx="2" fill="${GITHUB_COLORS.green}"/>`,
    `<text x="594" y="37" fill="${GITHUB_COLORS.muted}" font-size="11">Additions</text>`,
    `<rect x="659" y="28" width="10" height="10" rx="2" fill="${GITHUB_COLORS.red}"/>`,
    `<text x="674" y="37" fill="${GITHUB_COLORS.muted}" font-size="11">Deletions</text>`,
    rects.join('\n'),
    monthTicks.join('\n'),
    '</svg>'
  ].join('\n');
}
