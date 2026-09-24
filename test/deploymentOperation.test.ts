import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { RepositoryDeploymentConfig } from '@propr/core';
import { runDeploymentOperation, type DeploymentApi, type WorkflowRun } from '../src/jobs/deploymentOperation.js';
import { isDeploymentCommentAuthorized } from '../packages/core/src/webhook/deploymentAuthorization.js';

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
        assert.deepEqual(dispatch.args, [{ owner: 'nrdgrrrl', repo: 'WordRush', workflow: 'deploy-production.yml', branch: 'master', inputs: { commit: 'production-sha-1234567890', mode: 'deploy' } }]);
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
        });
        const result = await runDeploymentOperation({ owner: 'nrdgrrrl', repo: 'WordRush', pullRequestNumber: 12, mode: 'dry-run', config }, fixture.adapter);
        const dispatch = fixture.calls.find(call => call.method === 'dispatch')!;
        assert.deepEqual((dispatch.args[0] as { inputs: unknown }).inputs, { commit: 'production-sha-1234567890', mode: 'dry-run' });
        assert.equal(result.status, 'failure');
        assert.match(fixture.comments[0], /dry-run started/);
        assert.match(fixture.comments[1], /failed/);
        assert.match(fixture.comments[1], /actions\/runs\/22/);
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

    test('recovers from a transient run-list API error while monitoring', async () => {
        let attempts = 0;
        const fixture = api({
            listRuns: async () => {
                attempts++;
                if (attempts === 2) throw Object.assign(new Error('temporary'), { status: 503 });
                return attempts === 1 ? [] : [run(77)];
            },
        });
        const result = await runDeploymentOperation({ owner: 'nrdgrrrl', repo: 'WordRush', pullRequestNumber: 17, mode: 'deploy', config }, fixture.adapter);
        assert.equal(result.status, 'success');
        assert.equal(attempts >= 4, true);
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
