import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { RunStore } from '../src/core/store.js';
import { mergeCandidate } from '../src/runner/merge.js';
import { executeRun } from '../src/runner/runner.js';
import { currentBranch, gitValue } from '../src/worktree/git.js';
import { commitAll, gitCommand, installFixture, makeRepo } from './helpers.js';

async function completedRun() {
  const repo = await makeRepo();
  await installFixture(repo, ['alpha', 'beta']);
  const { run } = await executeRun({
    repo,
    task: 'Merge selected implementation',
    agents: ['alpha', 'beta'],
    parallel: 2,
  });
  return { repo, run, store: new RunStore(repo) };
}

describe('explicit candidate merge', () => {
  it('previews without moving refs, then merges only the chosen candidate and retains evidence', async () => {
    const { repo, run, store } = await completedRun();
    const alpha = run.agents[0];
    const beta = run.agents[1];
    if (!alpha || !beta) throw new Error('fixture missing');
    const before = await gitValue(repo, 'rev-parse', 'HEAD');
    // Staging the same evaluated content changes the real index, not the snapshot tree.
    await gitCommand(alpha.worktree, 'add', 'alpha.txt');
    const preview = await mergeCandidate({ repo, runId: run.id, agent: alpha.name, dryRun: true });
    expect(preview.dryRun).toBe(true);
    expect(await gitValue(repo, 'rev-parse', 'HEAD')).toBe(before);
    expect(await gitValue(alpha.worktree, 'rev-parse', 'HEAD')).toBe(alpha.headCommit);
    const candidateStatus = await gitValue(alpha.worktree, 'status', '--porcelain');
    const candidateIndex = await gitValue(alpha.worktree, 'diff', '--cached', '--binary');
    const merged = await mergeCandidate({ repo, runId: run.id, agent: alpha.name });
    expect(merged.targetBranch).toBe('main');
    expect(await readFile(join(repo, 'alpha.txt'), 'utf8')).toBe(run.task);
    await expect(readFile(join(repo, 'beta.txt'), 'utf8')).rejects.toThrow();
    expect(await gitValue(repo, 'status', '--porcelain')).toBe('');
    expect(await gitValue(alpha.worktree, 'status', '--porcelain')).toBe(candidateStatus);
    expect(await gitValue(alpha.worktree, 'diff', '--cached', '--binary')).toBe(candidateIndex);
    expect(await gitValue(alpha.worktree, 'rev-parse', 'HEAD')).toBe(alpha.headCommit);
    expect((await gitValue(repo, 'show', '-s', '--format=%P', 'HEAD')).split(' ')).toEqual([
      before,
      merged.candidateCommit,
    ]);
    expect((await store.load(run.id)).merge?.agent).toBe('alpha');
    expect(await readFile(join(store.runDirectory(run.id), 'report.md'), 'utf8')).toContain(
      '**Merged:**',
    );
    await expect(mergeCandidate({ repo, runId: run.id, agent: 'beta' })).rejects.toThrow(
      'already merged',
    );
  });
  it('refuses a dirty target without touching it', async () => {
    const { repo, run } = await completedRun();
    await writeFile(join(repo, 'precious.txt'), 'do not lose this');
    await expect(mergeCandidate({ repo, runId: run.id, agent: 'alpha' })).rejects.toThrow(
      'uncommitted',
    );
    expect(await readFile(join(repo, 'precious.txt'), 'utf8')).toBe('do not lose this');
    expect(await gitValue(repo, 'rev-parse', 'HEAD')).toBe(run.baseCommit);
  });
  it('refuses candidate edits made after evaluation', async () => {
    const { repo, run } = await completedRun();
    const agent = run.agents[0];
    await writeFile(join(agent?.worktree ?? '', 'alpha.txt'), 'changed after tests');
    await expect(mergeCandidate({ repo, runId: run.id, agent: 'alpha' })).rejects.toThrow(
      'changed after evaluation',
    );
    expect(await gitValue(repo, 'rev-parse', 'HEAD')).toBe(run.baseCommit);
  });
  it('detects conflicts before merge and leaves the target clean', async () => {
    const { repo, run } = await completedRun();
    await writeFile(join(repo, 'alpha.txt'), 'conflicting target implementation');
    await commitAll(repo, 'Conflicting target change');
    const target = await gitValue(repo, 'rev-parse', 'HEAD');
    await expect(
      mergeCandidate({ repo, runId: run.id, agent: 'alpha', dryRun: true }),
    ).rejects.toThrow('conflicts');
    await expect(mergeCandidate({ repo, runId: run.id, agent: 'alpha' })).rejects.toThrow(
      'conflicts',
    );
    expect(await gitValue(repo, 'rev-parse', 'HEAD')).toBe(target);
    expect(await gitValue(repo, 'status', '--porcelain')).toBe('');
    expect(await readFile(join(repo, 'alpha.txt'), 'utf8')).toBe(
      'conflicting target implementation',
    );
  });
  it.skipIf(process.platform === 'win32')(
    'rolls back the target when a repository merge hook fails',
    async () => {
      const { repo, run } = await completedRun();
      const { writeFile, chmod } = await import('node:fs/promises');
      const hook = join(
        repo,
        await gitValue(repo, 'rev-parse', '--git-path', 'hooks/pre-merge-commit'),
      );
      await writeFile(hook, '#!/bin/sh\nexit 1\n');
      await chmod(hook, 0o755);
      await expect(mergeCandidate({ repo, runId: run.id, agent: 'alpha' })).rejects.toThrow(
        'rolled back',
      );
      expect(await gitValue(repo, 'rev-parse', 'HEAD')).toBe(run.baseCommit);
      expect(await gitValue(repo, 'status', '--porcelain')).toBe('');
      await expect(readFile(join(repo, 'alpha.txt'), 'utf8')).rejects.toThrow();
      const { unlink } = await import('node:fs/promises');
      await unlink(hook);
      const retry = await mergeCandidate({ repo, runId: run.id, agent: 'alpha' });
      expect(retry.targetBranch).toBe('main');
      expect(await readFile(join(repo, 'alpha.txt'), 'utf8')).toBe(run.task);
    },
  );
  it('never switches branches to perform a merge', async () => {
    const { repo, run } = await completedRun();
    await gitCommand(repo, 'switch', '-c', 'other');
    await expect(mergeCandidate({ repo, runId: run.id, agent: 'alpha' })).rejects.toThrow(
      'Check out main',
    );
    expect(await currentBranch(repo)).toBe('other');
  });
});
