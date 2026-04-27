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

test('renderWeeklyCommitsSvg renders a simple static bar chart', () => {
  const svg = renderWeeklyCommitsSvg([
    ...Array.from({ length: 52 }, (_, index) => ({
      weekStart: `2025-05-${String(4 + index).padStart(2, '0')}T00:00:00.000Z`,
      count: index === 0 ? 1 : index === 1 ? 0 : index === 51 ? 9 : 0
    }))
  ]);

  assert.match(svg, /width="680" height="180" viewBox="0 0 680 180"/);
  assert.match(svg, /<rect x="20" y="\d+" width="8" height="\d+" fill="#2563eb"\/>/);
  assert.match(svg, /<rect x="20" y="\d+" width="8" height="\d+" fill="#2563eb"\/>/);
  assert.match(svg, /<rect x="632" y="\d+" width="8" height="\d+" fill="#2563eb"\/>/);
  assert.doesNotMatch(svg, /<rect x="32" y="\d+" width="8" height="[1-9]\d*" fill="#2563eb"\/>/);
  assert.doesNotMatch(svg, /\d{4}-\d{2}-\d{2}/);
});

test('renderWeeklyLinesSvg renders a simple static line chart', () => {
  const svg = renderWeeklyLinesSvg([
    ...Array.from({ length: 52 }, (_, index) => ({
      weekStart: `2025-05-${String(4 + index).padStart(2, '0')}T00:00:00.000Z`,
      additions: index === 0 ? 2 : index === 1 ? 0 : index === 51 ? 10 : 0,
      deletions: index === 0 ? 1 : index === 1 ? 0 : index === 51 ? 4 : 0
    }))
  ]);

  assert.match(svg, /width="680" height="180" viewBox="0 0 680 180"/);
  assert.match(svg, /<line x1="20" y1="90" x2="660" y2="90" stroke="#111827" stroke-width="2"\/>/);
  assert.match(svg, /<rect x="20" y="\d+" width="8" height="\d+" fill="#16a34a"\/>/);
  assert.match(svg, /<rect x="20" y="90" width="8" height="\d+" fill="#dc2626"\/>/);
  assert.doesNotMatch(svg, /<rect x="32" y="[0-9]+" width="8" height="[1-9]\d*" fill="#16a34a"\/>/);
  assert.doesNotMatch(svg, /<rect x="32" y="90" width="8" height="[1-9]\d*" fill="#dc2626"\/>/);
  assert.match(svg, /<rect x="632" y="\d+" width="8" height="\d+" fill="#16a34a"\/>/);
  assert.match(svg, /<rect x="632" y="90" width="8" height="\d+" fill="#dc2626"\/>/);
  assert.doesNotMatch(svg, /\d{4}-\d{2}-\d{2}/);
  assert.doesNotMatch(svg, /<path /);
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
