import test from 'node:test';
import assert from 'node:assert/strict';
import {
  renderWeeklyCommitsSvg,
  renderWeeklyLinesSvg
} from '../src/render-svg.mjs';
import {
  renderTopReposTable,
  replaceStatsBlock
} from '../src/update-readme.mjs';

function buildWeeklySeries(length, mapper) {
  const start = new Date('2025-05-04T00:00:00.000Z');

  return Array.from({ length }, (_, index) => {
    const week = new Date(start);
    week.setUTCDate(start.getUTCDate() + index * 7);
    return mapper(week.toISOString(), index);
  });
}

test('renderWeeklyCommitsSvg renders axes and month labels for a long weekly series', () => {
  const svg = renderWeeklyCommitsSvg(
    buildWeeklySeries(52, (weekStart, index) => ({
      weekStart,
      count: index === 0 ? 1 : index === 1 ? 0 : index === 51 ? 9 : 0
    }))
  );

  assert.match(svg, /width="800" height="240" viewBox="0 0 800 240"/);
  assert.match(svg, /font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif, 'Apple Color Emoji', 'Segoe UI Emoji'"/);
  assert.match(svg, /<rect x="0\.5" y="0\.5" width="799" height="239" rx="8" fill="#ffffff" stroke="#d0d7de"\/>/);
  assert.match(svg, /<line x1="64" y1="180" x2="734" y2="180" stroke="#d8dee4" stroke-width="1"\/>/);
  assert.match(svg, /<text x="746" y="\d+" fill="#57606a" font-size="10" text-anchor="start">9<\/text>/);
  assert.match(svg, /stroke="#eef2f6"/);
  assert.match(svg, />Weekly commits</);
  assert.match(svg, />9</);
  assert.match(svg, />0</);
  assert.match(svg, />Commits per week</);
  assert.match(svg, />May</);
  assert.match(svg, />Apr</);
  assert.match(svg, /<rect x="64" y="\d+" width="7" height="\d+" rx="2" fill="#0969da">/);
  assert.match(svg, /<title>2025-05-04: 1 commits<\/title>/);
  assert.match(svg, /<title>2026-04-26: 9 commits<\/title>/);
  assert.doesNotMatch(svg, /<rect x="77" y="\d+" width="7" height="[1-9]\d*" rx="2" fill="#0969da">/);
});

test('renderWeeklyLinesSvg renders axes, month labels and legend for a long weekly series', () => {
  const svg = renderWeeklyLinesSvg(
    buildWeeklySeries(52, (weekStart, index) => ({
      weekStart,
      additions: index === 0 ? 2 : index === 1 ? 0 : index === 51 ? 10 : 0,
      deletions: index === 0 ? 1 : index === 1 ? 0 : index === 51 ? 4 : 0
    }))
  );

  assert.match(svg, /width="800" height="240" viewBox="0 0 800 240"/);
  assert.match(svg, /font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif, 'Apple Color Emoji', 'Segoe UI Emoji'"/);
  assert.match(svg, /<rect x="0\.5" y="0\.5" width="799" height="239" rx="8" fill="#ffffff" stroke="#d0d7de"\/>/);
  assert.match(svg, /<line x1="64" y1="116" x2="734" y2="116" stroke="#8c959f" stroke-width="1"\/>/);
  assert.match(svg, /<text x="746" y="\d+" fill="#57606a" font-size="10" text-anchor="start">\+10<\/text>/);
  assert.match(svg, /stroke="#eef2f6"/);
  assert.match(svg, />\+10</);
  assert.match(svg, />\+5</);
  assert.doesNotMatch(svg, />\+3</);
  assert.match(svg, />0</);
  assert.match(svg, />-5</);
  assert.doesNotMatch(svg, />-3</);
  assert.match(svg, />-10</);
  assert.match(svg, />Additions and deletions per week, linear scale</);
  assert.match(svg, />May</);
  assert.match(svg, />Apr</);
  assert.match(svg, />Additions</);
  assert.match(svg, />Deletions</);
  // Linear scale: a +2 bar against a max of 10 must be exactly 2/10 of the
  // 60px positive area (=12px), not the sqrt-compressed 27px.
  assert.match(svg, /<rect x="64" y="104" width="7" height="12" rx="2" fill="#1a7f37">/);
  assert.match(svg, /<rect x="64" y="116" width="7" height="6" rx="2" fill="#cf222e">/);
  assert.match(svg, /<title>2025-05-04: \+2 \/ -1 lines<\/title>/);
  assert.match(svg, /<title>2026-04-26: \+10 \/ -4 lines<\/title>/);
  assert.doesNotMatch(svg, /<rect x="77" y="[0-9]+" width="7" height="[1-9]\d*" rx="2" fill="#1a7f37">/);
  assert.doesNotMatch(svg, /<rect x="77" y="116" width="7" height="[1-9]\d*" rx="2" fill="#cf222e">/);
  assert.doesNotMatch(svg, /<path /);
});

test('renderWeeklyLinesSvg compacts large axis labels', () => {
  const svg = renderWeeklyLinesSvg(
    buildWeeklySeries(4, (weekStart, index) => ({
      weekStart,
      additions: index === 2 ? 383836 : 0,
      deletions: index === 2 ? 159259 : 0
    }))
  );

  assert.match(svg, />\+384k</);
  assert.match(svg, />-384k</);
  assert.doesNotMatch(svg, />\+383836</);
  assert.doesNotMatch(svg, />-383836</);
});

test('renderTopReposTable renders the expected markdown table', () => {
  assert.equal(
    renderTopReposTable([
      {
        repo: 'rhanka/graphify',
        lastActivityAt: '2026-04-27T09:00:00.000Z',
        commits4w: 3,
        lines4w: 42
      },
      {
        repo: 'rhanka/rhanka',
        lastActivityAt: '2026-04-26T10:15:00.000Z',
        commits4w: 1,
        lines4w: 8
      }
    ]),
    [
      '| Repo | Derniere activite | Commits (4 sem.) | Lignes modifiees (4 sem.) |',
      '| --- | --- | --- | --- |',
      '| rhanka/graphify | 2026-04-27 | 3 | 42 |',
      '| rhanka/rhanka | 2026-04-26 | 1 | 8 |'
    ].join('\n')
  );
});

test('renderTopReposTable renders a fallback when there are no repos', () => {
  assert.equal(
    renderTopReposTable([]),
    '_Aucune activite sur les 4 dernieres semaines._'
  );
});

test('replaceStatsBlock swaps the full stats block and preserves outer content', () => {
  const readme = [
    '# Profile',
    '',
    '<!-- github-profile-stats:start -->',
    '_Stats generator output goes here._',
    '<!-- github-profile-stats:end -->',
    '',
    'Footer'
  ].join('\n');

  assert.equal(
    replaceStatsBlock(readme, '## Stats\nDone'),
    [
      '# Profile',
      '',
      '<!-- github-profile-stats:start -->',
      '## Stats',
      'Done',
      '<!-- github-profile-stats:end -->',
      '',
      'Footer'
    ].join('\n')
  );
});

test('replaceStatsBlock rejects a README without stats markers', () => {
  assert.throws(
    () => replaceStatsBlock('# Profile\n\nNo markers here\n', '## Stats'),
    /github-profile-stats/
  );
});
