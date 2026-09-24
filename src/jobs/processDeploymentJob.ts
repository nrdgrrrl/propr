import type { Job } from 'bullmq';
import type { Redis } from 'ioredis';
import { getAuthenticatedOctokit, getIssueQueue, loadMonitoredReposRaw, type DeploymentJobData, type JobResult, type RepositoryDeploymentConfig } from '@propr/core';
import { runDeploymentOperation, type DeploymentApi, type WorkflowRun } from './deploymentOperation.js';

function makeDeploymentApi(octokit: Awaited<ReturnType<typeof getAuthenticatedOctokit>>): DeploymentApi {
    return {
        getBranchHead: async (owner, repo, branch) => {
            const { data } = await octokit.request('GET /repos/{owner}/{repo}/branches/{branch}', { owner, repo, branch });
            return data.commit.sha;
        },
        getWorkflowId: async (owner, repo, workflow) => {
            const { data } = await octokit.request('GET /repos/{owner}/{repo}/actions/workflows/{workflow_id}', { owner, repo, workflow_id: workflow });
            return data.id;
        },
        listRuns: async (owner, repo, workflowId, branch) => {
            const { data } = await octokit.request('GET /repos/{owner}/{repo}/actions/workflows/{workflow_id}/runs', {
                owner, repo, workflow_id: workflowId, branch, event: 'workflow_dispatch', per_page: 100,
            });
            return data.workflow_runs as WorkflowRun[];
        },
        dispatch: async ({ owner, repo, workflow, branch, inputs }) => {
            const response = await octokit.request('POST /repos/{owner}/{repo}/actions/workflows/{workflow_id}/dispatches', {
                owner, repo, workflow_id: workflow, ref: branch, inputs,
            });
            const data = response.data as { workflow_run_id?: number; html_url?: string; run_url?: string } | undefined;
            return {
                ...(typeof data?.workflow_run_id === 'number' ? { runId: data.workflow_run_id } : {}),
                ...(typeof data?.html_url === 'string' ? { runUrl: data.html_url } : typeof data?.run_url === 'string' ? { runUrl: data.run_url } : {}),
            };
        },
        comment: async (owner, repo, pr, body) => {
            await octokit.request('POST /repos/{owner}/{repo}/issues/{issue_number}/comments', { owner, repo, issue_number: pr, body });
        },
        sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
    };
}

export async function processDeploymentJob(job: Job<DeploymentJobData>): Promise<JobResult> {
    const { repoOwner, repoName, pullRequestNumber, commentId, mode } = job.data;
    const issueQueue = await getIssueQueue();
    const redis = await issueQueue.client as unknown as Redis;
    const lockKey = `deployment-operation:${repoOwner.toLowerCase()}/${repoName.toLowerCase()}`;
    const lockToken = `${job.id ?? commentId}:${Date.now()}`;
    const locked = await redis.set(lockKey, lockToken, 'EX', 2 * 60 * 60, 'NX');
    if (locked !== 'OK') {
        const octokit = await getAuthenticatedOctokit();
        await octokit.request('POST /repos/{owner}/{repo}/issues/{issue_number}/comments', {
            owner: repoOwner, repo: repoName, issue_number: pullRequestNumber,
            body: '⚠️ Another configured deployment is already running for this repository. No second workflow was dispatched; check its Actions run before retrying.',
        });
        return { status: 'busy', taskId: `deploy-${commentId}` };
    }
    try {
    const repos = await loadMonitoredReposRaw();
    const configuredRepo = repos.find(item => item.name.toLowerCase() === `${repoOwner}/${repoName}`.toLowerCase());
    const config = configuredRepo?.deployment;
    if (!configuredRepo?.enabled || !config?.enabled) {
        const octokit = await getAuthenticatedOctokit();
        await octokit.request('POST /repos/{owner}/{repo}/issues/{issue_number}/comments', {
            owner: repoOwner, repo: repoName, issue_number: pullRequestNumber,
            body: '⚠️ Deployment is not enabled for this repository in ProPR configuration. No workflow was dispatched.',
        });
        return { status: 'configuration_missing', taskId: `deploy-${commentId}` };
    }
    const octokit = await getAuthenticatedOctokit();
    const api = makeDeploymentApi(octokit);
    const result = await runDeploymentOperation({ owner: repoOwner, repo: repoName, pullRequestNumber, mode, config: config as RepositoryDeploymentConfig }, api);
    return { status: result.status, taskId: `deploy-${commentId}`, output: result.runUrl };
    } finally {
        await redis.eval("if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end", 1, lockKey, lockToken);
    }
}
