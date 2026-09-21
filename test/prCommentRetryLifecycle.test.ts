import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getPRCommentFailureTransition, hasBullMQRetriesRemaining } from '../src/jobs/prCommentRetryLifecycle.js';

function job(attemptsMade: number, attempts: number) {
    return { attemptsMade, opts: { attempts } } as never;
}

test('retry lifecycle keeps task nonterminal while BullMQ attempts remain', () => {
    assert.equal(hasBullMQRetriesRemaining(job(0, 3)), true);
    assert.equal(hasBullMQRetriesRemaining(job(1, 3)), true);
    assert.equal(hasBullMQRetriesRemaining(job(2, 3)), false);
});

test('single-attempt jobs are final immediately', () => {
    assert.equal(hasBullMQRetriesRemaining(job(0, 1)), false);
});

test('failure transitions stay nonterminal until the final BullMQ attempt', () => {
    assert.deepEqual(getPRCommentFailureTransition(job(0, 3)), { state: 'processing', retryPending: true });
    assert.deepEqual(getPRCommentFailureTransition(job(1, 3)), { state: 'processing', retryPending: true });
    assert.deepEqual(getPRCommentFailureTransition(job(2, 3)), { state: 'failed', retryPending: false });
});
