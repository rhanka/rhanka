import test from 'node:test';
import assert from 'node:assert/strict';
import { main } from '../scripts/github-profile-stats.mjs';

test('github-profile-stats write mode requires a GitHub token for live collection', async () => {
  await assert.rejects(
    () =>
      main({
        argv: ['--write'],
        env: {
          ...process.env,
          PROFILE_STATS_TOKEN: '',
          GITHUB_TOKEN: ''
        }
      }),
    /PROFILE_STATS_TOKEN or GITHUB_TOKEN is required for live API collection/
  );
});
