import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { RepositoryDeploymentConfig } from '@propr/core';
import { runDeploymentOperation, type DeploymentApi, type WorkflowRun } from '../src/jobs/deploymentOperation.js';
import { isDeploymentCommentAuthorized } from '../packages/core/src/webhook/deploymentAuthorization.js';
import { getDeploymentDispatchClient, makeDeploymentApi, MissingDeploymentDispatchCredentialError } from '../src/jobs/deploymentGithubApi.js';

test('deployment authorization requires an explicitly whitelisted human', () => {
    assert.equal(isDeploymentCommentAuthorized('Alice', 'User', ['alice']), true);
    assert.equal(isDeploymentCommentAuthorized('Alice', 'User', []), false);
    assert.equal(isDeploymentCommentAuthorized('Mallory', 'User', ['alice']), false);
    assert.equal(isDeploymentCommentAuthorized('alice[bot]', 'Bot', ['alice[bot]']), false);
});

const config: RepositoryDeploymentConfig = {
    enabled: true,
    workflow: 'deploy-production.yml',
    productionBranch: 'master',
    commitInput: 'commit',
    modeInput: 'mode',
    deployValue: 'deploy',
    dryRunValue: 'dry-run',
};

function run(id: number, options: Partial<WorkflowRun> = {}): WorkflowRun {
    return {
        id,
        html_url: `https://github.com/nrdgrrrl/WordRush/actions/runs/${id}`,
        created_at: new Date().toISOString(),
        workflow_id: 9,
        event: 'workflow_dispatch',
        head_sha: 'production-sha-1234567890',
        head_branch: 'master',
        status: 'completed',
        conclusion: 'success',
        ...options,
    };
}

function api(overrides: Partial<DeploymentApi> = {}) {
    const comments: string[] = [];
    const calls: Array<{ method: string; args: unknown[] }> = [];
    let runLists = 0;
    const adapter: DeploymentApi = {
        getBranchHead: async (...args) => { calls.push({ method: 'branch', args }); return 'production-sha-1234567890'; },
        getWorkflowId: async (...args) => { calls.push({ method: 'workflow', args }); return 9; },
        listRuns: async (...args) => {
            calls.push({ method: 'runs', args });
            runLists++;
            if (runLists === 1) return [run(1, { head_sha: 'production-sha-1234567890' })];
            return [run(1), run(2)];
        },
        getRun: async (_owner, _repo, id) => { calls.push({ method: 'getRun', args: [id] }); return run(id); },
        dispatch: async (request) => { calls.push({ method: 'dispatch', args: [request] }); },
        comment: async (_owner, _repo, _pr, body) => { comments.push(body); },
        sleep: async () => {},
        ...overrides,
    };
    return { adapter, calls, comments };
}

describe('runDeploymentOperation', () => {
    test('resolves the configured production HEAD and dispatches only configured workflow/ref/inputs', async () => {
        const fixture = api();
        const result = await runDeploymentOperation({ owner: 'nrdgrrrl', repo: 'WordRush', pullRequestNumber: 11, mode: 'deploy', config }, fixture.adapter);
        const dispatch = fixture.calls.find(call => call.method === 'dispatch')!;
        assert.deepEqual(dispatch.args, [{ owner: 'nrdgrrrl', repo: 'WordRush', workflow: 'deploy-production.yml', branch: 'master', returnRunDetails: true, inputs: { commit: 'production-sha-1234567890', mode: 'deploy' } }]);
        assert.deepEqual(result, { status: 'success', sha: 'production-sha-1234567890', runUrl: 'https://github.com/nrdgrrrl/WordRush/actions/runs/2' });
        assert.equal(fixture.comments.length, 2);
        assert.match(fixture.comments[0], /production-sha-1234567890/);
        assert.match(fixture.comments[0], /actions\/runs\/2/);
        assert.match(fixture.comments[1], /succeeded/);
    });

    test('dispatches dry-run input and reports failed workflow completion', async () => {
        const fixture = api({
            listRuns: (() => {
                let count = 0;
                return async () => ++count === 1 ? [] : [run(22, { status: 'completed', conclusion: 'failure' })];
            })(),
            getRun: async (_owner, _repo, id) => run(id, { status: 'completed', conclusion: 'failure' }),
        });
        const result = await runDeploymentOperation({ owner: 'nrdgrrrl', repo: 'WordRush', pullRequestNumber: 12, mode: 'dry-run', config }, fixture.adapter);
        const dispatch = fixture.calls.find(call => call.method === 'dispatch')!;
        assert.deepEqual((dispatch.args[0] as { inputs: unknown }).inputs, { commit: 'production-sha-1234567890', mode: 'dry-run' });
        assert.equal(result.status, 'failure');
        assert.match(fixture.comments[0], /dry-run started/);
        assert.match(fixture.comments[1], /failed/);
        assert.match(fixture.comments[1], /actions\/runs\/22/);
    });

    test('uses the exact run ID and URL returned by workflow_dispatch despite a competing same-SHA run', async () => {
        const fixture = api({
            dispatch: async request => {
                fixture.calls.push({ method: 'dispatch', args: [request] });
                return { runId: 44, runUrl: 'https://github.com/nrdgrrrl/WordRush/actions/runs/44' };
            },
            getRun: async (_owner, _repo, id) => {
                fixture.calls.push({ method: 'getRun', args: [id] });
                return run(id, { head_sha: 'branch-advanced-after-resolution' });
            },
            listRuns: async (...args) => {
                fixture.calls.push({ method: 'runs', args });
                return [run(43)];
            },
        });
        const result = await runDeploymentOperation({ owner: 'nrdgrrrl', repo: 'WordRush', pullRequestNumber: 18, mode: 'deploy', config }, fixture.adapter);
        assert.equal(result.runUrl, 'https://github.com/nrdgrrrl/WordRush/actions/runs/44');
        assert.ok(fixture.comments.every(comment => comment.includes('production-sha-1234567890')));
        assert.deepEqual(fixture.calls.filter(call => call.method === 'getRun').map(call => call.args), [[44], [44]]);
        assert.equal(fixture.calls.filter(call => call.method === 'runs').length, 1, 'only the pre-dispatch snapshot is listed');
    });

    test('selects only a new matching workflow run, excluding older and unrelated concurrent runs', async () => {
        const fixture = api({
            listRuns: (() => {
                let count = 0;
                return async () => ++count === 1
                    ? [run(3), run(4, { head_sha: 'other-sha' })]
                    : [run(3), run(4, { head_sha: 'other-sha' }), run(5, { workflow_id: 55 }), run(6)];
            })(),
        });
        const result = await runDeploymentOperation({ owner: 'nrdgrrrl', repo: 'WordRush', pullRequestNumber: 13, mode: 'deploy', config }, fixture.adapter);
        assert.equal(result.runUrl, 'https://github.com/nrdgrrrl/WordRush/actions/runs/6');
    });

    test('fails closed without dispatch when repository deployment is disabled', async () => {
        const fixture = api();
        const result = await runDeploymentOperation({ owner: 'nrdgrrrl', repo: 'WordRush', pullRequestNumber: 14, mode: 'deploy', config: { ...config, enabled: false } }, fixture.adapter);
        assert.equal(result.status, 'failure');
        assert.equal(fixture.calls.some(call => call.method === 'dispatch'), false);
        assert.match(fixture.comments[0], /not enabled/);
    });

    test('reports GitHub dispatch errors without exposing raw error details', async () => {
        const fixture = api({ dispatch: async () => { throw Object.assign(new Error('secret-bearing response body'), { status: 403 }); } });
        const result = await runDeploymentOperation({ owner: 'nrdgrrrl', repo: 'WordRush', pullRequestNumber: 15, mode: 'deploy', config }, fixture.adapter);
        assert.equal(result.status, 'failure');
        assert.match(fixture.comments[0], /status: `403`/);
        assert.doesNotMatch(fixture.comments[0], /secret-bearing/);
    });

    test('recovers from a transient exact-run API error while monitoring', async () => {
        let attempts = 0;
        const fixture = api({
            getRun: async () => {
                attempts++;
                if (attempts === 1) throw Object.assign(new Error('temporary'), { status: 503 });
                return run(2);
            },
        });
        const result = await runDeploymentOperation({ owner: 'nrdgrrrl', repo: 'WordRush', pullRequestNumber: 17, mode: 'deploy', config }, fixture.adapter);
        assert.equal(result.status, 'success');
        assert.equal(attempts >= 2, true);
    });

    test('does not attach to any pre-existing run when no new run appears', async () => {
        const fixture = api({ listRuns: async () => [run(100)] });
        // Discovery is bounded; avoid real waits in the focused test.
        fixture.adapter.sleep = async () => {};
        const result = await runDeploymentOperation({ owner: 'nrdgrrrl', repo: 'WordRush', pullRequestNumber: 16, mode: 'deploy', config }, fixture.adapter);
        assert.equal(result.status, 'failure');
        assert.equal(result.runUrl, undefined);
        assert.match(fixture.comments[0], /could not identify the new workflow run/);
    });
});

describe('backend deployment dispatch credential', () => {
    test('own-App mode can use its normal installation client when Actions: write is configured on the App', () => {
        const regular = { request: async () => ({ data: {} }) } as never;
        assert.equal(getDeploymentDispatchClient(regular, { GH_AUTH_MODE: 'app' }), regular);
        assert.equal(getDeploymentDispatchClient(regular, { GH_AUTH_MODE: 'app', PROPR_DEPLOYMENT_GITHUB_TOKEN: 'relay-only-token' }), regular);
    });

    test('relay mode fails closed when no dedicated dispatch credential is configured', () => {
        const regular = { request: async () => ({ data: {} }) } as never;
        assert.throws(() => getDeploymentDispatchClient(regular, { GH_AUTH_MODE: 'relay' }), MissingDeploymentDispatchCredentialError);
    });

    test('dedicated token is confined to Actions API calls; branch reads and comments stay on the installation client', async () => {
        const token = 'backend-only-deploy-token';
        const tokenClientCalls: Array<{ route: string; parameters?: Record<string, unknown> }> = [];
        const normalClientCalls: string[] = [];
        const normal = { request: async (route: string) => {
            normalClientCalls.push(route);
            return { data: { commit: { sha: 'production-sha-1234567890' } } };
        } } as never;
        const dispatch = getDeploymentDispatchClient(normal, { GH_AUTH_MODE: 'relay', PROPR_DEPLOYMENT_GITHUB_TOKEN: token }, received => {
            assert.equal(received, token);
            return { request: async (route: string, parameters?: Record<string, unknown>) => {
                tokenClientCalls.push({ route, parameters });
                if (route.endsWith('/workflows/{workflow_id}')) return { data: { id: 3 } };
                if (route.endsWith('/workflows/{workflow_id}/runs')) return { data: { workflow_runs: [run(8)] } };
                if (route.endsWith('/runs/{run_id}')) return { data: run(8) };
                return { data: { workflow_run_id: 8, html_url: 'https://github.com/nrdgrrrl/WordRush/actions/runs/8', run_url: 'https://api.github.com/repos/nrdgrrrl/WordRush/actions/runs/8' } };
            } } as never;
        });
        const adapter = makeDeploymentApi(normal, dispatch);
        await adapter.getBranchHead('nrdgrrrl', 'WordRush', 'master');
        await adapter.getWorkflowId('nrdgrrrl', 'WordRush', 'deploy-production.yml');
        await adapter.listRuns('nrdgrrrl', 'WordRush', 3, 'master');
        await adapter.getRun('nrdgrrrl', 'WordRush', 8);
        await adapter.comment('nrdgrrrl', 'WordRush', 9, 'status');
        await adapter.dispatch({ owner: 'nrdgrrrl', repo: 'WordRush', workflow: 'deploy-production.yml', branch: 'master', inputs: { commit: 'sha', mode: 'deploy' }, returnRunDetails: true });
        assert.deepEqual(normalClientCalls, [
            'GET /repos/{owner}/{repo}/branches/{branch}',
            'POST /repos/{owner}/{repo}/issues/{issue_number}/comments',
        ]);
        assert.deepEqual(tokenClientCalls.map(call => call.route), [
            'GET /repos/{owner}/{repo}/actions/workflows/{workflow_id}',
            'GET /repos/{owner}/{repo}/actions/workflows/{workflow_id}/runs',
            'GET /repos/{owner}/{repo}/actions/runs/{run_id}',
            'POST /repos/{owner}/{repo}/actions/workflows/{workflow_id}/dispatches',
        ]);
        assert.deepEqual(tokenClientCalls[3], {
            route: 'POST /repos/{owner}/{repo}/actions/workflows/{workflow_id}/dispatches',
            parameters: {
                owner: 'nrdgrrrl', repo: 'WordRush', workflow_id: 'deploy-production.yml', ref: 'master',
                inputs: { commit: 'sha', mode: 'deploy' }, return_run_details: true,
            },
        });
    });
});
