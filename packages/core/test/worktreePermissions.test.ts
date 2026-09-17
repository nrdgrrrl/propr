import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import { simpleGit } from 'simple-git';
import { resolveLinkedWorktreeGitDir } from '../src/git/worktreeOperations.js';

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
