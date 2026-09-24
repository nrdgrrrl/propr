import type { Job } from 'bullmq';
import type { Redis } from 'ioredis';
import { getAuthenticatedOctokit, getIssueQueue, loadMonitoredReposRaw, type DeploymentJobData, type JobResult, type RepositoryDeploymentConfig } from '@propr/core';
import { getDeploymentDispatchClient, makeDeploymentApi, MissingDeploymentDispatchCredentialError } from './deploymentGithubApi.js';
import { runDeploymentOperation } from './deploymentOperation.js';

type GithubClient = Pick<Awaited<ReturnType<typeof getAuthenticatedOctokit>>, 'request'>;

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
    let dispatchOctokit: GithubClient;
    try {
        dispatchOctokit = getDeploymentDispatchClient(octokit);
    } catch (error) {
        if (!(error instanceof MissingDeploymentDispatchCredentialError)) throw error;
        await octokit.request('POST /repos/{owner}/{repo}/issues/{issue_number}/comments', {
            owner: repoOwner, repo: repoName, issue_number: pullRequestNumber,
            body: '❌ ProPR could not dispatch the configured deployment: this relay-mode backend has no `PROPR_DEPLOYMENT_GITHUB_TOKEN` configured. No workflow was dispatched.',
        });
        return { status: 'failure', taskId: `deploy-${commentId}` };
    }
    const api = makeDeploymentApi(octokit, dispatchOctokit);
    const result = await runDeploymentOperation({ owner: repoOwner, repo: repoName, pullRequestNumber, mode, config: config as RepositoryDeploymentConfig }, api);
    return { status: result.status, taskId: `deploy-${commentId}`, output: result.runUrl };
    } finally {
        await redis.eval("if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end", 1, lockKey, lockToken);
    }
}
