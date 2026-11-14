# agent-fleet

**One task. Multiple coding agents. Evidence before merging.**

agent-fleet is a local-first, open-source Agent Workbench for running CLI coding agents in parallel, watching their progress, and comparing their actual output. It gives each agent a separate Git worktree and branch, runs your project's checks, and produces a Markdown comparison report.

Built with **TypeScript, Node.js and Ink**. No agent-fleet account, cloud service, telemetry, or mandatory API key. Bring your own installed agent CLIs and their existing authentication.

> Status: **MVP / v0.1.0**. macOS and Linux are the supported CI targets. Windows users should use WSL. Agents and project checks execute code with your user privileges; Git worktrees are **not security sandboxes**. Read [Safety](docs/safety.md) before running an untrusted repository or command.

## What it does

- Runs Claude Code, Codex, or any command-based agent through replaceable adapters.
- Creates `agent-fleet/<agent>/<task-slug>-<run-id>` branches and independent worktrees from one pinned HEAD.
- Enforces a concurrency limit, per-agent timeout, and separate per-check timeout.
- Streams stdout/stderr to disk and shows status, approximate progress, latest action, changed-file count, checks, duration and reported cost in a TUI.
- Captures committed, staged, unstaged and untracked changes—including binary files—without staging over the agent's real index.
- Runs configured setup/lint/test commands in every worktree and records their exit codes and full logs.
- Writes a transparent heuristic comparison to `.agent-fleet/runs/<run-id>/report.md`.
- Lets you inspect complete diffs/logs and **explicitly** merge one reviewed candidate. Never merges or pushes automatically.

## Install from source

Requirements: **Node.js ≥22.12**, **Git ≥2.39**, and the agent CLIs you want to use.

```sh
git clone https://github.com/pooria683/agent-fleet.git
cd agent-fleet
npm ci
npm run build
npm link          # exposes the agent-fleet command; alternatively use node dist/cli/index.js
```

The package has not been assumed to be published on npm. Install from this repository for the MVP.

## Try it without API keys

```sh
npm run demo
```

This creates a disposable Git repository and runs two **deterministic fixtures**, not AI models. Both make real file changes; one also leaves a lint issue and a risky configuration change. You get real worktrees, diffs, tests, logs, scores and a report, with no network/model calls. The script prints the retained repository path and never merges anything.

## Run your agents

Install and authenticate Claude Code and/or Codex using their own instructions, then:

```sh
agent-fleet agents --repo .
agent-fleet init --repo .       # optional starter configuration; refuses overwrite
# Review and commit the new config before running, or use --allow-dirty.

agent-fleet run --repo . --task "Implement password reset flow" \
  --agents claude,codex --parallel 2
```

Preview the exact commands without creating anything:

```sh
agent-fleet run --repo . --task "Implement password reset flow" \
  --agents claude,codex --parallel 2 --dry-run
```

For CI, SSH without a TTY, or machine-readable output:

```sh
agent-fleet run --task "Add regression tests" --agents claude,codex --no-tui
agent-fleet run --task "Add regression tests" --agents claude,codex --json
```

A dirty source checkout is rejected by default. `--allow-dirty` permits it, but **only committed HEAD** is copied; your uncommitted changes are not included.

## Inspect, compare, choose

```sh
agent-fleet runs
agent-fleet show <run-id> --tui
agent-fleet report <run-id> --stdout
agent-fleet diff <run-id> claude
agent-fleet logs <run-id> claude --stream all
agent-fleet logs <run-id> claude --stream stderr --tail 100
```

TUI controls: **←/→** select agent, **Tab** switch view, **d** diff, **l** logs, **t** tools, **c** checks, **m** merge instructions, **↑/↓ / PgUp / PgDn** scroll, **q / Ctrl+C** cancel a live run or quit a finished one. The TUI bounds document previews to the last 512 KiB per file and labels truncation; the `diff` and `logs` commands stream the **complete** artifacts.

After reviewing the evidence:

```sh
agent-fleet merge <run-id> claude --into main --dry-run
agent-fleet merge <run-id> claude --into main
# Non-interactive, after review: add --yes
```

Merge requires a clean checkout of the target branch, a completed non-empty candidate, and an unchanged post-evaluation snapshot. It checks conflicts, creates a no-fast-forward merge, and rolls back a failed merge. It does not switch branches, stash your work, or push. Worktrees and logs are retained.

## Configuration at a glance

`agent-fleet.config.yaml` is optional. Commands are **argv arrays**, not shell strings:

```yaml
version: 1
run:
  parallel: 2
  timeoutSeconds: 1800
  checkTimeoutSeconds: 600
agents:
  claude:
    type: claude
    args: [--permission-mode, acceptEdits]
  codex:
    type: codex
    args: [--sandbox, workspace-write]
setup:
  - command: npm
    args: [ci]
checks:
  - name: lint
    command: npm
    args: [run, lint]
  - name: test
    command: npm
    args: [test]
```

Without configuration, agent-fleet detects `lint` and `test` scripts in `package.json` and selects npm/pnpm/yarn/bun from `packageManager` or lockfiles. It **does not install dependencies automatically**. Git worktrees do not contain ignored `node_modules`; configure setup explicitly when needed. Other stacks can provide any lint/test commands.

See [Configuration](docs/configuration.md), [Adapters](docs/adapters.md), and the [Cursor/generic CLI example](docs/adapters.md#generic-command-adapters).

## Storage

```text
.agent-fleet/
└── runs/<run-id>/
    ├── run.json                 # atomic status/result manifest
    ├── events.jsonl             # timestamped run events
    ├── report.md                # comparison and evidence links
    ├── agents/<agent>/
    │   ├── stdout.log
    │   ├── stderr.log
    │   ├── tools.jsonl
    │   ├── changes.diff
    │   └── check-<name>.log
    └── worktrees/<agent>/       # independent Git checkouts
```

On the first run, agent-fleet adds `/.agent-fleet/` to the repository-local `.git/info/exclude` if needed. This is an explicit local-only side effect; it does not modify tracked files or create a commit. New artifact directories/files are private to the current user where the OS supports POSIX modes.

## Development

```sh
npm run check        # Biome, TypeScript, tests, production build
npm run test:coverage
npm run demo
```

The test suite uses real temporary Git repositories and fake CLI processes. It covers concurrency, untracked/binary diffs, failures, timeout/process-group cleanup, cancellation, scoring, merge safety, CLI contracts and Ink interactions. It does not spend money on model calls.

- [Quickstart](docs/quickstart.md) · [راهنمای سریع فارسی](docs/quickstart.fa.md)
- [Architecture](docs/architecture.md)
- [Evaluation and costs](docs/evaluation.md)
- [Safety and limitations](docs/safety.md)
- [Contributing](CONTRIBUTING.md) · [Security](SECURITY.md) · [Changelog](CHANGELOG.md)

## License

[MIT](LICENSE)
