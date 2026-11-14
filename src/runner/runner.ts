import { EventEmitter } from 'node:events';
import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import { createAdapter } from '../agents/adapter.js';
import { type FleetConfig, loadConfig, resolveAgent } from '../core/config.js';
import { errorMessage, FleetError } from '../core/errors.js';
import { newRunId, RunStore } from '../core/store.js';
import { type AgentResult, emptyUsage, type RunEvent, type RunManifest } from '../core/types.js';
import { detectChecks, executeCheck, skippedChecks } from '../evaluator/checks.js';
import { writeReport } from '../evaluator/report.js';
import { rankAgents } from '../evaluator/score.js';
import { oneLine, taskSlug } from '../utils/format.js';
import { writePrivate } from '../utils/fs.js';
import { LogWriter } from '../utils/logs.js';
import { runProcess } from '../utils/process.js';
import {
  assertClean,
  assertNoGitOperation,
  cleanGitEnvironment,
  currentBranch,
  ensureLocalStorageExcluded,
  gitValue,
  repositoryRoot,
  withGitLock,
} from '../worktree/git.js';
import { changedFiles, createWorktree, snapshotWorktree } from '../worktree/manager.js';

export interface RunOptions {
  repo: string;
  task: string;
  agents: string[];
  parallel?: number;
  configPath?: string;
  timeoutSeconds?: number;
  checkTimeoutSeconds?: number;
  allowDirty?: boolean;
}
export interface PreparedRun {
  manifest: RunManifest;
  config: FleetConfig;
  store: RunStore;
  directory: string;
}
interface RunnerEvents {
  update: [RunManifest];
  event: [RunEvent];
  persistenceError: [Error];
}

export async function prepareRun(options: RunOptions): Promise<PreparedRun> {
  if (!options.task.trim()) throw new FleetError('The task must not be empty.');
  if (options.task.length > 100_000)
    throw new FleetError('The task is too long (maximum 100,000 characters).');
  if (!options.agents.length) throw new FleetError('Select at least one agent.');
  if (options.agents.length > 64) throw new FleetError('A run supports at most 64 agents.');
  if (new Set(options.agents).size !== options.agents.length)
    throw new FleetError('Each agent may appear only once per run.');
  const repoRoot = await repositoryRoot(options.repo);
  const loaded = await loadConfig(repoRoot, options.configPath);
  const specs = options.agents.map((name) => resolveAgent(loaded.config, name));
  const parallel = options.parallel ?? loaded.config.run.parallel;
  const timeoutSeconds = options.timeoutSeconds ?? loaded.config.run.timeoutSeconds;
  const checkTimeoutSeconds = options.checkTimeoutSeconds ?? loaded.config.run.checkTimeoutSeconds;
  for (const [name, value] of Object.entries({ parallel, timeoutSeconds, checkTimeoutSeconds })) {
    if (!Number.isInteger(value) || value < 1 || value > (name === 'parallel' ? 64 : 86_400))
      throw new FleetError(`Invalid ${name}: ${value}.`);
  }
  await assertNoGitOperation(repoRoot);
  const dirtyWarning =
    'The source checkout is dirty. The run uses HEAD only; uncommitted and untracked source changes are NOT included.';
  if (!options.allowDirty) await assertClean(repoRoot);
  const baseCommit = await gitValue(repoRoot, 'rev-parse', '--verify', 'HEAD^{commit}');
  const sourceBranch = await currentBranch(repoRoot);
  const store = new RunStore(repoRoot);
  const id = newRunId();
  const slug = taskSlug(options.task);
  const warnings: string[] = [];
  if (!sourceBranch)
    warnings.push(
      'The source checkout is detached. An explicit --into branch is required for merging.',
    );
  const manifest: RunManifest = {
    schemaVersion: 1,
    id,
    task: options.task,
    slug,
    repoRoot,
    baseCommit,
    sourceBranch,
    createdAt: new Date().toISOString(),
    finishedAt: null,
    status: 'running',
    parallel,
    timeoutSeconds,
    checkTimeoutSeconds,
    configPath: loaded.path,
    warnings,
    ownerPid: process.pid,
    merge: null,
    agents: specs.map(
      (spec): AgentResult => ({
        name: spec.name,
        adapter: spec.kind,
        status: 'queued',
        branch: `agent-fleet/${spec.name}/${slug}-${id.toLowerCase()}`,
        worktree: join(store.runDirectory(id), 'worktrees', spec.name),
        directory: `agents/${spec.name}`,
        baseCommit,
        headCommit: null,
        snapshotTree: null,
        startedAt: null,
        finishedAt: null,
        durationMs: 0,
        agentDurationMs: 0,
        exitCode: null,
        signal: null,
        pid: null,
        error: null,
        progress: 0,
        lastMessage: 'Waiting for a concurrency slot.',
        usage: emptyUsage(),
        filesChanged: 0,
        additions: 0,
        deletions: 0,
        risks: [],
        checks: [],
        score: null,
        scoreBreakdown: null,
        command: [],
      }),
    ),
  };
  await withGitLock(repoRoot, async () => {
    const excluded = await ensureLocalStorageExcluded(repoRoot);
    if (excluded)
      warnings.push(
        'Added /.agent-fleet/ to the repository-local .git/info/exclude; no tracked files were changed.',
      );
    if (options.allowDirty && !(await isCleanSafe(repoRoot))) warnings.push(dirtyWarning);
  });
  const directory = await store.create(manifest);
  return { manifest, config: loaded.config, store, directory };
}

async function isCleanSafe(repo: string): Promise<boolean> {
  return (await gitValue(repo, 'status', '--porcelain=v1', '--untracked-files=all')) === '';
}

export class FleetRunner extends EventEmitter<RunnerEvents> {
  private nextAgent = 0;
  private saves: Promise<void> = Promise.resolve();
  private events: Promise<void> = Promise.resolve();
  private saveError: Error | null = null;
  private eventError: Error | null = null;
  private lastSaved = 0;

  private heartbeat: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly prepared: PreparedRun,
    readonly signal: AbortSignal,
  ) {
    super();
  }

  get manifest(): RunManifest {
    return this.prepared.manifest;
  }

  private publish(
    agent: AgentResult | null,
    type: RunEvent['type'],
    message: string,
    important = false,
  ): void {
    const event: RunEvent = {
      timestamp: new Date().toISOString(),
      runId: this.manifest.id,
      agent: agent?.name ?? null,
      type,
      message,
    };
    this.emit('event', event);
    this.events = this.events
      .then(() => this.prepared.store.appendEvent(event))
      .catch((error: unknown) => {
        this.eventError ??= new Error(errorMessage(error));
      });
    this.emit('update', structuredClone(this.manifest));
    if (important || Date.now() - this.lastSaved > 1_000) this.save();
  }

  private save(): void {
    const snapshot = structuredClone(this.manifest);
    this.lastSaved = Date.now();
    this.saves = this.saves
      .then(() => this.prepared.store.save(snapshot))
      .catch((error: unknown) => {
        this.saveError ??= new Error(errorMessage(error));
        this.emit('persistenceError', this.saveError);
      });
  }

  private async flush(): Promise<void> {
    this.save();
    await Promise.all([this.saves, this.events]);
    if (this.saveError)
      throw new FleetError(`Could not persist run state: ${this.saveError.message}`);
    if (this.eventError)
      throw new FleetError(`Could not persist run events: ${this.eventError.message}`);
  }

  async run(): Promise<RunManifest> {
    if (this.manifest.status !== 'running')
      throw new FleetError('This runner has already been started.');
    this.publish(null, 'run', `Run started: ${this.manifest.task}`, true);
    this.heartbeat = setInterval(() => {
      for (const agent of this.manifest.agents) {
        if (agent.startedAt && (agent.status === 'running' || agent.status === 'checking'))
          agent.durationMs = Date.now() - Date.parse(agent.startedAt);
      }
      this.emit('update', structuredClone(this.manifest));
      this.save();
    }, 2_000);
    this.heartbeat.unref();
    try {
      await Promise.all(
        Array.from({ length: Math.min(this.manifest.parallel, this.manifest.agents.length) }, () =>
          this.worker(),
        ),
      );
    } finally {
      if (this.heartbeat) clearInterval(this.heartbeat);
      for (const agent of this.manifest.agents) {
        if (agent.status === 'queued') {
          agent.status = 'cancelled';
          agent.error = 'Run stopped before this agent started.';
          agent.finishedAt = new Date().toISOString();
        }
      }
      this.manifest.status = this.signal.aborted
        ? 'cancelled'
        : this.manifest.agents.some(
              (agent) => agent.status === 'failed' || agent.status === 'cancelled',
            )
          ? 'failed'
          : 'completed';
      this.manifest.finishedAt = new Date().toISOString();
      rankAgents(this.manifest.agents);
      this.publish(null, 'run', `Run ${this.manifest.status}.`, true);
      await this.flush();
      await writeReport(this.manifest, this.prepared.directory);
    }
    return this.manifest;
  }

  private async worker(): Promise<void> {
    while (this.nextAgent < this.manifest.agents.length) {
      const agent = this.manifest.agents[this.nextAgent++];
      if (!agent) break;
      if (this.signal.aborted) {
        agent.status = 'cancelled';
        agent.error = 'Run cancelled before execution.';
        agent.finishedAt = new Date().toISOString();
        this.publish(agent, 'status', agent.error, true);
        continue;
      }
      agent.startedAt = new Date().toISOString();
      try {
        await this.runAgent(agent);
      } catch (error) {
        agent.status = this.signal.aborted ? 'cancelled' : 'failed';
        agent.error = errorMessage(error);
        agent.lastMessage = agent.error;
      } finally {
        agent.pid = null;
        agent.finishedAt = new Date().toISOString();
        agent.durationMs = Date.now() - Date.parse(agent.startedAt);
        if (agent.status === 'running' || agent.status === 'checking')
          agent.status = this.signal.aborted ? 'cancelled' : 'completed';
        if (agent.status === 'completed') agent.progress = 100;
        this.publish(
          agent,
          'status',
          `${agent.name}: ${agent.status}${agent.error ? ` — ${agent.error}` : ''}`,
          true,
        );
      }
    }
  }

  private async runAgent(agent: AgentResult): Promise<void> {
    const { manifest, config, store, directory } = this.prepared;
    const spec = resolveAgent(config, agent.name);
    agent.lastMessage = 'Creating an isolated Git worktree.';
    this.publish(agent, 'status', agent.lastMessage, true);
    const worktree = await withGitLock(manifest.repoRoot, () =>
      createWorktree(
        manifest.repoRoot,
        directory,
        manifest.id,
        agent.name,
        manifest.slug,
        manifest.baseCommit,
      ),
    );
    agent.worktree = worktree.path;
    agent.branch = worktree.branch;
    agent.headCommit = await gitValue(worktree.path, 'rev-parse', 'HEAD');
    const agentDir = store.agentDirectory(manifest.id, agent.name);
    await mkdir(agentDir, { recursive: true, mode: 0o700 });
    const adapter = createAdapter(spec.kind);
    const context = {
      task: manifest.task,
      repoRoot: manifest.repoRoot,
      worktree: worktree.path,
      runDirectory: directory,
    };
    const command = adapter.command(spec, context);
    agent.command = command;
    if (this.signal.aborted) {
      agent.status = 'cancelled';
      agent.error = 'Cancelled after worktree creation; agent was not launched.';
      return;
    }
    const stdout = new LogWriter(join(agentDir, 'stdout.log'));
    const stderr = new LogWriter(join(agentDir, 'stderr.log'));

    await writePrivate(join(agentDir, 'tools.jsonl'), '');
    const env = cleanGitEnvironment({
      ...spec.env,
      AGENT_FLEET_TASK: manifest.task,
      AGENT_FLEET_AGENT: agent.name,
      AGENT_FLEET_REPO: manifest.repoRoot,
      AGENT_FLEET_WORKTREE: worktree.path,
      AGENT_FLEET_RUN_DIR: directory,
    });
    let toolWrites: Promise<void> = Promise.resolve();
    let toolError: string | null = null;
    let adapterError: string | null = null;
    let observations = 0;
    agent.status = 'running';
    agent.progress = 5;
    agent.lastMessage = 'Agent process started.';
    this.publish(agent, 'status', agent.lastMessage, true);
    let polling: Promise<void> | null = null;
    const poll = () => {
      if (polling) return;
      polling = changedFiles(worktree.path, manifest.baseCommit)
        .then((files) => {
          agent.filesChanged = files.length;
        })
        .catch(() => {
          /* The final snapshot reports Git errors; live telemetry is best effort. */
        })
        .finally(() => {
          polling = null;
        });
    };
    const interval = setInterval(poll, 2_000);
    interval.unref();
    try {
      const result = await runProcess(command[0] ?? spec.command, command.slice(1), {
        cwd: worktree.path,
        timeoutMs: manifest.timeoutSeconds * 1_000,
        signal: this.signal,
        env,
        onSpawn: (pid) => {
          agent.pid = pid;
          this.save();
        },
        onStdout: (chunk) => stdout.write(chunk),
        onStderr: (chunk) => stderr.write(chunk),
        onLine: (line, stream) => {
          try {
            const update = adapter.observe(line, stream);
            if (update.message) {
              observations++;
              agent.lastMessage = oneLine(update.message, 500);
              agent.progress = Math.max(
                agent.progress,
                update.progress ?? Math.min(85, 10 + Math.sqrt(observations) * 7),
              );
              this.publish(agent, 'message', update.message);
            }
            if (update.tool) {
              const toolLine = `${JSON.stringify({ timestamp: new Date().toISOString(), action: update.tool })}\n`;
              toolWrites = toolWrites
                .then(async () => {
                  await appendFile(join(agentDir, 'tools.jsonl'), toolLine, { mode: 0o600 });
                })
                .catch((error: unknown) => {
                  toolError ??= errorMessage(error);
                });
              agent.lastMessage = oneLine(update.tool, 500);
              this.publish(agent, 'tool', update.tool);
            }
            if (update.usage) {
              // Later token-only events must not erase an already reported cost.
              agent.usage = {
                inputTokens: update.usage.inputTokens ?? agent.usage.inputTokens,
                outputTokens: update.usage.outputTokens ?? agent.usage.outputTokens,
                cachedInputTokens: update.usage.cachedInputTokens ?? agent.usage.cachedInputTokens,
                costUsd: update.usage.costUsd ?? agent.usage.costUsd,
                source: update.usage.source,
              };
              this.publish(
                agent,
                'usage',
                `Reported cost: ${agent.usage.costUsd ?? 'unknown'}`,
                true,
              );
            }
            if (update.failed) adapterError = update.failed;
          } catch (error) {
            adapterError ??= errorMessage(error);
          }
        },
      });
      agent.agentDurationMs = result.durationMs;
      agent.durationMs = Date.now() - Date.parse(agent.startedAt ?? new Date().toISOString());
      agent.exitCode = result.exitCode;
      agent.signal = result.signal;
      if (result.timedOut) {
        agent.status = 'failed';
        agent.error = `Agent timed out after ${manifest.timeoutSeconds}s; partial output retained.`;
      } else if (result.cancelled || this.signal.aborted) {
        agent.status = 'cancelled';
        agent.error = 'Run cancelled.';
      } else if (result.exitCode !== 0 || result.error) {
        agent.status = 'failed';
        agent.error = result.error ?? `Agent exited with code ${result.exitCode}.`;
      } else if (adapterError) {
        agent.status = 'failed';
        agent.error = adapterError;
      }
    } finally {
      clearInterval(interval);
      if (polling) await polling;
      const errors = await Promise.all([stdout.close(), stderr.close()]);
      await toolWrites;
      const logError = errors.filter(Boolean).join('; ') || toolError;
      if (logError && agent.status !== 'cancelled') {
        agent.status = 'failed';
        agent.error = `Log persistence failed: ${logError}`;
      }
    }
    agent.headCommit = await gitValue(worktree.path, 'rev-parse', 'HEAD');
    if ((await currentBranch(worktree.path)) !== agent.branch) {
      agent.status = 'failed';
      agent.error =
        'Agent switched away from its assigned branch; candidate is not eligible for automatic merge.';
    }
    try {
      const snapshot = await snapshotWorktree(worktree.path, manifest.baseCommit, agentDir);
      agent.snapshotTree = snapshot.tree;
      agent.filesChanged = snapshot.files.length;
      agent.additions = snapshot.additions;
      agent.deletions = snapshot.deletions;
      agent.risks = snapshot.risks;
    } catch (error) {
      if (agent.status !== 'cancelled') agent.status = 'failed';
      agent.error = `${agent.error ? `${agent.error} ` : ''}Snapshot failed: ${errorMessage(error)}`;
    }
    this.publish(agent, 'status', `Captured ${agent.filesChanged} changed files.`, true);
    const detected = await detectChecks(worktree.path, config);
    if (detected.reason) {
      manifest.warnings.push(`${agent.name}: ${detected.reason}`);
      agent.checks = skippedChecks(detected.checks, detected.reason);
    }
    if (agent.status === 'cancelled' || this.signal.aborted) {
      agent.status = 'cancelled';
      agent.checks = skippedChecks(
        detected.checks,
        'Agent did not finish successfully; cancelled.',
      );
      return;
    }
    const executionFailed = agent.status === 'failed';
    agent.status = 'checking';
    agent.progress = Math.max(agent.progress, 90);
    agent.lastMessage = detected.checks.length
      ? 'Running project checks.'
      : 'No checks configured.';
    this.publish(agent, 'check', agent.lastMessage, true);
    const checks = [
      ...config.setup.map((specification, index) => ({
        ...specification,
        name: `setup-${index + 1}`,
      })),
      ...detected.checks,
    ];
    let failedSetup = false;
    for (const check of checks) {
      if (failedSetup || this.signal.aborted) {
        agent.checks.push(
          ...skippedChecks(
            [check],
            failedSetup ? 'A preceding setup command failed.' : 'Run cancelled.',
          ),
        );
        continue;
      }
      agent.lastMessage = `Running ${check.name}.`;
      this.publish(agent, 'check', agent.lastMessage, true);
      const logFile = `check-${check.name}.log`;
      const result = await executeCheck(
        check,
        check.name,
        worktree.path,
        join(agentDir, logFile),
        logFile,
        manifest.checkTimeoutSeconds,
        this.signal,
        env,
      );
      agent.checks.push(result);
      agent.progress = Math.min(99, 90 + (agent.checks.length / Math.max(checks.length, 1)) * 9);
      this.publish(agent, 'check', `${check.name}: ${result.status}`, true);
      if (check.name.startsWith('setup-') && result.status !== 'passed') failedSetup = true;
      if (result.status === 'cancelled') {
        agent.status = 'cancelled';
        agent.error = result.reason;
      }
    }
    if (failedSetup && agent.status !== 'cancelled') {
      agent.status = 'failed';
      agent.error = 'Worktree setup failed; project checks were skipped.';
    }
    if (agent.status === 'checking') agent.status = executionFailed ? 'failed' : 'completed';
    agent.lastMessage =
      agent.error ??
      (agent.filesChanged === 0
        ? 'Finished without file changes.'
        : `Finished with ${agent.filesChanged} changed files.`);
  }
}

export async function executeRun(
  options: RunOptions,
  signal = new AbortController().signal,
): Promise<{ run: RunManifest; reportPath: string }> {
  const prepared = await prepareRun(options);
  const runner = new FleetRunner(prepared, signal);
  const run = await runner.run();
  return { run, reportPath: join(prepared.directory, 'report.md') };
}
