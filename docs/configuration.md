# Configuration

The default lookup order is not a merge chain: agent-fleet looks for `agent-fleet.config.yaml`, `.yml`, and `.json` at the Git repository root and rejects ambiguity if more than one exists. `--config path` selects an explicit file, resolved relative to the invoking working directory. JSON uses the same schema. Unknown keys are errors; config size is limited to 1 MiB.

## Complete example

```yaml
version: 1
run:
  parallel: 2
  timeoutSeconds: 1800
  checkTimeoutSeconds: 600
agents:
  claude:
    type: claude
    command: claude
    args: [--permission-mode, acceptEdits, --model, sonnet]
  codex:
    type: codex
    command: codex
    args: [--sandbox, workspace-write, --model, gpt-5.4]
  local:
    type: command
    command: node
    args: [scripts/agent.mjs, --task, '{task}', --name, '{agent}']
    env:
      MY_AGENT_MODE: implementation
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

Model names above are examples, not availability guarantees; choose models supported by your installed CLI/account.

## Defaults and overrides

- `run.parallel`: 2, integer 1–64.
- `run.timeoutSeconds`: 1800, integer 1–86400. Applies to the agent process, not the subsequent checks.
- `run.checkTimeoutSeconds`: 600, integer 1–86400. Applies separately to each setup/lint/test command.
- CLI `--parallel`, `--timeout`, and `--check-timeout` override config values.
- Agent names: 1–64 characters, starting with a letter/digit, then letters/digits/`_`/`-`. Each name can appear once per run.
- `claude` and `codex` are built in. Other names require a configured command.
- `command` can override an executable path. Use a PATH name or absolute path for portability.
- An adapter's `args` **replace its default permission/sandbox arguments**. Include the desired permission mode or sandbox explicitly when overriding `args`. Output-protocol flags and the task argument are adapter-owned.
- `env` is optional string key/value data. The parent environment is inherited so existing CLI login credentials work. Do not commit secrets; agent-fleet does not redact secrets that an agent itself prints to logs.

## Commands are not shell strings

`command` plus `args` are passed directly to the OS. Pipes, redirects, `$VAR`, `&&`, glob expansion and command substitution are not interpreted. Use a reviewed script as the executable when you genuinely need shell behavior.

Generic agent arguments support exact placeholders inside any argument:

| Placeholder | Value |
|---|---|
| `{task}` | Original task, as one literal string even when embedded in a larger argument |
| `{agent}` | Selected agent name |
| `{repo}` | Absolute source repository root |
| `{worktree}` | This agent's absolute worktree path |
| `{run_dir}` | Absolute run artifact directory |

Relative script arguments such as `scripts/agent.mjs` resolve from the **worktree** working directory. Every process also receives `AGENT_FLEET_TASK`, `AGENT_FLEET_AGENT`, `AGENT_FLEET_REPO`, `AGENT_FLEET_WORKTREE`, and `AGENT_FLEET_RUN_DIR`.

## Setup and checks

`setup` is an ordered list of commands run before checks in each worktree. A failed setup command marks that agent failed and skips remaining setup/checks. Setup is included in the manifest as `setup-1`, etc.

`checks` can be:

- `auto` (default): inspect `package.json` for string `lint` and `test` scripts. Use `packageManager`, otherwise npm unless a pnpm/yarn/bun lockfile selects another manager. Run `<manager> run <script>`.
- `none`: explicitly disable checks. Missing/disabled checks contribute zero check/lint points; they never count as passing.
- A list of unique named commands, in execution order. Name the lint check `lint` (or include `lint` in its name) for the lint bonus.

Checks run serially within an agent; different agents occupy at most `parallel` slots. A check's nonzero exit marks the check failed, but does not by itself mean the agent process failed. Failed agent processes still get their partial output checked unless the run was cancelled.

Worktrees do not include ignored dependencies, build caches, `.env` files or submodule contents. agent-fleet does not silently install dependencies, initialize submodules, or copy secrets. Configure reproducible setup explicitly. Prefer non-mutating checks: the merge candidate is the **pre-check snapshot**, and post-check edits cause merge preflight to refuse stale evidence.
