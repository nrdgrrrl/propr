import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

process.env.NODE_ENV = 'test';

const enableAutoMerge = mock.fn(async () => ({ success: false, error: 'native auto-merge unavailable' }));
const findPlanIssueByRepoAndNumber = mock.fn(async () => null);
const linkPRToPlanIssue = mock.fn(async () => undefined);
const mockRequest = mock.fn(async (_endpoint: string, _options: Record<string, unknown>) => ({ data: {} }));
const mockOctokit = { request: mockRequest };

await mock.module('@propr/core', {
  namedExports: {
    findPlanIssueByRepoAndNumber,
    generateCompletionComment: mock.fn(),
    getAuthenticatedOctokit: mock.fn(async () => mockOctokit),
    getPrimaryProcessingLabels: () => ['AI'],
    linkPRToPlanIssue,
    processCommentEvent: mock.fn(),
    safeUpdateLabels: mock.fn(),
    updatePlanIssueStatus: mock.fn(),
    PlanIssueStatus: { MERGED: 'merged' },
    getPlanIssuesByDraft: mock.fn(),
    db: mock.fn(),
    isEpicBranch: (branch: string) => /^\d+-epic-[a-z0-9]+-[a-z0-9]+-[a-z0-9]{3}$/.test(branch),
  },
});

await mock.module('../src/github/autoMergeOperations.js', {
  namedExports: { enableAutoMerge },
});

await mock.module('../src/jobs/issueJob/config.js', {
  namedExports: { redisClient: {} },
});

await mock.module('../src/jobs/implementationPrUltrafix.js', {
  namedExports: { resolveImplementationPrUltrafixTrigger: () => null },
});

const { handleCreatedPlanIssuePR } = await import('../src/jobs/issueJobPostProcessingHelpers.js');

const baseBranch = '678-epic-planner-studio-abc';

function createOptions(overrides: {
  issueRef?: Record<string, unknown>;
  labels?: string[];
} = {}) {
  return {
    issueRef: {
      repoOwner: 'owner',
      repoName: 'repo',
      number: 42,
      isChildJob: true,
      baseBranch,
      baseLabel: `base-${baseBranch}`,
      ...overrides.issueRef,
    },
    currentIssueData: {
      data: {
        labels: (overrides.labels ?? ['auto-merge', `base-${baseBranch}`]).map(name => ({ name })),
      },
    },
    prNumber: 99,
    correlatedLogger: { info: mock.fn(), debug: mock.fn(), warn: mock.fn(), error: mock.fn() },
  };
}

function resetMocks(): void {
  enableAutoMerge.mock.resetCalls();
  enableAutoMerge.mock.mockImplementation(async () => ({ success: false, error: 'native auto-merge unavailable' }));
  findPlanIssueByRepoAndNumber.mock.resetCalls();
  linkPRToPlanIssue.mock.resetCalls();
  mockRequest.mock.resetCalls();
}

function mockSafeOpenPr(options: { checkRuns?: unknown[]; checkSuites?: unknown[]; statusCount?: number; pr?: Record<string, unknown> } = {}): void {
  const pr = options.pr ?? {
    state: 'open',
    draft: false,
    base: { ref: baseBranch },
    head: { sha: 'head-sha' },
    mergeable: true,
    mergeable_state: 'clean',
  };
  mockRequest.mock.mockImplementation(async (endpoint: string) => {
    if (endpoint === 'GET /repos/{owner}/{repo}') return { data: { allow_auto_merge: false } };
    if (endpoint.includes('/pulls/{pull_number}')) return { data: pr };
    if (endpoint.includes('/check-runs')) return { data: { check_runs: options.checkRuns ?? [] } };
    if (endpoint.includes('/check-suites')) return { data: { check_suites: options.checkSuites ?? [] } };
    if (endpoint.endsWith('/status')) return { data: { total_count: options.statusCount ?? 0, statuses: [] } };
    if (endpoint.includes('/merge')) return { data: { merged: true, sha: 'merge-sha' } };
    throw new Error(`Unexpected request: ${endpoint}`);
  });
}

test('does not invoke the fallback when native auto-merge succeeds', async () => {
  resetMocks();
  enableAutoMerge.mock.mockImplementation(async () => ({ success: true, autoMergeEnabled: true }));

  await handleCreatedPlanIssuePR(createOptions());

  assert.equal(enableAutoMerge.mock.calls.length, 1);
  assert.equal(mockRequest.mock.calls.length, 0);
});

test('continues to the fallback when native auto-merge is not enabled', async () => {
  resetMocks();
  enableAutoMerge.mock.mockImplementation(async () => ({ success: true, autoMergeEnabled: false }));
  mockSafeOpenPr();

  await handleCreatedPlanIssuePR(createOptions());

  assert.equal(mockRequest.mock.calls.some(call => call.arguments[0].includes('/merge')), true);
});

test('squash-merges a clean Epic child PR with no CI/status signals', async () => {
  resetMocks();
  mockSafeOpenPr();

  await handleCreatedPlanIssuePR(createOptions());

  const mergeCall = mockRequest.mock.calls.find(call => call.arguments[0].includes('/merge'));
  assert.ok(mergeCall);
  assert.equal(mergeCall.arguments[1].merge_method, 'squash');
});

test('does not directly merge when a CI or status signal exists', async () => {
  resetMocks();
  mockSafeOpenPr({ statusCount: 1 });

  await handleCreatedPlanIssuePR(createOptions());

  assert.equal(mockRequest.mock.calls.some(call => call.arguments[0].includes('/merge')), false);
});

test('does not directly merge when a check suite exists', async () => {
  resetMocks();
  mockSafeOpenPr({ checkSuites: [{}] });

  await handleCreatedPlanIssuePR(createOptions());

  assert.equal(mockRequest.mock.calls.some(call => call.arguments[0].includes('/merge')), false);
});

test('does not directly merge a non-Epic PR', async () => {
  resetMocks();
  mockSafeOpenPr();

  await handleCreatedPlanIssuePR(createOptions({ issueRef: { baseBranch: 'main', baseLabel: null } }));

  assert.equal(mockRequest.mock.calls.length, 0);
});

test('does not directly merge an unsafe PR', async () => {
  for (const pr of [
    { state: 'open', draft: true, base: { ref: baseBranch }, head: { sha: 'head-sha' }, mergeable: true, mergeable_state: 'clean' },
    { state: 'open', draft: false, base: { ref: baseBranch }, head: { sha: 'head-sha' }, mergeable: false, mergeable_state: 'dirty' },
    { state: 'open', draft: false, base: { ref: baseBranch }, head: { sha: 'head-sha' }, mergeable: null, mergeable_state: 'unknown' },
    { state: 'closed', draft: false, base: { ref: baseBranch }, head: { sha: 'head-sha' }, mergeable: true, mergeable_state: 'clean' },
  ]) {
    resetMocks();
    mockSafeOpenPr({ pr });

    await handleCreatedPlanIssuePR(createOptions());

    assert.equal(mockRequest.mock.calls.some(call => call.arguments[0].includes('/merge')), false);
  }
});
