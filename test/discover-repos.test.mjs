import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeCandidateRepos } from '../src/discover-repos.mjs';

test('mergeCandidateRepos merges GraphQL repos with manual includes and excludes', () => {
  const repos = mergeCandidateRepos({
    discoveredRepos: ['rhanka/graphify', 'rhanka/rhanka'],
    includeRepos: ['matchID-project/deces-dataprep'],
    excludeRepos: ['rhanka/rhanka']
  });

  assert.deepEqual(repos, [
    'matchID-project/deces-dataprep',
    'rhanka/graphify'
  ]);
});
