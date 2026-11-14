import { access, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { describe, expect, it } from 'vitest';
import { RunStore } from '../src/core/store.js';
import { executeRun, FleetRunner, prepareRun } from '../src/runner/runner.js';
import { currentBranch, gitValue, registeredWorktrees } from '../src/worktree/git.js';
import { commitAll, installFixture, makeRepo, writeFiles } from './helpers.js';

async function configureModes(repo: string, modes: Record<string, string>): Promise<void> {
  const path = join(repo, 'agent-fleet.config.json');
  const config = JSON.parse(await readFile(path, 'utf8'));
  for (const [name, mode] of Object.entries(modes)) config.agents[name].env.MODE = mode;
  await writeFile(path, JSON.stringify(config, null, 2));
  await commitAll(repo, 'Configure fixture modes');
}

describe('parallel runner integration', () => {
  it('honors concurrency, isolates branches, captures logs and checks, and leaves source HEAD untouched', async () => {
    const repo = await makeRepo();
    await installFixture(repo, ['alpha', 'beta', 'gamma']);
    const base = await gitValue(repo, 'rev-parse', 'HEAD');
    const prepared = await prepareRun({
      repo,
      task: 'Implement $(literal); `no-shell`',
      agents: ['alpha', 'beta', 'gamma'],
      parallel: 2,
    });
    const runner = new FleetRunner(prepared, new AbortController().signal);
    let maxActive = 0;
    runner.on('update', (run) => {
      maxActive = Math.max(
        maxActive,
        run.agents.filter((agent) => agent.status === 'running' || agent.status === 'checking')
          .length,
      );
    });
    const run = await runner.run();
    expect(run.status).toBe('completed');
    expect(maxActive).toBe(2);
    expect(run.agents.map((agent) => agent.status)).toEqual([
      'completed',
      'completed',
      'completed',
    ]);
    expect(new Set(run.agents.map((agent) => agent.branch)).size).toBe(3);
    expect(await registeredWorktrees(repo)).toHaveLength(4);
    for (const agent of run.agents) {
      expect(agent.exitCode).toBe(0);
      expect(agent.filesChanged).toBe(1);
      expect(agent.checks.map((check) => check.status)).toEqual(['passed', 'passed']);
      expect(agent.usage.costUsd).toBeNull();
      expect(agent.progress).toBe(100);
      expect(await readFile(join(agent.worktree, `${agent.name}.txt`), 'utf8')).toBe(run.task);
      const dir = prepared.store.agentDirectory(run.id, agent.name);
      expect(await readFile(join(dir, 'stdout.log'), 'utf8')).toContain(`start ${agent.name}`);
      expect(await readFile(join(dir, 'stderr.log'), 'utf8')).toContain('diagnostic');
      expect(JSON.parse((await readFile(join(dir, 'tools.jsonl'), 'utf8')).trim())).toMatchObject({
        action: expect.stringContaining('write'),
      });
      expect(await currentBranch(agent.worktree)).toBe(agent.branch);
    }
    expect(await gitValue(repo, 'rev-parse', 'HEAD')).toBe(base);
    expect(await gitValue(repo, 'status', '--porcelain=v1')).toBe('');
    expect(await currentBranch(repo)).toBe('main');
    expect(await readFile(join(prepared.directory, 'report.md'), 'utf8')).toContain(
      'agent-fleet comparison',
    );
    expect(await readFile(join(prepared.directory, 'events.jsonl'), 'utf8')).toContain(
      'Run completed',
    );
    await expect(access(join(repo, 'SHOULD_NOT_EXIST'))).rejects.toThrow();
  });
  it('records process and protocol failures independently and still checks partial output', async () => {
    const repo = await makeRepo();
    await installFixture(repo, ['good', 'bad', 'protocol']);
    await configureModes(repo, { bad: 'exit-error', protocol: 'protocol-error' });
    const { run } = await executeRun({
      repo,
      task: 'Try implementations',
      agents: ['good', 'bad', 'protocol'],
      parallel: 3,
    });
    expect(run.status).toBe('failed');
    expect(run.agents.map((agent) => agent.status)).toEqual(['completed', 'failed', 'failed']);
    expect(run.agents[1]?.exitCode).toBe(7);
    expect(run.agents[2]?.exitCode).toBe(0);
    expect(run.agents[2]?.error).toContain('protocol says failed');
    expect(run.agents[1]?.checks.every((check) => check.status === 'passed')).toBe(true);
    expect(run.agents[1]?.score).toBeNull();
  });
  it('times out and kills descendant processes, retaining partial output', async () => {
    const repo = await makeRepo();
    await installFixture(repo, ['slow'], {
      run: { parallel: 1, timeoutSeconds: 1, checkTimeoutSeconds: 3 },
    });
    await configureModes(repo, { slow: 'timeout' });
    const { run } = await executeRun({ repo, task: 'Timeout test', agents: ['slow'] });
    const agent = run.agents[0];
    expect(agent?.status).toBe('failed');
    expect(agent?.error).toContain('timed out');
    expect(agent?.filesChanged).toBe(1);
    await delay(1800);
    await expect(access(join(agent?.worktree ?? '', 'late.txt'))).rejects.toThrow();
  }, 12_000);
  it('cancels active and queued work without launching the queued agent', async () => {
    const repo = await makeRepo();
    await installFixture(repo, ['first', 'second']);
    const prepared = await prepareRun({
      repo,
      task: 'Cancel test',
      agents: ['first', 'second'],
      parallel: 1,
    });
    const controller = new AbortController();
    const runner = new FleetRunner(prepared, controller.signal);
    runner.on('event', (event) => {
      if (event.message === 'start first') controller.abort();
    });
    const run = await runner.run();
    expect(run.status).toBe('cancelled');
    expect(run.agents.map((agent) => agent.status)).toEqual(['cancelled', 'cancelled']);
    expect(run.agents[1]?.startedAt).toBeNull();
    await expect(access(run.agents[1]?.worktree ?? '')).rejects.toThrow();
    expect(await gitValue(repo, 'status', '--porcelain')).toBe('');
  });
  it('includes agent-created commits in the final diff', async () => {
    const repo = await makeRepo();
    await installFixture(repo, ['committed']);
    await configureModes(repo, { committed: 'commit' });
    const { run } = await executeRun({ repo, task: 'Commit test', agents: ['committed'] });
    expect(run.agents[0]?.status).toBe('completed');
    expect(run.agents[0]?.filesChanged).toBe(1);
    expect(run.agents[0]?.headCommit).not.toBe(run.baseCommit);
    expect(await gitValue(run.agents[0]?.worktree ?? '', 'status', '--porcelain')).toBe('');
  });
  it('preserves reported cost across later token-only updates', async () => {
    const repo = await makeRepo();
    await installFixture(repo, ['alpha']);
    await configureModes(repo, { alpha: 'usage' });
    const { run } = await executeRun({ repo, task: 'Usage test', agents: ['alpha'] });
    expect(run.agents[0]?.usage).toMatchObject({ costUsd: 0.02, inputTokens: 10, outputTokens: 3 });
  });
  it('keeps a no-op candidate unranked with empty tool artifacts', async () => {
    const repo = await makeRepo();
    await installFixture(repo, ['alpha']);
    await configureModes(repo, { alpha: 'noop' });
    const { run, reportPath } = await executeRun({ repo, task: 'No op', agents: ['alpha'] });
    expect(run.agents[0]?.status).toBe('completed');
    expect(run.agents[0]?.filesChanged).toBe(0);
    expect(run.agents[0]?.score).toBeNull();
    const toolPath = join(reportPath, '..', 'agents', 'alpha', 'tools.jsonl');
    expect(await readFile(toolPath, 'utf8')).toBe('');
  });
  it('does not turn missing checks into passing checks', async () => {
    const repo = await makeRepo();
    await installFixture(repo, ['alpha'], { checks: 'none' });
    const { run } = await executeRun({ repo, task: 'No checks', agents: ['alpha'] });
    expect(run.agents[0]?.status).toBe('completed');
    expect(run.agents[0]?.checks).toEqual([]);
    expect(run.agents[0]?.score).toBe(35);
    expect(run.warnings.join(' ')).toContain('disabled');
  });
  it('fails setup explicitly and skips dependent checks', async () => {
    const repo = await makeRepo();
    await installFixture(repo, ['alpha'], {
      setup: [{ command: process.execPath, args: ['-e', 'process.exit(3)'], env: {} }],
    });
    const { run } = await executeRun({ repo, task: 'Setup failure', agents: ['alpha'] });
    expect(run.agents[0]?.status).toBe('failed');
    expect(run.agents[0]?.checks.map((check) => check.status)).toEqual([
      'failed',
      'skipped',
      'skipped',
    ]);
    expect(run.agents[0]?.error).toContain('setup failed');
  });
  it('rejects dirty source by default and clearly excludes dirty changes with opt-in', async () => {
    const repo = await makeRepo();
    await installFixture(repo, ['alpha']);
    await writeFiles(repo, { 'uncommitted.txt': 'not part of HEAD' });
    await expect(prepareRun({ repo, task: 'Dirty', agents: ['alpha'] })).rejects.toThrow(
      '--allow-dirty',
    );
    const { run } = await executeRun({ repo, task: 'Dirty', agents: ['alpha'], allowDirty: true });
    expect(run.warnings.join(' ')).toContain('NOT included');
    await expect(access(join(run.agents[0]?.worktree ?? '', 'uncommitted.txt'))).rejects.toThrow();
    expect(await readFile(join(repo, 'uncommitted.txt'), 'utf8')).toBe('not part of HEAD');
  });
  it('recovers a dead supervisor as interrupted, never as completed', async () => {
    const repo = await makeRepo();
    await installFixture(repo, ['alpha', 'queued']);
    const prepared = await prepareRun({ repo, task: 'Crash test', agents: ['alpha', 'queued'] });
    const { execa } = await import('execa');
    const dead = execa(process.execPath, ['-e', '']);
    const pid = dead.pid;
    await dead;
    prepared.manifest.ownerPid = pid ?? 2_147_483_647;
    const first = prepared.manifest.agents[0];
    if (!first) throw new Error('Missing fixture agent');
    first.status = 'running';
    await prepared.store.save(prepared.manifest);
    const store = new RunStore(repo);
    const { recoverInterrupted } = await import('../src/runner/recovery.js');
    const recovered = await recoverInterrupted(await store.load(prepared.manifest.id), store);
    expect(recovered.status).toBe('interrupted');
    expect(recovered.agents.every((agent) => agent.status === 'failed')).toBe(true);
    expect(await readFile(join(prepared.directory, 'report.md'), 'utf8')).toContain('interrupted');
  });
});
