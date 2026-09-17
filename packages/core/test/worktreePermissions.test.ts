import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import { simpleGit } from 'simple-git';

const chownCalls: Array<{ file: string; args: string[] }> = [];
const execFileSyncMock = mock.fn((file: string, args: string[]) => {
    chownCalls.push({ file, args });
    return '';
});

await mock.module('node:child_process', {
    namedExports: { execFileSync: execFileSyncMock },
});

const {
    resolveGitCommonDir,
    resolveLinkedWorktreeGitDir,
    setupRepositoryPermissions,
    setupWorktreePermissions,
} = await import('../src/git/worktreeOperations.js');

test('resolves a linked worktree index under the common repository metadata', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'propr-worktree-permissions-'));
    const repositoryPath = path.join(tempDir, 'repository');
    const worktreePath = path.join(tempDir, 'worktree');

    try {
        await fs.ensureDir(repositoryPath);
        const git = simpleGit(repositoryPath);
        await git.init();
        await git.addConfig('user.name', 'ProPR Test');
        await git.addConfig('user.email', 'test@example.com');
        await fs.writeFile(path.join(repositoryPath, 'README.md'), 'test\n');
        await git.add('.');
        await git.commit('initial');
        await git.raw(['worktree', 'add', '-b', 'test-branch', worktreePath, 'HEAD']);

        const worktreeGit = simpleGit(worktreePath);
        const gitDir = await resolveLinkedWorktreeGitDir(worktreePath);
        const commonDir = path.resolve(worktreePath, (await worktreeGit.raw(['rev-parse', '--git-common-dir'])).trim());

        assert.equal(gitDir, path.resolve(worktreePath, (await worktreeGit.raw(['rev-parse', '--git-dir'])).trim()));
        assert.equal(path.dirname(gitDir), path.join(commonDir, 'worktrees'));
        assert.equal(await fs.pathExists(path.join(gitDir, 'index')), true);
        assert.notEqual(gitDir, commonDir);
    } finally {
        await fs.remove(tempDir);
    }
});

test('rejects an exact .. relative Git metadata path', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'propr-worktree-permissions-'));
    const repositoryPath = path.join(tempDir, 'repository');

    try {
        await fs.ensureDir(repositoryPath);
        await simpleGit(repositoryPath).init();

        await assert.rejects(
            resolveLinkedWorktreeGitDir(repositoryPath),
            /Git metadata path is not a linked-worktree directory/,
        );
    } finally {
        await fs.remove(tempDir);
    }
});

test('repairs shared Git metadata before an agent writes from a linked worktree', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'propr-shared-git-permissions-'));
    const repositoryPath = path.join(tempDir, 'repository');
    const worktreePath = path.join(tempDir, 'worktree');

    try {
        chownCalls.length = 0;
        await fs.ensureDir(repositoryPath);
        const git = simpleGit(repositoryPath);
        await git.init();
        await git.addConfig('user.name', 'ProPR Test');
        await git.addConfig('user.email', 'test@example.com');
        await fs.writeFile(path.join(repositoryPath, 'README.md'), 'test\n');
        await git.add('.');
        await git.commit('initial');

        const commonDir = await resolveGitCommonDir(repositoryPath);
        await setupRepositoryPermissions(repositoryPath, 'test/repository');
        assert.deepEqual(chownCalls[0], {
            file: 'sudo',
            args: ['chown', '-R', '1000:1000', '--', commonDir],
        });

        await git.raw(['worktree', 'add', '-b', 'test-branch', worktreePath, 'HEAD']);
        const linkedGitDir = await resolveLinkedWorktreeGitDir(worktreePath);
        await setupWorktreePermissions(worktreePath, 'test-branch', null);

        assert.deepEqual(chownCalls[1], {
            file: 'sudo',
            args: ['chown', '-R', '1000:1000', '--', worktreePath, linkedGitDir, commonDir],
        });
    } finally {
        await fs.remove(tempDir);
    }
});
