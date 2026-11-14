import { access, appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { execa } from 'execa';
import lockfile from 'proper-lockfile';
import { FleetError, GitError } from '../core/errors.js';

export function cleanGitEnvironment(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (!key.startsWith('GIT_') || /^GIT_(AUTHOR|COMMITTER|SSH)/.test(key)) env[key] = value;
  }
  return { ...env, GIT_OPTIONAL_LOCKS: '0', GIT_NO_LAZY_FETCH: '1', ...extra };
}

export async function git(
  cwd: string,
  args: readonly string[],
  options: { allowFailure?: boolean; env?: Record<string, string>; timeoutMs?: number } = {},
): Promise<{ stdout: string; exitCode: number }> {
  const result = await execa('git', [...args], {
    cwd,
    env: cleanGitEnvironment(options.env),
    stdin: 'ignore',
    reject: false,
    timeout: options.timeoutMs ?? 60_000,
    maxBuffer: 64 * 1024 * 1024,
    stripFinalNewline: false,
    windowsHide: true,
  });
  if (result.failed && !options.allowFailure) {
    const detail = String(result.stderr || result.message)
      .trim()
      .slice(0, 4_000);
    throw new GitError(`git ${args[0]} failed: ${detail}`, result.exitCode ?? null);
  }
  return {
    stdout: String(result.stdout ?? ''),
    exitCode: result.exitCode ?? (result.failed ? 1 : 0),
  };
}

export async function gitValue(cwd: string, ...args: string[]): Promise<string> {
  return (await git(cwd, args)).stdout.trim();
}

export async function repositoryRoot(path: string): Promise<string> {
  return resolve(await gitValue(path, 'rev-parse', '--show-toplevel'));
}

export async function currentBranch(repo: string): Promise<string | null> {
  const result = await git(repo, ['symbolic-ref', '--quiet', '--short', 'HEAD'], {
    allowFailure: true,
  });
  return result.exitCode === 0 ? result.stdout.trim() : null;
}

export async function isClean(repo: string): Promise<boolean> {
  return (await gitValue(repo, 'status', '--porcelain=v1', '--untracked-files=all')) === '';
}

export async function assertClean(repo: string): Promise<void> {
  if (!(await isClean(repo))) {
    throw new FleetError(
      'The repository has uncommitted or untracked changes. Commit/stash them first, or use --allow-dirty to run from HEAD without those changes.',
    );
  }
}

export async function assertNoGitOperation(repo: string): Promise<void> {
  for (const marker of [
    'MERGE_HEAD',
    'rebase-merge',
    'rebase-apply',
    'CHERRY_PICK_HEAD',
    'REVERT_HEAD',
    'sequencer',
  ]) {
    const path = resolve(repo, await gitValue(repo, 'rev-parse', '--git-path', marker));
    try {
      await access(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    throw new FleetError(
      `A Git operation is in progress (${marker}). Finish or abort it before continuing.`,
    );
  }
}

export async function commonGitDirectory(repo: string): Promise<string> {
  return resolve(repo, await gitValue(repo, 'rev-parse', '--git-common-dir'));
}

/** All worktree creation and merges sharing a repository use the same advisory lock. */
export async function withGitLock<T>(repo: string, action: () => Promise<T>): Promise<T> {
  const common = await commonGitDirectory(repo);
  const target = resolve(common, 'agent-fleet.lock');
  await writeFile(target, '', { flag: 'a', mode: 0o600 });
  const release = await lockfile.lock(target, {
    stale: 30_000,
    update: 5_000,
    retries: { retries: 10, factor: 1.3, minTimeout: 100, maxTimeout: 1_000 },
    realpath: false,
  });
  try {
    return await action();
  } finally {
    await release();
  }
}

/** A local exclude, not a tracked .gitignore change and never a modification of HEAD. */
export async function ensureLocalStorageExcluded(repo: string): Promise<boolean> {
  const ignored = await git(repo, ['check-ignore', '--quiet', '--', '.agent-fleet/probe'], {
    allowFailure: true,
  });
  if (ignored.exitCode === 0) return false;
  if (ignored.exitCode !== 1)
    throw new GitError('Could not check the local Git excludes.', ignored.exitCode);
  const common = await commonGitDirectory(repo);
  const info = resolve(common, 'info');
  await mkdir(info, { recursive: true });
  const path = resolve(info, 'exclude');
  const previous = await readFile(path, 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return '';
    throw error;
  });
  if (!previous.split(/\r?\n/).some((line) => /^\/?\.agent-fleet\/?$/.test(line.trim()))) {
    await appendFile(
      path,
      `${previous && !previous.endsWith('\n') ? '\n' : ''}# agent-fleet local run artifacts\n/.agent-fleet/\n`,
      { mode: 0o600 },
    );
  }
  return true;
}

export async function assertCommit(repo: string, commit: string): Promise<void> {
  const result = await git(repo, ['cat-file', '-e', `${commit}^{commit}`], { allowFailure: true });
  if (result.exitCode !== 0)
    throw new FleetError(`Commit ${commit} no longer exists in this repository.`);
}

export async function isAncestor(
  repo: string,
  ancestor: string,
  descendant: string,
): Promise<boolean> {
  const result = await git(repo, ['merge-base', '--is-ancestor', ancestor, descendant], {
    allowFailure: true,
  });
  if (result.exitCode > 1)
    throw new GitError('Could not determine commit ancestry.', result.exitCode);
  return result.exitCode === 0;
}

export interface RegisteredWorktree {
  path: string;
  head: string;
  branch: string | null;
}

export async function registeredWorktrees(repo: string): Promise<RegisteredWorktree[]> {
  const output = await gitValue(repo, 'worktree', 'list', '--porcelain');
  const worktrees: RegisteredWorktree[] = [];
  let current: RegisteredWorktree | null = null;
  for (const line of output.split('\n')) {
    if (line.startsWith('worktree ')) {
      current = { path: line.slice(9), head: '', branch: null };
      worktrees.push(current);
    } else if (current && line.startsWith('HEAD ')) current.head = line.slice(5);
    else if (current && line.startsWith('branch refs/heads/')) current.branch = line.slice(18);
  }
  return worktrees;
}
