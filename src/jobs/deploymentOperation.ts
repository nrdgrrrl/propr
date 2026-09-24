import type { RepositoryDeploymentConfig } from '@propr/core';

export interface WorkflowRun {
    id: number;
    html_url: string;
    created_at: string;
    workflow_id: number;
    event: string;
    head_sha: string;
    head_branch: string;
    status: 'queued' | 'in_progress' | 'completed' | string;
    conclusion: string | null;
}

export interface DeploymentApi {
    getBranchHead(owner: string, repo: string, branch: string): Promise<string>;
    getWorkflowId(owner: string, repo: string, workflow: string): Promise<number>;
    listRuns(owner: string, repo: string, workflowId: number, branch: string): Promise<WorkflowRun[]>;
    dispatch(request: { owner: string; repo: string; workflow: string; branch: string; inputs: Record<string, string> }): Promise<{ runId?: number; runUrl?: string } | void>;
    comment(owner: string, repo: string, pr: number, body: string): Promise<void>;
    sleep(ms: number): Promise<void>;
}

export interface DeploymentRequest {
    owner: string;
    repo: string;
    pullRequestNumber: number;
    mode: 'deploy' | 'dry-run';
    config: RepositoryDeploymentConfig;
}

const DISCOVERY_ATTEMPTS = 12;
const DISCOVERY_INTERVAL_MS = 5_000;
const MONITOR_ATTEMPTS = 360;
const MONITOR_INTERVAL_MS = 5_000;
function isNewMatchingRun(args: { candidate: WorkflowRun; request: DeploymentRequest; workflowId: number; sha: string; previousRunIds: Set<number>; after: number }): boolean {
    const { candidate, request, workflowId, sha, previousRunIds, after } = args;
    return !previousRunIds.has(candidate.id)
        && Date.parse(candidate.created_at) >= after - 1_000
        && candidate.workflow_id === workflowId
        && candidate.event === 'workflow_dispatch'
        && candidate.head_branch === request.config.productionBranch
        && candidate.head_sha === sha;
}

async function readWithRetry<T>(operation: () => Promise<T>, api: DeploymentApi): Promise<T> {
    for (let attempt = 0; ; attempt++) {
        try {
            return await operation();
        } catch (error) {
            const status = typeof error === 'object' && error !== null && 'status' in error ? Number((error as { status: unknown }).status) : 0;
            const headers = typeof error === 'object' && error !== null && 'response' in error
                ? ((error as { response?: { headers?: Record<string, string> } }).response?.headers ?? {})
                : {};
            const transient = status === 429 || status >= 500 || (status === 403 && (headers['retry-after'] || headers['x-ratelimit-remaining'] === '0'));
            if (!transient || attempt >= 2) throw error;
            const retryAfterSeconds = Number(headers['retry-after']);
            const delay = Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
                ? Math.min(retryAfterSeconds * 1_000, 30_000)
                : 500 * 2 ** attempt;
            await api.sleep(delay);
        }
    }
}

async function discoverWorkflowRun(args: {
    request: DeploymentRequest;
    api: DeploymentApi;
    workflowId: number;
    sha: string;
    previousRunIds: Set<number>;
    dispatchedAfter: number;
    dispatchResponse: { runId?: number; runUrl?: string } | void;
}): Promise<WorkflowRun | undefined> {
    const { request, api, workflowId, sha, previousRunIds, dispatchedAfter, dispatchResponse } = args;
    const { owner, repo, config } = request;
    if (dispatchResponse?.runId) {
        for (let attempt = 0; attempt < DISCOVERY_ATTEMPTS; attempt++) {
            const direct = (await readWithRetry(() => api.listRuns(owner, repo, workflowId, config.productionBranch), api)).find(candidate =>
                candidate.id === dispatchResponse.runId
                && candidate.workflow_id === workflowId
                && candidate.event === 'workflow_dispatch'
                && candidate.head_branch === config.productionBranch
                && candidate.head_sha === sha
            );
            if (direct) return direct;
            if (attempt + 1 < DISCOVERY_ATTEMPTS) await api.sleep(DISCOVERY_INTERVAL_MS);
        }
    }
    for (let attempt = 0; attempt < DISCOVERY_ATTEMPTS; attempt++) {
        const runs = await readWithRetry(() => api.listRuns(owner, repo, workflowId, config.productionBranch), api);
        const discovered = runs.filter(candidate => isNewMatchingRun({ candidate, request, workflowId, sha, previousRunIds, after: dispatchedAfter }))
            .sort((a, b) => b.id - a.id)[0];
        if (discovered) return discovered;
        if (attempt + 1 < DISCOVERY_ATTEMPTS) await api.sleep(DISCOVERY_INTERVAL_MS);
    }
    return undefined;
}

async function monitorWorkflowRun(args: {
    request: DeploymentRequest;
    api: DeploymentApi;
    workflowId: number;
    sha: string;
    run: WorkflowRun;
}): Promise<{ status: 'success' | 'failure'; runUrl: string }> {
    const { request, api, workflowId, sha, run } = args;
    const { owner, repo, pullRequestNumber, mode, config } = request;
    const action = mode === 'deploy' ? 'Production deployment' : 'Production deployment dry-run';
    await api.comment(owner, repo, pullRequestNumber, `🚀 **${action} started**\n\n- SHA: [\`${sha.slice(0, 12)}\`](https://github.com/${owner}/${repo}/commit/${sha})\n- Workflow: \`${config.workflow}\`\n- Run: [View GitHub Actions run](${run.html_url})`);

    for (let attempt = 0; attempt < MONITOR_ATTEMPTS; attempt++) {
        const latest = (await readWithRetry(() => api.listRuns(owner, repo, workflowId, config.productionBranch), api)).find(candidate => candidate.id === run.id);
        if (latest?.status === 'completed') {
            const success = latest.conclusion === 'success';
            await api.comment(owner, repo, pullRequestNumber, `${success ? '✅' : '❌'} **${action} ${success ? 'succeeded' : 'failed'}**\n\n- SHA: [\`${sha.slice(0, 12)}\`](https://github.com/${owner}/${repo}/commit/${sha})\n- Workflow: \`${config.workflow}\`\n- Result: \`${latest.conclusion ?? 'unknown'}\`\n- Run: [View GitHub Actions run](${latest.html_url})`);
            return { status: success ? 'success' : 'failure', runUrl: latest.html_url };
        }
        if (attempt + 1 < MONITOR_ATTEMPTS) await api.sleep(MONITOR_INTERVAL_MS);
    }
    await api.comment(owner, repo, pullRequestNumber, `⏱️ **${action} is still running** for SHA \`${sha.slice(0, 12)}\`. Monitoring timed out; check [the GitHub Actions run](${run.html_url}) for its current status.`);
    return { status: 'failure', runUrl: run.html_url };
}

/**
 * Dispatch and monitor the one repository-configured workflow. This is backend
 * control-plane code: callers must never pass its GitHub client to an agent.
 */
export async function runDeploymentOperation(
    request: DeploymentRequest,
    api: DeploymentApi,
): Promise<{ status: 'success' | 'failure'; sha?: string; runUrl?: string }> {
    const { owner, repo, pullRequestNumber, mode, config } = request;
    const report = (body: string) => api.comment(owner, repo, pullRequestNumber, body);
    if (!config.enabled) {
        await report('⚠️ Deployment is not enabled for this repository in ProPR configuration.');
        return { status: 'failure' };
    }

    let sha: string | undefined;
    let runUrl: string | undefined;
    try {
        const [workflowId, branchSha] = await Promise.all([
            readWithRetry(() => api.getWorkflowId(owner, repo, config.workflow), api),
            readWithRetry(() => api.getBranchHead(owner, repo, config.productionBranch), api),
        ]);
        sha = branchSha;
        const previousRunIds = new Set((await readWithRetry(() => api.listRuns(owner, repo, workflowId, config.productionBranch), api)).map(run => run.id));
        const dispatchedAfter = Math.floor(Date.now() / 1_000) * 1_000;
        const dispatchResponse = await api.dispatch({
            owner,
            repo,
            workflow: config.workflow,
            branch: config.productionBranch,
            inputs: {
                [config.commitInput]: sha,
                [config.modeInput]: mode === 'deploy' ? config.deployValue : config.dryRunValue,
            },
        });
        const run = await discoverWorkflowRun({ request, api, workflowId, sha, previousRunIds, dispatchedAfter, dispatchResponse });
        if (!run) {
            await report(`⚠️ ProPR dispatched \`${config.workflow}\` for production SHA \`${sha}\` (${mode}), but could not identify the new workflow run. Check the Actions tab before retrying.`);
            return { status: 'failure', sha };
        }

        runUrl = run.html_url;
        const result = await monitorWorkflowRun({ request, api, workflowId, sha, run });
        return { ...result, sha };
    } catch (error) {
        // Do not include arbitrary GitHub error bodies: they may contain sensitive
        // response details. Status codes are sufficient to guide an operator.
        const status = typeof error === 'object' && error !== null && 'status' in error ? String((error as { status: unknown }).status) : 'unavailable';
        try {
            await report(`❌ ProPR could not complete the configured deployment operation for ${mode === 'deploy' ? 'production deploy' : 'dry-run'}${sha ? ` at SHA \`${sha}\`` : ''}${runUrl ? `; check [the workflow run](${runUrl})` : ''}. GitHub API status: \`${status}\`. No deployment credentials were exposed to an agent.`);
        } catch {
            // Best effort reporting must not turn a safely-contained GitHub error
            // into a retried dispatch.
        }
        return { status: 'failure', ...(sha ? { sha } : {}), ...(runUrl ? { runUrl } : {}) };
    }
}
