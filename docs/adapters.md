# Agent adapters

An adapter turns a task into an argv array and interprets output lines into optional messages, tool actions, usage, progress and protocol failures. Every adapter runs with stdin closed/ignored, its own worktree as cwd, and raw stdout/stderr captured independently of parsing.

## Claude Code

Default command shape:

```sh
claude --permission-mode acceptEdits --output-format stream-json --verbose -p "the task"
```

The adapter reads assistant text/content blocks, tool-use blocks, and final `result.total_cost_usd`/usage when present. A result with `is_error: true` is a failure even if the process exits zero. `acceptEdits` does not approve arbitrary shell commands. To allow specific tools, configure the CLI's own allow-list flags; do not default to permission bypass.

Authentication, hooks, MCP configuration and model availability belong to the installed Claude CLI. agent-fleet does not use `--bare` because that changes credential and project-instruction discovery. Review the trust implications of project hooks in [Safety](safety.md).

Official reference: [Claude Code headless mode](https://code.claude.com/docs/en/headless).

## Codex

Default command shape:

```sh
codex exec --sandbox workspace-write --json "the task"
```

The adapter reads `thread.started`, `turn.started/completed/failed`, `item.*` messages, command/file/tool actions, plan steps and token usage. Codex JSONL token usage does not imply a dollar price; cost stays unknown unless an explicit supported cost event is available. `turn.failed` is a protocol failure. The default sandbox is workspace-write, never danger-full-access.

Codex's own sandbox is separate from agent-fleet's Git isolation. The evaluator's project commands are **not** run inside the Codex sandbox.

Official reference: [Codex non-interactive mode](https://developers.openai.com/codex/noninteractive).

## Generic command adapters

Any CLI can be configured without changing TypeScript:

```yaml
agents:
  local:
    type: command
    command: node
    args: [scripts/my-agent.mjs, '{task}']
```

Plain stdout/stderr lines become latest-action messages. For richer telemetry, emit one JSON object per line:

```jsonl
{"type":"message","message":"Reading authentication code","progress":20}
{"type":"tool","action":"edit","path":"src/auth.ts"}
{"type":"usage","cost_usd":0.04}
{"type":"usage","usage":{"input_tokens":1200,"output_tokens":300}}
{"type":"message","message":"Implementation ready","progress":90}
```

Supported fields:

- `type: message` with `message` (also accepts top-level `text` or `result`).
- `type: tool`, `tool_use` or `action`: the complete object is retained in `tools.jsonl`.
- `progress`: finite number 0–100. The runner reserves the final phase for checks and reaches 100 only when finished.
- `usage`: `input_tokens`/`prompt_tokens`, `output_tokens`/`completion_tokens`, `cache_read_input_tokens`/`cached_input_tokens`.
- `cost_usd` or `total_cost_usd`: nonnegative reported USD. Later token-only updates preserve a previously reported cost.
- `type: error` or `failed`, or `result.is_error: true`: protocol failure. Nonzero process exit is independently authoritative.
- `type: assistant` with `message.content[]` text/tool-use blocks is also understood for compatible CLIs.

Malformed JSON is treated as plain text, not a crash. Unknown events are ignored. Exit successfully with no changes is allowed, but the empty candidate is unranked and cannot be merged.

### Cursor Agent example

Cursor can use the generic adapter. Its print/streaming and force flags are documented by Cursor. [1](https://cursor.com/docs/cli/reference/output-format) [2](https://cursor.com/docs/cli/headless) [3](https://cursor.com/docs/cli/reference/parameters)

```yaml
agents:
  cursor:
    type: command
    command: cursor-agent
    args: [--print, --output-format, stream-json, --force, '{task}']
```

**`--force` allows commands/file changes without confirmation.** This is an explicit permission choice, not a safe default. Verify flags against your installed `cursor-agent --help`, and run only in a trusted environment. Depending on the CLI version, usage may be omitted; agent-fleet will show unknown cost rather than estimating it.

## Adding a native TypeScript adapter

1. Implement `AgentAdapter` in `src/agents/`.
2. Add its kind to the config/type union and factory.
3. Build argv without a shell; keep the task as a literal argument.
4. Parse streaming events incrementally and tolerate unknown/malformed events.
5. Add command-construction and protocol fixture tests. Do not require paid model calls in CI.

The generic adapter is the preferred extension path for a one-off CLI; a native adapter is useful when its event/usage protocol needs special handling.
