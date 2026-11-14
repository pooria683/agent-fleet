import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { CheckSpec, CommandSpec, FleetConfig } from '../core/config.js';
import type { CheckResult } from '../core/types.js';
import { formatCommand } from '../utils/format.js';
import { LogWriter } from '../utils/logs.js';
import { runProcess } from '../utils/process.js';

export async function detectChecks(
  worktree: string,
  config: FleetConfig,
): Promise<{ checks: CheckSpec[]; reason: string | null }> {
  if (config.checks === 'none') return { checks: [], reason: 'Checks disabled in configuration.' };
  if (Array.isArray(config.checks)) return { checks: config.checks, reason: null };
  let scripts: Record<string, unknown>;
  let packageManager = 'npm';
  try {
    const pkg: unknown = JSON.parse(await readFile(join(worktree, 'package.json'), 'utf8'));
    if (typeof pkg !== 'object' || pkg === null)
      return {
        checks: [],
        reason: 'No supported test/lint configuration; configure checks explicitly.',
      };
    scripts =
      'scripts' in pkg && typeof pkg.scripts === 'object' && pkg.scripts !== null
        ? (pkg.scripts as Record<string, unknown>)
        : {};
    if ('packageManager' in pkg && typeof pkg.packageManager === 'string') {
      const manager = pkg.packageManager.split('@')[0];
      if (['npm', 'pnpm', 'yarn', 'bun'].includes(manager ?? '')) packageManager = manager ?? 'npm';
    }
    if (packageManager === 'npm') {
      for (const [lock, manager] of [
        ['pnpm-lock.yaml', 'pnpm'],
        ['yarn.lock', 'yarn'],
        ['bun.lock', 'bun'],
        ['bun.lockb', 'bun'],
      ] as const) {
        try {
          await access(join(worktree, lock));
          packageManager = manager;
          break;
        } catch {
          /* Try the next lockfile. */
        }
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' || error instanceof SyntaxError) {
      return {
        checks: [],
        reason: 'No readable package.json; configure checks explicitly for this stack.',
      };
    }
    throw error;
  }
  const checks: CheckSpec[] = [];
  for (const name of ['lint', 'test']) {
    if (typeof scripts[name] === 'string')
      checks.push({ name, command: packageManager, args: ['run', name], env: {} });
  }
  return {
    checks,
    reason: checks.length === 0 ? 'No lint/test scripts found; configure checks explicitly.' : null,
  };
}

/** Recognize explicit summary counts only; do not count arbitrary diagnostic lines. */
export function parseLintErrorCount(line: string): number | null {
  const clean = line.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
  const match = clean.match(/\b(?:found\s+)?(\d+)\s+errors?\b/i);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isSafeInteger(value) ? value : null;
}

export async function executeCheck(
  spec: CommandSpec,
  name: string,
  worktree: string,
  logPath: string,
  relativeLog: string,
  timeoutSeconds: number,
  signal: AbortSignal,
  env: Record<string, string>,
): Promise<CheckResult> {
  const command = [spec.command, ...spec.args];
  if (signal.aborted)
    return {
      name,
      command,
      status: 'cancelled',
      exitCode: null,
      durationMs: 0,
      logFile: null,
      reason: 'Run cancelled.',
    };
  const log = new LogWriter(logPath);
  let lintErrors: number | null = null;
  log.write(`$ ${formatCommand(command)}\n`);
  const result = await runProcess(spec.command, spec.args, {
    cwd: worktree,
    timeoutMs: timeoutSeconds * 1_000,
    signal,
    env: { ...env, ...spec.env },
    onStdout: (chunk) => log.write(chunk),
    onStderr: (chunk) => log.write(chunk),
    onLine: (line) => {
      if (/lint/i.test(name)) {
        const count = parseLintErrorCount(line);
        if (count !== null) lintErrors = count;
      }
    },
  });
  log.write(
    `\n[agent-fleet] exit=${result.exitCode ?? 'null'} duration=${result.durationMs}ms${result.timedOut ? ' TIMEOUT' : ''}${result.cancelled ? ' CANCELLED' : ''}\n`,
  );
  const logError = await log.close();
  const failed = result.exitCode !== 0 || result.error !== null || logError !== null;
  return {
    name,
    command,
    status: result.cancelled ? 'cancelled' : failed ? 'failed' : 'passed',
    exitCode: result.exitCode,
    durationMs: result.durationMs,
    logFile: relativeLog,
    ...(/lint/i.test(name) ? { lintErrors } : {}),
    reason: result.timedOut
      ? `Timed out after ${timeoutSeconds}s.`
      : result.cancelled
        ? 'Run cancelled.'
        : (result.error ?? logError),
  };
}

export function skippedChecks(checks: readonly CheckSpec[], reason: string): CheckResult[] {
  return checks.map((check) => ({
    name: check.name,
    command: [check.command, ...check.args],
    status: 'skipped',
    exitCode: null,
    durationMs: 0,
    logFile: null,
    reason,
  }));
}

export function summarizeChecks(checks: readonly CheckResult[]): string {
  if (!checks.length) return 'not configured';
  return checks.map((check) => `${check.name}: ${check.status}`).join(', ');
}
