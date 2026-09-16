import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { hasPendingIndexingRetry } from '../src/indexingRetryStatus.ts';

describe('indexing worker retry status', () => {
    test('preserves indexing status while attempts remain', () => {
        assert.equal(hasPendingIndexingRetry(1, 3), true);
        assert.equal(hasPendingIndexingRetry(2, 3), true);
    });

    test('marks failure only after the final attempt', () => {
        assert.equal(hasPendingIndexingRetry(3, 3), false);
        assert.equal(hasPendingIndexingRetry(1), false);
    });
});
