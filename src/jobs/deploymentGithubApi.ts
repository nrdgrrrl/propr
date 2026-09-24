import { Octokit } from '@octokit/core';
import { parseTruthyEnvValue, resolveGithubAuthMode } from '@propr/shared';
import type { PaginatedOctokitInstance } from '@propr/core';
import type { DeploymentApi, WorkflowRun } from './deploymentOperation.js';

type GithubClient = Pick<PaginatedOctokitInstance, 'request'>;

export class MissingDeploymentDispatchCredentialError extends Error {
    constructor() {
        super('A backend-only GitHub Actions dispatch credential is required in relay mode.');
        this.name = 'MissingDeploymentDispatchCredentialError';
    }
}

export function getDeploymentDispatchClient(
    installationClient: GithubClient,
    env: NodeJS.ProcessEnv = process.env,
    createTokenClient: (token: string) => GithubClient = token => new Octokit({ auth: token }) as unknown as GithubClient,
): GithubClient {
    const mode = resolveGithubAuthMode({
        demoMode: parseTruthyEnvValue(env.PROPR_DEMO_MODE),
        ghAuthMode: env.GH_AUTH_MODE,
        relayUrl: env.PROPR_GH_RELAY_URL?.trim() || 'https://webhook.propr.dev',
        relayToken: env.PROPR_GH_RELAY_TOKEN,
        appId: env.GH_APP_ID,
        privateKeyPath: env.GH_PRIVATE_KEY_PATH,
        installationId: env.GH_INSTALLATION_ID,
    }).mode;
    const token = env.PROPR_DEPLOYMENT_GITHUB_TOKEN?.trim();
    if (token) return createTokenClient(token);
    if (mode === 'app') return installationClient;
    throw new MissingDeploymentDispatchCredentialError();
}

export function makeDeploymentApi(octokit: GithubClient, dispatchOctokit: GithubClient = octokit): DeploymentApi {
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
        getRun: async (owner, repo, runId) => {
            const { data } = await octokit.request('GET /repos/{owner}/{repo}/actions/runs/{run_id}', { owner, repo, run_id: runId });
            return data as WorkflowRun;
        },
        dispatch: async ({ owner, repo, workflow, branch, inputs, returnRunDetails }) => {
            const response = await dispatchOctokit.request('POST /repos/{owner}/{repo}/actions/workflows/{workflow_id}/dispatches', {
                owner, repo, workflow_id: workflow, ref: branch, inputs, return_run_details: returnRunDetails,
            });
            const data = response.data as { workflow_run_id?: number; html_url?: string; run_url?: string } | undefined;
            return {
                ...(typeof data?.workflow_run_id === 'number' ? { runId: data.workflow_run_id } : {}),
                ...(typeof data?.html_url === 'string' ? { runUrl: data.html_url } : {}),
            };
        },
        comment: async (owner, repo, pr, body) => {
            await octokit.request('POST /repos/{owner}/{repo}/issues/{issue_number}/comments', { owner, repo, issue_number: pr, body });
        },
        sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
    };
}
