# Quickstart

## 1. Install

Use Node.js 22.12+ and Git 2.39+ on macOS or Linux (WSL on Windows).

```sh
git clone https://github.com/pooria683/agent-fleet.git
cd agent-fleet
npm ci
npm run build
npm link
agent-fleet --help
```

If you do not want a global link, replace `agent-fleet` below with `node /absolute/path/to/agent-fleet/dist/cli/index.js`.

## 2. Verify the workbench offline

```sh
npm run demo
```

The demo uses deterministic command adapters, real Git worktrees and real Node tests/lint. It needs no credentials or model access. It leaves a temporary repository and prints its report path. Nothing is merged.

## 3. Prepare your project

Use a committed baseline. Commit or stash unrelated work first. Install the agent CLIs separately and sign in using their normal workflows. agent-fleet does not collect API keys.

```sh
cd /path/to/your/project
agent-fleet agents --repo .
agent-fleet init --repo .
```

Edit `agent-fleet.config.yaml` if your project needs dependency setup or non-npm checks. `init` creates an untracked file, so review and commit the config before running, or explicitly use `--allow-dirty`. A worktree does **not** copy ignored files such as `node_modules` or `.env`. Add an explicit setup command if appropriate; do not put secrets in configuration.

## 4. Preview, then run

```sh
agent-fleet run --repo . --task "Implement password reset flow" \
  --agents claude,codex --parallel 2 --dry-run

agent-fleet run --repo . --task "Implement password reset flow" \
  --agents claude,codex --parallel 2
```

Useful options:

| Option | Meaning |
|---|---|
| `--parallel N` | Maximum occupied agent slots, including that agent's checks |
| `--timeout seconds` | Per-agent process timeout; default 1800 |
| `--check-timeout seconds` | Per setup/lint/test command timeout; default 600 |
| `--config path` | Explicit YAML or JSON config |
| `--allow-dirty` | Permit dirty source, but still start every agent from committed HEAD |
| `--no-tui` | Plain progress output; automatic outside a TTY |
| `--json` | Final manifest on stdout; no TUI |
| `--dry-run` | Print commands/paths; create no artifacts, branches or worktrees |

In the TUI, use left/right to select an agent and `d`, `l`, `t`, `c` for diff, logs, tools and checks. `m` shows the explicit merge commands. `q` or Ctrl+C stops a live run gracefully and retains evidence; on a finished run it exits. Progress is approximate, not a model-reported completion guarantee.

## 5. Read the evidence

```sh
agent-fleet runs
agent-fleet show <run-id> --tui
agent-fleet report <run-id> --stdout
agent-fleet diff <run-id> claude
agent-fleet logs <run-id> claude --stream all
```

The Markdown report is at `.agent-fleet/runs/<run-id>/report.md`. It links to full logs and diffs. `—` for cost means **unknown**, not zero. A high score is not proof that an implementation is correct.

For `diff` and `logs`, either supply `<run-id> <agent>` or just `<agent>` to use the latest run. TUI document previews are bounded; CLI artifact commands are complete.

## 6. Merge deliberately

Check out the intended target yourself and keep it clean:

```sh
git switch main
agent-fleet merge <run-id> claude --into main --dry-run
agent-fleet merge <run-id> claude --into main
```

The command displays checks/risk flags and asks you to type `merge`. In automation, use `--yes` only after reviewing the diff. Merge never pushes. See [Safety](safety.md) for rollback and retained-worktree cleanup.

## Exit codes

- `0`: command succeeded; a comparison run completed even if a candidate's lint/test failed (read its checks/score).
- `1`: invalid input, missing artifact, failed/cancelled agent execution, setup/snapshot failure, or merge failure.

Use `run.json` and the report—not just the process exit code—to choose a candidate.
