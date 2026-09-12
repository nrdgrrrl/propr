import type { Logger } from 'pino';
import {
    findPlanIssueByRepoAndNumber,
    generateCompletionComment,
    getAuthenticatedOctokit,
    getPrimaryProcessingLabels,
    linkPRToPlanIssue,
    processCommentEvent,
    safeUpdateLabels,
    updatePlanIssueStatus,
    PlanIssueStatus,
    getPlanIssuesByDraft,
    db,
    isEpicBranch,
    type CommentEventConfig,
    type ClaudeCodeResponse,
    type IssueJobData,
} from '@propr/core';
import { enableAutoMerge } from '../github/autoMergeOperations.js';
import type { PostProcessingResult } from './issueJobHelpers.js';
import { redisClient } from './issueJob/config.js';
import { resolveImplementationPrUltrafixTrigger } from './implementationPrUltrafix.js';

type Octokit = {
    request: <T = unknown>(endpoint: string, options: Record<string, unknown>) => Promise<T>;
};

const ULTRAFIX_GOAL_MIN = 1;
const ULTRAFIX_GOAL_MAX = 10;
const ULTRAFIX_MAX_CYCLES_MIN = 1;

function sanitizeUltrafixGoal(value: number | null | undefined): number | null {
    return Number.isInteger(value) && (value as number) >= ULTRAFIX_GOAL_MIN && (value as number) <= ULTRAFIX_GOAL_MAX
        ? (value as number)
        : null;
}

function sanitizeUltrafixMaxCycles(value: number | null | undefined): number | null {
    return Number.isInteger(value) && (value as number) >= ULTRAFIX_MAX_CYCLES_MIN
        ? (value as number)
        : null;
}

function parseDraftContextConfig(contextConfig: unknown): Record<string, unknown> | null {
    if (!contextConfig) return null;
    if (typeof contextConfig !== 'string') {
        return typeof contextConfig === 'object' && !Array.isArray(contextConfig)
            ? contextConfig as Record<string, unknown>
            : null;
    }
    try {
        const parsed = JSON.parse(contextConfig) as unknown;
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
            ? parsed as Record<string, unknown>
            : null;
    } catch {
        return null;
    }
}

async function resolveEffectiveUltrafixSettings(planIssue: {
    draft_id: string;
    issue_number: number;
    run_ultrafix: number | boolean | null;
    ultrafix_goal: number | null;
    ultrafix_max_cycles: number | null;
}): Promise<{ runUltrafix: boolean; goal: number | null; maxCycles: number | null }> {
    const issueRunUltrafix = planIssue.run_ultrafix === true || planIssue.run_ultrafix === 1
        ? true
        : planIssue.run_ultrafix === false || planIssue.run_ultrafix === 0
            ? false
            : null;

    if (issueRunUltrafix !== null) {
        return {
            runUltrafix: issueRunUltrafix,
            goal: issueRunUltrafix ? sanitizeUltrafixGoal(planIssue.ultrafix_goal) : null,
            maxCycles: issueRunUltrafix ? sanitizeUltrafixMaxCycles(planIssue.ultrafix_max_cycles) : null,
        };
    }

    const draft = await db('task_drafts')
        .where({ draft_id: planIssue.draft_id })
        .select('context_config')
        .first();
    const contextConfig = parseDraftContextConfig(draft?.context_config);
    const plannerRunUltrafix = contextConfig?.runUltrafix === true;

    return {
        runUltrafix: plannerRunUltrafix,
        goal: plannerRunUltrafix ? sanitizeUltrafixGoal((contextConfig?.ultrafixGoal as number | null | undefined) ?? null) : null,
        maxCycles: plannerRunUltrafix ? sanitizeUltrafixMaxCycles((contextConfig?.ultrafixMaxCycles as number | null | undefined) ?? null) : null,
    };
}

function buildSystemUltrafixComment(goal: number | null, maxCycles: number | null): string {
    const parts = ['/ultrafix'];
    if (goal != null) parts.push(`goal=${goal}`);
    if (maxCycles != null) parts.push(`max=${maxCycles}`);
    return `${parts.join(' ')}\nTriggered automatically by Planner execution settings.`;
}

function createCommentConfig(): CommentEventConfig {
    return {
        redisClient,
        PR_FOLLOWUP_TRIGGER_KEYWORDS: (process.env.PR_FOLLOWUP_TRIGGER_KEYWORDS || '')
            .split(',')
            .map((keyword) => keyword.trim())
            .filter(Boolean),
        MODEL_LABEL_PATTERN: process.env.MODEL_LABEL_PATTERN || '^llm-(.+)$',
    };
}

export async function triggerSystemUltrafix(options: {
    owner: string;
    repo: string;
    prNumber: number;
    goal: number | null;
    maxCycles: number | null;
    correlatedLogger: Logger;
}): Promise<void> {
    const { owner, repo, prNumber, goal, maxCycles, correlatedLogger } = options;
    const sanitizedGoal = sanitizeUltrafixGoal(goal);
    const sanitizedMaxCycles = sanitizeUltrafixMaxCycles(maxCycles);
    const body = buildSystemUltrafixComment(sanitizedGoal, sanitizedMaxCycles);
    const octokit = await getAuthenticatedOctokit();
    const response = await octokit.request('POST /repos/{owner}/{repo}/issues/{issue_number}/comments', {
        owner,
        repo,
        issue_number: prNumber,
        body,
    });

    const botLogin = process.env.GITHUB_BOT_USERNAME || response.data.user?.login || 'propr-dev[bot]';
    const syntheticPayload = {
        action: 'created',
        repository: {
            name: repo,
            owner: { login: owner },
            full_name: `${owner}/${repo}`,
        },
        issue: {
            number: prNumber,
            pull_request: { url: `https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}` },
        },
        comment: {
            id: response.data.id,
            body,
            user: {
                login: botLogin,
                type: 'Bot',
            },
        },
    } as Parameters<typeof processCommentEvent>[0];

    await processCommentEvent(
        syntheticPayload,
        'issue_comment',
        `system-ultrafix-${owner}-${repo}-${prNumber}`,
        createCommentConfig(),
    );
    correlatedLogger.info({ prNumber, goal: sanitizedGoal, maxCycles: sanitizedMaxCycles }, 'Triggered system ultrafix for PR');
}

async function triggerNextPlanIssueIfNeeded(
    issueRef: IssueJobData,
    currentIssueData: { data: { labels: Array<{ name: string }> } },
    log: Logger,
): Promise<void> {
    try {
        const repository = `${issueRef.repoOwner}/${issueRef.repoName}`;
        const planIssue = await findPlanIssueByRepoAndNumber(repository, issueRef.number);
        if (!planIssue || !planIssue.draft_id) {
            log.debug({ issueNumber: issueRef.number }, 'Issue is not part of a plan, skipping next issue trigger');
            return;
        }

        const labels = currentIssueData.data.labels.map((label) => label.name);
        if (!labels.includes('auto-merge')) {
            log.debug({ issueNumber: issueRef.number }, 'Issue does not have auto-merge label, skipping next issue trigger');
            return;
        }

        await updatePlanIssueStatus(repository, issueRef.number, PlanIssueStatus.MERGED);
        log.info({ repository, issueNumber: issueRef.number }, 'Marked plan issue as merged (no changes needed)');

        const planIssues = await getPlanIssuesByDraft(planIssue.draft_id);
        const inProgressStatuses = ['processing', 'under_review', 'in_refinement', 'refinement_processing'];
        const inProgressIssues = planIssues.filter(
            (issue) => inProgressStatuses.includes(issue.status) && issue.issue_number !== issueRef.number,
        );
        if (inProgressIssues.length > 0) {
            log.debug({
                draftId: planIssue.draft_id,
                inProgressIssues: inProgressIssues.map((issue) => ({
                    number: issue.issue_number,
                    status: issue.status,
                })),
            }, 'Skipping next issue trigger - there are issues still in progress');
            return;
        }

        const nextPending = planIssues.find((issue) => issue.status === 'pending');
        if (!nextPending) {
            log.debug({ draftId: planIssue.draft_id }, 'No more pending issues in plan');
            return;
        }

        const epicLabel = labels.find((label) => label.startsWith('base-'));
        const labelsToAdd = [getPrimaryProcessingLabels()[0] || 'AI', 'auto-merge'];
        if (epicLabel) labelsToAdd.push(epicLabel);

        log.info({
            draftId: planIssue.draft_id,
            nextIssueNumber: nextPending.issue_number,
            labels: labelsToAdd,
        }, 'Triggering next pending issue in plan (no-changes case)');

        const octokit = await getAuthenticatedOctokit();
        await octokit.request('POST /repos/{owner}/{repo}/issues/{issue_number}/labels', {
            owner: issueRef.repoOwner,
            repo: issueRef.repoName,
            issue_number: nextPending.issue_number,
            labels: labelsToAdd,
        });
    } catch (error) {
        log.warn({ issueNumber: issueRef.number, error: (error as Error).message }, 'Failed to trigger next pending issue');
    }
}

async function tryDirectMergeForNoCiEpic(options: {
    issueRef: IssueJobData;
    labels: Array<{ name: string }>;
    prNumber: number;
    log: Logger;
}): Promise<void> {
    const { issueRef, labels, prNumber, log } = options;
    const baseBranch = issueRef.baseBranch;
    if (!issueRef.isChildJob || !baseBranch || !isEpicBranch(baseBranch) || !labels.some(label => label.name === `base-${baseBranch}`)) {
        return;
    }

    try {
        const octokit = await getAuthenticatedOctokit();
        const repositoryResponse = await octokit.request('GET /repos/{owner}/{repo}', {
            owner: issueRef.repoOwner,
            repo: issueRef.repoName,
        });
        if (repositoryResponse.data.allow_auto_merge !== false) {
            log.debug({ prNumber }, 'Skipping no-CI auto-merge fallback because native auto-merge is available');
            return;
        }

        const pullRequestResponse = await octokit.request('GET /repos/{owner}/{repo}/pulls/{pull_number}', {
            owner: issueRef.repoOwner,
            repo: issueRef.repoName,
            pull_number: prNumber,
        });
        const pullRequest = pullRequestResponse.data;
        if (
            pullRequest.state !== 'open' ||
            pullRequest.draft === true ||
            pullRequest.base?.ref !== baseBranch ||
            pullRequest.mergeable !== true ||
            pullRequest.mergeable_state !== 'clean' ||
            !pullRequest.head?.sha
        ) {
            log.debug({ prNumber }, 'Skipping no-CI auto-merge fallback because PR is not safely mergeable');
            return;
        }

        const [checkRunsResponse, checkSuitesResponse, statusResponse] = await Promise.all([
            octokit.request('GET /repos/{owner}/{repo}/commits/{ref}/check-runs', {
                owner: issueRef.repoOwner,
                repo: issueRef.repoName,
                ref: pullRequest.head.sha,
            }),
            octokit.request('GET /repos/{owner}/{repo}/commits/{ref}/check-suites', {
                owner: issueRef.repoOwner,
                repo: issueRef.repoName,
                ref: pullRequest.head.sha,
            }),
            octokit.request('GET /repos/{owner}/{repo}/commits/{ref}/status', {
                owner: issueRef.repoOwner,
                repo: issueRef.repoName,
                ref: pullRequest.head.sha,
            }),
        ]);
        const checkRuns = checkRunsResponse.data.check_runs;
        const checkSuites = checkSuitesResponse.data.check_suites;
        const statusContexts = statusResponse.data.total_count ?? statusResponse.data.statuses?.length;
        if (!Array.isArray(checkRuns) || !Array.isArray(checkSuites) || typeof statusContexts !== 'number') {
            log.warn({ prNumber }, 'Skipping no-CI auto-merge fallback because check status is unavailable');
            return;
        }
        if (checkRuns.length > 0 || checkSuites.length > 0 || statusContexts > 0) {
            log.debug({ prNumber, checkRuns: checkRuns.length, checkSuites: checkSuites.length, statusContexts }, 'Skipping no-CI auto-merge fallback because CI/status signals exist');
            return;
        }

        const mergeResponse = await octokit.request('PUT /repos/{owner}/{repo}/pulls/{pull_number}/merge', {
            owner: issueRef.repoOwner,
            repo: issueRef.repoName,
            pull_number: prNumber,
            merge_method: 'squash',
        });
        if (mergeResponse.data.merged !== true) {
            log.warn({ prNumber }, 'No-CI auto-merge fallback did not merge the PR');
            return;
        }
        log.info({ prNumber, sha: mergeResponse.data.sha }, 'Merged no-CI Epic PR after native auto-merge was unavailable');
    } catch (error) {
        log.warn({ prNumber, error: (error as Error).message }, 'Failed to evaluate no-CI auto-merge fallback');
    }
}

export async function handleNoCodeChanges(options: {
    octokit: Octokit;
    issueRef: IssueJobData;
    claudeResult: ClaudeCodeResponse;
    currentIssueData: { data: { labels: Array<{ name: string }> } };
    AI_PROCESSING_TAG: string;
    AI_DONE_TAG: string;
    correlatedLogger: Logger;
}): Promise<PostProcessingResult> {
    const {
        octokit,
        issueRef,
        claudeResult,
        currentIssueData,
        AI_PROCESSING_TAG,
        AI_DONE_TAG,
        correlatedLogger,
    } = options;

    correlatedLogger.info({ issueNumber: issueRef.number }, 'No code changes needed - work was already complete');
    await safeUpdateLabels(
        { octokit, owner: issueRef.repoOwner, repo: issueRef.repoName, issueNumber: issueRef.number, logger: correlatedLogger },
        [AI_PROCESSING_TAG],
        [AI_DONE_TAG],
    );

    const completionComment = await generateCompletionComment(claudeResult, {
        number: issueRef.number,
        repoOwner: issueRef.repoOwner,
        repoName: issueRef.repoName,
    }, { publishedAs: 'issue_comment' });
    await octokit.request('POST /repos/{owner}/{repo}/issues/{issue_number}/comments', {
        owner: issueRef.repoOwner,
        repo: issueRef.repoName,
        issue_number: issueRef.number,
        body: `✅ **No code changes needed - the implementation was already complete.**\n\n${completionComment}`,
    });

    await triggerNextPlanIssueIfNeeded(issueRef, currentIssueData, correlatedLogger);
    return { success: true, pr: null, updatedLabels: [AI_DONE_TAG] };
}

export async function handleCreatedPlanIssuePR(options: {
    issueRef: IssueJobData;
    currentIssueData: { data: { labels: Array<{ name: string }> } };
    prNumber: number;
    correlatedLogger: Logger;
}): Promise<void> {
    const { issueRef, currentIssueData, prNumber, correlatedLogger } = options;
    const repository = `${issueRef.repoOwner}/${issueRef.repoName}`;
    await linkPRToPlanIssue(repository, issueRef.number, prNumber);
    correlatedLogger.info({ repository, issueNumber: issueRef.number, prNumber }, 'Linked PR to plan issue');

    const hasAutoMergeLabel = currentIssueData.data.labels.some((label) => label.name === 'auto-merge');
    const planIssue = await findPlanIssueByRepoAndNumber(repository, issueRef.number);
    const effectiveUltrafix = planIssue
        ? await resolveEffectiveUltrafixSettings(planIssue)
        : { runUltrafix: false, goal: null, maxCycles: null };

    const ultrafixTrigger = resolveImplementationPrUltrafixTrigger(
        currentIssueData.data.labels,
        effectiveUltrafix,
    );

    if (ultrafixTrigger) {
        try {
            await triggerSystemUltrafix({
                owner: issueRef.repoOwner,
                repo: issueRef.repoName,
                prNumber,
                goal: ultrafixTrigger.goal,
                maxCycles: ultrafixTrigger.maxCycles,
                correlatedLogger,
            });
        } catch (error) {
            correlatedLogger.warn({
                repository,
                issueNumber: issueRef.number,
                prNumber,
                error: (error as Error).message,
            }, 'Failed to trigger system ultrafix for PR');
        }
        return;
    }

    if (!hasAutoMergeLabel) return;

    correlatedLogger.info({ prNumber }, 'Auto-merge label detected, enabling auto-merge on PR');
    const autoMergeResult = await enableAutoMerge({
        owner: issueRef.repoOwner,
        repoName: issueRef.repoName,
        prNumber,
    });
    if (autoMergeResult.success && autoMergeResult.autoMergeEnabled === true) {
        correlatedLogger.info({ prNumber, autoMergeEnabled: autoMergeResult.autoMergeEnabled }, 'Auto-merge enabled successfully');
        return;
    }

    correlatedLogger.warn({ prNumber, error: autoMergeResult.error }, autoMergeResult.success
        ? 'GitHub auto-merge was not enabled on PR'
        : 'Failed to enable auto-merge on PR');
    await tryDirectMergeForNoCiEpic({
        issueRef,
        labels: currentIssueData.data.labels,
        prNumber,
        log: correlatedLogger,
    });
}
