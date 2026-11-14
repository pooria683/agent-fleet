import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  currentBranch,
  ensureLocalStorageExcluded,
  gitValue,
  registeredWorktrees,
} from '../src/worktree/git.js';
import { changedFiles, createWorktree, snapshotWorktree } from '../src/worktree/manager.js';
import { gitCommand, makeRepo, temporaryDirectory } from './helpers.js';

describe('real Git worktrees and snapshots', () => {
  it('creates a unique branch at HEAD without checking it out in the source repository', async () => {
    const repo = await makeRepo();
    const base = await gitValue(repo, 'rev-parse', 'HEAD');
    const runDir = join(await temporaryDirectory(), 'run');
    const worktree = await createWorktree(
      repo,
      runDir,
      '20260101-000000-abcdef12',
      'alpha',
      'task',
      base,
    );
    expect(await currentBranch(repo)).toBe('main');
    expect(await currentBranch(worktree.path)).toBe(worktree.branch);
    expect(await gitValue(worktree.path, 'rev-parse', 'HEAD')).toBe(base);
    expect((await registeredWorktrees(repo)).map((entry) => entry.branch)).toContain(
      worktree.branch,
    );
    await expect(
      createWorktree(
        repo,
        join(await temporaryDirectory(), 'other'),
        '20260101-000000-abcdef12',
        'alpha',
        'task',
        base,
      ),
    ).rejects.toThrow();
  });
  it('captures committed, staged, unstaged, untracked, binary, renamed and deleted files without changing the real index', async () => {
    const repo = await makeRepo({
      'tracked.txt': 'original\n',
      'delete.txt': 'delete me\n',
      'rename-old.txt': 'rename me\n',
      '.gitignore': 'ignored.log\n',
    });
    const base = await gitValue(repo, 'rev-parse', 'HEAD');
    await ensureLocalStorageExcluded(repo);
    const runDir = join(repo, '.agent-fleet', 'runs', '20260101-000000-abcdef12');
    const worktree = await createWorktree(
      repo,
      runDir,
      '20260101-000000-abcdef12',
      'alpha',
      'task',
      base,
    );
    await rm(join(worktree.path, 'delete.txt'));
    await rename(join(worktree.path, 'rename-old.txt'), join(worktree.path, 'rename-new.txt'));
    await gitCommand(worktree.path, 'add', '-A');
    await gitCommand(worktree.path, 'commit', '-m', 'Agent committed changes');
    await writeFile(join(worktree.path, 'tracked.txt'), 'staged\n');
    await gitCommand(worktree.path, 'add', 'tracked.txt');
    await writeFile(join(worktree.path, 'tracked.txt'), 'staged and unstaged\n');
    await writeFile(join(worktree.path, 'new file.txt'), 'untracked content\n');
    await writeFile(join(worktree.path, 'ignored.log'), 'must not be captured');
    await writeFile(join(worktree.path, 'binary.bin'), Buffer.from([0, 1, 2, 255]));
    const indexBefore = await gitCommand(worktree.path, 'diff', '--cached', '--binary');
    const statusBefore = await gitCommand(worktree.path, 'status', '--porcelain=v1');
    const agentDir = join(await temporaryDirectory(), 'alpha');
    const { mkdir } = await import('node:fs/promises');
    await mkdir(agentDir);
    const snapshot = await snapshotWorktree(worktree.path, base, agentDir);
    expect(snapshot.files).toHaveLength(5);
    expect(snapshot.files.map((file) => file.path).sort()).toEqual([
      'binary.bin',
      'delete.txt',
      'new file.txt',
      'rename-new.txt',
      'tracked.txt',
    ]);
    expect(snapshot.files.find((file) => file.path === 'delete.txt')?.status).toBe('D');
    expect(snapshot.files.find((file) => file.path === 'rename-new.txt')?.status).toMatch(/^R/);
    expect(snapshot.risks.some((risk) => risk.includes('Deleted file'))).toBe(true);
    const patch = await readFile(snapshot.patchFile, 'utf8');
    expect(patch).toContain('+untracked content');
    expect(patch).toContain('+staged and unstaged');
    expect(patch).toContain('GIT binary patch');
    expect(patch).not.toContain('must not be captured');
    expect(await gitCommand(worktree.path, 'diff', '--cached', '--binary')).toBe(indexBefore);
    expect(await gitCommand(worktree.path, 'status', '--porcelain=v1')).toBe(statusBefore);
    expect((await changedFiles(worktree.path, base)).length).toBe(5);
    expect(await gitValue(repo, 'rev-parse', 'HEAD')).toBe(base);
    expect(await gitCommand(repo, 'status', '--porcelain')).toBe('');
  });
});
