import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ClaudeCodeResponse } from '@propr/core';
import { shouldRecordFailureLLMMetrics } from '../src/jobs/prCommentJobUtils.js';

test('failure handling records LLM metrics only when execution has not recorded them', () => {
    const result = {} as ClaudeCodeResponse;

    assert.equal(shouldRecordFailureLLMMetrics(null, false), false);
    assert.equal(shouldRecordFailureLLMMetrics(result, false), true);
    assert.equal(shouldRecordFailureLLMMetrics(result, true), false);
});
