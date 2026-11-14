import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { errorMessage, FleetError } from '../core/errors.js';
import { RunStore } from '../core/store.js';
import { isRunTerminal } from '../core/types.js';
import { writeReport } from '../evaluator/report.js';
import { oneLine } from '../utils/format.js';
import {
  assertClean,
  assertCommit,
  assertNoGitOperation,
  currentBranch,
  git,
  gitValue,
  isAncestor,
  repositoryRoot,
  withGitLock,
} from '../worktree/git.js';
import { snapshotWorktree, verifyWorktree } from '../worktree/manager.js';

export interface MergeOptions {
  repo: string;
  runId: string;
  agent: string;
  into?: string | undefined;
  dryRun?: boolean;
}
export interface MergeResult {
  dryRun: boolean;
  commit: string;
  candidateCommit: string;
  targetBranch: string;
  message: string;
}

export async function mergeCandidate(options: MergeOptions): Promise<MergeResult> {
  const repo = await repositoryRoot(options.repo);
  const store = new RunStore(repo);
  return withGitLock(repo, async () => {
    const run = await store.load(options.runId);
    if (!isRunTerminal(run.status))
      throw new FleetError('Wait for the run to finish before merging a candidate.');
    if (run.merge)
      throw new FleetError(
        `This run already merged ${run.merge.agent} into ${run.merge.targetBranch} at ${run.merge.commit}.`,
      );
    const agent = run.agents.find((candidate) => candidate.name === options.agent);
    if (!agent) throw new FleetError(`Agent "${options.agent}" is not part of run ${run.id}.`);
    if (
      agent.status !== 'completed' ||
      !agent.snapshotTree ||
      agent.filesChanged === 0 ||
      !agent.headCommit
    ) {
      throw new FleetError(
        'Only a completed candidate with a captured, non-empty diff can be merged.',
      );
    }
    const targetBranch = options.into ?? run.sourceBranch;
    if (!targetBranch)
      throw new FleetError('The run started from detached HEAD. Specify --into <branch>.');
    await git(repo, ['check-ref-format', '--branch', targetBranch]);
    const targetRef = `refs/heads/${targetBranch}`;
    if (
      (await git(repo, ['show-ref', '--verify', '--quiet', targetRef], { allowFailure: true }))
        .exitCode !== 0
    ) {
      throw new FleetError(`Target branch ${targetBranch} does not exist.`);
    }
    if (targetBranch === agent.branch)
      throw new FleetError('The target must differ from the candidate branch.');
    await assertCommit(repo, run.baseCommit);
    await assertCommit(repo, agent.headCommit);
    const head = await verifyWorktree(repo, agent.worktree, agent.branch);
    if (head !== agent.headCommit)
      throw new FleetError(
        'The candidate branch advanced after evaluation. Review it and start a new run instead of merging stale checks.',
      );
    if (!(await isAncestor(repo, run.baseCommit, head)))
      throw new FleetError('The candidate no longer descends from the recorded base commit.');
    const previewDirectory = await mkdtemp(join(store.runDirectory(run.id), 'merge-preview-'));
    const snapshot = await snapshotWorktree(agent.worktree, run.baseCommit, previewDirectory);
    if (snapshot.tree !== agent.snapshotTree) {
      throw new FleetError(
        'The candidate worktree changed after evaluation. Its old test results no longer apply; review and rerun before merging.',
      );
    }
    for (const variable of ['GIT_AUTHOR_IDENT', 'GIT_COMMITTER_IDENT']) {
      const identity = await git(repo, ['var', variable], { allowFailure: true });
      if (identity.exitCode !== 0)
        throw new FleetError(
          `Git ${variable} is not configured. Set git user.name and user.email before merging.`,
        );
    }
    const targetHead = await gitValue(repo, 'rev-parse', targetRef);
    const message = `agent-fleet: ${oneLine(run.task, 180)} (${agent.name})\n\nRun: ${run.id}\nCandidate: ${agent.branch}\nSnapshot: ${snapshot.tree}`;
    let candidateCommit = head;
    if ((await gitValue(agent.worktree, 'rev-parse', 'HEAD^{tree}')) !== snapshot.tree) {
      candidateCommit = await gitValue(
        repo,
        'commit-tree',
        snapshot.tree,
        '-p',
        head,
        '-m',
        message,
      );
    }
    const preview = await git(
      repo,
      ['merge-tree', '--write-tree', '--name-only', targetHead, candidateCommit],
      { allowFailure: true },
    );
    if (preview.exitCode !== 0) {
      throw new FleetError(
        `Merge conflicts with ${targetBranch}; no refs or working files were changed.\n${preview.stdout.trim().slice(0, 6_000)}`,
      );
    }
    if (options.dryRun) {
      return {
        dryRun: true,
        commit: targetHead,
        candidateCommit,
        targetBranch,
        message: `Merge preview passed: ${agent.name} → ${targetBranch}. No refs or working files changed.`,
      };
    }
    await assertNoGitOperation(repo);
    await assertClean(repo);
    if ((await currentBranch(repo)) !== targetBranch)
      throw new FleetError(
        `Check out ${targetBranch} in the source repository first. Merge never switches branches or stashes your changes.`,
      );
    if ((await gitValue(repo, 'rev-parse', 'HEAD')) !== targetHead)
      throw new FleetError('The target branch changed during preflight. Retry the merge.');
    // Merge the verified snapshot commit directly. Never reset the candidate's
    // real index or branch: staged and unstaged work must remain exactly as it was.
    try {
      await git(repo, ['merge', '--no-ff', candidateCommit, '-m', message], { timeoutMs: 180_000 });
    } catch (error) {
      try {
        await git(repo, ['merge', '--abort']);
      } catch (abortError) {
        throw new FleetError(
          `Merge failed and rollback failed: ${errorMessage(error)}. Rollback: ${errorMessage(abortError)}. Inspect the repository manually.`,
        );
      }
      throw new FleetError(`Merge failed; the target was rolled back. ${errorMessage(error)}`);
    }
    const commit = await gitValue(repo, 'rev-parse', 'HEAD');
    run.merge = { agent: agent.name, commit, targetBranch, mergedAt: new Date().toISOString() };
    let recordingWarning = '';
    try {
      await store.save(run);
      await writeReport(run, store.runDirectory(run.id));
    } catch (error) {
      recordingWarning = ` WARNING: the Git merge succeeded, but updating the run record failed (${errorMessage(error)}). Do not retry blindly; inspect git log.`;
    }
    return {
      dryRun: false,
      commit,
      candidateCommit,
      targetBranch,
      message: `Merged ${agent.name} into ${targetBranch} at ${commit}. Logs and worktrees retained.${recordingWarning}`,
    };
  });
}
