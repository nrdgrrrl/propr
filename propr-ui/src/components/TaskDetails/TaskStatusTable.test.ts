import { describe, expect, it } from 'vitest';
import { getClaudeExecutionLabel } from './TaskStatusTable';
import type { HistoryItem } from './types';

describe('getClaudeExecutionLabel', () => {
  it('shows interrupted when a completed-reason execution returned success=false', () => {
    const item: HistoryItem = {
      state: 'claude_execution',
      reason: 'claude agent execution completed',
      metadata: { claudeResult: { success: false } },
    };

    expect(getClaudeExecutionLabel(item, 0, [item])).toBe('Implementation Interrupted');
  });

  it('shows completed only when the Claude result succeeded', () => {
    const item: HistoryItem = {
      state: 'claude_execution',
      reason: 'claude agent execution completed',
      metadata: { claudeResult: { success: true } },
    };

    expect(getClaudeExecutionLabel(item, 0, [item])).toBe('Implementation Completed');
  });
});
