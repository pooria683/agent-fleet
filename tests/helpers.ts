import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execa } from 'execa';
import { afterEach } from 'vitest';
import { configSchema, type FleetConfig } from '../src/core/config.js';
import type { AgentResult, RunManifest } from '../src/core/types.js';
import { emptyUsage } from '../src/core/types.js';

export const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true, maxRetries: 5 })),
  );
});

export async function temporaryDirectory(): Promise<string> {
  const path = await realpath(await mkdtemp(join(tmpdir(), 'agent-fleet-test-')));
  temporaryDirectories.push(path);
  return path;
}

export async function writeFiles(root: string, files: Record<string, string>): Promise<void> {
  for (const [path, content] of Object.entries(files)) {
    const full = join(root, path);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, content);
  }
}

export async function gitCommand(repo: string, ...args: string[]): Promise<string> {
  const result = await execa('git', args, {
    cwd: repo,
    env: { GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' },
  });
  return result.stdout.trim();
}

export async function commitAll(repo: string, message = 'Fixture baseline'): Promise<string> {
  await gitCommand(repo, 'add', '-A');
  await gitCommand(repo, 'commit', '-m', message);
  return gitCommand(repo, 'rev-parse', 'HEAD');
}

export async function makeRepo(
  files: Record<string, string> = { 'README.md': '# Fixture\n' },
): Promise<string> {
  const repo = await temporaryDirectory();
  await gitCommand(repo, 'init', '-b', 'main');
  await gitCommand(repo, 'config', 'user.name', 'Fleet Tests');
  await gitCommand(repo, 'config', 'user.email', 'fleet-tests@example.invalid');
  await gitCommand(repo, 'config', 'commit.gpgsign', 'false');
  await writeFiles(repo, files);
  await commitAll(repo);
  return repo;
}

export const fixtureAgentSource = `
import { writeFileSync, mkdirSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { spawn } from 'node:child_process';
const name = process.env.AGENT_FLEET_AGENT;
const mode = process.env.MODE ?? 'success';
const event = (value) => console.log(JSON.stringify(value));
event({ type: 'message', message: 'start ' + name, progress: 10 });
if (mode === 'noop') { event({ type: 'message', message: 'done ' + name }); process.exit(0); }
if (mode === 'usage') {
  event({ type: 'usage', cost_usd: 0.02 });
  event({ type: 'usage', usage: { input_tokens: 10, output_tokens: 3 } });
}
event({ type: 'tool', action: 'write', path: name + '.txt' });
writeFileSync(name + '.txt', process.env.AGENT_FLEET_TASK);
console.error('diagnostic for ' + name);
if (mode === 'wait') await delay(700);
await delay(180);
if (mode === 'timeout') {
  spawn(process.execPath, ['-e', "process.on('SIGTERM',()=>{});setTimeout(() => require('node:fs').writeFileSync('late.txt', 'orphan'), 1600)"], { stdio: 'ignore' });
  await delay(10000);
}
if (mode === 'commit') {
  const { execFileSync } = await import('node:child_process');
  execFileSync('git', ['add', name + '.txt']);
  execFileSync('git', ['commit', '-m', 'Agent commit']);
}
if (mode === 'protocol-error') event({ type: 'error', message: 'protocol says failed' });
else event({ type: 'message', message: 'done ' + name, progress: 90 });
if (mode === 'exit-error') process.exitCode = 7;
`;

export function fixtureConfig(names: string[], overrides: Partial<FleetConfig> = {}): FleetConfig {
  return configSchema.parse({
    agents: Object.fromEntries(
      names.map((name) => [
        name,
        { type: 'command', command: process.execPath, args: ['agent.mjs', '{task}'], env: {} },
      ]),
    ),
    checks: [
      { name: 'lint', command: process.execPath, args: ['-e', 'process.exit(0)'] },
      { name: 'test', command: process.execPath, args: ['-e', 'process.exit(0)'] },
    ],
    ...overrides,
  });
}

export async function installFixture(
  repo: string,
  names: string[],
  overrides: Partial<FleetConfig> = {},
): Promise<FleetConfig> {
  const config = fixtureConfig(names, overrides);
  await writeFiles(repo, {
    'agent.mjs': fixtureAgentSource,
    'agent-fleet.config.json': `${JSON.stringify(config, null, 2)}\n`,
  });
  await commitAll(repo, 'Install command fixtures');
  return config;
}

export async function cli(repo: string, ...args: string[]) {
  return execa(
    process.execPath,
    [
      join(projectRoot, 'node_modules/tsx/dist/cli.mjs'),
      join(projectRoot, 'src/cli/index.ts'),
      ...args,
      '--repo',
      repo,
    ],
    { cwd: projectRoot, reject: false, timeout: 20_000, env: { NO_COLOR: '1' } },
  );
}

export function resultFixture(overrides: Partial<AgentResult> = {}): AgentResult {
  return {
    name: 'alpha',
    adapter: 'command',
    status: 'completed',
    branch: 'agent-fleet/alpha/task-run',
    worktree: '/tmp/repo/.agent-fleet/runs/run/worktrees/alpha',
    directory: 'agents/alpha',
    baseCommit: 'a'.repeat(40),
    headCommit: 'b'.repeat(40),
    snapshotTree: 'c'.repeat(40),
    startedAt: '2026-01-01T00:00:00.000Z',
    finishedAt: '2026-01-01T00:00:01.000Z',
    durationMs: 1000,
    agentDurationMs: 800,
    exitCode: 0,
    signal: null,
    pid: null,
    error: null,
    progress: 100,
    lastMessage: 'Done.',
    usage: emptyUsage(),
    filesChanged: 2,
    additions: 10,
    deletions: 1,
    risks: [],
    checks: [],
    score: null,
    scoreBreakdown: null,
    command: ['node', 'agent.mjs'],
    ...overrides,
  };
}

export function manifestFixture(agents: AgentResult[] = [resultFixture()]): RunManifest {
  return {
    schemaVersion: 1,
    id: '20260101-000000-abcdef12',
    task: 'Implement a feature',
    slug: 'implement-a-feature',
    repoRoot: '/tmp/repo',
    baseCommit: 'a'.repeat(40),
    sourceBranch: 'main',
    createdAt: '2026-01-01T00:00:00.000Z',
    finishedAt: '2026-01-01T00:00:02.000Z',
    status: 'completed',
    parallel: 2,
    timeoutSeconds: 30,
    checkTimeoutSeconds: 30,
    configPath: null,
    warnings: [],
    ownerPid: process.pid,
    agents,
    merge: null,
  };
}
