import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execa } from 'execa';
import { describe, expect, it } from 'vitest';
import { cli, installFixture, makeRepo, projectRoot } from './helpers.js';

describe('CLI public contract', () => {
  it('exposes help, version and useful validation errors', async () => {
    const repo = await makeRepo();
    const help = await execa(process.execPath, [
      join(projectRoot, 'node_modules/tsx/dist/cli.mjs'),
      join(projectRoot, 'src/cli/index.ts'),
      '--help',
    ]);
    expect(help.stdout).toContain('agent-fleet');
    expect(help.stdout).toContain('merge');
    const version = await execa(process.execPath, [
      join(projectRoot, 'node_modules/tsx/dist/cli.mjs'),
      join(projectRoot, 'src/cli/index.ts'),
      '--version',
    ]);
    expect(version.stdout).toBe('0.1.0');
    const invalid = await cli(
      repo,
      'run',
      '--task',
      'Task',
      '--agents',
      'alpha',
      '--parallel',
      '0',
    );
    expect(invalid.exitCode).not.toBe(0);
    expect(invalid.stderr).toContain('positive integer');
  });
  it('dry-run has no filesystem or Git side effects', async () => {
    const repo = await makeRepo();
    await installFixture(repo, ['alpha']);
    const result = await cli(repo, 'run', '--task', 'Plan only', '--agents', 'alpha', '--dry-run');
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('no agents, checks, worktrees');
    expect(result.stdout).toContain('agent.mjs');
    await expect(access(join(repo, '.agent-fleet'))).rejects.toThrow();
  });
  it('runs, reports, streams logs/diff and explicitly merges from the command line', async () => {
    const repo = await makeRepo();
    await installFixture(repo, ['alpha', 'beta']);
    const result = await cli(
      repo,
      'run',
      '--task',
      'Implement password reset flow',
      '--agents',
      'alpha,beta',
      '--parallel',
      '2',
      '--no-tui',
      '--json',
    );
    expect(result.stderr).not.toContain('FleetError');
    expect(result.exitCode).toBe(0);
    const run = JSON.parse(result.stdout);
    expect(run.status).toBe('completed');
    const diff = await cli(repo, 'diff', run.id, 'alpha');
    expect(diff.exitCode).toBe(0);
    expect(diff.stdout).toContain('+Implement password reset flow');
    const logs = await cli(repo, 'logs', 'alpha', '--stream', 'stdout', '--tail', '1');
    expect(logs.exitCode).toBe(0);
    expect(logs.stdout).toContain('done alpha');
    const allLogs = await cli(repo, 'logs', run.id, 'alpha', '--stream', 'all');
    expect(allLogs.exitCode).toBe(0);
    expect(allLogs.stdout).toContain('done alpha');
    expect(allLogs.stdout).toContain('diagnostic for alpha');
    expect(allLogs.stdout).toContain('── tools ──');
    const report = await cli(repo, 'report', run.id, '--stdout');
    expect(report.stdout).toContain('# agent-fleet comparison');
    const noConfirm = await cli(repo, 'merge', run.id, 'alpha');
    expect(noConfirm.exitCode).not.toBe(0);
    expect(noConfirm.stderr).toContain('--yes');
    const preview = await cli(repo, 'merge', run.id, 'alpha', '--dry-run');
    expect(preview.exitCode).toBe(0);
    const merge = await cli(repo, 'merge', run.id, 'alpha', '--yes');
    expect(merge.exitCode).toBe(0);
    expect(await readFile(join(repo, 'alpha.txt'), 'utf8')).toBe(run.task);
    const runs = await cli(repo, 'runs', '--json');
    expect(JSON.parse(runs.stdout)[0].merge.agent).toBe('alpha');
  });
  it('init refuses to overwrite configuration unless explicitly forced', async () => {
    const repo = await makeRepo();
    expect((await cli(repo, 'init')).exitCode).toBe(0);
    const path = join(repo, 'agent-fleet.config.yaml');
    const initial = await readFile(path, 'utf8');
    expect(initial).toContain('acceptEdits');
    expect((await cli(repo, 'init')).exitCode).not.toBe(0);
    expect(await readFile(path, 'utf8')).toBe(initial);
    expect((await cli(repo, 'init', '--force')).exitCode).toBe(0);
    expect((await cli(repo, 'agents', '--json')).exitCode).toBe(0);
  });
});
