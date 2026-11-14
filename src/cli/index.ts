#!/usr/bin/env node
import { createReadStream } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { pipeline } from 'node:stream/promises';
import { Command } from 'commander';
import { createAdapter } from '../agents/adapter.js';
import {
  defaultAdapterArgs,
  defaultConfigText,
  loadConfig,
  parseAgentList,
  resolveAgent,
} from '../core/config.js';
import { errorMessage, FleetError } from '../core/errors.js';
import { newRunId, RunStore } from '../core/store.js';
import type { RunManifest } from '../core/types.js';

import { detectChecks, summarizeChecks } from '../evaluator/checks.js';
import { renderReport, writeReport } from '../evaluator/report.js';
import { mergeCandidate } from '../runner/merge.js';
import { recoverInterrupted } from '../runner/recovery.js';
import { FleetRunner, prepareRun } from '../runner/runner.js';
import { findExecutable } from '../utils/executable.js';
import {
  formatCommand,
  formatCost,
  formatDuration,
  oneLine,
  positiveInteger,
  taskSlug,
} from '../utils/format.js';
import {
  ensureLocalStorageExcluded,
  gitValue,
  repositoryRoot,
  withGitLock,
} from '../worktree/git.js';

interface RepoOptions {
  repo: string;
  config?: string;
}
interface RunCliOptions extends RepoOptions {
  task: string;
  agents: string;
  parallel?: number;
  timeout?: number;
  checkTimeout?: number;
  allowDirty?: boolean;
  tui: boolean;
  dryRun?: boolean;
  json?: boolean;
}

function printSummary(run: RunManifest): void {
  console.log(`\n${run.id} · ${run.status} · base ${run.baseCommit.slice(0, 12)}`);
  console.log(
    [
      'AGENT'.padEnd(20),
      'STATUS'.padEnd(12),
      'SCORE'.padEnd(8),
      'TIME'.padEnd(10),
      'FILES'.padEnd(7),
      'COST'.padEnd(11),
      'CHECKS',
    ].join(''),
  );
  for (const agent of [...run.agents].sort((a, b) => (b.score ?? -1) - (a.score ?? -1))) {
    console.log(
      agent.name.padEnd(20) +
        agent.status.padEnd(12) +
        String(agent.score ?? '—').padEnd(8) +
        formatDuration(agent.durationMs).padEnd(10) +
        String(agent.filesChanged).padEnd(7) +
        formatCost(agent.usage.costUsd).padEnd(11) +
        summarizeChecks(agent.checks),
    );
    if (agent.error) console.log(`  ${oneLine(agent.error, 200)}`);
  }
  console.log('Cost — = unknown, not free. Scores are heuristic; review every diff.');
}

async function selection(
  repo: string,
  first?: string,
  second?: string,
): Promise<{ run: RunManifest; agent: string; store: RunStore }> {
  if (!first) throw new FleetError('Specify an agent, optionally preceded by a run ID.');
  const store = new RunStore(await repositoryRoot(repo));
  const run = second ? await store.load(first) : await store.latest();
  await recoverInterrupted(run, store);
  if (!run.agents.some((agent) => agent.name === (second ?? first)))
    throw new FleetError(`Agent "${second ?? first}" is not part of run ${run.id}.`);
  return { run, agent: second ?? first, store };
}

async function streamArtifact(path: string): Promise<void> {
  await pipeline(createReadStream(path), process.stdout, { end: false });
}

async function confirmMerge(description: string, yes?: boolean): Promise<boolean> {
  if (yes) return true;
  if (!process.stdin.isTTY || !process.stdout.isTTY)
    throw new FleetError(
      'Non-interactive merge requires --yes after reviewing the diff and --dry-run.',
    );
  const reader = createInterface({ input: process.stdin, output: process.stdout });
  try {
    console.log(description);
    return (
      (await reader.question('Type "merge" to confirm (anything else cancels): ')).trim() ===
      'merge'
    );
  } finally {
    reader.close();
  }
}

async function runAction(options: RunCliOptions): Promise<void> {
  const names = parseAgentList(options.agents);
  const runOptions = {
    repo: options.repo,
    task: options.task,
    agents: names,
    ...(options.parallel === undefined ? {} : { parallel: options.parallel }),
    ...(options.config === undefined ? {} : { configPath: options.config }),
    ...(options.timeout === undefined ? {} : { timeoutSeconds: options.timeout }),
    ...(options.checkTimeout === undefined ? {} : { checkTimeoutSeconds: options.checkTimeout }),
    ...(options.allowDirty === undefined ? {} : { allowDirty: options.allowDirty }),
  };
  if (options.dryRun) {
    const repo = await repositoryRoot(options.repo);
    const { config } = await loadConfig(repo, options.config);
    const id = newRunId();
    const slug = taskSlug(options.task);
    const directory = join(repo, '.agent-fleet', 'runs', id);
    console.log(
      `Dry run — no agents, checks, worktrees, branches or artifacts will be created.\nRepository: ${repo}\nBase: ${await gitValue(repo, 'rev-parse', 'HEAD')}\nTask: ${options.task}\nParallel: ${options.parallel ?? config.run.parallel}`,
    );
    for (const name of names) {
      const agent = resolveAgent(config, name);
      const worktree = join(directory, 'worktrees', name);
      const command = createAdapter(agent.kind).command(agent, {
        task: options.task,
        repoRoot: repo,
        worktree,
        runDirectory: directory,
      });
      console.log(
        `\n${name} (${agent.kind})\n  Branch: agent-fleet/${name}/${slug}-${id.toLowerCase()}\n  Worktree: ${worktree}\n  Command: ${formatCommand(command)}\n  Executable: ${(await findExecutable(agent.command, repo)) ?? 'NOT FOUND on PATH'}`,
      );
    }
    for (const setup of config.setup)
      console.log(`Setup: ${formatCommand([setup.command, ...setup.args])}`);
    const checks = await detectChecks(repo, config);
    for (const check of checks.checks)
      console.log(`Check ${check.name}: ${formatCommand([check.command, ...check.args])}`);
    if (checks.reason) console.log(checks.reason);
    console.log(
      '\nCommands run with the privileges of your user account. A worktree is not a security sandbox.',
    );
    return;
  }
  const prepared = await prepareRun(runOptions);
  const controller = new AbortController();
  const stop = () => {
    controller.abort();
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  const runner = new FleetRunner(prepared, controller.signal);
  const interactive = options.tui && !options.json && process.stdin.isTTY && process.stdout.isTTY;
  console.error(`Run ${prepared.manifest.id} · artifacts: ${prepared.directory}`);
  try {
    if (interactive) {
      const { renderLiveRun } = await import('../ui/render.js');
      await renderLiveRun(runner, controller);
    } else {
      if (!options.json) {
        runner.on('event', (event) => {
          if (event.type === 'message' || event.type === 'tool')
            console.log(`[${event.agent ?? 'fleet'}] ${oneLine(event.message, 180)}`);
          else console.log(`[${event.agent ?? 'fleet'}] ${oneLine(event.message, 240)}`);
        });
        runner.on('persistenceError', (error) =>
          console.error(`Storage warning: ${error.message}`),
        );
      }
      await runner.run();
    }
  } finally {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
  }
  const run = runner.manifest;
  if (options.json) console.log(JSON.stringify(run, null, 2));
  else {
    printSummary(run);
    console.log(`\nReport: ${join(prepared.directory, 'report.md')}`);
    console.log(`Inspect: agent-fleet show ${run.id} --tui`);
    console.log(`Diff:    agent-fleet diff ${run.id} <agent>`);
  }
  if (run.status !== 'completed') process.exitCode = 1;
}

export function createProgram(version: string): Command {
  const program = new Command();
  program
    .name('agent-fleet')
    .description('Run coding agents in parallel. Compare the evidence. Merge deliberately.')
    .version(version)
    .showHelpAfterError();

  program
    .command('run')
    .description('Run a task across isolated Git worktrees')
    .requiredOption('--task <text>', 'Task passed as one argument, never interpreted by a shell')
    .requiredOption('--agents <names>', 'Comma-separated adapters, e.g. claude,codex')
    .option('--repo <path>', 'Repository or a directory inside it', '.')
    .option('--parallel <count>', 'Maximum concurrent agents', positiveInteger)
    .option('--config <path>', 'YAML/JSON configuration path')
    .option('--timeout <seconds>', 'Agent process timeout', positiveInteger)
    .option('--check-timeout <seconds>', 'Timeout per setup/lint/test command', positiveInteger)
    .option(
      '--allow-dirty',
      'Allow a dirty source checkout; only committed HEAD is included',
      false,
    )
    .option('--no-tui', 'Stream a plain-text progress summary instead of Ink')
    .option('--json', 'Print the final manifest as JSON (no TUI)', false)
    .option('--dry-run', 'Print the execution plan without side effects', false)
    .action(runAction);

  program
    .command('init')
    .description('Create a starter configuration without changing tracked files')
    .option('--repo <path>', 'Repository path', '.')
    .option('--force', 'Replace an existing starter configuration', false)
    .action(async (options: RepoOptions & { force: boolean }) => {
      const repo = await repositoryRoot(options.repo);
      const path = join(repo, 'agent-fleet.config.yaml');
      try {
        await writeFile(path, defaultConfigText, { flag: options.force ? 'w' : 'wx' });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST')
          throw new FleetError(
            `${path} already exists. Use --force only if you want to replace it.`,
          );
        throw error;
      }
      const excluded = await withGitLock(repo, () => ensureLocalStorageExcluded(repo));
      console.log(
        `Created ${path}${excluded ? '\nAdded /.agent-fleet/ to .git/info/exclude (local only).' : ''}\nCommit this new configuration before running, or use --allow-dirty (uncommitted source changes will not be included).\nNext: agent-fleet run --repo ${formatCommand([options.repo])} --task "Your task" --agents claude,codex`,
      );
    });

  program
    .command('agents')
    .description('List configured adapters and locate their executables (does not launch them)')
    .option('--repo <path>', 'Repository path', '.')
    .option('--config <path>', 'Configuration path')
    .option('--json', 'JSON output', false)
    .action(async (options: RepoOptions & { json: boolean }) => {
      const repo = await repositoryRoot(options.repo);
      const { config, path } = await loadConfig(repo, options.config);
      const names = [...new Set(['claude', 'codex', ...Object.keys(config.agents)])];
      const agents = await Promise.all(
        names.map(async (name) => {
          const agent = resolveAgent(config, name);
          return {
            ...agent,
            defaults: defaultAdapterArgs(agent.kind),
            executable: await findExecutable(agent.command, repo),
          };
        }),
      );
      if (options.json) console.log(JSON.stringify({ configPath: path, agents }, null, 2));
      else {
        console.log(`Config: ${path ?? 'built-in defaults'}\n`);
        for (const agent of agents)
          console.log(
            `${agent.name.padEnd(20)}${agent.kind.padEnd(10)}${agent.executable ?? 'NOT FOUND'}${agent.executable ? '' : ` (install ${agent.command} or configure its path)`}`,
          );
        console.log(
          '\nAuthentication is managed by each CLI. agent-fleet never requests or stores API keys.',
        );
      }
    });

  program
    .command('runs')
    .description('List local runs; mark dead supervisors as interrupted')
    .option('--repo <path>', 'Repository path', '.')
    .option('--json', 'JSON output', false)
    .action(async (options: RepoOptions & { json: boolean }) => {
      const store = new RunStore(await repositoryRoot(options.repo));
      const runs = await store.list();
      for (const run of runs) await recoverInterrupted(run, store);
      if (options.json) console.log(JSON.stringify(runs, null, 2));
      else if (!runs.length)
        console.log('No runs yet. Try agent-fleet run --help or npm run demo.');
      else
        for (const run of runs)
          console.log(
            `${run.id}  ${run.status.padEnd(12)}${String(run.agents.length).padStart(2)} agents  ${oneLine(run.task, 70)}`,
          );
    });

  program
    .command('show')
    .argument('[runId]', 'Run ID; defaults to latest')
    .description('Inspect a finished or in-progress run')
    .option('--repo <path>', 'Repository path', '.')
    .option('--tui', 'Open the interactive read-only dashboard', false)
    .action(async (runId: string | undefined, options: RepoOptions & { tui: boolean }) => {
      const store = new RunStore(await repositoryRoot(options.repo));
      const run = await recoverInterrupted(await store.resolveId(runId), store);
      if (options.tui && process.stdin.isTTY && process.stdout.isTTY) {
        const { renderHistoricalRun } = await import('../ui/history.js');
        await renderHistoricalRun(run, store);
      } else if (options.tui)
        throw new FleetError(
          '--tui requires an interactive terminal. Use report or show without --tui.',
        );
      else printSummary(run);
    });

  program
    .command('report')
    .argument('[runId]', 'Run ID; defaults to latest')
    .description('Write/refresh the Markdown comparison report')
    .option('--repo <path>', 'Repository path', '.')
    .option('--stdout', 'Print Markdown instead of the report path', false)
    .action(async (runId: string | undefined, options: RepoOptions & { stdout: boolean }) => {
      const store = new RunStore(await repositoryRoot(options.repo));
      const run = await recoverInterrupted(await store.resolveId(runId), store);
      const path = await writeReport(run, store.runDirectory(run.id));
      console.log(options.stdout ? renderReport(run) : path);
    });

  program
    .command('diff')
    .argument('[runIdOrAgent]', 'Run ID, or agent name for latest run')
    .argument('[agent]', 'Agent name')
    .description('Stream the complete captured diff, including untracked files')
    .option('--repo <path>', 'Repository path', '.')
    .action(async (first: string | undefined, second: string | undefined, options: RepoOptions) => {
      const { run, agent, store } = await selection(options.repo, first, second);
      const candidate = run.agents.find((entry) => entry.name === agent);
      if (!candidate?.snapshotTree)
        throw new FleetError('No final diff snapshot is available for this agent.');
      await streamArtifact(join(store.agentDirectory(run.id, agent), 'changes.diff'));
    });

  program
    .command('logs')
    .argument('[runIdOrAgent]', 'Run ID, or agent name for latest run')
    .argument('[agent]', 'Agent name')
    .description('Stream complete raw logs')
    .option('--repo <path>', 'Repository path', '.')
    .option('--stream <stream>', 'stdout, stderr, tools, events or all', 'all')
    .option('--tail <lines>', 'Show only the last N lines of each selected log', positiveInteger)
    .action(
      async (
        first: string | undefined,
        second: string | undefined,
        options: RepoOptions & { stream: string; tail?: number },
      ) => {
        const { run, agent, store } = await selection(options.repo, first, second);
        const streams = options.stream === 'all' ? ['stdout', 'stderr', 'tools'] : [options.stream];
        if (streams.some((stream) => !['stdout', 'stderr', 'tools', 'events'].includes(stream)))
          throw new FleetError('--stream must be stdout, stderr, tools, events or all.');
        for (const stream of streams) {
          const path =
            stream === 'events'
              ? join(store.runDirectory(run.id), 'events.jsonl')
              : join(
                  store.agentDirectory(run.id, agent),
                  stream === 'tools' ? 'tools.jsonl' : `${stream}.log`,
                );
          console.log(`\n── ${stream} ──`);
          if (options.tail !== undefined) {
            const ring: string[] = [];
            const reader = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
            for await (const line of reader) {
              ring.push(line);
              if (ring.length > options.tail) ring.shift();
            }
            console.log(ring.join('\n'));
          } else await streamArtifact(path);
        }
      },
    );

  program
    .command('merge')
    .argument('<runId>')
    .argument('<agent>')
    .description('Explicitly merge one reviewed candidate; never pushes')
    .option('--repo <path>', 'Repository path', '.')
    .option('--into <branch>', 'Target branch; defaults to the branch recorded at run start')
    .option('--dry-run', 'Check mergeability without changing refs or working files', false)
    .option('--yes', 'Confirm a non-interactive merge after manual review', false)
    .action(
      async (
        runId: string,
        agent: string,
        options: RepoOptions & { into?: string; dryRun: boolean; yes: boolean },
      ) => {
        const repo = await repositoryRoot(options.repo);
        const run = await new RunStore(repo).load(runId);
        const candidate = run.agents.find((entry) => entry.name === agent);
        if (!candidate) throw new FleetError(`Agent ${agent} is not part of this run.`);
        const target = options.into ?? run.sourceBranch ?? '(detached: --into required)';
        if (!options.dryRun) {
          const description = `${agent} → ${target}\nBranch: ${candidate.branch}\nChecks: ${summarizeChecks(candidate.checks)}\nRisk flags: ${candidate.risks.length}\nReview the full diff first: agent-fleet diff ${run.id} ${agent}`;
          if (!(await confirmMerge(description, options.yes))) {
            console.log('Merge cancelled.');
            return;
          }
        }
        const result = await mergeCandidate({
          repo,
          runId,
          agent,
          into: options.into,
          dryRun: options.dryRun,
        });
        console.log(result.message);
      },
    );

  return program;
}

async function main(): Promise<void> {
  const packageJson = JSON.parse(
    await readFile(new URL('../../package.json', import.meta.url), 'utf8'),
  ) as { version: string };
  await createProgram(packageJson.version).parseAsync(process.argv);
}

main().catch((error: unknown) => {
  console.error(`agent-fleet: ${errorMessage(error)}`);
  process.exitCode = 1;
});
