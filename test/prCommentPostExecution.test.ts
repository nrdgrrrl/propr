import assert from 'node:assert/strict';
import { beforeEach, mock, test } from 'node:test';

const completionCommentBody = '⚠️ Follow-up execution was interrupted before completion\n\nNo code changes were produced to publish before the interruption.';
const mockCommitChanges = mock.fn(async () => null);
const mockBuildCompletionComment = mock.fn(async () => completionCommentBody);
const mockUpdateTaskState = mock.fn(async () => {});
const mockOctokitRequest = mock.fn(async () => ({
    data: {
        html_url: 'https://github.com/owner/repo/pull/7#issuecomment-100',
        body: completionCommentBody,
    },
}));

await mock.module('@propr/core', {
    namedExports: {
        commitChanges: mockCommitChanges,
        cleanupPreparedVisualPreviewEvidence: mock.fn(async () => {}),
        db: mock.fn(),
        getRepoUrl: mock.fn(() => 'https://github.com/owner/repo.git'),
        getAuthenticatedOctokit: mock.fn(),
        loadRepositoryVisualPreviewSettings: mock.fn(async () => ({})),
        prepareVisualPreviewEvidence: mock.fn(async () => ({
            evidence: { assets: [], toolSuggestions: [] },
        })),
        pushBranch: mock.fn(),
        appendVisualPreviewSection: mock.fn((body: string) => body),
        AI_COMMIT_AUTHOR: { name: 'ProPR', email: 'propr@example.test' },
        renderVisualPreviewSection: mock.fn(),
        renderVisualPreviewUploadFailureSection: mock.fn(),
        resolveAgentTerminationReason: mock.fn((result: { terminationReason?: string }) => result.terminationReason),
        TaskStates: { COMPLETED: 'completed' },
        VISUAL_PREVIEW_SLOT: '<!-- visual-preview-slot -->',
    },
});

await mock.module('../src/jobs/prCompletionComment.js', {
    namedExports: { buildCompletionComment: mockBuildCompletionComment },
});

await mock.module('../src/jobs/prCommentJobUtils.js', {
    namedExports: { buildCommitMessage: mock.fn(() => 'follow-up commit message') },
});

await mock.module('../src/jobs/reviewCommentGatherer.js', {
    namedExports: { markReviewFindingsProcessed: mock.fn(async () => {}) },
});

await mock.module('../src/jobs/ultrafixJobHelpers.js', {
    namedExports: { resolveUltrafixHistoryMeta: mock.fn(async () => ({})) },
});

await mock.module('../src/github/visualPreviewAttachments.js', {
    namedExports: {
        isVisualPreviewUploadAuthenticationError: mock.fn(() => false),
        publishPullRequestCommentVisualPreviews: mock.fn(),
    },
});

const { handlePostExecution } = await import('../src/jobs/prCommentPostExecution.js');

beforeEach(() => {
    mockCommitChanges.mock.resetCalls();
    mockBuildCompletionComment.mock.resetCalls();
    mockUpdateTaskState.mock.resetCalls();
    mockOctokitRequest.mock.resetCalls();
});

test('finalizes an interrupted no-change follow-up after publishing its completion comment', async () => {
    const result = await handlePostExecution({
        state: {
            octokit: {
                request: mockOctokitRequest,
                auth: mock.fn(),
            },
            worktreeInfo: {
                worktreePath: '/tmp/propr-follow-up',
                branchName: 'feature/follow-up',
            },
            claudeResult: {
                success: false,
                executionTime: 60_000,
                output: null,
                logs: '',
                exitCode: null,
                finalResult: { type: 'result', subtype: 'error_max_turns' },
                modifiedFiles: [],
                commitMessage: null,
                summary: 'Validation completed before the turn limit.',
                terminationReason: 'max_turns',
            },
            authorsText: '@reviewer',
            unprocessedComments: [{ id: 103, body: 'Run validation only', author: 'reviewer', createdAt: new Date().toISOString() }],
            startingWorkComment: {
                data: {
                    id: 100,
                    html_url: 'https://github.com/owner/repo/pull/7#issuecomment-100',
                },
            },
        },
        job: { data: { commandMode: 'default' } },
        taskId: 'pr-comment-7',
        stateManager: { updateTaskState: mockUpdateTaskState },
        context: {
            pullRequestNumber: 7,
            repoOwner: 'owner',
            repoName: 'repo',
            correlatedLogger: { info: mock.fn(), warn: mock.fn() },
        },
        unprocessedReviewComments: [],
        llm: 'claude-test',
        redisClient: {},
        prProcessingLockKey: 'lock:pr:owner:repo:7',
        prProcessingLockToken: 'lock-token',
    } as never, 'https://propr.example/tasks/pr-comment-7');

    assert.deepEqual(result, { commitHash: undefined, partial: true });
    assert.equal(mockCommitChanges.mock.callCount(), 1);
    assert.equal(mockBuildCompletionComment.mock.callCount(), 1);
    assert.deepEqual(mockOctokitRequest.mock.calls[0].arguments, [
        'PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}',
        {
            owner: 'owner',
            repo: 'repo',
            comment_id: 100,
            body: completionCommentBody,
        },
    ]);

    assert.equal(mockUpdateTaskState.mock.callCount(), 1);
    const completedStateUpdate = mockUpdateTaskState.mock.calls[0].arguments;
    assert.equal(completedStateUpdate[0], 'pr-comment-7');
    assert.equal(completedStateUpdate[1], 'completed');
    assert.deepEqual(completedStateUpdate[2], {
        reason: 'PR comment processing published partial work after interrupted execution',
        commitHash: undefined,
        historyMetadata: {
            commandMode: 'default',
            githubComment: {
                url: 'https://github.com/owner/repo/pull/7#issuecomment-100',
                body: completionCommentBody,
            },
            incompleteExecution: { reason: 'max_turns' },
        },
    });
});
