# Safety, trust and limitations

## A worktree is not a sandbox

agent-fleet spawns executables with your OS user privileges. A malicious agent, repository hook, dependency lifecycle script, lint command or test can read files outside its cwd, access the network, modify the original repository, or spend money through your authenticated CLI. Git isolation prevents ordinary concurrent edits from colliding; it is **not** an isolation boundary against hostile code.

Use a disposable container/VM with restricted mounts, network and credentials for untrusted repositories or agents. Review project instructions, hooks, MCP configuration and dependency scripts before running. Codex's own workspace-write sandbox applies to its agent process, not to agent-fleet's evaluator. Claude permission modes and Cursor `--force` are explicit choices made in adapter configuration.

agent-fleet never enables permission-bypass/full-access flags by default. It does not request, store or inject provider API keys. The inherited environment may contain credentials needed by your CLIs; raw agent output can still contain secrets. Artifact files/directories use private POSIX modes where supported, but inspect before sharing reports or logs.

## Source protection

- The base is a pinned commit, not a moving branch name.
- Dirty source is rejected unless `--allow-dirty`; even then only HEAD is included.
- Worktree creation and agent-fleet merges share an advisory lock stored inside the common Git directory. This does not lock other Git clients; avoid concurrent manual Git writes.
- The first run may append `/.agent-fleet/` to `.git/info/exclude`. This local-only change is reported. No tracked ignore file is edited and no baseline commit is created.
- Snapshot staging uses a private index, not the agent's real index.
- Nothing is merged or pushed automatically.

## Merge preflight and rollback

The explicit merge command requires:

- a terminal run and a completed candidate with a non-empty captured tree;
- the recorded registered worktree/branch and unchanged evaluated snapshot;
- a candidate descending from the recorded base;
- an existing target branch, checked out in the source repository, clean and not in a merge/rebase/cherry-pick/revert;
- configured Git author/committer identity;
- a successful `git merge-tree` conflict preview.

`--dry-run` may write Git objects and a private preview artifact, but does not move refs or change working files. An actual merge creates a snapshot commit and merges it directly with a no-fast-forward merge; the candidate branch, real index and worktree stay untouched. Repository merge hooks may run. If the merge fails, agent-fleet attempts `git merge --abort`; a rollback failure is reported explicitly for manual inspection. If recording the report after a successful Git merge fails, the command reports that the merge **did** succeed and warns not to retry blindly.

Only one candidate per run is recorded as merged. The command never switches branches, stashes, force-updates the target, or pushes.

## Cancellation, timeouts and crashes

Timeout/cancellation terminates the POSIX process group and escalates to SIGKILL. A process that creates a new session, a supervisor killed with SIGKILL, or power loss can defeat cleanup. Inspect `ps` and worktrees after an interrupted run. Inspection marks a dead supervisor's unfinished agents failed and the run interrupted; it does not pretend results completed or automatically resume execution. PID reuse is a small local-MVP limitation.

Agent timeout is separate from each check timeout. Raw logs and partial diffs are retained on failure/cancellation whenever capture is possible.

## Retention and cleanup

Runs, worktrees, branches, logs and diffs are retained. Prompts, source code and tool arguments may be sensitive; logs are not automatically redacted. There is no automatic expiration.

After reviewing/merging, remove a worktree explicitly:

```sh
git worktree remove /path/to/repo/.agent-fleet/runs/<run-id>/worktrees/<agent>
# Git refuses dirty worktrees. Use --force only if you intend to discard those edits.
git branch -d agent-fleet/<agent>/<slug>-<run-id>
# Use -D only for an unmerged branch you intentionally discard.
```

Keep the run directory if you want its evidence. Remove artifacts manually when no longer needed. To undo local exclusion, remove the agent-fleet entry from `.git/info/exclude` after artifacts are gone.

## MVP boundaries

macOS/Linux are tested; use WSL on Windows. No web UI, daemon, cloud sync, automatic dependency installation, submodule recursion, semantic quality judge, authoritative cross-provider pricing, distributed scheduling, or automatic conflict resolution. TUI previews are bounded to the last 512 KiB per document; CLI `diff`/`logs` stream complete files.
