import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeConfig } from '../src/config.mjs';

test('normalizeConfig keeps unique identities and repo overrides', () => {
  const config = normalizeConfig({
    identities: {
      logins: ['rhanka', 'rhanka'],
      emails: ['fabien.antoine@gmail.com', 'fabien.antoine@m4x.org']
    },
    includeRepos: ['rhanka/graphify'],
    excludeRepos: ['rhanka/archive'],
    windowWeeks: 52
  });

  assert.deepEqual(config.identities.logins, ['rhanka']);
  assert.deepEqual(config.identities.emails, [
    'fabien.antoine@gmail.com',
    'fabien.antoine@m4x.org'
  ]);
  assert.equal(config.windowWeeks, 52);
});
