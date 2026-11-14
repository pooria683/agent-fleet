import { StringDecoder } from 'node:string_decoder';
import { execa } from 'execa';
import { errorMessage } from '../core/errors.js';
import { cleanGitEnvironment } from '../worktree/git.js';

export interface ProcessOptions {
  cwd: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  env?: Record<string, string>;
  onStdout?: (chunk: Buffer) => void;
  onStderr?: (chunk: Buffer) => void;
  onLine?: (line: string, stream: 'stdout' | 'stderr') => void;
  onSpawn?: (pid: number) => void;
  input?: string;
}

export interface ProcessResult {
  exitCode: number | null;
  signal: string | null;
  durationMs: number;
  timedOut: boolean;
  cancelled: boolean;
  error: string | null;
  outputTail: string;
}

// One listener, not one per agent. This also cleans up on normal process.exit().
// A SIGKILL of the supervisor itself cannot be intercepted; recovery warns about it.
const activeGroups = new Set<number>();
process.on('exit', () => {
  if (process.platform === 'win32') return;
  for (const pid of activeGroups) {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      /* Already gone. */
    }
  }
});

/** No implicit shell. Timeout/cancellation kills the POSIX process group, not just its leader. */
export async function runProcess(
  command: string,
  args: readonly string[],
  options: ProcessOptions,
): Promise<ProcessResult> {
  const start = performance.now();
  let tail = '';
  let termination: 'timeout' | 'cancelled' | null = null;
  let terminationError: string | null = null;
  let exited = false;
  let timeoutTimer: ReturnType<typeof setTimeout> | null = null;
  let forceTimer: ReturnType<typeof setTimeout> | null = null;
  const cancellation = new AbortController();
  const child = execa(command, [...args], {
    cwd: options.cwd,
    stdin: options.input === undefined ? 'ignore' : 'pipe',
    ...(options.input === undefined ? {} : { input: options.input }),
    buffer: false,
    reject: false,
    forceKillAfterDelay: 2_000,
    detached: process.platform !== 'win32',
    cleanup: false,
    preferLocal: false,
    windowsHide: true,
    env: { ...cleanGitEnvironment(), NO_COLOR: '1', FORCE_COLOR: '0', ...options.env },
    cancelSignal: cancellation.signal,
  });
  const pid = child.pid;
  if (pid !== undefined) {
    if (process.platform !== 'win32') activeGroups.add(pid);
    options.onSpawn?.(pid);
  }
  const killGroup = (signal: 'SIGTERM' | 'SIGKILL') => {
    try {
      if (process.platform !== 'win32' && pid !== undefined) process.kill(-pid, signal);
      else child.kill(signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH')
        terminationError ??= errorMessage(error);
    }
  };
  const stop = (reason: 'timeout' | 'cancelled') => {
    if (exited || termination) return;
    termination = reason;
    killGroup('SIGTERM');
    cancellation.abort();
    forceTimer = setTimeout(() => killGroup('SIGKILL'), 2_000);
    forceTimer.unref();
  };
  const onAbort = () => stop('cancelled');
  options.signal?.addEventListener('abort', onAbort, { once: true });
  if (options.signal?.aborted) onAbort();
  if (options.timeoutMs && options.timeoutMs > 0) {
    timeoutTimer = setTimeout(() => stop('timeout'), options.timeoutMs);
    timeoutTimer.unref();
  }
  child.on('exit', () => {
    exited = true;
    if (timeoutTimer) clearTimeout(timeoutTimer);
    if (termination) {
      // The leader has exited; finish off any descendants that ignored SIGTERM.
      killGroup('SIGKILL');
      if (forceTimer) clearTimeout(forceTimer);
    }
    if (pid !== undefined) activeGroups.delete(pid);
  });

  const decoders = { stdout: new StringDecoder('utf8'), stderr: new StringDecoder('utf8') };
  const pending = { stdout: '', stderr: '' };
  for (const stream of ['stdout', 'stderr'] as const) {
    child[stream]?.on('data', (chunk: Buffer) => {
      if (stream === 'stdout') options.onStdout?.(chunk);
      else options.onStderr?.(chunk);
      const text = decoders[stream].write(chunk);
      tail = `${tail}${text}`.slice(-16_384);
      pending[stream] += text;
      const lines = pending[stream].split(/\r?\n/);
      pending[stream] = lines.pop() ?? '';
      // Bound an unbroken JSONL event in memory; complete raw output still goes to disk.
      if (pending[stream].length > 1_048_576) pending[stream] = pending[stream].slice(-1_048_576);
      for (const line of lines) options.onLine?.(line, stream);
    });
  }
  try {
    const result = await child;
    for (const stream of ['stdout', 'stderr'] as const) {
      const rest = pending[stream] + decoders[stream].end();
      if (rest) options.onLine?.(rest, stream);
    }
    const timedOut = termination === 'timeout';
    const cancelled =
      termination === 'cancelled' || (result.isCanceled && termination !== 'timeout');
    return {
      exitCode: result.exitCode ?? null,
      signal: result.signal ?? null,
      durationMs: Math.round(performance.now() - start),
      timedOut,
      cancelled,
      error:
        terminationError ??
        (timedOut
          ? 'Command timed out.'
          : cancelled
            ? 'Command cancelled.'
            : result.failed
              ? errorMessage(result.message ?? result.shortMessage)
              : null),
      outputTail: tail,
    };
  } catch (error) {
    return {
      exitCode: null,
      signal: null,
      durationMs: Math.round(performance.now() - start),
      timedOut: termination === 'timeout',
      cancelled: termination === 'cancelled' || options.signal?.aborted === true,
      error: terminationError ?? errorMessage(error),
      outputTail: tail,
    };
  } finally {
    if (timeoutTimer) clearTimeout(timeoutTimer);
    if (forceTimer) clearTimeout(forceTimer);
    options.signal?.removeEventListener('abort', onAbort);
    if (pid !== undefined) activeGroups.delete(pid);
  }
}
