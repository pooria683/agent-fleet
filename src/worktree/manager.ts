import { createWriteStream } from 'node:fs';
import { copyFile, mkdir, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { execa } from 'execa';
import { FleetError } from '../core/errors.js';
import type { DiffSnapshot, FileChange } from '../core/types.js';

import { assertCommit, cleanGitEnvironment, git, gitValue, registeredWorktrees } from './git.js';

export interface Worktree {
  path: string;
  branch: string;
  baseCommit: string;
}

export async function createWorktree(
  repo: string,
  runDir: string,
  runId: string,
  agent: string,
  slug: string,
  baseCommit: string,
): Promise<Worktree> {
  await assertCommit(repo, baseCommit);
  const branch = `agent-fleet/${agent}/${slug}-${runId.toLowerCase()}`;
  await git(repo, ['check-ref-format', '--branch', branch]);
  const path = join(runDir, 'worktrees', agent);
  await mkdir(resolve(path, '..'), { recursive: true, mode: 0o700 });
  await git(repo, ['worktree', 'add', '-b', branch, path, baseCommit], { timeoutMs: 180_000 });
  return { path, branch, baseCommit };
}

export async function changedFiles(worktree: string, baseCommit: string): Promise<string[]> {
  const tracked = (await gitValue(worktree, 'diff', '--name-only', '-z', baseCommit, '--'))
    .split('\0')
    .filter(Boolean);
  const untracked = (await gitValue(worktree, 'ls-files', '--others', '--exclude-standard', '-z'))
    .split('\0')
    .filter(Boolean);
  return [...new Set([...tracked, ...untracked])].filter(
    (path) => !path.startsWith('.agent-fleet/'),
  );
}

function parseNameStatus(output: string): Map<string, string> {
  const parts = output.split('\0');
  const files = new Map<string, string>();
  for (let index = 0; index < parts.length; ) {
    const status = parts[index++];
    if (!status) continue;
    const path = parts[index++];
    if (!path) continue;
    if (/^[RC]/.test(status)) {
      const old = path;
      const destination = parts[index++];
      if (destination) files.set(destination, `${status[0]}: ${old} → ${destination}`);
    } else files.set(path, status);
  }
  return files;
}

function parseNumstat(output: string): Map<string, { additions: number; deletions: number }> {
  const parts = output.split('\0');
  const files = new Map<string, { additions: number; deletions: number }>();
  for (let index = 0; index < parts.length; ) {
    const entry = parts[index++];
    if (!entry) continue;
    const match = /^(\d+|-)\t(\d+|-)\t(.*)$/.exec(entry);
    if (!match) continue;
    let path = match[3] ?? '';
    if (path === '') {
      index++; // Old name of a rename/copy.
      path = parts[index++] ?? '';
    }
    if (path)
      files.set(path, {
        additions: Number(match[1] === '-' ? 0 : match[1]),
        deletions: Number(match[2] === '-' ? 0 : match[2]),
      });
  }
  return files;
}

export function detectRisks(files: readonly FileChange[]): string[] {
  const risks: string[] = [];
  for (const file of files) {
    if (file.status.startsWith('D')) risks.push(`Deleted file: ${file.path}`);
    if (file.status.startsWith('R')) risks.push(`Renamed/moved file: ${file.path}`);
    const normalized = file.path.replaceAll('\\', '/');
    if (
      /(^|\/)(\.github|\.gitlab)(\/|$)/.test(normalized) ||
      /(^|\/)(Dockerfile[^/]*|Containerfile[^/]*|Makefile|Justfile|Taskfile[^/]*|package\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|package-lock\.json|npm-shrinkwrap\.json|Cargo\.(toml|lock)|go\.(mod|sum)|pyproject\.toml|poetry\.lock|uv\.lock|requirements[^/]*\.txt|Pipfile[^/]*|tsconfig[^/]*\.json|biome[^/]*\.jsonc?|eslint[^/]*|\.prettierrc[^/]*|\.env[^/]*|terraform[^/]*|.*\.tf|.*\.tfvars)$/.test(
        normalized,
      ) ||
      /(^|\/)(\.gitmodules|\.gitattributes|\.npmrc|\.yarnrc[^/]*|\.claude|\.codex)(\/|$)/.test(
        normalized,
      )
    ) {
      risks.push(`Configuration/build/dependency change: ${file.path}`);
    }
    if (file.additions + file.deletions > 1_000)
      risks.push(`Large change (${file.additions + file.deletions} lines): ${file.path}`);
  }
  return risks;
}

/**
 * Snapshot into a private index: includes committed, staged, unstaged and untracked
 * changes without touching the agent's real index. Ignored files stay ignored.
 */
export async function snapshotWorktree(
  worktree: string,
  baseCommit: string,
  agentDir: string,
): Promise<DiffSnapshot> {
  if (await gitValue(worktree, 'ls-files', '--unmerged')) {
    throw new FleetError(
      'The agent left unmerged index entries. Resolve conflicts before comparing or merging.',
    );
  }
  const indexPath = join(agentDir, 'snapshot.index');
  const realIndex = resolve(worktree, await gitValue(worktree, 'rev-parse', '--git-path', 'index'));
  await copyFile(realIndex, indexPath);
  const env = { GIT_INDEX_FILE: indexPath };
  let tree: string;
  try {
    await git(worktree, ['add', '-A', '--', '.', ':(exclude).agent-fleet'], {
      env,
      timeoutMs: 180_000,
    });
    tree = (await git(worktree, ['write-tree'], { env })).stdout.trim();
  } finally {
    await unlink(indexPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
  return finishSnapshot(worktree, baseCommit, agentDir, env, tree);
}

async function finishSnapshot(
  worktree: string,
  baseCommit: string,
  agentDir: string,
  env: Record<string, string>,
  tree: string,
): Promise<DiffSnapshot> {
  const statuses = parseNameStatus(
    await gitValue(worktree, 'diff', '--name-status', '-z', '--find-renames', baseCommit, tree),
  );
  const stats = parseNumstat(
    await gitValue(worktree, 'diff', '--numstat', '-z', '--find-renames', baseCommit, tree),
  );
  const files: FileChange[] = [...statuses].map(([path, status]) => ({
    path,
    status,
    additions: stats.get(path)?.additions ?? 0,
    deletions: stats.get(path)?.deletions ?? 0,
  }));
  const patchFile = join(agentDir, 'changes.diff');
  const child = execa(
    'git',
    [
      'diff',
      '--binary',
      '--full-index',
      '--no-ext-diff',
      '--no-textconv',
      '--no-color',
      '--find-renames',
      baseCommit,
      tree,
    ],
    {
      cwd: worktree,
      env: cleanGitEnvironment(env),
      stdin: 'ignore',
      buffer: false,
      timeout: 180_000,
      maxBuffer: Infinity,
    },
  );
  await pipeline(child.stdout, createWriteStream(patchFile, { mode: 0o600 }));
  await child;
  return {
    tree,
    files,
    additions: files.reduce((sum, file) => sum + file.additions, 0),
    deletions: files.reduce((sum, file) => sum + file.deletions, 0),
    risks: detectRisks(files),
    patchFile,
  };
}

export async function verifyWorktree(repo: string, path: string, branch: string): Promise<string> {
  const worktrees = await registeredWorktrees(repo);
  const actual = worktrees.find((entry) => resolve(entry.path) === resolve(path));
  if (!actual || actual.branch !== branch)
    throw new FleetError(
      'The candidate worktree/branch is no longer registered as recorded. It will not be merged.',
    );
  if (actual.head !== (await gitValue(path, 'rev-parse', 'HEAD'))) {
    throw new FleetError('The candidate worktree changed unexpectedly.');
  }
  return gitValue(path, 'rev-parse', 'HEAD');
}
