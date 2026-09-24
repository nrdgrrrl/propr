import assert from 'node:assert/strict';
import test from 'node:test';
import { pullRequestPollingOptions } from '../src/polling/pullRequestPollingOptions.js';

test('polling intentionally limits PR comments to open PRs; merged-PR deploy requires event-driven intake', () => {
    assert.deepEqual(pullRequestPollingOptions('nrdgrrrl', 'WordRush'), {
        owner: 'nrdgrrrl', repo: 'WordRush', state: 'open', per_page: 100,
    });
});
