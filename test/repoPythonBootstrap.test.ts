import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, test } from 'node:test';

const temporaryDirectories: string[] = [];

afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

async function createFixture(files: Record<string, string>): Promise<{ root: string; log: string; fakeBin: string }> {
    const root = await mkdtemp(path.join(os.tmpdir(), 'propr-python-bootstrap-'));
    temporaryDirectories.push(root);
    const fakeBin = path.join(root, 'bin');
    const log = path.join(root, 'uv.log');
    await mkdir(fakeBin, { recursive: true });

    await Promise.all(Object.entries(files).map(async ([relativePath, contents]) => {
        const filePath = path.join(root, relativePath);
        await mkdir(path.dirname(filePath), { recursive: true });
        await writeFile(filePath, contents);
    }));

    const fakeUv = path.join(fakeBin, 'uv');
    await writeFile(fakeUv, '#!/bin/sh\nset -eu\nprintf \'%s\\n\' "$*" >> "$UV_COMMAND_LOG"\nif [ "$1" = "venv" ]; then\n  mkdir -p "$2/bin"\n  : > "$2/bin/python"\n  chmod +x "$2/bin/python"\nfi\n');
    await chmod(fakeUv, 0o755);

    return { root, log, fakeBin };
}

function runBootstrap(root: string, fakeBin: string, log: string): void {
    execFileSync('bash', ['scripts/repo-python-bootstrap.sh'], {
        cwd: process.cwd(),
        env: {
            ...process.env,
            PATH: `${fakeBin}:${process.env.PATH}`,
            PROPR_WORKSPACE: root,
            PROPR_CACHE_DIR: path.join(root, 'cache'),
            UV_COMMAND_LOG: log,
        },
        stdio: 'pipe',
    });
}

test('bootstraps a referenced root venv from requirements-dev.txt', async () => {
    const { root, log, fakeBin } = await createFixture({
        Makefile: 'ecology-doc-check:\n\t.venv/bin/python tools/check_docs.py\n',
        'requirements-dev.txt': 'pytest\nruff\n',
        'requirements.txt': 'runtime-dependency\n',
    });

    runBootstrap(root, fakeBin, log);

    assert.deepEqual((await readFile(log, 'utf8')).trim().split('\n'), [
        'venv .venv',
        'pip install --python .venv/bin/python -r requirements-dev.txt',
    ]);
    await readFile(path.join(root, '.venv', 'bin', 'python'));
});

test('does not bootstrap projects that do not require a root venv', async () => {
    const { root, log, fakeBin } = await createFixture({
        Makefile: 'check:\n\tpython3 -m pytest\n',
        'requirements-dev.txt': 'pytest\n',
    });

    runBootstrap(root, fakeBin, log);

    await assert.rejects(readFile(log, 'utf8'));
    await assert.rejects(readFile(path.join(root, '.venv', 'bin', 'python')));
});

test('does not recreate an existing repository venv', async () => {
    const { root, log, fakeBin } = await createFixture({
        Makefile: 'check:\n\t.venv/bin/python -m pytest\n',
        'requirements-dev.txt': 'pytest\n',
        '.venv/bin/python': '',
    });
    await chmod(path.join(root, '.venv', 'bin', 'python'), 0o755);

    runBootstrap(root, fakeBin, log);

    await assert.rejects(readFile(log, 'utf8'));
});
