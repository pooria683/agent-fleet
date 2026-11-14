# Architecture

## Source layout

```text
src/
├── cli/          Commander commands, plain/JSON output, confirmation prompts
├── core/         Types, errors, validated config, atomic local run store
├── agents/       Claude, Codex and generic streaming adapters
├── worktree/     Git commands, repository lock, worktrees, private-index snapshots
├── runner/       Bounded scheduler, process lifecycle, explicit merge, recovery
├── evaluator/    Setup/lint/test execution, transparent scoring, Markdown report
├── ui/           Ink dashboard, bounded document previews, historical inspection
└── utils/        Process groups, raw log writers, formatting, private filesystem writes
```

## Lifecycle

1. Resolve the Git root, validate config/agent names and limits, pin `HEAD^{commit}` and record the source branch.
2. Require a clean source unless explicitly overridden. Add the local artifact exclude if necessary. Create a private run directory and initial manifest.
3. Start at most `parallel` workers. Under an advisory Git lock, each creates `git worktree add -b agent-fleet/<agent>/<slug>-<run-id> <path> <base>`.
4. Spawn the adapter without a shell. Stream raw output to files, parse JSONL/plain actions, poll changed-file counts, and atomically persist status/usage.
5. On exit, timeout or cancellation, close logs and capture a Git tree using a **temporary index**. This includes net committed/staged/unstaged/untracked changes relative to base while respecting ignores. The agent's real index is untouched.
6. Run setup and checks in the worktree. Preserve the pre-check tree as the candidate; store check exit codes, durations and full logs.
7. When every slot finishes, rank eligible candidates, persist the terminal manifest and write `report.md`.
8. A separate explicit merge command verifies the candidate still matches its evaluated tree, previews conflicts, and merges a snapshot commit into the clean checked-out target without changing the candidate branch, index or worktree.

## State and evidence

`run.json` is the authoritative structured result. Writes use a private temporary file and rename. Important transitions are persisted immediately; message updates are throttled and a heartbeat preserves elapsed time. `events.jsonl` records timestamped messages/actions/check transitions. Raw stdout/stderr are never reduced to the bounded terminal preview.

Agent states: `queued → running → checking → completed|failed`, with `cancelled` for user stopping. A failed agent can still be in `checking` while its partial output is evaluated; the failure is restored afterward. A run can also be `interrupted` when a later inspection finds its supervisor dead.

A completed run means orchestration finished. Lint/test failures are candidate quality signals and do not automatically turn a successfully exited agent into an execution failure. Setup/snapshot/protocol/process failures do.

## Git snapshot details

The snapshot copies the worktree index into the private run directory, stages the current working tree into that copy, and calls `git write-tree`. Diffing base against the resulting tree captures all net changes, including untracked and binary files. Rename/delete/config risk flags come from name-status/numstat and path heuristics. The temporary index is removed; Git objects remain available for the retained candidate and merge.

Ignored files are intentionally excluded. Submodule working-tree contents are not recursively snapshotted or initialized; gitlink changes are visible, but submodule-heavy projects need explicit setup/check handling. External diff/textconv drivers are disabled for evidence generation.

## Process and crash behavior

On POSIX, each agent/check is a process-group leader. Timeout/cancellation signals the group, escalates to SIGKILL, and cleans descendants when the leader exits. An exit hook cleans active groups on normal supervisor exit. A SIGKILL/power loss cannot be intercepted; an agent that starts a separate session can also escape group cleanup. Recovery therefore marks unfinished work **interrupted/failed**, never completed, and tells you to inspect processes/worktrees.

Inspection commands use the recorded supervisor PID to detect dead runs. PID reuse is a small local-MVP limitation. There is no daemon, automatic resume, distributed lock service or cloud state.

## Public local API

The package exports `prepareRun`, `FleetRunner`, `executeRun`, `mergeCandidate`, config types, adapter interfaces and report rendering from `src/core/index.ts`.

```ts
import { executeRun } from 'agent-fleet';

const { run, reportPath } = await executeRun({
  repo: '/path/to/repo',
  task: 'Add regression tests',
  agents: ['claude', 'codex'],
  parallel: 2,
});
```

The library does not install/authenticate agent CLIs or provide a security sandbox. `FleetRunner` emits typed `update`, `event`, and `persistenceError` events for custom local interfaces.
