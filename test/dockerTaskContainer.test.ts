import { describe, test } from 'node:test';
import assert from 'node:assert';
import {
    addTaskAttemptLabelsToDockerArgs,
    findTaskContainer,
    inspectLegacyDockerContainerLivenessForTask,
    inspectTaskContainerLivenessForTask,
    type ExecutionResult,
} from '../packages/core/src/claude/docker/dockerExecutor.js';
import { resolveExecutionArgs } from '../packages/core/src/claude/docker/dockerExecutionOwnership.js';

function result(stdout: string, exitCode = 0, stderr = ''): ExecutionResult {
    return { stdout, stderr, exitCode, messageTimestamps: new Map() };
}

describe('running Docker task container lookup', () => {
    test('scopes child runs and host bind sources for named stacks while preserving default paths', () => {
        const previousStack = process.env.PROPR_STACK;
        const previousTempRoot = process.env.PROPR_HOST_TEMP_ROOT;
        try {
            process.env.PROPR_STACK = 'propr-alt';
            process.env.PROPR_HOST_TEMP_ROOT = '/srv/propr-alt-temp';
            const scoped = resolveExecutionArgs('docker', [
                'run', '--rm', '--name', 'claude-issue-17-task-id',
                '-v', '/tmp/pr-worktrees/acme/repo:/home/node/workspace:rw',
                '-v', '/tmp/git-processor:/tmp/git-processor:ro',
                '-v', '/tmp/claude-logs:/tmp/claude-logs:rw',
                '-v', '/tmp/propr-vibe-prompts/vibe-prompt-1/prompt.txt:/home/node/prompt.txt:ro',
                'agent-image',
            ], 'task-id', 'generation-id');

            assert.ok(scoped.includes('propr.stack=propr-alt'));
            assert.ok(scoped.includes('propr-alt-claude-issue-17-task-id'));
            assert.ok(scoped.includes('/srv/propr-alt-temp/pr-worktrees/acme/repo:/home/node/workspace:rw'));
            assert.ok(scoped.includes('/srv/propr-alt-temp/git-processor:/tmp/git-processor:ro'));
            assert.ok(scoped.includes('/srv/propr-alt-temp/claude-logs:/tmp/claude-logs:rw'));
            assert.ok(scoped.includes('/srv/propr-alt-temp/propr-vibe-prompts/vibe-prompt-1/prompt.txt:/home/node/prompt.txt:ro'));

            process.env.PROPR_STACK = 'propr-main';
            delete process.env.PROPR_HOST_TEMP_ROOT;
            const existingMain = resolveExecutionArgs('docker', [
                'run', '--rm', '--name', 'claude-issue-17-task-id',
                '-v', '/tmp/git-processor:/tmp/git-processor:rw', 'agent-image',
            ], undefined, undefined);
            assert.ok(existingMain.includes('propr.stack=propr-main'));
            assert.ok(existingMain.includes('propr-main-claude-issue-17-task-id'));
            assert.ok(existingMain.includes('/tmp/git-processor:/tmp/git-processor:rw'));

            delete process.env.PROPR_STACK;
            const legacy = resolveExecutionArgs('docker', [
                'run', '--rm', '--name', 'claude-issue-17-task-id',
                '-v', '/tmp/git-processor:/tmp/git-processor:rw', 'agent-image',
            ], undefined, undefined);
            assert.ok(legacy.includes('propr.stack=propr'));
            assert.ok(legacy.includes('claude-issue-17-task-id'));
            assert.ok(legacy.includes('/tmp/git-processor:/tmp/git-processor:rw'));
        } finally {
            if (previousStack === undefined) delete process.env.PROPR_STACK;
            else process.env.PROPR_STACK = previousStack;
            if (previousTempRoot === undefined) delete process.env.PROPR_HOST_TEMP_ROOT;
            else process.env.PROPR_HOST_TEMP_ROOT = previousTempRoot;
        }
    });

    test('translates linked worktree bind sources under the git processor root', () => {
        const previousStack = process.env.PROPR_STACK;
        const previousTempRoot = process.env.PROPR_HOST_TEMP_ROOT;
        try {
            process.env.PROPR_STACK = 'propr-alt';
            process.env.PROPR_HOST_TEMP_ROOT = '/srv/propr-alt-temp';
            const scoped = resolveExecutionArgs('docker', [
                'run', '--rm', '--name', 'codex-pr-279-followup',
                '-v', '/tmp/git-processor/worktrees/acme/repo/pr-279-followup:/home/node/workspace:rw',
                'agent-image',
            ], undefined, undefined);

            assert.ok(scoped.includes('/srv/propr-alt-temp/git-processor/worktrees/acme/repo/pr-279-followup:/home/node/workspace:rw'));
        } finally {
            if (previousStack === undefined) delete process.env.PROPR_STACK;
            else process.env.PROPR_STACK = previousStack;
            if (previousTempRoot === undefined) delete process.env.PROPR_HOST_TEMP_ROOT;
            else process.env.PROPR_HOST_TEMP_ROOT = previousTempRoot;
        }
    });

    test('enables Docker init for every protected run without duplicating an existing flag', () => {
        const withInit = resolveExecutionArgs('docker', [
            'run', '--rm', '--name', 'agent-task', 'agent-image',
        ], undefined, undefined);
        assert.equal(withInit.filter(arg => arg === '--init').length, 1);
        assert.ok(withInit.includes('propr.stack=propr'));

        const alreadyInitialized = resolveExecutionArgs('docker', [
            'run', '--init', '--rm', '--name', 'agent-task', 'agent-image',
        ], undefined, undefined);
        assert.equal(alreadyInitialized.filter(arg => arg === '--init').length, 1);
    });

    test('scopes named-stack discovery and does not treat an unscoped legacy name as a collision', async () => {
        const previousStack = process.env.PROPR_STACK;
        const previousTempRoot = process.env.PROPR_HOST_TEMP_ROOT;
        process.env.PROPR_STACK = 'propr-main';
        delete process.env.PROPR_HOST_TEMP_ROOT;
        let receivedArgs: string[] = [];
        let legacyDiscoveryCalled = false;
        try {
            await findTaskContainer('same-task-id', async (_command, args) => {
                receivedArgs = args;
                return result('');
            });
            const legacyLiveness = await inspectLegacyDockerContainerLivenessForTask(
                'same-task-id',
                async () => {
                    legacyDiscoveryCalled = true;
                    return result('abcdef123456:legacy-child\n');
                },
            );

            assert.ok(receivedArgs.includes('label=propr.stack=propr-main'));
            assert.equal(legacyLiveness, 'not_found');
            assert.equal(legacyDiscoveryCalled, false);
        } finally {
            if (previousStack === undefined) delete process.env.PROPR_STACK;
            else process.env.PROPR_STACK = previousStack;
            if (previousTempRoot === undefined) delete process.env.PROPR_HOST_TEMP_ROOT;
            else process.env.PROPR_HOST_TEMP_ROOT = previousTempRoot;
        }
    });

    test('finds a running container by the exact task label', async () => {
        let receivedArgs: string[] = [];
        const executor = async (_command: string, args: string[]) => {
            receivedArgs = args;
            return result('417758dda147:codex-issue-1734-96957312\n');
        };

        const container = await findTaskContainer(
            'pr-comments-propr-gitfix-1734-96957312',
            executor,
        );

        assert.deepStrictEqual(container, {
            id: '417758dda147',
            name: 'codex-issue-1734-96957312',
        });
        assert.ok(receivedArgs.includes('label=propr.task.id=pr-comments-propr-gitfix-1734-96957312'));
        assert.ok(receivedArgs.includes('-a'));
        assert.ok(!receivedArgs.some(arg => arg.startsWith('name=')));
    });

    test('returns null when no matching container exists in any lifecycle state', async () => {
        const container = await findTaskContainer(
            'pr-comments-propr-gitfix-1734-96957312',
            async () => result(''),
        );

        assert.strictEqual(container, null);
    });

    test('uses exact task and attempt-generation labels for fenced lookup', async () => {
        let receivedArgs: string[] = [];
        await findTaskContainer(
            'pr-comments-propr-gitfix-1734-96957312',
            'generation-hash',
            async (_command, args) => {
                receivedArgs = args;
                return result('');
            },
        );

        assert.ok(receivedArgs.includes('label=propr.task.id=pr-comments-propr-gitfix-1734-96957312'));
        assert.ok(receivedArgs.includes('label=propr.task.attempt-generation=generation-hash'));
        assert.ok(!receivedArgs.some(arg => arg.startsWith('name=')));
    });

    test('does not use a shared eight-character suffix to identify a task container', async () => {
        let receivedArgs: string[] = [];
        const firstTask = 'pr-comments-owner-one-1748-12345678';
        const secondTask = 'pr-comments-owner-two-1748-12345678';

        await findTaskContainer(firstTask, async (_command, args) => {
            receivedArgs = args;
            return result('');
        });

        assert.ok(receivedArgs.includes(`label=propr.task.id=${firstTask}`));
        assert.ok(!receivedArgs.includes(`label=propr.task.id=${secondTask}`));
        assert.ok(!receivedArgs.some(arg => arg.includes('12345678$')));
    });

    test('adds attempt labels to every protected Docker run', () => {
        const args = addTaskAttemptLabelsToDockerArgs(
            ['run', '--rm', '--name', 'agent-task', 'agent-image'],
            'task-1748',
            'generation-hash',
        );

        assert.deepStrictEqual(args.slice(0, 5), [
            'run',
            '--label', 'propr.task.id=task-1748',
            '--label', 'propr.task.attempt-generation=generation-hash',
        ]);
    });

    test('adds the exact task label even when no attempt generation is available', () => {
        const args = addTaskAttemptLabelsToDockerArgs(
            ['run', '--rm', '--name', 'agent-task', 'agent-image'],
            'task-legacy-compatible',
            undefined,
        );

        assert.deepStrictEqual(args.slice(0, 3), [
            'run',
            '--label', 'propr.task.id=task-legacy-compatible',
        ]);
        assert.ok(!args.some(arg => arg.startsWith('propr.task.attempt-generation=')));
    });

    test('fails open when Docker inspection is unavailable', async () => {
        const container = await findTaskContainer(
            'pr-comments-propr-gitfix-1734-96957312',
            async () => { throw new Error('Docker unavailable'); },
        );

        assert.strictEqual(container, null);
    });

    test('distinguishes a preserved stopped exact-task container from a live one', async () => {
        const stopped = await inspectTaskContainerLivenessForTask(
            'pr-comments-propr-gitfix-1734-96957312',
            async () => result('417758dda147\tcodex-issue-1734-96957312-old\texited\n'),
        );
        const running = await inspectTaskContainerLivenessForTask(
            'pr-comments-propr-gitfix-1734-96957312',
            async () => result('9c3a01d7f820\tcodex-issue-1734-96957312-live\trunning\n'),
        );

        assert.deepStrictEqual(stopped, {
            liveness: 'stopped',
            container: { id: '417758dda147', name: 'codex-issue-1734-96957312-old' },
        });
        assert.deepStrictEqual(running, {
            liveness: 'running',
            container: { id: '9c3a01d7f820', name: 'codex-issue-1734-96957312-live' },
        });
    });

    test('fails closed when exact-task Docker inspection is unavailable or returns an unknown state', async () => {
        assert.deepStrictEqual(await inspectTaskContainerLivenessForTask(
            'pr-comments-propr-gitfix-1734-96957312',
            async () => result('', 1, 'daemon unavailable'),
        ), { liveness: 'unavailable', container: null });

        assert.deepStrictEqual(await inspectTaskContainerLivenessForTask(
            'pr-comments-propr-gitfix-1734-96957312',
            async () => result('417758dda147\tcodex-task\tremoving\n'),
        ), {
            liveness: 'unavailable',
            container: { id: '417758dda147', name: 'codex-task' },
        });
    });

    test('detects a running pre-label container without authorizing removal', async () => {
        let receivedArgs: string[] = [];
        const liveness = await inspectLegacyDockerContainerLivenessForTask(
            'pr-comments-propr-gitfix-1734-96957312',
            async (_command, args) => {
                receivedArgs = args;
                return result('417758dda147:claude-issue-1734-96957312\n');
            },
        );

        assert.strictEqual(liveness, 'running');
        assert.deepStrictEqual(receivedArgs, [
            'ps',
            '--filter', 'name=96957312$',
            '--format', '{{.ID}}:{{.Names}}',
        ]);
        assert.ok(!receivedArgs.includes('rm'));
    });
});
