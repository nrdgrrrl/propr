import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

const removed: string[] = [];

await mock.module('../src/claude/docker/dockerExecutor.js', {
    namedExports: {
        executeDockerCommand: mock.fn(async (_command: string, args: string[]) => {
            if (args[0] === 'images') {
                return { exitCode: 0, stdout: 'candidate\nstale\nrunning\n', stderr: '', messageTimestamps: new Map() };
            }
            if (args[0] === 'ps') {
                return { exitCode: 0, stdout: 'container-id\n', stderr: '', messageTimestamps: new Map() };
            }
            if (args[0] === 'inspect' && args[1] === '--format') {
                return { exitCode: 0, stdout: 'sha256:running-image\n', stderr: '', messageTimestamps: new Map() };
            }
            if (args[0] === 'image' && args[1] === 'inspect') {
                const tag = args[2]?.split(':').at(-1);
                const image = tag === 'candidate'
                    ? { Id: 'sha256:candidate-image', Config: { Labels: { 'dev.propr.agent-bundle': 'true' } } }
                    : tag === 'running'
                        ? { Id: 'sha256:running-image', Config: { Labels: {} } }
                        : { Id: 'sha256:stale-image', Config: { Labels: {} } };
                return { exitCode: 0, stdout: `${JSON.stringify(image)}\n`, stderr: '', messageTimestamps: new Map() };
            }
            if (args[0] === 'rmi') {
                removed.push(args[1] ?? '');
                return { exitCode: 0, stdout: '', stderr: '', messageTimestamps: new Map() };
            }
            throw new Error(`Unexpected Docker command: ${args.join(' ')}`);
        })
    }
});

const { cleanupUnusedAgentImages } = await import('../src/claude/docker/dockerImageManager.js');

test('cleanup keeps an unconfigured bundle candidate and running image while removing only a stale unlabelled image', async () => {
    const deleted = await cleanupUnusedAgentImages(new Set(['configured']));

    assert.equal(deleted, 1);
    assert.deepEqual(removed, ['propr/agent:stale']);
});
